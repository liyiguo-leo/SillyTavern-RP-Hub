// SPDX-License-Identifier: AGPL-3.0-or-later
// local/util.js —— 后端 lib/util.js 的浏览器版（语义逐条对齐，便于 diff 校验）
//
// 差异只有一处：createHash('sha256') → 自带的同步 sha256（local/sha256.js），
// 因此 stableId 与后端逐字节一致，本地/服务端两种模式对同一张卡产出同样的 id。

import { sha256HexString } from './sha256.js';

/** 稳定 id：基于内容哈希生成，同一输入永远得到同一 id（prefix + 12 位十六进制） */
export function stableId(prefix, ...parts) {
    return `${prefix}_${sha256HexString(parts.join('\u0000')).slice(0, 12)}`;
}

export function toNumber(value, fallback = null) {
    if (value === undefined || value === null || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

export function toBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        if (s === 'true') return true;
        if (s === 'false') return false;
    }
    return !!value;
}

export function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 字符串 keys → 数组（兼容 RP-Hub/ST 的逗号/顿号分隔字符串） */
export function normalizeKeys(keys) {
    if (typeof keys === 'string') {
        return keys.split(/[,，]/).map((k) => k.trim()).filter(Boolean);
    }
    if (Array.isArray(keys)) return keys.filter((k) => typeof k === 'string').map((k) => k.trim()).filter(Boolean);
    return [];
}

/**
 * 从 findRegex / regex 提取「模式 + flags」：
 * - 形如 `/pattern/gims` 的字面量 → 拆开（从尾部扫描未转义的定界符 /）
 * - 否则原样当模式
 */
export function splitRegexLiteral(input) {
    const text = String(input || '').trim();
    if (text.startsWith('/') && text.length >= 2) {
        let lastSlash = -1;
        for (let i = text.length - 1; i > 0; i--) {
            if (text[i] === '/') {
                let backslashes = 0;
                let j = i - 1;
                while (j >= 0 && text[j] === '\\') {
                    backslashes++;
                    j--;
                }
                if (backslashes % 2 === 0) {
                    lastSlash = i;
                    break;
                }
            }
        }
        if (lastSlash > 0) {
            const flags = text.slice(lastSlash + 1);
            if (/^[dgimsuvy]*$/.test(flags)) {
                return { pattern: text.slice(1, lastSlash), flags: flags || undefined };
            }
        }
    }
    return { pattern: text, flags: undefined };
}

/** 深拷贝（structuredClone 优先，退化 JSON） */
export function deepClone(value) {
    try {
        return structuredClone(value);
    } catch {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            return value;
        }
    }
}
