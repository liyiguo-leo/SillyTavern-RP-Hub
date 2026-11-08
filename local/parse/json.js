// SPDX-License-Identifier: AGPL-3.0-or-later
// local/parse/json.js —— 后端 lib/parse/json.js 移植（纯 JSON 卡解析）

import { isPlainObject } from '../util.js';

function isPlausibleCharacterObject(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    if (typeof obj.spec === 'string' && /^chara_card_v[23]$/.test(obj.spec)) return true;
    if (typeof obj.spec === 'string' && obj.spec) return true;
    if (typeof obj.data === 'object' && obj.data && typeof obj.data.name === 'string') return true;
    if (typeof obj.name === 'string') return true;
    if (typeof obj.char_name === 'string') return true;
    return false;
}

function unwrap(obj) {
    let current = obj;
    while (Array.isArray(current)) {
        if (current.length === 0) return null;
        current = current[0];
    }
    for (let guard = 0; guard < 4; guard++) {
        if (!current || typeof current !== 'object') return null;
        if (isPlausibleCharacterObject(current)) return current;
        if ('chara' in current) current = current.chara;
        else if ('character' in current && typeof current.character === 'object') current = current.character;
        else if ('card' in current && typeof current.card === 'object') current = current.card;
        else if ('data' in current && typeof current.data === 'object' && !isPlausibleCharacterObject(current)) {
            current = current.data;
        } else {
            break;
        }
    }
    return isPlausibleCharacterObject(current) ? current : null;
}

function detectSpec(dataObj) {
    if (dataObj && typeof dataObj === 'object') {
        const spec = dataObj.spec;
        if (typeof spec === 'string' && /^chara_card_v[23]$/.test(spec)) return spec;
        if (dataObj.data && typeof dataObj.data === 'object' && typeof dataObj.data.spec === 'string') {
            const s = dataObj.data.spec;
            if (/^chara_card_v[23]$/.test(s)) return s;
        }
        if (typeof spec === 'string' && spec) return spec;
    }
    return 'unknown';
}

/**
 * 按 BOM 选择解码器（UTF-8 / UTF-16LE / UTF-16BE），并兜底去掉残留 BOM。
 * 真实卡片里 UTF-16 + BOM 的导出并不少见（部分 Windows 工具/表格导出）。
 */
function decodeText(bytes) {
    let text;
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        text = new TextDecoder('utf-8').decode(bytes.subarray(3));
    } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
        text = new TextDecoder('utf-16le').decode(bytes.subarray(2));
    } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
        text = new TextDecoder('utf-16be').decode(bytes.subarray(2));
    } else {
        text = new TextDecoder('utf-8').decode(bytes);
    }
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * JSON 字节 → { spec, data, blocks, features }
 * @param {Uint8Array} bytes
 */
export function parseJson(bytes) {
    let text = decodeText(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        throw Object.assign(new Error(`JSON 解析失败：${err.message}`), { code: 'PARSE_FAILED', stage: 'parse' });
    }

    const data = unwrap(parsed);
    if (!data) {
        throw Object.assign(new Error('JSON 对象中未找到可识别的角色数据（name/spec/description 均缺失）'), { code: 'INVALID_CHARACTER' });
    }

    let spec = detectSpec(parsed);
    let character = data;
    if (isPlausibleCharacterObject(data)
        && data.data && typeof data.data === 'object'
        && typeof data.spec === 'string') {
        character = data.data;
    }
    if (spec === 'unknown') spec = detectSpec(character);

    return { spec, data: character, blocks: [], features: ['json'] };
}

export { isPlainObject };
