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
    const result = nameRegexScriptsInCard(card);
    return { changed: result.changed > 0 };
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
