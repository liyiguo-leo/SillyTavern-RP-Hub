// SPDX-License-Identifier: AGPL-3.0-or-later
// local/pipeline.js —— 上传/分析共享管线：嗅探 → 解析 → 语义判定 → 规范化
//
// 与后端 lib/pipeline.js 同构；仅 parsePng 变 async（浏览器解压走 DecompressionStream）。

import { parsePng, isPng } from './parse/png.js';
import { parseJson } from './parse/json.js';
import { detectFormatDetail } from './detect.js';
import { buildNormalized } from './normalize/index.js';
import { isPlainObject } from './util.js';

const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0c]);

/**
 * 格式嗅探：只依据字节魔数，不看文件名。
 *
 * BOM 处理（v2 修复）：很多 Windows 工具导出的卡片 JSON 带 UTF-8 / UTF-16 BOM，
 * 旧实现只看首字节 → 0xEF / 0xFF 既不等于 `{` 也不等于 `[`，直接判成“未知格式”→ 422。
 * 现在先跳过 BOM，UTF-16 直接按 JSON 处理（parseJson 会按 BOM 选解码器）。
 */
export function sniffFormat(bytes) {
    if (isPng(bytes)) return 'png';

    let start = 0;
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        start = 3; // UTF-8 BOM
    } else if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
        return 'json'; // UTF-16（LE/BE）BOM：只可能是文本卡
    }

    while (start < bytes.length && WHITESPACE.has(bytes[start])) start++;
    if (start >= bytes.length) return null;
    const first = bytes[start];
    if (first === 0x7b || first === 0x5b) return 'json';
    if (first === 0x3c) return 'html';
    return null;
}

/**
 * 完整分析管道。
 * @param {Uint8Array|ArrayBuffer} input 原始字节
 * @param {'rphub'} [forcedFormatDetail] 手动标记强制结果
 */
export async function runPipeline(input, forcedFormatDetail) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const format = sniffFormat(bytes);
    if (format === null || format === 'html') {
        throw Object.assign(new Error('不支持的卡片格式（既不是 PNG 也不是 JSON）'), { code: 'UNSUPPORTED_FORMAT' });
    }

    const parsed = format === 'png' ? await parsePng(bytes) : parseJson(bytes);

    if (!isPlainObject(parsed.data)) {
        throw Object.assign(new Error('卡数据不是有效的 JSON 对象'), { code: 'PARSE_FAILED', stage: 'parse' });
    }

    let { formatDetail, features } = detectFormatDetail(parsed.data, parsed.blocks, { spec: parsed.spec });
    if (forcedFormatDetail === 'rphub') formatDetail = 'rphub';

    const allFeatures = [...parsed.features, ...features].filter((f, i, arr) => arr.indexOf(f) === i);
    const normalized = buildNormalized(parsed, formatDetail);

    return {
        format,
        spec: parsed.spec,
        data: parsed.data,
        blocks: parsed.blocks,
        features: allFeatures,
        formatDetail,
        normalized,
    };
}
