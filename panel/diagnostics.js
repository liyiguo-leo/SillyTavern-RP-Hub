// SPDX-License-Identifier: AGPL-3.0-or-later
// panel/diagnostics.js —— 不需要控制台的诊断浮层
//
// 背景：TauriTavern 这类封装默认可能没有 F12 / DevTools，用户在“卡上传失败 422”时
// 无法把控制台里那行 `[rphub-local] POST /cards/analyze 未完成：…` 拷出来。
// 这个浮层把同样信息做成可点、可复制的界面，并且能回答一个关键问题：
//   **请求到底有没有到达本地后端？**（最近请求列表为空 = 根本没到，问题在别处）
//
// 依赖：无（纯 DOM + 内联样式），不引入 jquery / toastr 也可工作。

const PANEL_ID = 'rphub-diagnostics-panel';
const BTN_ID = 'rphub-diagnostics-btn';

/**
 * 来自酒馆助手 iframe 的失败上报。
 * 导入拦截跑在 TH 的 script iframe 里（独立 realm），那儿的失败本 realm 看不到，
 * 所以 enabler 会用 postMessage 把失败转发到页面，由本面板统一展示。
 */
let forwardedFailure = null;

// 注意：监听器在模块加载时就注册（早于面板挂载），避免错过首个失败
try {
    window.addEventListener('message', (event) => {
        const data = event?.data;
        if (!data || typeof data !== 'object' || data.type !== 'rphub:failure') return;
        forwardedFailure = { ...data.payload, from: 'tavern-helper-iframe', at: new Date().toISOString() };
        try {
            if (typeof window.toastr !== 'undefined' && forwardedFailure?.status >= 400) {
                const code = forwardedFailure?.body?.error?.code || '';
                window.toastr.error(`卡处理失败：${forwardedFailure.status} ${code}`, 'RP-Hub', { timeOut: 10000 });
            }
        } catch { /* 忽略 */ }
        const panel = document.getElementById(PANEL_ID);
        if (panel && typeof window.__rphubRenderDiagnostics === 'function') window.__rphubRenderDiagnostics();
    });
} catch { /* 忽略 */ }

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function backend() {
    try { return window.__rphubLocalBackend__ ?? null; } catch { return null; }
}

/* ---------------- 正则白名单（scoped 脚本的准入门槛） ----------------
 * 引擎读脚本时 allowedOnly=true：卡内 scoped 正则必须出现在
 * extension_settings.character_allowed_regex（avatar 数组）里才会被执行。
 * 酒馆内置「正则」扩展会替用户写这份白名单，但**它一旦启用就会和本引擎双重替换**；
 * 所以正确姿势是关掉内置正则，再由这里显式放行当前卡（或撤销）。
 */
function stContext() {
    const pick = (w) => {
        try { return w?.SillyTavern?.getContext?.() ?? null; } catch { return null; }
    };
    return pick(globalThis) || (typeof window !== 'undefined' ? pick(window.parent) : null) || null;
}

function currentAvatar() {
    const c = stContext();
    return c?.characters?.[c.this_chid]?.avatar || null;
}

function isScopedAllowed() {
    const c = stContext();
    const avatar = currentAvatar();
    if (!c || !avatar) return null; // 未知（没选卡 / 无上下文）
    const list = c.extensionSettings?.character_allowed_regex;
    return Array.isArray(list) && list.includes(avatar);
}

function setScopedAllowed(allow) {
    const c = stContext();
    const avatar = currentAvatar();
    if (!c || !avatar) return false;
    c.extensionSettings = c.extensionSettings || {};
    if (!Array.isArray(c.extensionSettings.character_allowed_regex)) {
        c.extensionSettings.character_allowed_regex = [];
    }
    const list = c.extensionSettings.character_allowed_regex;
    const idx = list.indexOf(avatar);
    if (allow && idx < 0) list.push(avatar);
    if (!allow && idx >= 0) list.splice(idx, 1);
    try { c.saveSettingsDebounced?.(); } catch { /* 忽略 */ }
    return true;
}

/** 查当前卡在本地库里的语义模式（rphub / st / 不在库） */
async function lookupMode(extra) {
    const be = backend();
    if (!be) return '后端未安装';
    const c = stContext();
    const name = c?.characters?.[c.this_chid]?.name;
    if (!name) return '未选中角色';
    try {
        const res = await fetch(`${be.base}/cards/by-name/${encodeURIComponent(name)}`);
        if (res.status === 404) {
            const probe = await fetch(`${be.base}/status`);
            return probe.ok ? '卡不在本地库' : '后端不可达';
        }
        if (!res.ok) return '后端不可达';
        const data = await res.json();
        return `${data.formatDetail}${data.marked ? '（手动标记）' : ''}`;
    } catch {
        return '后端不可达';
    }
}

/** 汇总诊断数据（同时供复制与 report() 使用） */
export function collectReport(extra = {}) {
    const be = backend();
    const recent = typeof be?.recent === 'function' ? be.recent() : [];
    const failure = typeof be?.lastFailure === 'function' ? be.lastFailure() : null;
    return {
        at: new Date().toISOString(),
        extension: extra.version ? { version: extra.version } : undefined,
        backend: be ? { mode: be.mode, base: be.base, version: be.version } : null,
        host: {
            href: (() => { try { return location.href; } catch { return null; } })(),
            hasSillyTavern: (() => { try { return typeof SillyTavern !== 'undefined'; } catch { return false; } })(),
            hasTavernHelper: (() => { try { return !!window.TavernHelper; } catch { return false; } })(),
            hasTauriTavernDev: (() => { try { return !!window.__TAURITAVERN__?.api?.dev; } catch { return false; } })(),
        },
        lastFailure: failure || forwardedFailure,
        lastFailureSource: failure ? 'page' : (forwardedFailure ? 'tavern-helper-iframe' : null),
        recentRequests: recent,
        note: recent.length === 0
            ? '本地后端没有收到任何接口请求：说明这次失败发生在别处（例如酒馆原生导入），不是 RP-Hub 后端拒绝的。'
            : '本地后端收到过请求，可对照 lastFailure / 最近请求判断是哪一步被拒绝。',
    };
}

/** 生成可复制的纯文本报告 */
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

function toast(message) {
    try {
        if (typeof window.toastr !== 'undefined') { window.toastr.info(message, 'RP-Hub'); return; }
    } catch { /* 忽略 */ }
    console.info('[rphub]', message);
}

function renderPanel(panel, extra) {
    const report = collectReport(extra);
    const f = report.lastFailure;
    const rows = report.recentRequests.map((r) => (
        `<tr><td>${new Date(r.at).toLocaleTimeString()}</td><td>${esc(r.method)} ${esc(r.path)}</td>`
        + `<td style="color:${r.status >= 400 ? '#d33' : '#2a2'}">${r.status}</td><td>${r.byteLength}B</td></tr>`
    )).join('');

    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <strong style="font-size:13px">RP-Hub 诊断</strong>
        <span style="font-size:11px;opacity:.7">${esc(extra.version || '')}</span>
        <span style="flex:1"></span>
        <button data-act="copy" style="font-size:11px;padding:2px 6px;cursor:pointer">复制报告</button>
        <button data-act="logs" style="font-size:11px;padding:2px 6px;cursor:pointer">拉取宿主日志</button>
        <button data-act="close" style="font-size:11px;padding:2px 6px;cursor:pointer">关闭</button>
      </div>
      <div style="font-size:11px;line-height:1.5;margin-bottom:6px">
        后端：<b>${esc(report.backend?.mode ?? '未安装')}</b>
        ${report.backend?.base ? ` · ${esc(report.backend.base)}` : ''}<br>
        宿主：ST=${report.host.hasSillyTavern ? '✓' : '✗'} ·
        酒馆助手=${report.host.hasTavernHelper ? '✓' : '✗'} ·
        TT调试API=${report.host.hasTauriTavernDev ? '✓' : '✗'}<br>
        ${esc(report.note)}
      </div>
      <div style="font-size:11px;background:#f2f6ff;border:1px solid #ccd9f2;border-radius:6px;padding:6px;margin-bottom:6px">
        <b>正则引擎</b>：<span data-role="mode">查询中…</span><br>
        本卡内嵌正则（scoped）：<b data-role="allowed">…</b>
        <button data-act="allow" style="font-size:11px;padding:1px 6px;margin-left:6px;cursor:pointer">允许</button>
        <button data-act="deny" style="font-size:11px;padding:1px 6px;cursor:pointer">撤销</button>
        <div style="opacity:.75;margin-top:3px">同一份正则只能由一个引擎执行：请关闭酒馆内置「正则」扩展，再在这里显式放行本卡。</div>
      </div>
      ${f ? `<div style="font-size:11px;background:#fff3f3;border:1px solid #f3c9c9;border-radius:6px;padding:6px;margin-bottom:6px">
        <b>最近失败</b>：${esc(f.method)} ${esc(f.path)} → <b style="color:#d33">${f.status}</b> ${esc(f.code)}<br>
        ${esc(f.message)}<br>
        体积 ${f.byteLength}B · 前 16 字节 <code>${esc(f.headHex || '(空)')}</code>
        ${f.hint ? `<br>提示：${esc(f.hint)}` : ''}
      </div>` : '<div style="font-size:11px;margin-bottom:6px">最近失败：无</div>'}
      <div style="font-size:11px;max-height:150px;overflow:auto">
        ${rows
            ? `<table style="width:100%;border-collapse:collapse;font-size:11px">
                 <thead><tr><th align="left">时间</th><th align="left">接口</th><th align="left">码</th><th align="left">体积</th></tr></thead>
                 <tbody>${rows}</tbody></table>`
            : '<div style="opacity:.7">暂无请求记录</div>'}
      </div>
      <div data-role="logs" style="font-size:11px;max-height:150px;overflow:auto;margin-top:6px"></div>
    `;

    panel.querySelector('[data-act="close"]').addEventListener('click', () => { panel.style.display = 'none'; });

    // 正则白名单：显示 + 一键放行/撤销（scoped 脚本必须在这里放行才会被执行）
    const modeEl = panel.querySelector('[data-role="mode"]');
    const allowedEl = panel.querySelector('[data-role="allowed"]');
    const syncAllowed = () => {
        const value = isScopedAllowed();
        allowedEl.textContent = value === null ? '未知（未选中角色）' : (value ? '已允许' : '未允许');
        allowedEl.style.color = value ? '#1f8a4c' : '#c22';
    };
    syncAllowed();
    lookupMode(extra).then((text) => { if (modeEl) modeEl.textContent = text; }).catch(() => { /* 忽略 */ });

    panel.querySelector('[data-act="allow"]').addEventListener('click', () => {
        if (setScopedAllowed(true)) { syncAllowed(); toast('已允许本卡内嵌正则；重新打开聊天或强制重渲染后生效'); }
        else toast('写入失败：没有拿到酒馆上下文');
    });
    panel.querySelector('[data-act="deny"]').addEventListener('click', () => {
        if (setScopedAllowed(false)) { syncAllowed(); toast('已撤销本卡内嵌正则的允许'); }
        else toast('写入失败：没有拿到酒馆上下文');
    });
    panel.querySelector('[data-act="copy"]').addEventListener('click', async () => {
        const ok = await copyText(reportText(extra));
        toast(ok ? '诊断报告已复制到剪贴板' : '复制失败：请手动从面板抄写');
    });
    panel.querySelector('[data-act="logs"]').addEventListener('click', async () => {
        const box = panel.querySelector('[data-role="logs"]');
        box.textContent = '正在向宿主读取日志…';
        try {
            const dev = await (window.__TAURITAVERN__?.ready ?? window.__TAURITAVERN_MAIN_READY__).then(() => window.__TAURITAVERN__?.api?.dev);
            if (!dev?.frontendLogs?.list) { box.textContent = '当前宿主没有 frontendLogs API（非 TT 或无调试 API）'; return; }
            const entries = await dev.frontendLogs.list({ limit: 200 });
            const picked = (entries || []).filter((e) => String(e.message || '').includes('rphub')).slice(-40);
            box.innerHTML = picked.length
                ? picked.map((e) => `<div style="white-space:pre-wrap;margin-bottom:2px">[${esc(e.level)}] ${esc(e.message)}</div>`).join('')
                : '宿主日志里没有含 "rphub" 的条目';
        } catch (e) {
            box.textContent = `读取失败：${e?.message || e}`;
        }
    });
}

/**
 * 挂载诊断浮层（幂等）。
 * @param {{version?: string}} [extra]
 */
export function mountDiagnostics(extra = {}) {
    if (typeof document === 'undefined' || !document.body) return null;
    if (document.getElementById(BTN_ID)) return document.getElementById(PANEL_ID);

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.textContent = 'RP-Hub 诊断';
    btn.title = '打开本地后端诊断（无需控制台）';
    Object.assign(btn.style, {
        position: 'fixed', right: '10px', bottom: '10px', zIndex: '99998',
        padding: '4px 8px', fontSize: '11px', lineHeight: '1.4',
        background: 'rgba(30,30,30,.82)', color: '#eee', border: '1px solid #555',
        borderRadius: '6px', cursor: 'pointer', opacity: '.75',
    });
    btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
    btn.addEventListener('mouseleave', () => { btn.style.opacity = '.75'; });

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
        position: 'fixed', right: '10px', bottom: '42px', zIndex: '99999', width: '420px',
        maxHeight: '70vh', overflow: 'auto', background: 'rgba(255,255,255,.98)', color: '#222',
        border: '1px solid #bbb', borderRadius: '8px', boxShadow: '0 6px 24px rgba(0,0,0,.25)',
        padding: '10px', fontFamily: 'system-ui, sans-serif', display: 'none',
    });

    btn.addEventListener('click', () => {
        const open = panel.style.display === 'none' || !panel.style.display;
        panel.style.display = open ? 'block' : 'none';
        if (open) renderPanel(panel, extra);
    });

    document.body.appendChild(btn);
    document.body.appendChild(panel);

    // 供 iframe 转发失败时重绘
    window.__rphubRenderDiagnostics = () => renderPanel(panel, extra);

    // 后端失败时自动弹面板 + 一条 toast（TT 没控制台也能看到原因）
    const be = backend();
    if (be?.onFailure) {
        be.onFailure((failure) => {
            const code = failure?.body?.error?.code || '';
            const msg = failure?.body?.error?.message || '';
            try {
                if (typeof window.toastr !== 'undefined') {
                    window.toastr.error(`卡处理失败：${failure.status} ${code}`, 'RP-Hub', { timeOut: 10000 });
                }
            } catch { /* 忽略 */ }
            panel.style.display = 'block';
            renderPanel(panel, extra);
            console.warn('[rphub] 接口失败：', failure.status, code, msg);
        });
    }

    return panel;
}
