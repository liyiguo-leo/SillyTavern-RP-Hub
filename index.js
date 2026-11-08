// SPDX-License-Identifier: AGPL-3.0-or-later
// index.js —— 扩展入口（精简版）
//
// 只做三件事：
//   1. 装本地后端（/api/plugins/rp-hub-compat/v1 的浏览器实现）
//   2. 动态装载引擎（RegexPlus 管道；失败可给出明确指引）
//   3. 暴露最小控制台入口 __rphub__（不再有诊断面板）

import { installLocalBackend } from './local/fetch-shim.js';
import { importToSt } from './panel/st-import.js';
import { probeEnvironment, checkCoreScript } from './local/compat.js';
import { backfillRegexNamesOnce } from './panel/backfill-regex-names.js';
import { EXTENSION_VERSION } from './local/constants.js';

export const EXTENSION_URL = new URL('./', import.meta.url).href;

/** 扩展激活入口（manifest.json 的 hooks.activate）。 */
export async function init() {
    let backendInfo = null;
    try {
        backendInfo = await installLocalBackend({ hooks: { importToSt } });
    } catch (error) {
        console.error('[rphub] 本地后端安装失败：', error);
    }


    try {
        const boot = await import('./boot.js');
        await boot.start({ backendInfo, extensionUrl: EXTENSION_URL });
    } catch (error) {
        reportBootFailure(error);
    }

    // 方案 B（默认关闭）：给已导入的卡补正则名。开启才跑，且每卡每会话一次。
    try {
        setTimeout(() => { void backfillRegexNamesOnce().catch(() => { }); }, 3000);
    } catch { /* 忽略 */ }
}

/** 引擎模块图装载失败时的可执行提示 */
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
            + '  解决：改用 TT 变体产物（node tools/build-variant.mjs --target tt 生成的 dist/tt）。',
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

// 最小控制台入口（排障用，不提供 UI）
try {
    window.__rphub__ = {
        extensionUrl: EXTENSION_URL,
        version: EXTENSION_VERSION,
        compat: probeEnvironment,
        checkCoreScript,
    };
} catch { /* 忽略 */ }
