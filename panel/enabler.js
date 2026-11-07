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
