// SPDX-License-Identifier: AGPL-3.0-or-later
// local/png-rewrite.js —— 只改 PNG 文本块（chara/ccv3），其余字节原样
//
// 用途：导入前把 scriptName 写进卡数据，这样酒馆导入时就带着名字，
// **导入后不需要再写一次角色卡**（避免多余的角色重载 / 正文重渲染）。
//
// 安全边界：
//   - 只处理文本块 tEXt / zTXt / iTXt；图像相关块（IHDR/IDAT/IEND 等）一个字节都不改
//   - 只替换关键字为 chara / ccv3 的块；其余文本块原样保留
//   - 仅当 transform 真的改动了 JSON 时才重建该块（否则整张图原样返回）
//   - 重建时重算该块 CRC32

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TEXT_CHUNK_TYPES = new Set(['tEXt', 'zTXt', 'iTXt']);
const CARD_KEYWORDS = new Set(['chara', 'ccv3']);

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(bytes) {
    let c = -1;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

export function isPngBytes(bytes) {
    if (!bytes || bytes.length < 8) return false;
    for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
    return true;
}

async function inflate(payload) {
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    void writer.write(payload).then(() => writer.close()).catch(() => { });
    const reader = ds.readable.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > 32 * 1024 * 1024) throw new Error('解压超出上限');
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
}

async function deflate(payload) {
    const cs = new CompressionStream('deflate');
    const writer = cs.writable.getWriter();
    void writer.write(payload).then(() => writer.close()).catch(() => { });
    const reader = cs.readable.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
}

/** base64 字符串 → 字节 */
function base64ToBytes(text) {
    const cleaned = String(text).replace(/[^A-Za-z0-9+/=]/g, '');
    const bin = atob(cleaned);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** 字节 → base64（分段避免栈溢出） */
function bytesToBase64(bytes) {
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(binary);
}

/** 解出文本块里的关键字与「内容字节」 */
async function decodeChunk(type, data) {
    let nullIndex = -1;
    for (let i = 0; i < data.length; i++) {
        if (data[i] === 0) { nullIndex = i; break; }
    }
    if (nullIndex < 0) return null;
    const keyword = decoder.decode(data.subarray(0, nullIndex));

    if (type === 'tEXt') {
        return { keyword, payloadText: decoder.decode(data.subarray(nullIndex + 1)), encoding: 'text' };
    }

    if (type === 'zTXt') {
        const method = data[nullIndex + 1];
        if (method !== 0) return null;
        const raw = await inflate(data.subarray(nullIndex + 2));
        return { keyword, payloadText: decoder.decode(raw), encoding: 'z' };
    }

    // iTXt: keyword\0 flag method lang\0 translated\0 payload
    let cursor = nullIndex + 1;
    const flag = data[cursor];
    const method = data[cursor + 1];
    cursor += 2;
    for (let i = 0; i < 2; i++) {
        while (cursor < data.length && data[cursor] !== 0) cursor++;
        cursor++;
    }
    let payload = data.subarray(cursor);
    if (flag === 1) {
        if (method !== 0) return null;
        payload = await inflate(payload);
    }
    return { keyword, payloadText: decoder.decode(payload), encoding: flag === 1 ? 'itxt-z' : 'itxt' };
}

/** 由关键字 + 文本内容重建块数据（按原编码方式） */
async function encodeChunk(type, keyword, text, encoding) {
    const keywordBytes = encoder.encode(keyword);
    const payloadBytes = encoder.encode(text);

    if (type === 'tEXt') {
        const out = new Uint8Array(keywordBytes.length + 1 + payloadBytes.length);
        out.set(keywordBytes, 0);
        out[keywordBytes.length] = 0;
        out.set(payloadBytes, keywordBytes.length + 1);
        return out;
    }

    if (type === 'zTXt') {
        const compressed = await deflate(payloadBytes);
        const out = new Uint8Array(keywordBytes.length + 2 + compressed.length);
        out.set(keywordBytes, 0);
        out[keywordBytes.length] = 0;
        out[keywordBytes.length + 1] = 0; // compression method 0
        out.set(compressed, keywordBytes.length + 2);
        return out;
    }

    // iTXt: keyword \0 flag method langtag\0 translated\0 text
    const compressed = encoding === 'itxt-z';
    const body = compressed ? await deflate(payloadBytes) : payloadBytes;
    const out = new Uint8Array(keywordBytes.length + 5 + body.length);
    let offset = 0;
    out.set(keywordBytes, offset); offset += keywordBytes.length;
    out[offset++] = 0;                    // keyword 结束
    out[offset++] = compressed ? 1 : 0;   // compression flag
    out[offset++] = 0;                    // compression method
    out[offset++] = 0;                    // language tag（空）结束
    out[offset++] = 0;                    // translated keyword（空）结束
    out.set(body, offset);
    return out;
}

/**
 * 重写 PNG 里的 chara/ccv3 文本块。
 * @param {Uint8Array} bytes 原始 PNG
 * @param {(cardJson: object) => {changed: boolean}} transform 就地修改卡 JSON
 * @returns {Promise<{bytes: Uint8Array, changed: boolean, blocks: number}>}
 */
export async function rewriteCardTextChunks(bytes, transform) {
    if (!isPngBytes(bytes)) return { bytes, changed: false, blocks: 0 };

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const parts = [bytes.subarray(0, 8)];   // 签名原样
    let offset = 8;
    let changedAny = false;
    let touched = 0;
    let sawCardBlock = false;

    while (offset + 12 <= bytes.length) {
        const length = view.getUint32(offset);
        const typeStart = offset + 4;
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > bytes.length) {
            // 截断：剩余原样收尾
            parts.push(bytes.subarray(offset));
            offset = bytes.length;
            break;
        }

        let type = '';
        for (let i = 0; i < 4; i++) type += String.fromCharCode(bytes[typeStart + i]);
        const originalChunk = bytes.subarray(offset, dataEnd + 4);

        if (!TEXT_CHUNK_TYPES.has(type)) {
            parts.push(originalChunk);
            offset = dataEnd + 4;
            continue;
        }

        const data = bytes.subarray(dataStart, dataEnd);
        const decoded = await decodeChunk(type, data).catch(() => null);
        if (!decoded || !CARD_KEYWORDS.has(decoded.keyword)) {
            parts.push(originalChunk);
            offset = dataEnd + 4;
            continue;
        }
        sawCardBlock = true;

        // 内容可能是 base64 的 JSON，也可能是纯 JSON 文本
        let cardJson = null;
        let viaBase64 = false;
        try {
            cardJson = JSON.parse(decoder.decode(base64ToBytes(decoded.payloadText)));
            viaBase64 = true;
        } catch {
            try { cardJson = JSON.parse(decoded.payloadText); } catch { cardJson = null; }
        }
        if (!cardJson || typeof cardJson !== 'object') {
            parts.push(originalChunk);
            offset = dataEnd + 4;
            continue;
        }

        const result = transform(cardJson) || { changed: false };
        if (!result.changed) {
            parts.push(originalChunk);
            offset = dataEnd + 4;
            continue;
        }

        const jsonText = JSON.stringify(cardJson);
        const payloadText = viaBase64 ? bytesToBase64(encoder.encode(jsonText)) : jsonText;
        const newData = await encodeChunk(type, decoded.keyword, payloadText, decoded.encoding);

        const chunk = new Uint8Array(12 + newData.length);
        const chunkView = new DataView(chunk.buffer);
        chunkView.setUint32(0, newData.length);
        for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
        chunk.set(newData, 8);
        const crcInput = chunk.subarray(4, 8 + newData.length);
        chunkView.setUint32(8 + newData.length, crc32(crcInput));

        parts.push(chunk);
        changedAny = true;
        touched += 1;
        offset = dataEnd + 4;
    }

    if (!changedAny) return { bytes, changed: false, blocks: 0 };
    if (!sawCardBlock) return { bytes, changed: false, blocks: 0 };

    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const part of parts) { out.set(part, cursor); cursor += part.length; }
    return { bytes: out, changed: true, blocks: touched };
}
