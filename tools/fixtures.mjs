// tools/fixtures.mjs —— 测试样本构造（对拍/接口测试共用）

import zlib from 'node:zlib';

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

export function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 构造最小可用 PNG（1x1 RGBA），按需附加 tEXt / zTXt / iTXt 文本块 */
export function buildPng({ text = null, ztxt = null, itxt = null } = {}) {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const idat = zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0]));
    const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat)];

    const latin = (s) => Buffer.from(s, 'latin1');

    if (text) parts.push(chunk('tEXt', Buffer.concat([latin(`${text.keyword}\0`), Buffer.from(text.value, 'utf8')])));
    if (ztxt) {
        const payload = zlib.deflateSync(Buffer.from(ztxt.value, 'utf8'));
        parts.push(chunk('zTXt', Buffer.concat([latin(`${ztxt.keyword}\0`), Buffer.from([0]), payload])));
    }
    if (itxt) {
        const payload = Buffer.from(itxt.value, 'utf8');
        parts.push(chunk('iTXt', Buffer.concat([
            latin(`${itxt.keyword}\0`),
            Buffer.from([itxt.compressed ? 1 : 0, 0]),
            latin('\0'),
            latin('\0'),
            itxt.compressed ? zlib.deflateSync(payload) : payload,
        ])));
    }
    parts.push(chunk('IEND', Buffer.alloc(0)));
    return Buffer.concat(parts);
}

/** 合成 RP-Hub 卡数据：覆盖正则三来源、位置字符串、变量模板、未映射字段等归一分支 */
export function rpCardJson() {
    return {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {
            name: '对拍用RP卡',
            description: '合成样本：覆盖 RP-Hub 的全部归一分支',
            personality: '冷静',
            scenario: '测试',
            first_mes: '<div class="ui">{{getvar::hp}}</div>',
            mes_example: '',
            creator_notes: '仅用于对拍',
            system_prompt: '',
            post_history_instructions: '',
            tags: ['测试', 'rphub'],
            creator: 'fidelity-test',
            character_version: '1.0',
            extensions: {
                rp_hub_watermark: 'RP-Hub',
                regex_scripts: [
                    { name: 'ST侧同正则', findRegex: '/<hp>(.*?)<\\/hp>/gs', replaceString: 'HP=$1', placement: [2] },
                    { name: '仅ST', findRegex: '\\[st-only\\]', replaceString: '', disabled: true },
                ],
                talkativeness: 0.5,
            },
            regex_scripts: [
                { name: 'ST侧同正则', findRegex: '/<hp>(.*?)<\\/hp>/gs', replaceString: 'HP=$1', placement: [2] },
                { name: 'RP更新块', findRegex: '<UpdateVariable>[\\s\\S]*?</UpdateVariable>', replaceString: '', markdownOnly: true },
                { name: 'NAI画图正则', regex: '/(?s)foo(bar)/', replacement: 'baz', scope: 'global' },
            ],
            rp_hub_regex_scripts: [
                { scriptName: '占位空', findRegex: '', replaceString: 'x', minDepth: 0 },
            ],
            uiTemplates: [
                {
                    name: '状态栏',
                    initialVariableState: { hp: 100, mp: 20, bag: { gold: 5 } },
                    variableSchema: { hp: 'number' },
                },
                { name: '空模板' },
            ],
            runtimeByCharacter: { hp: 88 },
            character_book: {
                name: '对拍世界书',
                entries: [
                    { keys: ['hp', '血量'], content: '血量说明', position: 'before_char', depth: 2, constant: true },
                    { key: '唤醒,觉知', content: 'trigger', position: 4, enabled: false, exclude_recursion: true, probability: 60 },
                    { comment: '无名条目', content: 'x', position: 'unknown_position', disable: true },
                ],
            },
            create_date: '2026-01-01T00:00:00.000Z',
            unknown_field_keep_me: { a: 1 },
        },
    };
}

/** 合成普通 ST 卡（无 RP-Hub 字段） */
export function stCardJson() {
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: '普通酒馆卡',
            description: 'stock',
            personality: '',
            scenario: '',
            first_mes: 'hi',
            mes_example: '',
            creator_notes: '',
            system_prompt: '',
            post_history_instructions: '',
            tags: [],
            extensions: { talkativeness: '0.5' },
        },
    };
}
