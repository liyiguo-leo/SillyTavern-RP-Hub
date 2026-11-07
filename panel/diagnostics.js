// SPDX-License-Identifier: AGPL-3.0-or-later
// panel/diagnostics.js —— 不需要控制台的诊断浮层（v2：移动端布局 + iframe RPC）
//
// 设计要点：
//   1. 布局自适应：宽度 min(460, 视口-16)，底边抬高避开输入框与宿主悬浮球；
//      长 URL / 长报错一律断行，不再横向溢出。
//   2. 当前卡与「卡内正则是否放行」由酒馆助手 iframe 通过 RPC 提供
//      （页面 realm 的 getContext() 在 TauriTavern 里可能是裁剪版）。
//   3. by-name 的 404 是正常探测，不计入失败（已由 fetch-shim 过滤）。
//   4. 卡库列表走 GET /cards，用来回答「卡到底有没有进本地库」。

const PANEL_ID = 'rphub-diagnostics-panel';
const BTN_ID = 'rphub-diagnostics-btn';
const DISABLE_KEY = 'rphub:no-diagnostics';

// 页面 realm 内直接用桥的写入函数做「测试写入」
import { fillInput, sendMessage } from './card-bridge.js';

let forwardedFailure = null;
let lastState = null;      // 来自 iframe 的 regex-state
let lastCards = null;      // GET /cards 结果
let modeInfo = null;       // { text, notInLibrary }
let autoState = null;      // { config, last } 来自 iframe 的 auto-get
let frameInfo = null;      // 页面里的 iframe 概况（卡内前端就在这些 iframe 里）
/** iframe 消息环形记录（安卓端没有控制台，全部进面板） */
const cardMessages = [];
const CARD_MESSAGE_LIMIT = 40;

function pushCardMessage(entry) {
    cardMessages.push({ at: new Date().toLocaleTimeString(), ...entry });
    while (cardMessages.length > CARD_MESSAGE_LIMIT) cardMessages.shift();
    const panel = document.getElementById(PANEL_ID);
    if (panel && panel.style.display !== 'none' && typeof window.__rphubRenderDiagnostics === 'function') {
        window.__rphubRenderDiagnostics();
    }
}

const pendingRpc = new Map();

/* ------------------------------ 工具 ------------------------------ */

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function backend() {
    try { return window.__rphubLocalBackend__ ?? null; } catch { return null; }
}

/** 页面里的 iframe 统计：能不能读到 document 决定我们能否注入诊断 */
function scanFrames() {
    try {
        const frames = Array.from(window.frames || []);
        let sameOrigin = 0;
        for (const frame of frames) {
            try { if (frame.document) sameOrigin++; } catch { /* 跨源 */ }
        }
        return { total: frames.length, sameOrigin };
    } catch {
        return null;
    }
}

/** 拉宿主日志并写进面板（安卓没有控制台，这一步是唯一信息源） */
async function renderHostLogs(box) {
    if (!box) return;
    box.textContent = '读取宿主日志…';
    try {
        const dev = await (window.__TAURITAVERN__?.ready ?? window.__TAURITAVERN_MAIN_READY__).then(() => window.__TAURITAVERN__?.api?.dev);
        if (!dev?.frontendLogs?.list) { box.textContent = '当前宿主没有 frontendLogs API（非 TT 或无调试 API）'; return; }
        const entries = await dev.frontendLogs.list({ limit: 300 });
        const picked = (entries || [])
            .filter((e) => String(e.message || '').includes('rphub')
                || e.level === 'error' || e.level === 'warn')
            .slice(-60);
        box.innerHTML = picked.length
            ? picked.map((e) => `<div style="white-space:pre-wrap;margin-bottom:2px">[${esc(e.level)}] ${esc(e.message)}</div>`).join('')
            : '宿主日志里没有 warn/error 或 rphub 条目';
    } catch (e) {
        box.textContent = `读取失败：${e?.message || e}`;
    }
}

/** 「上次自动处理」的人话摘要 */
function autoText(last) {
    if (!last) return '尚未执行';
    const bits = [];
    if (last.mode) bits.push(`模式=${last.mode}`);
    if (Array.isArray(last.actions) && last.actions.length) bits.push(last.actions.join(' + '));
    else if (last.skipped) bits.push(`跳过：${last.skipped}`);
    if (last.error) bits.push(`错误：${last.error}`);
    if (last.worldbookError) bits.push(`世界书失败：${last.worldbookError}`);
    return `上次：${bits.join(' · ') || '无动作'}`;
}

function toast(message) {
    try {
        if (typeof window.toastr !== 'undefined') { window.toastr.info(message, 'RP-Hub'); return; }
    } catch { /* 忽略 */ }
    console.info('[rphub]', message);
}

/** 向所有子 frame 广播（酒馆助手 iframe 在里面） */
function broadcast(message) {
    try {
        const frames = window.frames || [];
        for (let i = 0; i < frames.length; i++) {
            try { frames[i].postMessage(message, '*'); } catch { /* 单个失败忽略 */ }
        }
    } catch { /* 忽略 */ }
}

/** 调 iframe 的 RPC；超时返回 null（表示没有 iframe 接） */
function rpc(method, params = {}, timeoutMs = 1500) {
    return new Promise((resolve) => {
        const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        pendingRpc.set(id, resolve);
        broadcast({ type: 'rphub:rpc', id, method, params });
        setTimeout(() => {
            if (pendingRpc.delete(id)) resolve(null);
        }, timeoutMs);
    });
}

try {
    window.addEventListener('message', (event) => {
        const data = event?.data;
        if (!data || typeof data !== 'object') return;

        if (data.type === 'rphub:rpc:result') {
            const done = pendingRpc.get(data.id);
            if (done) { pendingRpc.delete(data.id); done({ result: data.result ?? null, error: data.error ?? null }); }
            return;
        }

        if (data.type === 'rphub:failure') {
            forwardedFailure = { ...data.payload, from: 'tavern-helper-iframe', at: new Date().toISOString() };
            try {
                if (typeof window.toastr !== 'undefined' && forwardedFailure?.status >= 400) {
                    const code = forwardedFailure?.body?.error?.code || '';
                    window.toastr.error(`卡处理失败：${forwardedFailure.status} ${code}`, 'RP-Hub', { timeOut: 10000 });
                }
            } catch { /* 忽略 */ }
            try { window.__rphubShowDiagnostics?.(); } catch { /* 忽略 */ }
            if (typeof window.__rphubRenderDiagnostics === 'function') window.__rphubRenderDiagnostics();
            return;
        }

        // 其余消息：可能是卡内前端发给宿主的交互指令（填输入框/发送等）
        const tracing = !!window.__rphubTraceMessages;
        const panel = document.getElementById(PANEL_ID);
        const panelOpen = !!panel && panel.style.display !== 'none';
        if (!tracing && !panelOpen) return;
        const keys = Object.keys(data).slice(0, 8);
        const previewText = ['text', 'content', 'value', 'message', 'prompt']
            .map((k) => (typeof data[k] === 'string' ? data[k] : null))
            .find(Boolean) || '';
        pushCardMessage({
            kind: 'iframe',
            type: String(data.type ?? data.action ?? data.event ?? data.command ?? '(无 type)'),
            keys,
            preview: previewText.slice(0, 60),
        });
    });

    // 卡内消息桥的处理结果也进面板（安卓看不到 console）
    window.addEventListener('rphub:card-bridge', (event) => {
        const d = event?.detail || {};
        pushCardMessage({ kind: 'bridge', type: d.type || '(bridge)', keys: [], preview: String(d.text || '').slice(0, 60), ok: d.ok, sent: d.sent });
    });
} catch { /* 忽略 */ }

/**
 * 彻底移除诊断浮层（并记住下次不再挂载）。
 * 用途：排查「面板点不动」时，用来排除是不是浮层挡住/抢了点击。
 */
export function disableDiagnostics() {
    try { document.getElementById(BTN_ID)?.remove(); } catch { /* 忽略 */ }
    try { document.getElementById(PANEL_ID)?.remove(); } catch { /* 忽略 */ }
    try { localStorage.setItem(DISABLE_KEY, '1'); } catch { /* 忽略 */ }
    console.info('[rphub] 诊断浮层已移除，并会在下次启动时跳过挂载（清除 localStorage 的 rphub:no-diagnostics 可恢复）');
}

/** 诊断是否被用户关闭 */
export function isDiagnosticsDisabled() {
    try {
        if (/[?&]rphub=nopanel\b/.test(location.search)) return true;
        return localStorage.getItem(DISABLE_KEY) === '1';
    } catch {
        return false;
    }
}

/**
 * 下一次点击的「最上层元素栈」，用来找出是谁在拦截点击。
 * 返回 Promise<{target, stack}>：stack[0] 就是点击落到的元素。
 */
export function probeNextClick(timeoutMs = 20000) {
    return new Promise((resolve) => {
        const handler = (event) => {
            cleanup();
            const stack = (() => {
                try {
                    return (document.elementsFromPoint?.(event.clientX, event.clientY) || [])
                        .slice(0, 6)
                        .map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.split(/\s+/).slice(0, 2).join('.')}` : ''}`);
                } catch {
                    return [];
                }
            })();
            const result = { target: event.target, stack, x: event.clientX, y: event.clientY };
            console.info('[rphub] 点击落点最上层元素：', stack, event.target);
            resolve(result);
        };
        const timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
        const cleanup = () => {
            clearTimeout(timer);
            document.removeEventListener('click', handler, true);
            document.removeEventListener('pointerdown', handler, true);
        };
        document.addEventListener('click', handler, true);
        document.addEventListener('pointerdown', handler, true);
        console.info('[rphub] 已挂上点击探针：点一下你点不动的那个控件');
    });
}

/**
 * 追踪 iframe 之间的 postMessage（排查「卡内按钮点了没反应」）。
 * 很多卡的前端界面是向宿主发消息来实现「填充输入框 / 发送」的，
 * ST/TT 里没有 RP-Hub 那个宿主，消息就石沉大海。开这个开关能看到真实协议。
 */
export function traceIframeMessages(enable = true) {
    const KEY = '__rphubTraceMessages';
    if (!window[KEY]) {
        window[KEY] = true;
        window.addEventListener('message', (event) => {
            if (!window[KEY]) return;
            const data = event?.data;
            const summary = (() => {
                try {
                    if (data == null) return String(data);
                    if (typeof data !== 'object') return String(data).slice(0, 200);
                    return `${data.type ?? '(no type)'} :: ${JSON.stringify(data).slice(0, 400)}`;
                } catch { return '(无法序列化)'; }
            })();
            console.info('[rphub:trace] iframe message ←', summary, 'source=', event?.origin);
        });
        console.info('[rphub:trace] 已开始记录 iframe 消息：现在点一下卡里没反应的按钮，然后把 [rphub:trace] 行发我。');
    }
    window[KEY] = !!enable;
    if (!enable) console.info('[rphub:trace] 已关闭');
    return window[KEY];
}

/** 汇总诊断（复制/报告用） */export function collectReport(extra = {}) {
    const be = backend();
    const recent = typeof be?.recent === 'function' ? be.recent() : [];
    const failure = (typeof be?.lastFailure === 'function' ? be.lastFailure() : null) || forwardedFailure;
    return {
        at: new Date().toISOString(),
        extension: extra.version ? { version: extra.version } : undefined,
        backend: be ? { mode: be.mode, base: be.base, version: be.version } : null,
        host: {
            href: (() => { try { return location.href; } catch { return null; } })(),
            viewport: (() => { try { return { w: window.innerWidth, h: window.innerHeight }; } catch { return null; } })(),
            hasSillyTavern: (() => { try { return typeof SillyTavern !== 'undefined'; } catch { return false; } })(),
            hasTavernHelper: (() => { try { return !!window.TavernHelper; } catch { return false; } })(),
            hasTauriTavernDev: (() => { try { return !!window.__TAURITAVERN__?.api?.dev; } catch { return false; } })(),
        },
        currentCharacter: lastState,
        library: lastCards ? { count: lastCards.count, names: (lastCards.cards || []).slice(0, 10).map((c) => c.characterName) } : null,
        lastFailure: failure,
        recentRequests: recent,
        cardMessages: cardMessages.slice(-20),
    };
}

export function reportText(extra = {}) {
    return JSON.stringify(collectReport(extra), null, 2);
}

async function copyText(text) {
    try {
        if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
    } catch { /* 落到 execCommand */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    } catch {
        return false;
    }
}

/* ------------------------------ 渲染 ------------------------------ */

function layout(panel, btn) {
    const vw = Math.max(320, window.innerWidth || 360);
    const vh = Math.max(420, window.innerHeight || 640);
    const width = Math.min(460, vw - 16);

    Object.assign(btn.style, {
        right: '8px',
        bottom: '76px',          // 抬高，避开输入框与宿主悬浮球
    });
    Object.assign(panel.style, {
        width: `${width}px`,
        right: '8px',
        left: 'auto',
        bottom: '116px',
        maxHeight: `${Math.round(vh * 0.62)}px`,
    });
}

function renderPanel(panel, extra) {
    const report = collectReport(extra);
    const f = report.lastFailure;
    const state = lastState;
    const cards = lastCards;

    const recentRows = report.recentRequests.map((r) => (
        `<tr><td style="white-space:nowrap">${new Date(r.at).toLocaleTimeString()}</td>`
        + `<td style="word-break:break-all">${esc(r.method)} ${esc(r.path)}</td>`
        + `<td style="color:${r.status >= 400 ? '#c22' : '#1f8a4c'};white-space:nowrap">${r.status}</td>`
        + `<td style="white-space:nowrap">${r.byteLength}B</td></tr>`
    )).join('');

    const allowedText = state?.allowed === null || state?.allowed === undefined
        ? (state ? '未知' : '未知（未取到酒馆上下文）')
        : (state.allowed ? '已允许' : '未允许');
    const allowedColor = state?.allowed ? '#1f8a4c' : '#c22';

    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px">
        <strong style="font-size:13px">RP-Hub 诊断</strong>
        <span style="font-size:11px;opacity:.65">${esc(extra.version || '')}</span>
        <span style="flex:1"></span>
        <button data-act="copy" style="font-size:11px;padding:2px 6px">复制</button>
        <button data-act="logs" style="font-size:11px;padding:2px 6px">宿主日志</button>
        <button data-act="close" style="font-size:11px;padding:2px 6px">收起</button>
      </div>

      <div style="font-size:11px;line-height:1.6;margin-bottom:6px;word-break:break-all">
        后端：<b>${esc(report.backend?.mode ?? '未安装')}</b>${report.backend?.base ? `<br><span style="opacity:.7">${esc(report.backend.base)}</span>` : ''}<br>
        宿主：ST=${report.host.hasSillyTavern ? '✓' : '✗'} · 酒馆助手=${report.host.hasTavernHelper ? '✓' : '✗'} · TT调试API=${report.host.hasTauriTavernDev ? '✓' : '✗'}
        ${frameInfo ? `<br>页面 iframe：${frameInfo.total} 个（同源可读 ${frameInfo.sameOrigin} 个）` : ''}
      </div>

      <div style="font-size:11px;background:#f7f4ff;border:1px solid #d9d2f0;border-radius:6px;padding:6px;margin-bottom:6px">
        <b>自动化（免手动）</b>
        <div style="margin-top:3px;display:flex;flex-direction:column;gap:2px">
          <label><input type="checkbox" data-auto="regex" ${autoState?.config?.regex !== false ? 'checked' : ''}> 自动放行卡内正则（scoped）</label>
          <label><input type="checkbox" data-auto="worldbook" ${autoState?.config?.worldbook !== false ? 'checked' : ''}> 自动落地并绑定卡内世界书</label>
        </div>
        <div style="margin-top:4px;display:flex;gap:6px;align-items:center">
          <button data-act="auto-run" style="font-size:11px;padding:1px 8px">立即执行一次</button>
          <span style="opacity:.72">${esc(autoText(autoState?.last))}</span>
        </div>
      </div>

      <div style="font-size:11px;background:#f2f6ff;border:1px solid #ccd9f2;border-radius:6px;padding:6px;margin-bottom:6px;word-break:break-all">
        <b>当前卡</b>：${esc(state?.name ?? '未知')}${state?.avatar ? `<br><span style="opacity:.7">${esc(state.avatar)}</span>` : ''}
        ${state ? `<br><span style="opacity:.7">解析途径：${esc(state.resolvedVia || '?')} · 角色数：${esc(state.characterCount ?? '?')} · 酒馆助手：${state.hasTavernHelper ? '✓' : '✗'}</span>` : ''}<br>
        <b>正则引擎模式</b>：<span data-role="mode">${esc(modeInfo?.text ?? '查询中…')}</span><br>
        <b>识别来源</b>：自动判定=${esc(modeInfo?.auto ?? '?')} · 手动标记=${modeInfo?.marked ? '有' : '无'}<br>
        <b>卡内正则（scoped）</b>：<b style="color:${allowedColor}">${esc(allowedText)}</b>
        <div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap">
          <button data-act="allow" style="font-size:11px;padding:1px 8px">允许</button>
          <button data-act="deny" style="font-size:11px;padding:1px 8px">撤销</button>
          ${modeInfo?.cardId ? '<button data-act="inspect" style="font-size:11px;padding:1px 8px">卡面体检</button>' : ''}
          ${modeInfo?.cardId ? '<button data-act="install-lorebook" style="font-size:11px;padding:1px 8px">导入卡面世界书</button>' : ''}
          ${modeInfo?.marked ? '<button data-act="unmark" style="font-size:11px;padding:1px 8px">取消标记</button>' : ''}
          ${modeInfo?.notInLibrary ? '<button data-act="mark-rp" style="font-size:11px;padding:1px 8px">手动标记为 RP</button>' : ''}
        </div>
        <div style="opacity:.72;margin-top:4px">只能有一个正则引擎：请关闭酒馆内置「正则」扩展后，再在这里放行本卡。</div>
        <div data-role="inspect" style="margin-top:4px"></div>
        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
          <button data-act="card-scripts" style="font-size:11px;padding:1px 8px">抓卡内脚本</button>
          <button data-act="trace-msg" style="font-size:11px;padding:1px 8px">追踪 iframe 消息</button>
          <button data-act="test-input" style="font-size:11px;padding:1px 8px">测试写入</button>
        </div>
        <div data-role="scripts" style="margin-top:4px;max-height:190px;overflow:auto"></div>
      </div>

      <div style="font-size:11px;margin-bottom:6px">
        <b>卡内消息（最近 ${cardMessages.length}）</b>
        <div style="max-height:120px;overflow:auto;font-size:10px;margin-top:2px">
          ${cardMessages.slice(-8).map((m) => `<div style="word-break:break-all"><span style="opacity:.55">${esc(m.at)}</span> [${esc(m.kind)}] ${esc(m.type)}${m.preview ? ` · ${esc(m.preview)}` : ''}${m.ok === false ? ' · 写入失败' : ''}${m.sent ? ' · 已发送' : ''}</div>`).join('')
            || '<div style="opacity:.6">暂无。点下面「追踪 iframe 消息」，再操作卡里的按钮，这里就会出现。</div>'}
        </div>
      </div>

      <div style="font-size:11px;margin-bottom:6px;word-break:break-all">
        <b>本地卡库</b>：${cards ? `${cards.count} 张` : '读取中…'}
        ${cards && cards.cards?.length ? `<div style="opacity:.75;margin-top:2px">${cards.cards.slice(0, 4).map((c) => esc(c.characterName || '(无名)')).join(' · ')}${cards.count > 4 ? ' …' : ''}</div>` : ''}
      </div>

      ${f ? `<div style="font-size:11px;background:#fff3f3;border:1px solid #f3c9c9;border-radius:6px;padding:6px;margin-bottom:6px;word-break:break-all">
        <b>最近失败</b>：${esc(f.method)} <span style="opacity:.8">${esc(f.path)}</span> → <b style="color:#c22">${f.status}</b> ${esc(f.body?.error?.code || f.code || '')}<br>
        ${esc(f.body?.error?.message || f.message || '')}<br>
        体积 ${f.byteLength ?? 0}B · 前 16 字节 <code>${esc(f.headHex || '(空)')}</code>
        ${f.hint ? `<br>提示：${esc(f.hint)}` : ''}
      </div>` : '<div style="font-size:11px;margin-bottom:6px;opacity:.75">最近失败：无</div>'}

      <div style="font-size:11px;max-height:132px;overflow:auto">
        ${recentRows
            ? `<table style="width:100%;border-collapse:collapse;font-size:11px">
                 <thead><tr><th align="left">时间</th><th align="left">接口</th><th align="left">码</th><th align="left">体积</th></tr></thead>
                 <tbody>${recentRows}</tbody></table>`
            : '<div style="opacity:.7">本页暂无请求记录（请求可能发生在酒馆助手 iframe 里，那属正常）</div>'}
      </div>
      <div data-role="logs" style="font-size:11px;max-height:120px;overflow:auto;margin-top:6px;word-break:break-all"></div>
    `;

    panel.querySelector('[data-act="close"]').addEventListener('click', () => { panel.style.display = 'none'; });

    panel.querySelector('[data-act="copy"]').addEventListener('click', async () => {
        const ok = await copyText(reportText(extra));
        toast(ok ? '诊断报告已复制' : '复制失败：请手动抄写');
    });

    panel.querySelector('[data-act="logs"]').addEventListener('click', () => {
        void renderHostLogs(panel.querySelector('[data-role="logs"]'));
    });

    panel.querySelector('[data-act="allow"]').addEventListener('click', async () => {
        const res = await rpc('regex-set', { allow: true });
        if (!res || res.error || !res.result?.ok) { toast(`放行失败：${res?.error || res?.result?.reason || '酒馆助手未响应'}`); return; }
        toast('已允许本卡内嵌正则；重新打开聊天后生效');
        await refresh(panel, extra);
    });

    panel.querySelector('[data-act="deny"]').addEventListener('click', async () => {
        const res = await rpc('regex-set', { allow: false });
        if (!res || res.error || !res.result?.ok) { toast(`撤销失败：${res?.error || res?.result?.reason || '酒馆助手未响应'}`); return; }
        toast('已撤销本卡内嵌正则的允许');
        await refresh(panel, extra);
    });

    // 卡不在本地库时的兜底：按「当前卡头像」的哈希写一条 rphub 标记（与 rp-mode 的探测口径一致）
    const markBtn = panel.querySelector('[data-act="mark-rp"]');
    if (markBtn) {
        markBtn.addEventListener('click', async () => {
            const be = backend();
            const avatar = lastState?.avatar;
            if (!be?.base || !avatar) { toast('缺少卡信息，无法标记'); return; }
            try {
                const res = await fetch(`/characters/${encodeURIComponent(avatar)}`);
                if (!res.ok) throw new Error(`读取卡图失败 HTTP ${res.status}`);
                const bytes = new Uint8Array(await res.arrayBuffer());
                const { sha256HexBytes } = await import('../local/sha256.js');
                const hash = sha256HexBytes(bytes);
                const put = await fetch(`${be.base}/marks/${hash}`, {
                    method: 'PUT',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ type: 'rphub' }),
                });
                if (!put.ok) throw new Error(`写入标记失败 HTTP ${put.status}`);
                try { window.__rphub__?.clearModeCache?.(); } catch { /* 忽略 */ }
                toast('已按当前卡标记为 RP；重新打开聊天后按 RP 语义渲染');
                await refresh(panel, extra);
            } catch (e) {
                toast(`标记失败：${e?.message || e}`);
            }
        });
    }

    // 卡面体检：把本地库真正存下来的东西摊开（回答「为什么识别成普通卡 / 为什么没有模板」）
    const inspectBtn = panel.querySelector('[data-act="inspect"]');
    if (inspectBtn) {
        inspectBtn.addEventListener('click', async () => {
            const be = backend();
            const cardId = modeInfo?.cardId;
            const box = panel.querySelector('[data-role="inspect"]');
            if (!be?.base || !cardId || !box) return;
            box.textContent = '体检中…';
            try {
                const res = await fetch(`${be.base}/cards/${cardId}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                const extKeys = Object.keys(data.character?.extensions || {});
                const rpKeys = extKeys.filter((k) => k.startsWith('rp_hub') || k === 'ui_templates' || k === 'rp_hub_watermark');
                const ui = data.variables?.uiTemplates?.length ?? 0;
                const runtime = data.variables?.runtimeByCharacter != null;
                box.innerHTML = `<div style="background:#fff;border:1px dashed #bbb;border-radius:6px;padding:6px;margin-top:4px">
                  formatDetail=<b>${esc(data.formatDetail)}</b><br>
                  regex=${(data.regex || []).length} · lorebook=${(data.lorebook || []).length} · uiTemplates=<b>${ui}</b> · runtimeByCharacter=${runtime ? '有' : '无'}<br>
                  extensions：${extKeys.length ? esc(extKeys.slice(0, 10).join(', ')) : '（无）'}<br>
                  RP-Hub 特征字段：${rpKeys.length ? esc(rpKeys.join(', ')) : '（无 → 上游会判为普通 ST 卡）'}
                </div>`;

                // 世界书现状：存在哪些书、当前卡绑的是哪本（RP助手 注入依赖 primary）
                const wb = await rpc('worldbooks');
                if (wb?.result) {
                    const names = Array.isArray(wb.result.names) ? wb.result.names : [];
                    const bound = wb.result.bound || null;
                    box.insertAdjacentHTML('beforeend', `<div style="background:#fff;border:1px dashed #bbb;border-radius:6px;padding:6px;margin-top:4px">
                      世界书：${names.length} 本${names.length ? `<br><span style="opacity:.75">${esc(names.slice(0, 6).join(' · '))}${names.length > 6 ? ' …' : ''}</span>` : ''}<br>
                      当前卡绑定：primary=<b>${esc(bound?.primary ?? '（无）')}</b> · additional=${(bound?.additional || []).length}
                    </div>`);
                }

                // 重复世界书检测（内容指纹相同的多本 → 一键清理，保留已绑定的那本）
                const dup = await rpc('worldbook-duplicates', {}, 30000);
                const groups = Array.isArray(dup?.result?.duplicates) ? dup.result.duplicates : [];
                if (groups.length > 0) {
                    const boundPrimary = dup.result.boundPrimary || null;
                    box.insertAdjacentHTML('beforeend', `<div style="background:#fff8f0;border:1px solid #f0d3b0;border-radius:6px;padding:6px;margin-top:4px">
                      <b>重复世界书</b>：${groups.length} 组
                      <div style="opacity:.8;margin-top:2px">${groups.map((g) => esc(g.join('  /  '))).join('<br>')}</div>
                      <button data-act="dedupe-worldbooks" style="font-size:11px;padding:1px 8px;margin-top:4px">保留绑定的那本，删除其余</button>
                    </div>`);
                    box.querySelector('[data-act="dedupe-worldbooks"]').addEventListener('click', async () => {
                        const toDelete = [];
                        for (const group of groups) {
                            const keep = group.includes(boundPrimary) ? boundPrimary : group[0];
                            toDelete.push(...group.filter((n) => n !== keep));
                        }
                        if (toDelete.length === 0) { toast('没有可删除的重复项（都绑着呢）'); return; }
                        const result = await rpc('worldbook-delete', { names: toDelete }, 30000);
                        if (result?.error) { toast(`清理失败：${result.error}`); return; }
                        const done = result?.result?.deleted?.length ?? 0;
                        const skipped = result?.result?.skipped?.length ?? 0;
                        toast(`已删除 ${done} 本重复世界书${skipped ? `，跳过 ${skipped} 本（正在使用）` : ''}`);
                        await refresh(panel, extra);
                    });
                }
            } catch (e) {
                box.textContent = `体检失败：${e?.message || e}`;
            }
        });
    }

    // 取消标记
    const unmarkBtn = panel.querySelector('[data-act="unmark"]');
    if (unmarkBtn) {
        unmarkBtn.addEventListener('click', async () => {
            const be = backend();
            const hash = modeInfo?.contentHash;
            if (!be?.base || !hash) { toast('缺少 contentHash，无法取消标记'); return; }
            try {
                const res = await fetch(`${be.base}/marks/${hash}`, { method: 'DELETE' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                try { window.__rphub__?.clearModeCache?.(); } catch { /* 忽略 */ }
                toast('已取消 RP 标记');
                await refresh(panel, extra);
            } catch (e) {
                toast(`取消标记失败：${e?.message || e}`);
            }
        });
    }

    // 自动化开关 + 立即执行
    panel.querySelectorAll('input[data-auto]').forEach((el) => {
        el.addEventListener('change', async () => {
            const patch = {};
            patch[el.dataset.auto] = el.checked;
            const res = await rpc('auto-set', patch, 25000);
            if (res?.result?.config) autoState = res.result;
            await refresh(panel, extra);
        });
    });
    const autoRunBtn = panel.querySelector('[data-act="auto-run"]');
    if (autoRunBtn) {
        autoRunBtn.addEventListener('click', async () => {
            const res = await rpc('auto-run', {}, 30000);
            await refresh(panel, extra);
            const last = res?.result;
            if (res?.error) toast(`自动处理失败：${res.error}`);
            else if (last?.actions?.length) toast(`已自动处理：${last.actions.join(' / ')}`);
            else toast(last?.skipped ? `无需处理（${last.skipped}）` : '自动处理完成，无动作');
        });
    }

    // 测试写入：验证「我们的写入路径」在宿主里能不能落到输入框（与卡无关）
    const testBtn = panel.querySelector('[data-act="test-input"]');
    if (testBtn) {
        testBtn.addEventListener('click', () => {
            const probe = `RP-Hub 测试写入 ${new Date().toLocaleTimeString()}`;
            const result = fillInput(probe);
            pushCardMessage({
                kind: result.ok ? 'bridge-test' : 'bridge-test-fail',
                type: result.selector ? `selector=${result.selector}` : 'no-input-found',
                keys: [],
                preview: probe,
                ok: result.ok,
            });
            toast(result.ok ? `已写入输入框（${result.selector}）` : '没找到可写入的输入框');
        });
    }

    // 抓卡内脚本：看清按钮到底调用了什么（postMessage / triggerSlash / parent.document / TavernHelper）
    const scriptsBtn = panel.querySelector('[data-act="card-scripts"]');
    if (scriptsBtn) {
        scriptsBtn.addEventListener('click', async () => {
            const box = panel.querySelector('[data-role="scripts"]');
            box.textContent = '抓取中…';
            try {
                const res = await rpc('card-scripts', {}, 20000);
                if (res?.error || !res?.result) { box.textContent = `抓取失败：${res?.error || '酒馆助手未响应'}`; return; }
                const data = res.result;
                window.__rphubCardScripts = data;
                const patterns = [
                    { label: 'postMessage', re: /postMessage\s*\(/g },
                    { label: 'send_textarea', re: /send_textarea/g },
                    { label: 'triggerSlash', re: /triggerSlash/g },
                    { label: 'parent.', re: /parent\./g },
                    { label: 'TavernHelper.', re: /TavernHelper\./g },
                    { label: 'insertOrReplace', re: /insertOrReplace/gi },
                ];
                const rows = (data.scripts || []).map((s) => {
                    const hits = patterns
                        .map((p) => { const n = (s.content.match(p.re) || []).length; return n ? `${p.label}×${n}` : null; })
                        .filter(Boolean).join(' · ');
                    return `<div style="margin-bottom:2px"><b>${esc(s.name)}</b> (${s.length}B)${hits ? `<br><span style="color:#c60">${esc(hits)}</span>` : ''}</div>`;
                }).join('');
                box.innerHTML = `<div style="background:#fff;border:1px dashed #bbb;border-radius:6px;padding:6px">
                  extensions：${esc((data.extKeys || []).join(', ') || '（无）')}<br>
                  tavern_helper 键：${esc((data.thKeys || []).join(', ') || '（无）')} · 脚本 ${data.scriptCount ?? 0} 条
                  <div style="margin-top:4px">${rows || '（卡内没有酒馆助手脚本）'}</div>
                  <div style="opacity:.7;margin-top:4px">完整内容已放到 window.__rphubCardScripts，可执行 copy(JSON.stringify(__rphubCardScripts)) 复制</div>
                </div>`;
            } catch (e) {
                box.textContent = `抓取失败：${e?.message || e}`;
            }
        });
    }

    // 追踪 iframe 消息：很多卡的前端是「向宿主发消息」来填输入框/发送的，这里能看到真实协议
    const traceBtn = panel.querySelector('[data-act="trace-msg"]');
    if (traceBtn) {
        traceBtn.addEventListener('click', () => {
            traceIframeMessages(true);
            toast('已开始记录 iframe 消息：请点一下卡里没反应的按钮，然后把 [rphub:trace] 行发我');
        });
    }

    // 导入卡面世界书：卡内 character_book 在酒馆里不会自动变成世界书文件，这里补上并绑定到当前卡
    const loreBtn = panel.querySelector('[data-act="install-lorebook"]');
    if (loreBtn) {
        loreBtn.addEventListener('click', async () => {
            const be = backend();
            const cardId = modeInfo?.cardId;
            if (!be?.base || !cardId) { toast('没有可用的卡记录'); return; }
            try {
                const res = await fetch(`${be.base}/cards/${cardId}/lorebook`);
                if (!res.ok) throw new Error(`读取世界书失败 HTTP ${res.status}`);
                const data = await res.json();
                const entries = Array.isArray(data.lorebook) ? data.lorebook : [];
                if (entries.length === 0) { toast('这张卡没有卡内世界书条目'); return; }
                const out = await rpc('install-lorebook', { entries }, 30000);
                if (!out || out.error) throw new Error(out?.error || '酒馆助手未响应');
                const r = out.result || {};
                if (!r.ok) throw new Error(r.reason || '未知失败');
                toast(`世界书就绪：${r.name}（${r.entries} 条${r.imported ? '，已新建' : '，已存在'}${r.bound ? '，已绑定当前卡' : `，未绑定${r.bindError ? `：${r.bindError}` : ''}`}）`);
                await refresh(panel, extra);
            } catch (e) {
                toast(`导入世界书失败：${e?.message || e}`);
            }
        });
    }
}

/** 查当前卡在本地库里的语义模式 */
async function lookupMode(be) {
    const name = lastState?.name;
    if (!be?.base) return { text: '后端未安装' };
    if (!name) return { text: '未选中角色' };
    try {
        const res = await fetch(`${be.base}/cards/by-name/${encodeURIComponent(name)}`);
        if (res.status === 404) {
            const probe = await fetch(`${be.base}/status`);
            const reachable = probe.ok;
            return {
                text: reachable ? '卡不在本地库（按 st 语义运行）' : '后端不可达',
                notInLibrary: reachable,
            };
        }
        if (!res.ok) return { text: `HTTP ${res.status}` };
        const data = await res.json();
        const info = {
            text: `${data.formatDetail}${data.marked ? '（手动标记）' : ''}`,
            cardId: data.cardId ?? null,
            contentHash: data.contentHash ?? null,
            marked: !!data.marked,
            auto: data.formatDetail ?? null,
        };
        // 再读一次卡体，取「自动判定」的原始 formatDetail（它与 marks 覆盖后的生效值可能不同）
        if (info.cardId) {
            try {
                const r2 = await fetch(`${be.base}/cards/${info.cardId}`);
                if (r2.ok) {
                    const d2 = await r2.json();
                    if (d2?.formatDetail) info.auto = d2.formatDetail;
                    info.lorebookCount = Array.isArray(d2?.lorebook) ? d2.lorebook.length : null;
                    info.regexCount = Array.isArray(d2?.regex) ? d2.regex.length : null;
                }
            } catch { /* 忽略 */ }
        }
        return info;
    } catch {
        return { text: '查询失败' };
    }
}

/** 拉取 iframe 状态 + 卡库 + 当前卡模式，然后一次性重绘 */
/** 正在点按面板时不要重绘（重绘会换掉 DOM，导致点击丢在旧节点上） */
let interacting = false;
let lastRefreshAt = 0;

async function refresh(panel, extra, { force = false } = {}) {
    if (interacting && !force) return;
    if (!force && Date.now() - lastRefreshAt < 200) return;
    lastRefreshAt = Date.now();
    const be = backend();
    const [stateRes, cardsRes, autoRes] = await Promise.all([
        rpc('regex-state'),
        (async () => {
            if (!be?.base) return null;
            try {
                const res = await fetch(`${be.base}/cards`);
                return res.ok ? await res.json() : null;
            } catch { return null; }
        })(),
        rpc('auto-get'),
    ]);
    if (stateRes?.result) lastState = stateRes.result;
    if (cardsRes) lastCards = cardsRes;
    if (autoRes?.result) autoState = autoRes.result;

    frameInfo = scanFrames();
    modeInfo = await lookupMode(be);
    renderPanel(panel, extra);

    // 安卓没有控制台：打开面板就自动拉一次宿主日志（用户不用再点按钮）
    const logsBox = panel.querySelector('[data-role="logs"]');
    if (logsBox && !logsBox.dataset.loaded) {
        logsBox.dataset.loaded = '1';
        void renderHostLogs(logsBox);
    }
}

/**
 * 挂载诊断浮层（幂等）。
 * @param {{version?: string}} [extra]
 */
export function mountDiagnostics(extra = {}) {
    if (typeof document === 'undefined' || !document.body) return null;
    if (isDiagnosticsDisabled()) {
        console.info('[rphub] 诊断浮层已被禁用（?rphub=nopanel 或 localStorage rphub:no-diagnostics）');
        return null;
    }
    if (document.getElementById(BTN_ID)) return document.getElementById(PANEL_ID);

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.textContent = 'RP-Hub 诊断';
    btn.title = '打开本地后端诊断（不需要控制台）';
    Object.assign(btn.style, {
        position: 'fixed', zIndex: '99998',
        padding: '4px 8px', fontSize: '11px', lineHeight: '1.4',
        background: 'rgba(30,30,30,.82)', color: '#eee', border: '1px solid #555',
        borderRadius: '6px', cursor: 'pointer', opacity: '.8',
    });

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
        position: 'fixed', zIndex: '99999', overflow: 'auto',
        background: 'rgba(255,255,255,.98)', color: '#222',
        border: '1px solid #bbb', borderRadius: '8px', boxShadow: '0 6px 24px rgba(0,0,0,.25)',
        padding: '10px', fontFamily: 'system-ui, sans-serif', display: 'none',
        boxSizing: 'border-box',
    });

    layout(panel, btn);
    window.addEventListener('resize', () => layout(panel, btn));

    // 默认不显示：诊断只是排障入口，正常使用不该占屏。
    // 出现失败时自动出现；也可用 ?rphub=debug 或控制台 __rphubShowDiagnostics() 调出。
    const debugRequested = (() => { try { return /[?&]rphub=debug\b/.test(location.search); } catch { return false; } })();
    btn.style.display = debugRequested ? '' : 'none';
    window.__rphubShowDiagnostics = () => { btn.style.display = ''; };

    btn.addEventListener('click', () => {
        const open = panel.style.display === 'none' || !panel.style.display;
        panel.style.display = open ? 'block' : 'none';
        if (open) {
            panel.innerHTML = '<div style="font-size:11px">读取中…</div>';
            void refresh(panel, extra);
        }
    });

    document.body.appendChild(btn);
    document.body.appendChild(panel);

    // 安卓端没有控制台：左上角连点 3 次即可呼出面板
    try {
        let tapTimes = [];
        document.addEventListener('pointerdown', (event) => {
            if (!(event.clientX < 56 && event.clientY < 56)) { tapTimes = []; return; }
            const now = Date.now();
            tapTimes = tapTimes.filter((t) => now - t < 1200);
            tapTimes.push(now);
            if (tapTimes.length >= 3) {
                tapTimes = [];
                btn.style.display = '';
                panel.style.display = 'block';
                void refresh(panel, extra);
                toast('诊断面板已打开（左上角连点 3 次）');
            }
        }, true);
    } catch { /* 忽略 */ }

    // 点按期间不重绘（否则 mousedown 后重绘会吞掉 click）
    panel.addEventListener('pointerdown', () => { interacting = true; }, true);
    window.addEventListener('pointerup', () => { setTimeout(() => { interacting = false; }, 0); }, true);
    panel.style.pointerEvents = 'auto';

    // 供 iframe 转发失败时重绘
    window.__rphubRenderDiagnostics = () => { if (panel.style.display !== 'none') void refresh(panel, extra); };

    // 页面 realm 自己的失败（例如导入拦截走父页面时）
    const be = backend();
    if (be?.onFailure) {
        be.onFailure((failure) => {
            const code = failure?.body?.error?.code || '';
            try {
                if (typeof window.toastr !== 'undefined') {
                    window.toastr.error(`卡处理失败：${failure.status} ${code}`, 'RP-Hub', { timeOut: 10000 });
                }
            } catch { /* 忽略 */ }
            panel.style.display = 'block';
            void refresh(panel, extra);
            try { window.__rphubShowDiagnostics?.(); } catch { /* 忽略 */ }
        });
    }

    return panel;
}
