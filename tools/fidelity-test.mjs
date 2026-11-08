// tools/fidelity-test.mjs —— 本地（浏览器）实现 vs 真后端：规范化结果逐字段对拍
//
// 意义：整合后同一个仓库里有两份"解析/归一"实现——server/（Node）与 local/（浏览器）。
// 一旦两者语义漂移，同一张卡在「有插件」和「没插件」的机器上会被判成不同模式、产出不同
// cardId/marks。本脚本就是防漂移闸门：清空差异才算过。
//
// 运行：node tools/fidelity-test.mjs

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { runPipeline as runBackend } from '../../_ref/backend/lib/pipeline.js';
import { runPipeline as runLocal } from '../local/pipeline.js';
import { buildPng, rpCardJson, stCardJson } from './fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_ST_CARD = path.join(__dirname, '../../_ref/rphub/示例/角色卡示例/角色卡示例.png');

function diff(a, b, at = '$', out = []) {
    if (a === b) return out;
    const ta = Object.prototype.toString.call(a);
    const tb = Object.prototype.toString.call(b);
    if (ta !== tb) { out.push(`${at}: 类型不同 ${ta} vs ${tb}`); return out; }
    if (Array.isArray(a)) {
        if (a.length !== b.length) out.push(`${at}: 长度不同 ${a.length} vs ${b.length}`);
        for (let i = 0; i < Math.max(a.length, b.length); i++) diff(a[i], b[i], `${at}[${i}]`, out);
        return out;
    }
    if (a && typeof a === 'object') {
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], `${at}.${k}`, out);
        return out;
    }
    if (Number.isNaN(a) && Number.isNaN(b)) return out;
    out.push(`${at}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    return out;
}

const rp = rpCardJson();
const rpB64 = Buffer.from(JSON.stringify(rp), 'utf8').toString('base64');

const cases = [];
if (fs.existsSync(SAMPLE_ST_CARD)) {
    cases.push({ name: '真实酒馆 V3 角色卡 PNG（chara + ccv3 双块）', bytes: fs.readFileSync(SAMPLE_ST_CARD), expect: 'st' });
}
cases.push({ name: '普通 ST 卡 JSON（必须让位）', bytes: Buffer.from(JSON.stringify(stCardJson()), 'utf8'), expect: 'st' });
cases.push({ name: '合成 RP 卡（chara_card_v3 包裹 JSON）', bytes: Buffer.from(JSON.stringify(rp), 'utf8'), expect: 'rphub' });
cases.push({ name: '合成 RP 卡（角色对象直出 JSON）', bytes: Buffer.from(JSON.stringify(rp.data), 'utf8'), expect: 'rphub' });
cases.push({ name: '合成 RP 卡 PNG（tEXt 未压缩块）', bytes: buildPng({ text: { keyword: 'chara', value: rpB64 } }), expect: 'rphub' });
cases.push({ name: '合成 RP 卡 PNG（zTXt zlib 压缩块）', bytes: buildPng({ ztxt: { keyword: 'chara', value: rpB64 } }), expect: 'rphub' });
cases.push({ name: '合成 RP 卡 PNG（iTXt 压缩块 + ccv3）', bytes: buildPng({ itxt: { keyword: 'ccv3', value: rpB64, compressed: true } }), expect: 'rphub' });

let failed = 0;
for (const c of cases) {
    let a, b, errA = null, errB = null;
    try { a = runBackend(c.bytes); } catch (e) { errA = e; }
    try { b = await runLocal(new Uint8Array(c.bytes)); } catch (e) { errB = e; }

    if (errA || errB) {
        failed++;
        console.log(`\n✗ ${c.name}\n  后端: ${errA ? errA.message : 'ok'} | 本地: ${errB ? errB.message : 'ok'}`);
        continue;
    }

    const d = [
        ...diff(a.format, b.format, 'format'),
        ...diff(a.spec, b.spec, 'spec'),
        ...diff(a.formatDetail, b.formatDetail, 'formatDetail'),
        ...diff(a.features, b.features, 'features'),
        ...diff(a.normalized, b.normalized, 'normalized'),
    ];
    const ok = d.length === 0 && b.formatDetail === c.expect;
    if (!ok) failed++;

    console.log(`\n${ok ? '✓' : '✗'} ${c.name}`);
    console.log(`  format=${b.format} spec=${b.spec} formatDetail=${b.formatDetail}（期望 ${c.expect}）`
        + ` regex=${b.normalized.regex.length} lorebook=${b.normalized.lorebook.length}`
        + ` uiTemplates=${b.normalized.variables?.uiTemplates?.length ?? 0}`
        + ` mapping=${JSON.stringify(b.normalized.mappingSummary)}`);
    if (d.length) {
        console.log(`  规范化结果存在 ${d.length} 处差异（显示前 12 条）：`);
        for (const line of d.slice(0, 12)) console.log(`   - ${line}`);
    }
}

// contentHash 必须与后端 createHash('sha256') 逐字节一致（marks 的键）
{
    const bytes = fs.existsSync(SAMPLE_ST_CARD) ? fs.readFileSync(SAMPLE_ST_CARD) : Buffer.from('{}');
    const backendHash = crypto.createHash('sha256').update(bytes).digest('hex');
    const { sha256HexBytes } = await import('../local/sha256.js');
    const localHash = sha256HexBytes(new Uint8Array(bytes));
    const ok = backendHash === localHash;
    if (!ok) failed++;
    console.log(`\n${ok ? '✓' : '✗'} sha256 与 node:crypto 一致（${localHash.slice(0, 16)}…）`);
}

console.log(`\n=== ${failed === 0 ? `全部通过（${cases.length + 1} 项）` : `${failed} 项失败`} ===`);
process.exit(failed === 0 ? 0 : 1);
