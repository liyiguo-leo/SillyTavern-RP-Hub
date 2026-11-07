// SPDX-License-Identifier: AGPL-3.0-or-later
// panel/enabler.js —— 运行在酒馆助手脚本 iframe 内（独立 realm）
//
// 职责只有两件：
//   1. 在**这个 realm** 里再装一次本地后端（父窗口的 patch 不会跨 iframe 生效）；
//   2. 加载真正的面板 bundle（panel/rp-hub-panel.js，来自 RP助手 的构建产物）。
//
// 性能注意：用 HEAD 探测产物是否存在，再 import —— 不要 GET 一遍再 import（236 KB 会下两次）。

import { installLocalBackend, getLocalBackend } from '../local/fetch-shim.js';
import { importToSt } from './st-import.js';

const PANEL_BUNDLE = new URL('./rp-hub-panel.js', import.meta.url).href;

async function panelBundleExists() {
    try {
        const res = await fetch(PANEL_BUNDLE, { method: 'HEAD' });
        return res.ok;
    } catch {
        return false;
    }
}

async function main() {
    try {
        const info = await installLocalBackend({ hooks: { importToSt } });
        console.info(`[rphub:panel] 本地后端已装入酒馆助手 iframe · 模式=${info.mode}`);
    } catch (e) {
        console.warn('[rphub:panel] 本地后端安装失败，面板将依赖服务端插件：', e);
    }

    // 失败上报：本 realm 是隐藏 iframe，界面不可见 → 转发给父页面（诊断浮层会展示）
    try {
        const be = getLocalBackend();
        if (be?.onFailure) {
            be.onFailure((failure) => {
                try {
                    (window.parent ?? window.top ?? window).postMessage(
                        { type: 'rphub:failure', payload: failure },
                        '*',
                    );
                } catch { /* 跨源时忽略 */ }
            });
        }
    } catch { /* 忽略 */ }

    // RPC：父页面的诊断面板拿不到「当前卡 / 白名单」，但本 realm 的 getContext() 是完整的
    try {
        installRpc();
    } catch (e) {
        console.warn('[rphub:panel] RPC 安装失败：', e);
    }

    if (!await panelBundleExists()) {
        console.info(`[rphub:panel] 未找到面板产物 ${PANEL_BUNDLE}。`
            + '把 RP助手 的构建产物放到 panel/rp-hub-panel.js（或跑 node tools/fetch-panel.mjs）即可启用面板。');
        return;
    }

    try {
        await import(PANEL_BUNDLE);
        console.info('[rphub:panel] 面板 bundle 已加载。');
    } catch (e) {
        console.error('[rphub:panel] 面板 bundle 加载失败：', e);
    }

    // 控制台诊断：window.__rphubPanel__.backend().mode === 'local' | 'server'
    try {
        window.__rphubPanel__ = { backend: () => getLocalBackend() };
    } catch { /* 忽略 */ }
}

void main();

/* ------------------------------ 诊断 RPC ------------------------------ */
//
// 页面 realm 里 `SillyTavern.getContext()` 可能是裁剪版（拿不到 characters/this_chid），
// 而酒馆助手脚本 iframe 里是完整的。所以「当前卡是谁 / 卡内正则是否放行 / 放行与撤销」
// 都由本 iframe 执行，页面只负责显示。

function installRpc() {
    const ctx = () => {
        try { return SillyTavern.getContext(); } catch { return null; }
    };

    const currentChar = () => {
        const c = ctx();
        const th = (() => { try { return window.TavernHelper ?? null; } catch { return null; } })();

        // TT/某些版本里 ctx.this_chid 为 null → 用酒馆助手的公开 API 兜底
        let name = null;
        try { name = th?.getCurrentCharacterName?.() ?? null; } catch { /* 忽略 */ }

        let char = null;
        if (Array.isArray(c?.characters)) {
            if (name) char = c.characters.find((x) => x?.name === name) ?? null;
            if (!char && c.this_chid !== null && c.this_chid !== undefined) char = c.characters[c.this_chid] ?? null;
        }

        let avatar = char?.avatar ?? null;
        if (!avatar) {
            try {
                const path = th?.getCharAvatarPath?.('current');
                if (typeof path === 'string' && path) avatar = decodeURIComponent(path.split('/').pop() || '') || null;
            } catch { /* 忽略 */ }
        }

        return { ctx: c, char, avatar, name: name ?? char?.name ?? null };
    };

    const handlers = {
        'regex-state': () => {
            const { ctx: c, avatar, name, char } = currentChar();
            const list = c?.extensionSettings?.character_allowed_regex;
            const th = (() => { try { return window.TavernHelper ?? null; } catch { return null; } })();
            return {
                hasContext: !!c,
                hasCharacter: !!char || !!avatar,
                avatar,
                name,
                allowed: Array.isArray(list) && avatar ? list.includes(avatar) : null,
                characterCount: Array.isArray(c?.characters) ? c.characters.length : null,
                thisChid: c?.this_chid ?? null,
                hasTavernHelper: !!th,
                resolvedVia: char ? 'characters' : (avatar ? 'tavern-helper' : 'none'),
            };
        },
        'regex-set': ({ allow } = {}) => {
            const { ctx: c, avatar } = currentChar();
            if (!c) return { ok: false, reason: '没有酒馆上下文' };
            if (!avatar) return { ok: false, reason: '未选中角色' };
            c.extensionSettings = c.extensionSettings || {};
            if (!Array.isArray(c.extensionSettings.character_allowed_regex)) {
                c.extensionSettings.character_allowed_regex = [];
            }
            const list = c.extensionSettings.character_allowed_regex;
            const idx = list.indexOf(avatar);
            if (allow && idx < 0) list.push(avatar);
            if (!allow && idx >= 0) list.splice(idx, 1);
            try { c.saveSettingsDebounced?.(); } catch { /* 忽略 */ }
            return { ok: true, allowed: !!allow, avatar, count: list.length };
        },
        'cards': () => {
            const be = getLocalBackend();
            if (!be?.base) return { ok: false, reason: '本地后端未安装' };
            return fetch(`${be.base}/cards`).then((r) => (r.ok ? r.json() : { ok: false, reason: `HTTP ${r.status}` }));
        },
    };

    window.addEventListener('message', async (event) => {
        const data = event?.data;
        if (!data || typeof data !== 'object' || data.type !== 'rphub:rpc') return;
        const fn = handlers[data.method];
        let result = null;
        let error = null;
        try {
            if (!fn) error = `未知方法：${data.method}`;
            else result = await fn(data.params || {});
        } catch (e) {
            error = e?.message || String(e);
        }
        try {
            (event.source ?? window.parent)?.postMessage({ type: 'rphub:rpc:result', id: data.id, result, error }, '*');
        } catch { /* 忽略 */ }
    });

    console.info('[rphub:panel] 诊断 RPC 已就绪（regex-state / regex-set / cards）。');
}
