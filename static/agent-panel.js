/* 智能体侧栏：
   左：CLI 智能体清单 + 网页端增删改（写入 config.local.toml）
   右：工作台，按正在做 / 空闲 / 离线分组 */

(function () {
    const LS_LEFT = 'agentPanelLeftOpen';
    const LS_RIGHT = 'agentPanelRightOpen';
    const POLL_MS = 5000;
    const STALE_SECONDS = 180;

    let latestStatus = null;
    let cliData = { builtin: [], custom: [] };
    let editingName = null;          // 正在编辑的自定义 CLI（null = 新增）
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
            renderAll();
            pullAll();
        }
    };

    // --- 通用工具 ---

    function agoText(sec) {
        if (sec === null || sec === undefined) return '未连接';
        if (sec < 60) return '刚刚还在';
        if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
        return `${Math.floor(sec / 3600)} 小时前`;
    }

    function stateOf(info) {
        if (!info || !info.available) return 'offline';
        if (info.busy && (info.last_seen === null || info.last_seen < STALE_SECONDS)) return 'working';
        return 'idle';
    }

    function dot(state) {
        const cls = state === 'working' ? 'agent-dot working'
            : state === 'idle' ? 'agent-dot idle' : 'agent-dot offline';
        return `<span class="${cls}"></span>`;
    }

    function roleChip(name) {
        const role = roleOf(name);
        return role ? `<span class="agent-role">${esc(role)}</span>` : '';
    }

    // --- 左栏：CLI 清单与配置 ---

    function onlineNames() {
        const out = new Set();
        for (const [name, info] of Object.entries(latestStatus || {})) {
            if (name !== 'paused' && info && info.available) out.add(name);
        }
        return out;
    }

    function cliRow(item) {
        const online = (item.instances || []).map((i) => i.name);
        const running = online.length > 0;
        const state = running ? 'idle' : (item.available ? 'idle' : 'offline');
        const isApi = item.type === 'api';
        const installBadge = isApi
            ? '<span class="cli-badge api">API 接口</span>'
            : (item.available
                ? '<span class="cli-badge ok">已安装</span>'
                : '<span class="cli-badge bad">未安装</span>');
        const detail = isApi
            ? (item.model ? `${item.model}${item.base_url ? ' · ' + item.base_url : ''}` : '未配置接口地址')
            : (item.command || '（未设置命令）');
        const runBadge = running
            ? `<span class="cli-badge run">在线 ${online.length}</span>`
            : '';
        const actions = item.editable
            ? `<span class="cli-actions">
                 <button type="button" class="cli-icon-btn" title="编辑" onclick="editCliAgent('${esc(item.name)}')">&#9998;</button>
                 <button type="button" class="cli-icon-btn danger" title="删除" onclick="deleteCliAgent('${esc(item.name)}')">&times;</button>
               </span>`
            : '';

        return `
            <div class="cli-row" data-name="${esc(item.name)}">
                <div class="cli-row-main">
                    <div class="agent-row-top">
                        ${dot(state)}
                        <span class="agent-name" style="color:${esc(item.color)}">${esc(item.label)}</span>
                        ${runBadge}
                        ${actions}
                    </div>
                    <div class="cli-row-sub">
                        <code class="cli-cmd" title="${esc(detail)}">${esc(detail)}</code>
                        ${installBadge}
                    </div>
                </div>
            </div>
        `;
    }

    function renderLeft() {
        const builtinList = document.getElementById('cli-builtin-list');
        const customList = document.getElementById('cli-custom-list');
        if (!builtinList || !customList) return;

        const builtin = cliData.builtin || [];
        const custom = cliData.custom || [];

        document.getElementById('cli-builtin-count').textContent = String(builtin.length);
        document.getElementById('cli-custom-count').textContent = String(custom.length);

        builtinList.innerHTML = builtin.length
            ? builtin.map(cliRow).join('')
            : '<div class="agent-empty small">无</div>';
        customList.innerHTML = custom.length
            ? custom.map(cliRow).join('')
            : '<div class="agent-empty small">还没有自定义 CLI，点标题栏的 + 添加。</div>';

        const pathEl = document.getElementById('cli-config-path');
        if (pathEl) {
            pathEl.textContent = cliData.config_path ? `配置写入：${cliData.config_path}` : '';
            pathEl.title = cliData.config_path || '';
        }
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

    function renderRight() {
        const entries = Object.entries(latestStatus || {})
            .filter(([name]) => name !== 'paused')
            .map(([name, info]) => ({ name, info: info || {}, state: stateOf(info) }));

        const working = entries.filter((e) => e.state === 'working');
        const idle = entries.filter((e) => e.state === 'idle');
        const offline = entries.filter((e) => e.state === 'offline');

        const set = (id, countId, items, renderer) => {
            const el = document.getElementById(id);
            const c = document.getElementById(countId);
            if (c) c.textContent = String(items.length);
            if (!el) return;
            el.innerHTML = items.length
                ? items.map(renderer).join('')
                : '<div class="agent-empty small">无</div>';
        };

        set('agent-list-working', 'agent-count-working', working, (e) => workRow(e.name, e.info, e.state));
        set('agent-list-idle', 'agent-count-idle', idle, (e) => workRow(e.name, e.info, e.state));
        set('agent-list-offline', 'agent-count-offline', offline, (e) => workRow(e.name, e.info, e.state));
    }

    function renderAll() {
        renderLeft();
        renderRight();
    }

    // 兼容 chat.js 里状态刷新时调用
    window.renderAgentPanels = function (status) {
        if (status) latestStatus = status;
        renderRight();
    };

    // --- 请求 ---

    async function api(path, options = {}) {
        const headers = Object.assign(
            { 'X-Session-Token': window.SESSION_TOKEN || '' },
            options.body ? { 'Content-Type': 'application/json' } : {},
            options.headers || {}
        );
        const r = await fetch(path, Object.assign({}, options, { headers }));
        let data = null;
        try { data = await r.json(); } catch (e) { data = null; }
        if (!r.ok) throw new Error((data && data.error) || `请求失败 (${r.status})`);
        return data;
    }

    async function pullStatus() {
        try {
            latestStatus = await api('/api/status');
            renderRight();
        } catch (e) { /* 服务重启期间忽略 */ }
    }

    async function pullCli() {
        try {
            cliData = await api('/api/cli-agents');
            renderLeft();
        } catch (e) { /* ignore */ }
    }

    function pullAll() {
        pullStatus();
        pullCli();
    }

    // --- 表单 ---

    window.showCliForm = function (item) {
        const form = document.getElementById('cli-form');
        if (!form) return;
        editingName = item ? item.name : null;
        document.getElementById('cli-form-title').textContent = item ? '编辑 CLI' : '添加 CLI';
        document.getElementById('cli-name').value = item ? item.name : '';
        document.getElementById('cli-name').disabled = !!item;   // 改名等于新建，这里锁定
        document.getElementById('cli-command').value = item ? item.command : '';
        document.getElementById('cli-label').value = item ? item.label : '';
        document.getElementById('cli-cwd').value = item ? (item.cwd || '') : '';
        document.getElementById('cli-color').value = item ? (item.color || '#8b5cf6') : '#8b5cf6';
        document.getElementById('cli-form-error').textContent = '';
        form.classList.remove('hidden');
        document.getElementById('cli-command').focus();
    };

    window.hideCliForm = function () {
        const form = document.getElementById('cli-form');
        if (form) form.classList.add('hidden');
        editingName = null;
    };

    window.editCliAgent = function (name) {
        const item = (cliData.custom || []).find((c) => c.name === name);
        if (item) window.showCliForm(item);
    };

    window.saveCliAgent = async function (event) {
        event.preventDefault();
        const errEl = document.getElementById('cli-form-error');
        const payload = {
            name: document.getElementById('cli-name').value.trim().toLowerCase(),
            command: document.getElementById('cli-command').value.trim(),
            label: document.getElementById('cli-label').value.trim(),
            cwd: document.getElementById('cli-cwd').value.trim(),
            color: document.getElementById('cli-color').value,
        };
        try {
            await api('/api/cli-agents', { method: 'POST', body: JSON.stringify(payload) });
            window.hideCliForm();
            await pullCli();
            await pullStatus();
        } catch (e) {
            if (errEl) errEl.textContent = e.message;
        }
    };

    window.deleteCliAgent = async function (name) {
        if (!confirm(`删除 CLI「${name}」？\n这只会移除配置，正在运行的实例不受影响。`)) return;
        try {
            await api(`/api/cli-agents/${encodeURIComponent(name)}`, { method: 'DELETE' });
            await pullCli();
        } catch (e) {
            alert(e.message);
        }
    };

    // --- 启动 ---

    function restore() {
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
        pullAll();
        pollTimer = setInterval(() => {
            if (isOpen('left')) pullCli();
            if (isOpen('left') || isOpen('right')) pullStatus();
        }, POLL_MS);
    });

    // 别的客户端改了 CLI 配置时刷新
    window.refreshCliPanels = () => { pullCli(); pullStatus(); };
})();
