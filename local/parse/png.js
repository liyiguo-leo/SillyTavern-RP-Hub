// SPDX-License-Identifier: AGPL-3.0-or-later
// local/parse/png.js —— 后端 lib/parse/png.js 的浏览器版
//
// 与后端逐条对齐，只把 node:zlib 换成 DecompressionStream('deflate')：
//   tEXt：keyword\0content（content 为 Latin-1 文本，按 UTF-8 读取兼容中文字段）
//   zTXt：keyword\0<压缩方法 1 字节> + zlib 压缩内容
//   iTXt：keyword\0<压缩标志>\0<压缩方法>\0<语言标签>\0<翻译关键字>\0 + 内容
// 因此解析变为 async（其余语义、限制、优先级完全一致）。

const TEXT_CHUNK_TYPES = new Set(['tEXt', 'zTXt', 'iTXt']);
const MAX_CHUNK_LENGTH = 32 * 1024 * 1024;
const MAX_CHUNKS_COUNT = 1000;
const MAX_INFLATE_LENGTH = 16 * 1024 * 1024;

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const decoder = new TextDecoder('utf-8');

export function isPng(bytes) {
    if (!bytes || bytes.length < 8) return false;
    for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
    return true;
}

/** zlib 解压（浏览器内置 DecompressionStream；流式读取 + 上限保护，避免一次性翻倍占用） */
async function inflate(payload) {
    if (typeof DecompressionStream !== 'function') {
        throw new Error('当前环境不支持 DecompressionStream（无法解压 zTXt/iTXt）');
    }
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    // 写入与读取并行：payload 可能是几十 MB 的文本块，先灌后读会在管道缓冲区阻塞
    void writer.write(payload).then(() => writer.close()).catch(() => { /* 解压失败由 reader 侧抛出 */ });

    const reader = ds.readable.getReader();
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > MAX_INFLATE_LENGTH) {
                await reader.cancel().catch(() => {});
                throw new Error('解压结果超出上限（疑似压缩炸弹）');
            }
            chunks.push(value);
        }
    } finally {
        try { reader.releaseLock(); } catch { /* 忽略 */ }
    }

    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
}

async function decodeTextChunk(type, data) {
    let nullIdx = -1;
    for (let i = 0; i < data.length; i++) {
        if (data[i] === 0) { nullIdx = i; break; }
    }
    if (nullIdx === -1) return null;
    const keyword = decoder.decode(data.subarray(0, nullIdx));
    let content = null;

    if (type === 'tEXt') {
        content = decoder.decode(data.subarray(nullIdx + 1));
    } else if (type === 'zTXt') {
        if (nullIdx + 2 > data.length) return { keyword, content: null, compressed: true };
        const method = data[nullIdx + 1];
        const payload = data.subarray(nullIdx + 2);
        if (method !== 0) return { keyword, content: null, compressed: true };
        try {
            content = decoder.decode(await inflate(payload));
        } catch {
            return { keyword, content: null, compressed: true };
        }
    } else if (type === 'iTXt') {
        let cursor = nullIdx + 1;
        if (cursor >= data.length) return { keyword, content: null };
        const compressionFlag = data[cursor];
        cursor += 1;
        if (cursor >= data.length) return { keyword, content: null };
        const compressionMethod = data[cursor];
        cursor += 1;

        for (let i = 0; i < 2; i++) {
            while (cursor < data.length && data[cursor] !== 0) cursor++;
            if (cursor >= data.length) return { keyword, content: null };
            cursor += 1;
        }

        const payload = data.subarray(cursor);
        if (compressionFlag === 1) {
            if (compressionMethod !== 0) return { keyword, content: null, compressed: true };
            try {
                content = decoder.decode(await inflate(payload));
            } catch {
                content = null;
            }
        } else {
            content = decoder.decode(payload);
        }
    }
    return { keyword, content };
}

/**
 * 解析 PNG 字节 → 文本块清单。
 * @param {Uint8Array} bytes
 * @returns {Promise<Array<{keyword:string, content:string|null, chunkType:string}>>}
 */
export async function extractPngBlocks(bytes) {
    const blocks = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8;
    const len = bytes.length;
    let chunkCount = 0;
    while (offset + 12 <= len) {
        chunkCount++;
        if (chunkCount > MAX_CHUNKS_COUNT) break;

        const length = view.getUint32(offset);
        if (length > MAX_CHUNK_LENGTH) break;

        let type = '';
        for (let i = 0; i < 4; i++) type += String.fromCharCode(bytes[offset + 4 + i]);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > len) break;
        if (TEXT_CHUNK_TYPES.has(type)) {
            const decoded = await decodeTextChunk(type, bytes.subarray(dataStart, dataEnd));
            if (decoded && decoded.keyword) {
                blocks.push({ keyword: decoded.keyword, content: decoded.content, chunkType: type });
            }
        }
        offset = dataEnd + 4;
    }
    return blocks;
}

function findCharaBlock(blocks) {
    // ccv3 优先（与 ST 本体 character-card-parser.js 一致：V3 卡双块并存时以 ccv3 为准）
    for (const b of blocks) if (b.keyword === 'ccv3') return b;
    for (const b of blocks) if (b.keyword === 'chara') return b;
    return null;
}

/** base64（宽松：先剔除非法字符，贴近 Buffer.from(x,'base64') 的宽容度） */
function base64Decode(text) {
    const cleaned = String(text).replace(/[^A-Za-z0-9+/=]/g, '');
    const bin = atob(cleaned);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** chara 块内容解码：base64 JSON 优先，失败回退纯 UTF-8 文本（支持去除 BOM） */
export function decodeCharaContent(content) {
    if (typeof content !== 'string') return null;
    try {
        let text = decoder.decode(base64Decode(content));
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        return { parsed: JSON.parse(text), viaBase64: true };
    } catch {
        // 落回纯文本
    }
    try {
        let text = content;
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        return { parsed: JSON.parse(text), viaBase64: false };
    } catch {
        return null;
    }
}

export function detectSpec(dataObj) {
    if (dataObj && typeof dataObj === 'object') {
        const spec = dataObj.spec;
        if (typeof spec === 'string' && /^chara_card_v[23]$/.test(spec)) return spec;
        if (dataObj.data && typeof dataObj.data === 'object' && typeof dataObj.data.spec === 'string') {
            const s = dataObj.data.spec;
            if (/^chara_card_v[23]$/.test(s)) return s;
        }
        if (dataObj.spec === 'rphub' || dataObj.rp_hub_export === true) return 'rphub_export';
        if (typeof spec === 'string' && spec) return spec;
    }
    return 'unknown';
}

/** PNG → { spec, data, blocks, features } */
export async function parsePng(bytes) {
    const blocks = await extractPngBlocks(bytes);
    if (blocks.length === 0) {
        throw Object.assign(new Error('PNG 块提取失败：未找到任何文本块'), { code: 'PARSE_FAILED', stage: 'extract' });
    }

    const charaBlock = findCharaBlock(blocks);
    if (!charaBlock) {
        throw Object.assign(new Error('PNG 块提取失败：缺少 chara / ccv3 块'), { code: 'PARSE_FAILED', stage: 'extract' });
    }

    const decoded = decodeCharaContent(charaBlock.content);
    if (!decoded) {
        throw Object.assign(new Error('chara 块内容无法解码为 JSON（base64 与纯文本均失败）'), { code: 'PARSE_FAILED', stage: 'parse' });
    }

    let dataObj = decoded.parsed;
    let spec = detectSpec(dataObj);
    if (dataObj && typeof dataObj === 'object' && 'data' in dataObj && dataObj.data && typeof dataObj.data === 'object') {
        dataObj = dataObj.data;
        if (spec === 'unknown') spec = detectSpec(dataObj);
    }

    return { spec, data: dataObj, blocks, features: ['png', 'chara_block'] };
}
