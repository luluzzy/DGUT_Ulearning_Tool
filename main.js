// ==UserScript==
// @name         DGUT Ulearning Tool
// @version      1.1.3
// @match        https://ua.dgut.edu.cn/learnCourse/learnCourse.html*
// @description  DGUT U学院课程播放与章节测验辅助，支持异步加载、视频内测验和自动切页。
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @connect      ua.dgut.edu.cn
// @noframes
// @license      MIT
// @namespace    https://greasyfork.org/users/1537344
// @downloadURL  https://update.greasyfork.org/scripts/555722/DGUT%20Ulearning%20Tool.user.js
// @updateURL    https://update.greasyfork.org/scripts/555722/DGUT%20Ulearning%20Tool.meta.js
// ==/UserScript==

(function () {
    'use strict';

    const INSTANCE = '__dgutUlearningTool';
    const PANEL_ID = 'dgut-ulearning-tool-panel';
    const SCAN_DELAY = 150;
    const TEXT_PAGE_DELAY = 3000;
    const LOG_LIMIT = 100;
    const SPEEDS = [0.75, 1, 1.25, 1.5, 2, 3, 4, 5, 6];
    const videos = new Map();
    const quizzes = new Map();
    let speed = 1;
    let running = true;
    let destroyed = false;
    let scanTimer = null;
    let recoveryTimer;
    let advanceTimer;
    let currentPage = '';
    let navigatedPage = null;
    let summaryContinued = false;
    let advanceAfter = 0;
    let lastLog = '';
    let textPage = null;

    window[INSTANCE]?.destroy();
    const panel = createPanel();
    const logBox = panel.querySelector('#logBox');
    const observer = new MutationObserver(records => {
        if (records.some(record => !panel.contains(record.target))) scheduleScan();
    });
    window[INSTANCE] = { destroy };
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'class', 'disabled', 'hidden', 'aria-disabled'],
    });
    recoveryTimer = setInterval(scheduleScan, 2000);
    window.addEventListener('pagehide', destroy);
    scheduleScan();

    function log(message) {
        if (destroyed || message === lastLog) return;
        lastLog = message;
        const row = document.createElement('div');
        row.textContent = message;
        logBox.append(row);
        while (logBox.childElementCount > LOG_LIMIT) logBox.firstElementChild.remove();
        logBox.scrollTop = logBox.scrollHeight;
    }

    function createPanel() {
        document.getElementById(PANEL_ID)?.remove();
        const box = document.createElement('section');
        box.id = PANEL_ID;
        box.style.cssText = 'position:fixed;top:100px;right:24px;z-index:999999;background:#242628;color:#fff;padding:12px;border-radius:6px;font:14px/1.5 sans-serif;width:260px;max-width:calc(100vw - 48px);box-sizing:border-box;';
        box.innerHTML = `
            <style>
                #${PANEL_ID} button {
                    appearance: none;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    box-sizing: border-box;
                    min-width: 32px;
                    height: 32px;
                    margin: 0;
                    padding: 0 10px;
                    border: 1px solid #858b91 !important;
                    border-radius: 4px;
                    background: #45494d !important;
                    color: #fff !important;
                    font: inherit;
                    line-height: 1;
                    text-shadow: none;
                    cursor: pointer;
                }
                #${PANEL_ID} button:hover { background: #565c62 !important; }
                #${PANEL_ID} button:active { background: #363b3f !important; }
                #${PANEL_ID} button:focus-visible { outline: 2px solid #67e8f9; outline-offset: 2px; }
            </style>
            <div data-drag style="cursor:move;font-weight:bold;touch-action:none">DGUT Ulearning Tool</div>
            <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
                <button id="speedDown" type="button" title="降低倍速" aria-label="降低倍速">−</button>
                <span>倍速 <span id="speedVal">1</span>x</span>
                <button id="speedUp" type="button" title="提高倍速" aria-label="提高倍速">+</button>
            </div>
            <div style="display:flex;align-items:center;gap:12px;margin:8px 0">
                <label><input id="autoRun" type="checkbox" checked>自动运行</label>
                <button id="retryTasks" type="button" title="重试播放或失败的答案请求">重试</button>
            </div>
            <div id="logBox" role="log" style="height:130px;overflow:auto;background:#141516;padding:6px;border-radius:4px;font-size:12px;overflow-wrap:anywhere"></div>`;
        document.body.append(box);
        box.querySelector('#speedUp').onclick = () => changeSpeed(1);
        box.querySelector('#speedDown').onclick = () => changeSpeed(-1);
        box.querySelector('#autoRun').onchange = event => {
            running = event.target.checked;
            textPage = null;
            if (!running) {
                for (const state of quizzes.values()) cancelQuiz(state);
                quizzes.clear();
                for (const record of videos.values()) record.element.pause();
            } else {
                for (const record of videos.values()) record.blocked = false;
            }
            log(running ? '自动运行已开启。' : '自动运行已暂停。');
            scheduleScan();
        };
        box.querySelector('#retryTasks').onclick = () => {
            for (const record of videos.values()) record.blocked = false;
            for (const state of quizzes.values()) {
                if (state.submitted && Date.now() - state.submittedAt >= 15000) state.submitted = false;
                for (const entry of state.entries.values()) {
                    if (entry.status === 'failed') entry.status = 'pending';
                }
            }
            log('正在重试。');
            scheduleScan();
        };
        const handle = box.querySelector('[data-drag]');
        let drag;
        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            const rect = box.getBoundingClientRect();
            drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
            handle.setPointerCapture(event.pointerId);
        });
        handle.addEventListener('pointermove', event => {
            if (!drag) return;
            box.style.right = 'auto';
            box.style.left = Math.max(0, Math.min(window.innerWidth - box.offsetWidth, event.clientX - drag.x)) + 'px';
            box.style.top = Math.max(0, Math.min(window.innerHeight - box.offsetHeight, event.clientY - drag.y)) + 'px';
        });
        handle.addEventListener('lostpointercapture', () => { drag = null; });
        return box;
    }

    function changeSpeed(direction) {
        speed = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed) + direction))];
        panel.querySelector('#speedVal').textContent = String(speed);
        for (const record of videos.values()) applySpeed(record);
        log(`视频倍速：${speed}x`);
    }

    function scheduleScan() {
        if (!destroyed && scanTimer === null) {
            scanTimer = setTimeout(() => {
                scanTimer = null;
                scan();
            }, SCAN_DELAY);
        }
    }

    function pageKey() {
        return location.href + '|' + (document.querySelector('.page-name.active')?.closest('[id^="page"]')?.id || '');
    }

    function visible(element) {
        if (!element?.isConnected) return false;
        for (let node = element; node && node !== document.body; node = node.parentElement) {
            if (node.hidden || node.classList.contains('hidden') || node.getAttribute('aria-hidden') === 'true') return false;
            const style = getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
        }
        return true;
    }

    function clickable(element) {
        return visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true'
            && !element.classList.contains('disabled') && !element.classList.contains('disable');
    }

    function scan() {
        if (destroyed || !running) return;
        const key = pageKey();
        if (key !== currentPage) {
            for (const state of quizzes.values()) cancelQuiz(state);
            quizzes.clear();
            for (const record of videos.values()) detachVideo(record);
            videos.clear();
            currentPage = key;
            navigatedPage = null;
            summaryContinued = false;
            advanceAfter = 0;
            textPage = null;
            clearTimeout(advanceTimer);
        }
        syncVideos();
        const blockingModals = [...document.querySelectorAll('.modal')]
            .filter(modal => !modal.classList.contains('video-question-modal') && visible(modal));
        if (blockingModals.length) {
            textPage = null;
            if (blockingModals.length === 1 && blockingModals[0].id === 'statModal') advanceChapter(blockingModals[0]);
            else log('网站提示需要处理，自动操作已等待。');
            return;
        }
        syncQuizzes();
        const modalOpen = [...document.querySelectorAll('.video-question-modal')].some(visible);
        if (modalOpen) textPage = null;
        const nextVideo = [...videos.values()].find(record => !record.completed && !record.element.ended);
        if (nextVideo && !modalOpen && visible(nextVideo.element)) playVideo(nextVideo);
        advancePage();
    }

    function videoSource(video) {
        return video.getAttribute('src') || video.querySelector('source')?.getAttribute('src') || video.currentSrc;
    }

    function syncVideos() {
        for (const [video, record] of videos) {
            if (!video.isConnected) {
                detachVideo(record);
                videos.delete(video);
            }
        }
        for (const video of document.querySelectorAll('video')) {
            if (video.closest('.question-view, .video-question-modal') ||
                (video.id && !video.id.startsWith('elementVideo') && !video.closest('.video-element'))) continue;
            let record = videos.get(video);
            if (!record) {
                record = { element: video, source: videoSource(video), completed: video.ended, blocked: false, pending: false, listeners: [] };
                videos.set(video, record);
                const listen = (event, callback) => {
                    video.addEventListener(event, callback);
                    record.listeners.push([event, callback]);
                };
                listen('loadstart', () => {
                    record.completed = false;
                    record.blocked = false;
                    record.source = videoSource(video);
                    scheduleScan();
                });
                listen('loadedmetadata', scheduleScan);
                listen('canplay', scheduleScan);
                listen('play', () => { record.blocked = false; });
                listen('ended', () => {
                    if (record.completed) return;
                    record.completed = true;
                    advanceAfter = Date.now() + 700;
                    clearTimeout(advanceTimer);
                    advanceTimer = setTimeout(scheduleScan, 700);
                    log('视频已播放完毕，等待页面任务完成。');
                    scheduleScan();
                });
                video.muted = true;
                log('已识别课程视频。');
            }
            const source = videoSource(video);
            if (source !== record.source) {
                record.source = source;
                record.completed = false;
                record.blocked = false;
            }
        }
    }

    function applySpeed(record) {
        try {
            if (record.element.playbackRate !== speed) record.element.playbackRate = speed;
        } catch {
            record.blocked = true;
            log('播放器拒绝设置倍速，请使用播放器控件调整。');
        }
    }

    function playVideo(record) {
        const video = record.element;
        if (record.blocked || record.pending || record.completed || video.ended || !record.source) return;
        applySpeed(record);
        if (record.blocked || !video.paused) return;
        record.pending = true;
        const source = record.source;
        Promise.resolve().then(() => {
            if (running && !destroyed && videos.get(video) === record && source === videoSource(video)) return video.play();
        }).catch(error => {
            if (destroyed || videos.get(video) !== record || source !== videoSource(video)) return;
            if (error.name !== 'AbortError') {
                record.blocked = true;
                log('播放被浏览器或播放器阻止，请手动播放一次，或点击重试。');
            }
        }).finally(() => { record.pending = false; });
    }

    function detachVideo(record) {
        for (const [event, listener] of record.listeners) record.element.removeEventListener(event, listener);
    }

    function questionType(node) {
        const text = (node.querySelector('.question-type-tag')?.textContent || '').toLowerCase();
        if (text.includes('单选题') || text.includes('multiple choice')) return 'single';
        if (text.includes('多选题') || text.includes('multiple response')) return 'multiple';
        if (text.includes('判断题') || text.includes('true/false')) return 'judge';
        if (text.includes('填空题') || text.includes('fill in the blank')) return 'blank';
        return null;
    }

    function questionNodes(root) {
        return [...root.querySelectorAll('.question-element-node')]
            .filter(node => !node.parentElement.closest('.question-element-node'))
            .map(node => node.querySelector('[id^="question"]'));
    }

    function quizCurrent(state) {
        return running && !destroyed && quizzes.get(state.root) === state && state.root.isConnected && state.page === pageKey();
    }

    function syncQuizzes() {
        const roots = [...document.querySelectorAll('.question-view')].filter(visible);
        for (const [root, state] of quizzes) {
            if (!roots.includes(root)) {
                cancelQuiz(state);
                quizzes.delete(root);
            }
        }
        for (const root of roots) {
            let state = quizzes.get(root);
            if (!state) {
                state = { root, page: currentPage, entries: new Map(), requests: new Set(), active: 0, submitted: false, graded: false, continued: false, readyAt: Date.now() + SCAN_DELAY };
                quizzes.set(root, state);
            }
            if ([...root.querySelectorAll('.limit-time-mask')].some(visible)) continue;
            const nodes = questionNodes(root);
            if (!nodes.length || nodes.some(node => !node)) continue;
            const finished = nodes.every(node => node.classList.contains('finished'));
            if (finished) {
                state.graded = true;
                if (nodes.every(node => node.classList.contains('right'))) continueVideo(state);
                continue;
            }
            if (state.graded) {
                cancelQuiz(state);
                state.entries.clear();
                state.submitted = false;
                state.graded = false;
                state.continued = false;
            }
            if (state.submitted) continue;
            for (const [node, entry] of state.entries) {
                if (!nodes.includes(node)) {
                    entry.cancel?.();
                    state.entries.delete(node);
                    state.readyAt = Date.now() + SCAN_DELAY;
                }
            }
            for (const node of nodes) {
                if (!state.entries.has(node)) {
                    const id = /^question(\d+)$/.exec(node.id)?.[1];
                    const type = questionType(node);
                    if (!id || !type) continue;
                    const selector = type === 'blank' ? 'input.blank-input' : type === 'judge' ? '.right-btn, .wrong-btn' : '.choice-item';
                    if (!node.querySelector(selector)) continue;
                    state.entries.set(node, { node, id, type, status: 'pending' });
                    state.readyAt = Date.now() + SCAN_DELAY;
                }
            }
            for (const entry of state.entries.values()) {
                // Apply queued responses only after the current page and blocking dialogs are checked.
                if (entry.status === 'ready') {
                    let applied = false;
                    try { applied = applyAnswer(entry, entry.answers); } catch { /* Keep submission blocked if controls changed. */ }
                    entry.status = applied ? 'answered' : 'failed';
                    if (!applied) log(`题目 ${entry.id}：答案与当前控件不匹配，已停止自动提交。`);
                    state.readyAt = Date.now() + SCAN_DELAY;
                    scheduleScan();
                }
                if (state.active >= 2) break;
                if (entry.status === 'pending') requestAnswers(state, entry);
            }
            if (Date.now() < state.readyAt || !nodes.every(node => state.entries.get(node)?.status === 'answered')) continue;
            const button = root.querySelector('.question-operation-area .btn-submit:not(.btn-video)');
            if (clickable(button)) {
                state.submitted = true;
                state.submittedAt = Date.now();
                button.click();
                log('题目已填写并提交，等待网站评判。');
            }
        }
    }

    function readCookie(name) {
        const item = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(name + '='));
        return item ? item.slice(name.length + 1) : '';
    }

    function requestAnswers(state, entry) {
        const parentId = /^page(\d+)$/.exec(document.querySelector('.page-name.active')?.closest('[id^="page"]')?.id || '')?.[1];
        if (!parentId) return;
        const auth = readCookie('token') || readCookie('AUTHORIZATION');
        if (!auth) {
            entry.status = 'failed';
            log('未找到课程登录凭据，请登录后点击重试。');
            return;
        }
        entry.status = 'loading';
        state.active++;
        let handle;
        let settled = false;
        const finish = (answers, error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            state.requests.delete(cancel);
            state.active--;
            if (!quizCurrent(state) || !state.root.contains(entry.node) || state.entries.get(entry.node) !== entry) return;
            if (!error && Array.isArray(answers) && answers.length > 0) {
                entry.answers = answers;
                entry.status = 'ready';
            } else {
                entry.status = 'failed';
                log(`题目 ${entry.id}：${error || '答案为空或题型数据不匹配'}，已停止自动提交。`);
            }
            scheduleScan();
        };
        const cancel = () => {
            finish(null, '请求已取消');
            handle?.abort();
        };
        const timeout = setTimeout(() => {
            finish(null, '请求超时');
            handle?.abort();
        }, 15000);
        state.requests.add(cancel);
        entry.cancel = cancel;
        try {
            handle = GM_xmlhttpRequest({
                method: 'GET',
                url: `https://ua.dgut.edu.cn/uaapi/questionAnswer/${encodeURIComponent(entry.id)}?parentId=${encodeURIComponent(parentId)}`,
                headers: { 'UA-AUTHORIZATION': auth, 'AUTHORIZATION': auth, 'X-Requested-With': 'XMLHttpRequest' },
                timeout: 15000,
                onload(response) {
                    if (response.status < 200 || response.status >= 300) {
                        finish(null, `接口返回 HTTP ${response.status}`);
                        return;
                    }
                    try {
                        finish(JSON.parse(response.responseText).correctAnswerList);
                    } catch {
                        finish(null, '响应格式错误');
                    }
                },
                onerror: () => finish(null, '网络请求失败'),
                ontimeout: () => finish(null, '请求超时'),
                onabort: () => finish(null, '请求已取消'),
            });
        } catch {
            finish(null, '无法调用脚本请求接口');
        }
    }

    function applyAnswer(entry, answers) {
        const { node, type } = entry;
        if (type === 'single' || type === 'multiple') {
            const wanted = new Set(answers.map(answer => String(answer).trim().toUpperCase()));
            if (type === 'single' && wanted.size !== 1) return false;
            const options = [...node.querySelectorAll('.choice-item')].map(item => ({
                item,
                letter: item.querySelector('.option')?.textContent.trim().replace(/[.．、:：)]$/, '').toUpperCase(),
            }));
            if ([...wanted].some(letter => !options.some(option => option.letter === letter))) return false;
            for (const { item, letter } of options) {
                const selected = item.classList.contains('selected') || !!item.querySelector('.checkbox.selected, input:checked');
                if ((wanted.has(letter) && !selected) || (type === 'multiple' && !wanted.has(letter) && selected)) item.click();
            }
            return true;
        }
        if (type === 'judge') {
            const answer = String(answers[0]).trim().toLowerCase();
            if (answers.length !== 1 || !['true', 'false'].includes(answer)) return false;
            const button = node.querySelector(answer === 'true' ? '.right-btn' : '.wrong-btn');
            if (!button) return false;
            if (!button.classList.contains('selected')) button.click();
            return true;
        }
        if (type === 'blank') {
            const inputs = [...node.querySelectorAll('input.blank-input')];
            if (inputs.length !== answers.length || answers.some(answer => typeof answer !== 'string')) return false;
            inputs.forEach((input, index) => {
                const alternatives = answers[index].split('//');
                let answer = alternatives.shift();
                while (answer.endsWith(':') && alternatives.length) answer += '//' + alternatives.shift();
                input.value = answer;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            });
            return true;
        }
        return false;
    }

    function cancelQuiz(state) {
        for (const cancel of [...state.requests]) cancel();
    }

    function continueVideo(state) {
        if (!state.root.closest('.video-question-modal') || state.continued) return;
        const button = state.root.querySelector('.question-operation-area .btn-video[data-bind*="continueVideo"]');
        if (clickable(button)) {
            state.continued = true;
            button.click();
            log('视频内测验已通过，继续播放。');
        }
    }

    function advanceChapter(modal) {
        if (navigatedPage !== currentPage || summaryContinued) return;
        const chapter = modal.querySelector('.stat-page.chapter-stat');
        if (!chapter?.classList.contains('complete')) {
            log('等待网站确认本章进度为 100%。');
            return;
        }
        const button = chapter.querySelector('.stat-next > button[data-bind="click: goNextPage"]');
        if (clickable(button)) {
            summaryContinued = true;
            button.click();
            log('网站已确认本章完成，进入下一章。');
        } else if (chapter.querySelector('button[data-bind="click: closeStatPage"]')) {
            log('已到达最后一章，完成情况请查看网站统计。');
        }
    }

    function advancePage() {
        if (navigatedPage === currentPage || pageKey() !== currentPage || Date.now() < advanceAfter) return;
        if ([...document.querySelectorAll('.video-question-modal')].some(visible)) return;
        const mainQuizzes = [...quizzes.values()].filter(state => !state.root.closest('.video-question-modal'));
        if (!videos.size && !mainQuizzes.length) {
            if (!textPageReady()) return;
        } else {
            textPage = null;
        }
        if ([...videos.values()].some(record => !record.completed && !record.element.ended)) return;
        if (mainQuizzes.some(state => {
            const nodes = questionNodes(state.root);
            return !nodes.length || nodes.some(node => !node?.classList.contains('finished') || !node.classList.contains('right'));
        })) return;
        const button = [...document.querySelectorAll('.next-page-btn, .mobile-next-page-btn, .next-btn, .btn-next, .nextVideoBtn')].find(clickable);
        if (!button) return;
        navigatedPage = currentPage;
        button.click();
        log(textPage ? '图文页已加载，已点击下一页。' : '当前页面任务已完成，已点击下一页。');
    }

    function textPageReady() {
        const reset = () => { textPage = null; return false; };
        if ([...document.querySelectorAll('.page-loader, .load-failed-page, .hide-page, .not-audition-page')].some(visible)) return reset();
        const wrapper = document.querySelector('#MathDiv.page-content > .page-wrapper');
        if (!visible(wrapper)) return reset();
        const elements = [...wrapper.querySelectorAll(':scope > .page-element')];
        if (!elements.length) return reset();

        // Image-text containers also host audio/Flash; unrendered components must keep the page waiting.
        const nonText = '.file-media, video, audio, iframe, object, embed, .audio-text, .video-element, .question-view, .question-element-node, [data-bbtype="video"], [data-bbtype="audio"], [data-bbtype="attachment"], [data-bind*="component:"]';
        const blocks = [];
        const contents = [];
        let hasContent = false;
        for (const element of elements) {
            const block = element.querySelector(':scope > .image-text');
            if (!element.id.startsWith('pageElement') || !visible(block) || element.matches(nonText) || element.querySelector(nonText)) return reset();
            blocks.push(block);
            const images = [...block.querySelectorAll('img[src]')].map(image => image.getAttribute('src')).filter(Boolean);
            const text = block.textContent.trim();
            if (text || images.length) hasContent = true;
            contents.push(JSON.stringify([text, images]));
        }
        if (!hasContent) return reset();

        if (!textPage || textPage.wrapper !== wrapper || blocks.length !== textPage.blocks.length
            || blocks.some((block, index) => block !== textPage.blocks[index] || contents[index] !== textPage.contents[index])) {
            textPage = { wrapper, blocks, contents, readyAt: Date.now() + TEXT_PAGE_DELAY };
            log('检测到图文页，等待内容加载稳定。');
            return false;
        }
        return Date.now() >= textPage.readyAt;
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        observer.disconnect();
        clearTimeout(scanTimer);
        clearInterval(recoveryTimer);
        clearTimeout(advanceTimer);
        for (const state of quizzes.values()) cancelQuiz(state);
        for (const record of videos.values()) detachVideo(record);
        quizzes.clear();
        videos.clear();
        window.removeEventListener('pagehide', destroy);
        panel.remove();
        if (window[INSTANCE]?.destroy === destroy) delete window[INSTANCE];
    }
})();
