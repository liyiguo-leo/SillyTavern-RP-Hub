// SPDX-License-Identifier: AGPL-3.0-or-later
// local/compat.js —— 宿主兼容面探测（真机排查用，不改任何状态）
//
// 目的：把“能不能跑”的问题变成一组可读的布尔值，而不是在控制台里凭猜测。
//   SillyTavern / getContext / eventSource / characters / TavernHelper / /script.js
// 其中 /script.js 是唯一的**硬**前置：RegexPlus 的 st-bridge 静态 import 它。

/** @returns {object} 快照，可直接 console.table 看 */
export function probeEnvironment() {
    const pick = (w) => {
        try { return w?.SillyTavern?.getContext?.() ?? null; } catch { return null; }
    };
    const ctx = pick(globalThis) || pick(typeof window !== 'undefined' ? window.parent : null);
    const th = (() => {
        try { return typeof window !== 'undefined' ? (window.TavernHelper ?? null) : null; } catch { return null; }
    })();

    const flags = {
        hasWindow: typeof window !== 'undefined',
        isIframe: (() => { try { return window.top !== window.self; } catch { return true; } })(),
        hasSillyTavernGlobal: (() => { try { return typeof SillyTavern !== 'undefined'; } catch { return false; } })(),
        hasGetContext: !!ctx,
        hasEventSource: !!ctx?.eventSource,
        hasEventTypes: !!ctx?.eventTypes,
        hasCharacters: Array.isArray(ctx?.characters),
        hasThisChid: ctx?.this_chid !== undefined,
        hasExtensionSettings: !!ctx?.extensionSettings,
        hasTavernHelper: !!th,
        hasTavernHelperScriptApi: !!(th?.updateScriptTreesWith && th?.getScriptTrees),
        hasThImportRawCharacter: typeof th?.importRawCharacter === 'function' || typeof globalThis?.importRawCharacter === 'function',
        hasDecompressionStream: typeof DecompressionStream === 'function',
        hasIndexedDB: typeof indexedDB !== 'undefined',
        hasStructuredClone: typeof structuredClone === 'function',
    };

    console.info('[rphub] 宿主兼容面', flags, ctx ? { name1: ctx.name1, characters: ctx.characters?.length, this_chid: ctx.this_chid } : '(无 getContext)');
    return flags;
}

/**
 * 探测 /script.js 是否可达（TT 真机 30 秒自检用）。
 * @returns {Promise<{ok:boolean, status:number|null, contentType:string|null, advice:string}>}
 */
export async function checkCoreScript() {
    try {
        const res = await fetch('/script.js', { method: 'HEAD' });
        const ok = res.ok;
        return {
            ok,
            status: res.status,
            contentType: res.headers.get('content-type'),
            advice: ok
                ? '宿主提供了 /script.js：直接使用标准构建即可。'
                : '宿主没有 /script.js：请安装 TT 变体（node tools/build-variant.mjs --target tt → dist/tt）。',
        };
    } catch (e) {
        return { ok: false, status: null, contentType: null, advice: `请求失败：${e?.message || e}` };
    }
}
