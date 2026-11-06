/* 智能体侧栏：左边列出接入的智能体，右边显示谁在干活、谁空闲。 */

(function () {
    const LS_LEFT = 'agentPanelLeftOpen';
    const LS_RIGHT = 'agentPanelRightOpen';
    const POLL_MS = 5000;
    const STALE_SECONDS = 180;   // 超过这个时间没动静，就不再说「正在做」

    let latestStatus = null;
    let pollTimer = null;

    const colorOf = (name) => (typeof getColor === 'function' ? getColor(name) : '#888');
    const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? ''));
    const roleOf = (name) => (window._agentRoles && window._agentRoles[name]) || '';

    function panelEl(side) {
        return document.getElementById(side === 'left' ? 'agent-panel-left' : 'agent-panel-right');
    }

    function isOpen(side) {
        const el = panelEl(side);
        return !!el && !el.classList.contains('hidden');
    }

    function setOpen(side, open) {
        const el = panelEl(side);
        if (!el) return;
        el.classList.toggle('hidden', !open);
        const btn = document.getElementById(`agent-${side}-toggle`);
        if (btn) btn.classList.toggle('active', open);
        try {
            localStorage.setItem(side === 'left' ? LS_LEFT : LS_RIGHT, open ? '1' : '0');
        } catch (e) { /* 隐私模式忽略 */ }
    }

    window.toggleAgentPanel = function (side) {
        const open = !isOpen(side);
        setOpen(side, open);
        if (open) {
            renderAgentPanels(latestStatus);
            pullStatus();
        }
    };

    function agoText(sec) {
        if (sec === null || sec === undefined) return '未连接';
        if (sec < 60) return '刚刚还在';
        if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
        return `${Math.floor(sec / 3600)} 小时前`;
    }

    function stateOf(name, info, now) {
        if (!info.available) return 'offline';
        // 忙碌标记会随时间失效，避免一个卡住的 worker 永远显示「工作中」
        if (info.busy && (info.last_seen === null || info.last_seen < STALE_SECONDS)) return 'working';
        return 'idle';
    }

    function dot(state) {
        const cls = state === 'working' ? 'agent-dot working'
            : state === 'idle' ? 'agent-dot idle' : 'agent-dot offline';
        return `<span class="${cls}"></span>`;
    }

    function avatar(name, color) {
        const initial = esc((name || '?').slice(0, 1).toUpperCase());
        return `<span class="agent-avatar" style="background-color:${color}">${initial}</span>`;
    }

    function roleChip(name) {
        const role = roleOf(name);
        return role ? `<span class="agent-role">${esc(role)}</span>` : '';
    }

    function stateLabel(state) {
        if (state === 'working') return '<span class="agent-state working">工作中</span>';
        if (state === 'idle') return '<span class="agent-state idle">空闲</span>';
        return '<span class="agent-state offline">离线</span>';
    }

    // --- 左栏：接入的智能体一览 ---

    function renderLeft(entries) {
        const list = document.getElementById('agent-list-left');
        const count = document.getElementById('agent-count-left');
        if (!list) return;

        if (!entries.length) {
            list.innerHTML = '<div class="agent-empty">还没有智能体接入。<br>启动一个 CLI 启动器后，这里会出现它。</div>';
            if (count) count.textContent = '0';
            return;
        }

        const online = entries.filter((e) => e.info.available).length;
        if (count) count.textContent = `${online}/${entries.length}`;

        list.innerHTML = entries.map(({ name, info, state }) => `
            <div class="agent-row ${state}" title="@${esc(name)}">
                ${avatar(name, colorOf(name))}
                <div class="agent-row-main">
                    <div class="agent-row-top">
                        ${dot(state)}
                        <span class="agent-name" style="color:${colorOf(name)}">${esc(info.label || name)}</span>
                        ${roleChip(name)}
                    </div>
                    <div class="agent-row-sub">${stateLabel(state)}<span class="agent-seen">${agoText(info.last_seen)}</span></div>
                </div>
            </div>
        `).join('');
    }

    // --- 右栏：谁在做什么 ---

    function workDescription(info) {
        const bits = [];
        if (info.job_title) bits.push(`任务：${esc(info.job_title)}`);
        if (info.channel) bits.push(`在 #${esc(info.channel)}`);
        if (!bits.length && info.last_text) bits.push(esc(info.last_text));
        return bits.join(' · ');
    }

    function workRow(name, info, state) {
        const desc = workDescription(info);
        const last = info.last_time ? `<span class="agent-seen">${esc(info.last_time)}</span>` : '';
        return `
            <div class="agent-work-card ${state}" title="@${esc(name)}">
                <div class="agent-row-top">
                    ${dot(state)}
                    <span class="agent-name" style="color:${colorOf(name)}">${esc(info.label || name)}</span>
                    ${roleChip(name)}
                    ${last}
                </div>
                <div class="agent-work-desc">${desc || (state === 'working' ? '正在处理消息…' : '暂无最近的发言')}</div>
            </div>
        `;
    }

    function renderRight(entries) {
        const working = entries.filter((e) => e.state === 'working');
        const idle = entries.filter((e) => e.state === 'idle');
        const offline = entries.filter((e) => e.state === 'offline');

        const set = (id, countId, items, renderer) => {
            const el = document.getElementById(id);
            const c = document.getElementById(countId);
            if (c) c.textContent = String(items.length);
            if (!el) return;
            if (!items.length) {
                el.innerHTML = '<div class="agent-empty small">无</div>';
                return;
            }
            el.innerHTML = items.map(renderer).join('');
        };

        set('agent-list-working', 'agent-count-working', working, (e) => workRow(e.name, e.info, e.state));
        set('agent-list-idle', 'agent-count-idle', idle, (e) => workRow(e.name, e.info, e.state));
        set('agent-list-offline', 'agent-count-offline', offline, (e) => workRow(e.name, e.info, e.state));
    }

    window.renderAgentPanels = function (status) {
        if (status) latestStatus = status;
        if (!latestStatus) return;

        const entries = Object.entries(latestStatus)
            .filter(([name]) => name !== 'paused')
            .map(([name, info]) => ({ name, info: info || {}, state: stateOf(name, info || {}) }));

        // 没有状态数据的已注册智能体也列出来（离线）
        const known = new Set(entries.map((e) => e.name));
        for (const name of Object.keys(window.agentConfig || {})) {
            if (!known.has(name)) {
                entries.push({ name, info: { available: false, label: (window.agentConfig[name] || {}).label || name }, state: 'offline' });
            }
        }

        entries.sort((a, b) => {
            const rank = { working: 0, idle: 1, offline: 2 };
            if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
            return (a.info.label || a.name).localeCompare(b.info.label || b.name, 'zh-CN');
        });

        renderLeft(entries);
        renderRight(entries);
    };

    async function pullStatus() {
        try {
            const r = await fetch('/api/status', { headers: { 'X-Session-Token': window.SESSION_TOKEN || '' } });
            if (!r.ok) return;
            renderAgentPanels(await r.json());
        } catch (e) { /* 服务重启期间忽略 */ }
    }

    function startPolling() {
        if (pollTimer) return;
        pollTimer = setInterval(() => {
            if (isOpen('left') || isOpen('right')) pullStatus();
        }, POLL_MS);
    }

    function restore() {
        // 第一次打开时左栏默认展开，右栏先收起
        let left = true;
        let right = false;
        try {
            const l = localStorage.getItem(LS_LEFT);
            const r = localStorage.getItem(LS_RIGHT);
            if (l !== null) left = l === '1';
            if (r !== null) right = r === '1';
        } catch (e) { /* ignore */ }
        setOpen('left', left);
        setOpen('right', right);
    }

    document.addEventListener('DOMContentLoaded', () => {
        restore();
        pullStatus();
        startPolling();
    });
})();
