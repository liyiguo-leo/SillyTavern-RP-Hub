// SPDX-License-Identifier: AGPL-3.0-or-later
// panel/st-import.js —— 本地模式下的「写回」：把卡交给酒馆自己导入
//
// 导入前会先过一遍 local/card-bytes.js：给 RP 卡的正则补 scriptName（可关）。
// 这一步失败不影响导入（原样交给酒馆）。

import { prepareCardBytes } from '../local/card-bytes.js';

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

    // 导入前预处理（补正则名）；失败时返回原字节
    const prepared = await prepareCardBytes(bytes);
    const blob = new Blob([prepared], { type: mime });

    // 通道 1：酒馆原生接口
    const ctx = getContext();
    if (ctx) {
        try {
            const form = new FormData();
            form.append('avatar', new File([prepared], name, { type: mime }));
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
        const fresh = getContext();
        const pool = fresh?.characters || [];
        const hit = Array.isArray(pool)
            ? pool.find((c) => String(c?.name || '').trim() === String(name.replace(/\.[^.]+$/, '')).trim())
            : null;
        if (hit?.avatar) return String(hit.avatar).replace(/\.png$/i, '') + '.png';
        try { await fresh?.getCharacters?.(); } catch { /* 忽略 */ }
        return null;
    }

    throw new Error('当前宿主既没有 /api/characters/import，也没有酒馆助手导入接口');
}
