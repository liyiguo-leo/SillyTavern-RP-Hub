// SPDX-License-Identifier: AGPL-3.0-or-later
// panel/st-import.js —— 本地模式下的「写回」：把卡交给酒馆自己导入
//
// 两条通道，按可用性依次尝试（TT 酒馆 / 纯前端宿主未必有 Node 版的 /api/characters/import）：
//   1. POST /api/characters/import   —— 与酒馆原生拖入同一条链路（SillyTavern 一定有）
//   2. TavernHelper.importRawCharacter —— 酒馆助手提供的原生导入接口（TT 上更可能可用）
// 都不可用时抛错，由调用方把 standardCard.error 透给上层（卡已入本地库，不影响后续渲染）。

/** 取 ST 上下文：优先当前 realm，其次父窗口（TT / iframe 场景） */
function getContext() {
    const pick = (w) => {
        try { return w?.SillyTavern?.getContext?.() ?? null; } catch { return null; }
    };
    return pick(globalThis) || pick(window.parent) || pick(window.top) || null;
}

function hasTavernHelperImport() {
    try {
        return typeof importRawCharacter === 'function';
    } catch {
        return typeof window?.TavernHelper?.importRawCharacter === 'function';
    }
}

/**
 * @param {Uint8Array} bytes 卡原始字节
 * @param {string|null} filename 原始文件名（决定 file_type）
 * @returns {Promise<string|null>} avatar 文件名（含 .png）；拿不到具体文件名时返回 null
 */
export async function importToSt(bytes, filename) {
    const name = String(filename || '').trim() || 'card.png';
    const ext = (name.split('.').pop() || 'png').toLowerCase();
    const mime = ext === 'json' ? 'application/json' : (ext === 'png' ? 'image/png' : 'application/octet-stream');
    const blob = new Blob([bytes], { type: mime });

    // 通道 1：酒馆原生接口
    const ctx = getContext();
    if (ctx) {
        try {
            const form = new FormData();
            form.append('avatar', new File([bytes], name, { type: mime }));
            form.append('file_type', ext);
            form.append('user_name', String(ctx.name1 ?? ''));

            const headers = typeof ctx.getRequestHeaders === 'function'
                ? ctx.getRequestHeaders({ omitContentType: true })
                : {};
            delete headers['Content-Type'];
            delete headers['content-type'];

            const res = await fetch('/api/characters/import', { method: 'POST', headers, body: form });
            const data = await res.json().catch(() => null);
            if (res.ok && data?.file_name) {
                return String(data.file_name).replace(/\.png$/i, '') + '.png';
            }
            console.warn(`[rphub:panel] /api/characters/import 不可用（HTTP ${res.status}），改用酒馆助手导入`);
        } catch (e) {
            console.warn('[rphub:panel] /api/characters/import 异常，改用酒馆助手导入：', e?.message || e);
        }
    }

    // 通道 2：酒馆助手 importRawCharacter
    if (hasTavernHelperImport()) {
        const fn = (() => {
            try { return importRawCharacter; } catch { return window.TavernHelper.importRawCharacter; }
        })();
        await fn(name, blob);
        // TH 返回真实 Response，但不同版本回包字段不一；用最新角色列表兜底定位 avatar
        const fresh = getContext();
        const pool = fresh?.characters || fresh?.getCharacters?.() || [];
        const hit = Array.isArray(pool)
            ? pool.find((c) => String(c?.name || '').trim() === String(name.replace(/\.[^.]+$/, '')).trim())
            : null;
        if (hit?.avatar) return String(hit.avatar).replace(/\.png$/i, '') + '.png';
        try { await fresh?.getCharacters?.(); } catch { /* 忽略 */ }
        return null;
    }

    throw new Error('当前宿主既没有 /api/characters/import，也没有酒馆助手导入接口');
}
