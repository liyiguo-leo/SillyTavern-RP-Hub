// SPDX-License-Identifier: AGPL-3.0-or-later
// index.js —— 扩展入口（只做「装载」和「报错」，不直接拉整张模块图）
//
// 为什么入口要这么薄：
//   RegexPlus 的 src/st-bridge.js 静态 import '../../../../../script.js'（酒馆前端内部模块）。
//   若宿主没有这个文件（例如某些 Tauri 封装），**静态模块图求值就会 404 失败**，
//   而且失败发生在 init 执行之前 —— 用户只会看到一句 “Failed to fetch dynamically imported module”。
//   所以这里把整张图挪进 boot.js，用动态 import 装载：失败也能捕获，能给出可执行的指引，
//   并为 TT 变体（variants/tt）保留切换点。

import { installLocalBackend } from './local/fetch-shim.js';
import { importToSt } from './panel/st-import.js';
import { probeEnvironment, checkCoreScript } from './local/compat.js';

export const EXTENSION_URL = new URL('./', import.meta.url).href;

/**
 * 扩展激活入口（manifest.json 的 hooks.activate）。
 */
export async function init() {
    // ① 本地后端先装：它不依赖 RegexPlus 的模块图，即使引擎装不起来也要能用
    let backendInfo = null;
    try {
        backendInfo = await installLocalBackend({ hooks: { importToSt } });
    } catch (error) {
        console.error('[rphub] 本地后端安装失败：', error);
    }

    // ② 装载引擎 + 管道 + 面板（动态 import，失败可诊断）
    try {
        const boot = await import('./boot.js');
        await boot.start({ backendInfo, extensionUrl: EXTENSION_URL });
    } catch (error) {
        reportBootFailure(error);
    }
}

/** 引擎模块图装载失败时的可执行提示（而不是一行 404） */
function reportBootFailure(error) {
    const message = String(error?.message || error);
    const looksLikeMissingSt = /script\.js|dynamically imported module|Importing a module script failed/i.test(message);

    console.error('[rphub] 引擎模块装载失败：', error);
    try { window.__rphub_boot_error__ = { message, at: new Date().toISOString() }; } catch { /* 忽略 */ }

    if (looksLikeMissingSt) {
        console.error(
            '[rphub] 诊断：本扩展的 src/st-bridge.js 依赖酒馆前端模块 /script.js。\n'
            + '  当前宿主疑似没有该文件（TauriTavern 等纯前端封装）。\n'
            + '  验证：控制台执行 fetch("/script.js").then(r => console.log(r.status))\n'
            + '  解决：改用 TT 变体产物（node tools/build-variant.mjs --target tt 生成的 dist/tt），\n'
            + '        它把 src/st-bridge.js 换成语义等价的“酒馆上下文适配版”，不 import /script.js。',
        );
        try {
            if (typeof toastr !== 'undefined') {
                toastr.error('RP-Hub：当前酒馆缺少 /script.js 兼容层，请安装 TT 版扩展（详见控制台）', 'RP-Hub', { timeOut: 12000 });
            }
        } catch { /* 忽略 */ }
        return;
    }

    try {
        if (typeof toastr !== 'undefined') toastr.error(`RP-Hub 引擎装载失败：${message}`, 'RP-Hub');
    } catch { /* 忽略 */ }
}

// 控制台诊断入口（TT 真机排查用）
try {
    window.__rphub__ = {
        extensionUrl: EXTENSION_URL,
        compat: probeEnvironment,
        checkCoreScript,
    };
} catch { /* 忽略 */ }
