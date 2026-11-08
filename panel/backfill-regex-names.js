// SPDX-License-Identifier: AGPL-3.0-or-later
// panel/backfill-regex-names.js —— 方案 B：给「已经导入过」的卡补正则名（默认关闭）
//
// 为什么默认关闭：写回角色卡会触发一次角色重载（历史上会导致正文重渲染）。
// 导入路径已经用「导入前改写 chara 块」覆盖了新卡，这里只服务老卡。
//
// 开启：localStorage['rphub:regex-backfill'] = '1'
// 每张卡每会话只处理一次；只补空 scriptName。

import { collectRegexArrays, nameRegexScriptsInCard } from '../local/regex-names.js';

const FLAG_KEY = 'rphub:regex-backfill';
const handled = new Set();

function ctx() {
    const pick = (w) => {
        try { return w?.SillyTavern?.getContext?.() ?? null; } catch { return null; }
    };
    return pick(globalThis) || (typeof window !== 'undefined' ? pick(window.parent) : null) || null;
}

function helper() {
    try { return window.TavernHelper ?? null; } catch { return null; }
}

function isEnabled() {
    try { return localStorage.getItem(FLAG_KEY) === '1'; } catch { return false; }
}

/**
 * 给当前卡补一次正则名（幂等，每卡每会话一次）。
 * @returns {Promise<{skipped?: string, changed?: number}>}
 */
export async function backfillRegexNamesOnce() {
    if (!isEnabled()) return { skipped: 'disabled' };

    const c = ctx();
    if (!c) return { skipped: 'no-context' };

    let name = null;
    try { name = helper()?.getCurrentCharacterName?.() ?? null; } catch { /* 忽略 */ }

    let char = null;
    if (Array.isArray(c.characters)) {
        if (name) char = c.characters.find((x) => x?.name === name) ?? null;
        if (!char && c.this_chid !== null && c.this_chid !== undefined) char = c.characters[c.this_chid] ?? null;
    }
    if (!char?.data) return { skipped: 'no-character' };

    const key = String(char.avatar || name || '');
    if (!key || handled.has(key)) return { skipped: 'already-handled' };
    handled.add(key);

    const arrays = collectRegexArrays(char.data);
    if (arrays.length === 0) return { skipped: 'no-scripts' };
    const hasEmpty = arrays.some((list) => list.some((s) => !String(s?.scriptName || '').trim()));
    if (!hasEmpty) return { skipped: 'nothing-to-do' };

    const result = nameRegexScriptsInCard(char.data);
    if (result.changed === 0) return { skipped: 'nothing-changed' };

    try {
        const th = helper();
        if (name && typeof th?.updateCharacterWith === 'function') {
            await th.updateCharacterWith(name, (ch) => {
                nameRegexScriptsInCard(ch.data);
                return ch;
            });
            console.info(`[rphub] 已为「${name}」补 ${result.changed} 条正则名（方案 B）`);
            return { changed: result.changed, via: 'tavern-helper' };
        }
    } catch (e) {
        console.warn('[rphub] 补正则名写回失败（忽略）：', e?.message || e);
    }
    return { skipped: 'write-failed' };
}
