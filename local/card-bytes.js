// SPDX-License-Identifier: AGPL-3.0-or-later
// local/card-bytes.js —— 导入前的字节预处理（当前只做「正则命名」）
//
// 设计原则：**失败即返回原始字节**。任何异常都不影响导入本身。
// 开关：localStorage['rphub:regex-naming'] = '0' 可整体关闭（默认开）。

import { rewriteCardTextChunks, isPngBytes } from './png-rewrite.js';
import { nameRegexScriptsInCard, looksLikeRpHubCard } from './regex-names.js';

const FLAG_KEY = 'rphub:regex-naming';

export function isRegexNamingEnabled() {
    try {
        return localStorage.getItem(FLAG_KEY) !== '0';
    } catch {
        return true;
    }
}

/** 卡 JSON → 是否需要补名（就地修改） */
function transformCardJson(parsed) {
    const card = (parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object')
        ? parsed.data
        : parsed;
    if (!looksLikeRpHubCard(card)) return { changed: false };

    let changed = false;

    // ① 位置归一：有些 RP 卡把正则放在 data.regex_scripts（顶层），引擎只读
    //    data.extensions.regex_scripts —— 导入时合并到标准位，避免「正则不生效」。
    const topLevel = Array.isArray(card.regex_scripts) ? card.regex_scripts : null;
    if (topLevel && topLevel.length > 0) {
        card.extensions = (card.extensions && typeof card.extensions === 'object') ? card.extensions : {};
        const extList = Array.isArray(card.extensions.regex_scripts) ? card.extensions.regex_scripts : [];
        const keyOf = (s) => `${s?.findRegex ?? s?.regex ?? ''}\u0000${s?.replaceString ?? s?.replacement ?? ''}\u0000${s?.regexFlags ?? s?.flags ?? ''}`;
        const seen = new Set(extList.map(keyOf));
        const additions = topLevel.filter((s) => !seen.has(keyOf(s)));
        if (additions.length > 0) {
            card.extensions.regex_scripts = [...extList, ...additions.map((s) => ({ ...s }))];
            changed = true;
        }
    }

    // ② 补名字（只补空值）
    const result = nameRegexScriptsInCard(card);
    if (result.changed > 0) changed = true;

    return { changed };
}

/**
 * 导入前处理：给 RP 卡的正则补 scriptName。
 * @param {Uint8Array} bytes 原始卡字节
 * @returns {Promise<Uint8Array>} 处理后的字节（失败/无需处理时原样返回）
 */
export async function prepareCardBytes(bytes) {
    if (!isRegexNamingEnabled()) return bytes;
    try {
        if (isPngBytes(bytes)) {
            const result = await rewriteCardTextChunks(bytes, transformCardJson);
            return result.changed ? result.bytes : bytes;
        }

        // JSON 卡
        let text = new TextDecoder('utf-8').decode(bytes);
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        const parsed = JSON.parse(text);
        const result = transformCardJson(parsed);
        if (!result.changed) return bytes;
        return new TextEncoder().encode(JSON.stringify(parsed));
    } catch (error) {
        console.warn('[rphub] 正则命名失败，按原样导入：', error?.message || error);
        return bytes;
    }
}
