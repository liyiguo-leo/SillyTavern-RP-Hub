// tools/regex-names-test.mjs —— 正则命名功能的回归测试
//
// 关注两件事：
//   1. 命名规则本身（分类、序号、确定性、不覆盖已有名字）
//   2. 导入前改写 PNG 的**边界**：图像块必须一字不动，只改 chara/ccv3 文本块
//
// 运行：node tools/regex-names-test.mjs

import fs from 'node:fs';

// card-bytes 会读 localStorage（浏览器环境），Node 里给个最小实现
globalThis.localStorage = {
    _v: null,
    getItem() { return this._v; },
    setItem(_k, v) { this._v = v; },
    removeItem() { this._v = null; },
};

const { buildRegexNames, classifyRegex, nameRegexScriptsInCard, looksLikeRpHubCard } = await import('../local/regex-names.js');
const { prepareCardBytes } = await import('../local/card-bytes.js');
const { parsePng } = await import('../local/parse/png.js');
const { buildPng } = await import('./fixtures.mjs');

let failed = 0;
const ok = (cond, label, extra = '') => {
    if (cond) console.log(`  ✓ ${label}${extra ? ` · ${extra}` : ''}`);
    else { failed++; console.log(`  ✗ ${label}${extra ? ` · ${extra}` : ''}`); }
};

/* ---------------- 1. 分类 ---------------- */

console.log('\n[1] 分类规则');
{
    const cases = [
        [{ findRegex: '<UpdateVariable>[\\s\\S]*?</UpdateVariable>', replaceString: '' }, '剥离·变量更新'],
        [{ findRegex: '<StatusPlaceHolderImpl/>', replaceString: '' }, '剥离·状态占位'],
        [{ findRegex: '```html([\\s\\S]*?)```', replaceString: '<div class="panel">$1</div>' }, '结构·界面容器'],
        [{ findRegex: '(.+)', replaceString: '<span style="color: #ff0">$1</span>' }, '样式·颜色'],
        [{ findRegex: '(.+)', replaceString: '<span style="font-size: 14px">$1</span>' }, '样式·字体'],
        [{ findRegex: '(.+)', replaceString: '<div style="display: flex; padding: 4px">$1</div>' }, '样式·布局'],
        [{ findRegex: 'hello', replaceString: 'world', promptOnly: true }, '提示词'],
        [{ findRegex: 'abc', replaceString: 'xyz' }, '替换·abc'],
    ];
    for (const [script, expected] of cases) {
        const actual = classifyRegex(script);
        ok(actual === expected, `${expected}`, actual === expected ? '' : `实际 ${actual}`);
    }
}

/* ---------------- 2. 命名 ---------------- */

console.log('\n[2] 命名与幂等');
{
    const scripts = [
        { findRegex: '(.+)', replaceString: 'color: red' },
        { findRegex: '(.+)', replaceString: 'font-size: 3px' },
        { findRegex: '(.+)', replaceString: 'color: blue' },
        { findRegex: 'x', replaceString: 'y', scriptName: '我自己改的名字' },
    ];
    const names = buildRegexNames(scripts);
    ok(names[0] === 'RP·样式·颜色·01' && names[2] === 'RP·样式·颜色·02', '同类多条自动编号', names.join(' | '));
    ok(names[3] === 'RP·替换·x' || names[3].startsWith('RP·'), '第 4 条也生成了名字', names[3]);

    const card = { extensions: { rp_hub_watermark: 'RP-Hub', regex_scripts: scripts.map((s) => ({ ...s })) } };
    const first = nameRegexScriptsInCard(card);
    ok(first.changed === 3, '已有名字的条目不被改写（3/4 被补名）', String(first.changed));
    ok(card.extensions.regex_scripts[3].scriptName === '我自己改的名字', '用户改过的名字保持原样');
    const second = nameRegexScriptsInCard(card);
    ok(second.changed === 0, '第二次执行无变化（幂等）', String(second.changed));

    const again = buildRegexNames(scripts.map((s) => ({ ...s })));
    ok(JSON.stringify(again) === JSON.stringify(names), '同样输入 → 同样名字（确定性）');
}

/* ---------------- 3. 只对 RP 卡生效 ---------------- */

console.log('\n[3] 适用范围');
{
    ok(looksLikeRpHubCard({ extensions: { rp_hub_watermark: 'x' } }), 'rp_hub_watermark → RP 卡');
    ok(looksLikeRpHubCard({ extensions: { rp_hub_ui_templates: [] } }), 'rp_hub_ui_templates → RP 卡');
    ok(!looksLikeRpHubCard({ extensions: { regex_scripts: [] }, name: '普通卡' }), '普通 ST 卡 → 不处理');
}

/* ---------------- 4. PNG 改写边界 ---------------- */

function cardJson() {
    return {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {
            name: '命名测试卡',
            description: 'd',
            extensions: {
                rp_hub_watermark: 'RP-Hub',
                regex_scripts: [
                    { findRegex: '(.+)', replaceString: '<span style="color: red">$1</span>' },
                    { findRegex: '(.+)', replaceString: '<span style="font-size: 12px">$1</span>' },
                    { findRegex: '```html([\\s\\S]*?)```', replaceString: '<div class="panel">$1</div>' },
                ],
            },
        },
    };
}

/** 拆出 PNG 的块清单（type + 原始字节） */
function chunksOf(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = [];
    let offset = 8;
    while (offset + 12 <= bytes.length) {
        const length = view.getUint32(offset);
        const end = offset + 12 + length;
        if (end > bytes.length) break;
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        out.push({ type, raw: Buffer.from(bytes.subarray(offset, end)) });
        offset = end;
    }
    return out;
}

/** 校验某个块的 CRC 是否正确 */
function crcOK(chunkRaw) {
    const table = (() => {
        const t = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            t[n] = c;
        }
        return t;
    })();
    let c = -1;
    const body = Buffer.from(chunkRaw.subarray(4, chunkRaw.length - 4));
    for (let i = 0; i < body.length; i++) c = table[(c ^ body[i]) & 0xff] ^ (c >>> 8);
    const expected = (c ^ -1) >>> 0;
    const actual = chunkRaw.readUInt32BE(chunkRaw.length - 4);
    return expected === actual;
}

const card = cardJson();
const b64 = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');

for (const variant of ['tEXt', 'zTXt']) {
    console.log(`\n[4] PNG 改写（${variant}）`);
    globalThis.localStorage._v = null; // 功能开启

    const png = variant === 'tEXt'
        ? buildPng({ text: { keyword: 'chara', value: b64 } })
        : buildPng({ ztxt: { keyword: 'chara', value: b64 } });

    const before = chunksOf(png);
    const outBytes = await prepareCardBytes(new Uint8Array(png));
    const after = chunksOf(Buffer.from(outBytes));

    const beforeImg = before.filter((c) => !['tEXt', 'zTXt', 'iTXt'].includes(c.type));
    const afterImg = after.filter((c) => !['tEXt', 'zTXt', 'iTXt'].includes(c.type));
    ok(beforeImg.length === afterImg.length && beforeImg.every((c, i) => c.raw.equals(afterImg[i].raw)),
        '图像块（IHDR/IDAT/IEND）字节完全一致');

    const textChunk = after.find((c) => c.type === variant);
    ok(!!textChunk && crcOK(textChunk.raw), `${variant} 块 CRC 校验通过`);

    const parsed = await parsePng(new Uint8Array(outBytes));
    const scripts = parsed.data?.extensions?.regex_scripts || [];
    ok(scripts.length === 3, '正则条数不变', String(scripts.length));
    ok(scripts.every((s) => typeof s.scriptName === 'string' && s.scriptName.startsWith('RP·')), '每条都补上了 RP· 名字',
        scripts.map((s) => s.scriptName).join(' | '));
    ok(scripts[0].findRegex === '(.+)', 'findRegex 未被改动');
}

/* ---------------- 5. JSON 卡 + 开关 ---------------- */

console.log('\n[5] JSON 卡与开关');
{
    globalThis.localStorage._v = null;
    const jsonCard = JSON.stringify(card);
    const out = await prepareCardBytes(new TextEncoder().encode(jsonCard));
    const parsed = JSON.parse(new TextDecoder().decode(out));
    const scripts = parsed.data.extensions.regex_scripts;
    ok(scripts.every((s) => s.scriptName?.startsWith('RP·')), 'JSON 卡同样补名', scripts[0].scriptName);

    globalThis.localStorage._v = '0'; // 关闭功能
    const off = await prepareCardBytes(new TextEncoder().encode(jsonCard));
    ok(Buffer.from(off).equals(Buffer.from(new TextEncoder().encode(jsonCard))), '开关关闭时字节原样返回');
    globalThis.localStorage._v = null;
}

console.log(`\n=== ${failed === 0 ? '全部通过' : `${failed} 项失败`} ===`);
process.exit(failed === 0 ? 0 : 1);
