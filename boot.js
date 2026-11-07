// SPDX-License-Identifier: AGPL-3.0-or-later
// boot.js —— 引擎装载（原 index.js 主体）
//
// 由 index.js 动态 import：这样 /script.js 缺失导致的模块图失败可以被捕获并给出指引，
// 而不是让整个扩展在求值阶段静默死亡。

import { engine } from './src/engine/engine.js';
import * as pipeline from './src/pipeline/index.js';
import * as panel from './src/panel/ui.js';
import { mountCompatApi } from './src/pipeline/force-render.js';
import { rphubCompatPromptInterceptor } from './src/pipeline/prompt.js';
import { getFormatDetail, clearModeCache } from './src/store/rp-mode.js';
import { getRegexScripts } from './src/store/scripts.js';
import { characters, this_chid } from './src/st-bridge.js';
import { initStreamService } from './src/stream/stream-service.js';
import { initLegacyStreamHook } from './src/stream/legacy-hook.js';

import { getLocalBackend } from './local/fetch-shim.js';
import { registerPanelScript } from './panel/register.js';
import { probeEnvironment } from './local/compat.js';

/**
 * @param {{backendInfo?: {mode:string, base:string}, extensionUrl: string}} ctx
 */
export async function start(ctx = {}) {
    const { backendInfo = null, extensionUrl = new URL('./', import.meta.url).href } = ctx;

    if (typeof engine?.run !== 'function') {
        console.error('[rphub] 引擎核心加载失败：engine.run 不存在。');
        return;
    }

    console.info(`[rphub] 数据后端：${backendInfo?.mode === 'server' ? '服务端插件' : '浏览器本地库'}（${backendInfo?.base ?? getLocalBackend()?.base ?? '?'}）`);
    console.debug('[rphub] 宿主兼容面：', probeEnvironment());

    // ① generate_interceptor（prompt 通道 per-message placement/depth）
    try {
        if (typeof globalThis.rphubCompatPromptInterceptor !== 'function') {
            globalThis.rphubCompatPromptInterceptor = rphubCompatPromptInterceptor;
        }
    } catch {
        console.warn('[rphub] 无法注册 generate_interceptor（prompt 通道将走 GENERATE_AFTER_DATA 兜底）。');
    }

    // ② 数据层自检（模式判定 + 脚本合并）
    try {
        const info = await getFormatDetail({ avatar: characters?.[this_chid]?.avatar, name: characters?.[this_chid]?.name });
        const mode = info.formatDetail;
        const scripts = getRegexScripts({ allowedOnly: true, mode });
        console.debug(`[rphub] 当前角色模式：${mode}，合并脚本数：${scripts.length}。`);
    } catch (error) {
        console.warn('[rphub] 数据层自检失败（不阻塞管道挂载）：', String(error?.message || error));
    }

    // ③ 管道 / 流式 / 面板
    await pipeline.init();
    initLegacyStreamHook();
    initStreamService();

    try {
        await panel.init();
    } catch (error) {
        console.error('[rphub] 正则面板初始化失败（不阻塞引擎管道）：', String(error?.message || error));
    }

    mountCompatApi();

    // ④ 把 RP助手 面板脚本注册进酒馆助手（已装则跳过；未装则静默）
    try {
        await registerPanelScript(extensionUrl);
    } catch (error) {
        console.warn('[rphub] 面板脚本注册失败（可手动在酒馆助手里添加）：', error);
    }

    try {
        window.__rphub__ = { ...(window.__rphub__ || {}), extensionUrl, backend: () => getLocalBackend(), clearModeCache };
    } catch { /* 忽略 */ }

    console.debug('[rphub] 事件管道已启动（合并版：引擎 + 本地后端 + 面板）。');
}
