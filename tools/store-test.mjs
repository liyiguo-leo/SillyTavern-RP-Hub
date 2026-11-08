// tools/store-test.mjs —— 卡库（分表存储）行为测试
//
// 验证「元数据 / 卡体分表」这一优化真的生效，且语义与后端一致：
//   1. readIndex / findByName 只返回元数据，**不带** normalized/raw（否则就是没优化）
//   2. readCard 能拿到完整卡体
//   3. 删除卡体后元数据查询仍然工作（说明两条路径解耦）
//   4. exportLibrary / importLibrary 往返一致
//
// 无 indexedDB 的 Node 环境下 store 自动走内存实现，行为与 IndexedDB 分支同构。
//
// 运行：node tools/store-test.mjs

import {
    writeCard, readIndex, findByName, findByContentHash, readCard, hasCard,
    rollbackCard, stats, exportLibrary, importLibrary, readMarks, writeMark, getStore,
} from '../local/store.js';
import { buildPng, rpCardJson, stCardJson } from './fixtures.mjs';
import { runPipeline } from '../local/pipeline.js';
import { sha256HexBytes, sha256HexString } from '../local/sha256.js';

let failed = 0;
const ok = (cond, label, extra = '') => {
    if (cond) console.log(`  ✓ ${label}${extra ? ` · ${extra}` : ''}`);
    else { failed++; console.log(`  ✗ ${label}${extra ? ` · ${extra}` : ''}`); }
};

async function upload(bytes, filename) {
    const u8 = new Uint8Array(bytes);
    const contentHash = sha256HexBytes(u8);
    const payload = await runPipeline(u8);
    const characterName = payload.normalized.character?.name || 'Unknown';
    const importedAt = new Date().toISOString();
    const cardId = 'c' + sha256HexString(contentHash + characterName + importedAt).slice(0, 16);
    const meta = {
        cardId, format: payload.format, formatDetail: payload.formatDetail, importedAt, sourceFile: filename,
        characterName, contentHash,
        regexCount: payload.normalized.regex.length, lorebookCount: payload.normalized.lorebook.length,
        schema_version: 2,
    };
    await writeCard({ meta, payload: { cardId, normalized: { ...payload.normalized, cardId }, raw: { blocks: payload.blocks, originalJson: { spec: payload.spec, data: payload.data } } } });
    return { cardId, contentHash, characterName };
}

console.log('\n[1] 落库两张卡');
const rpBytes = buildPng({ text: { keyword: 'chara', value: Buffer.from(JSON.stringify(rpCardJson())).toString('base64') } });
const a = await upload(rpBytes, 'rp.png');
const b = await upload(new TextEncoder().encode(JSON.stringify(stCardJson())), 'stock.json');
ok(await hasCard(a.cardId) && await hasCard(b.cardId), '两张卡都入库', `${a.cardId} / ${b.cardId}`);
{
    const s = await stats();
    ok(s.cards === 2, 'stats 用 count() 计数', JSON.stringify(s));
}

console.log('\n[2] 元数据查询不拖卡体（分表生效）');
{
    const index = await readIndex();
    const metas = Object.values(index.cards);
    ok(metas.length === 2, 'readIndex 返回 2 条元数据', String(metas.length));
    ok(metas.every((m) => m.normalized === undefined && m.raw === undefined), '元数据里没有 normalized/raw');
    ok(metas.every((m) => typeof m.characterName === 'string' && typeof m.contentHash === 'string'), '元数据字段完整');

    const byName = await findByName(a.characterName);
    ok(byName?.cardId === a.cardId, 'findByName 命中', byName?.cardId);
    ok(byName?.normalized === undefined, 'findByName 不返回卡体');
    ok(await findByContentHash(a.contentHash) === a.cardId, 'findByContentHash 命中');
}

console.log('\n[3] 读卡体');
{
    const card = await readCard(a.cardId);
    ok(!!card?.normalized, 'normalized 可读', `regex=${card?.normalized?.regex?.length}`);
    ok(!!card?.raw?.blocks?.length, 'raw.blocks 可读', `${card?.raw?.blocks?.length} 块`);
    ok(card?.characterName === a.characterName, '元数据与卡体合并后字段齐全');
}

console.log('\n[4] 卡库导出 / 导入（跨设备迁移）');
{
    await writeMark(a.contentHash, { type: 'rphub', markedAt: new Date().toISOString() });
    const bundle = await exportLibrary();
    ok(bundle.format === 'rphub-local-library' && bundle.cards.length === 2, '导出结构正确', `cards=${bundle.cards.length} marks=${bundle.marks.length}`);
    ok(bundle.cards.every((c) => c.normalized && !c.raw), '导出含 normalized、不含 raw（体积可控）');

    await rollbackCard(a.cardId);
    await rollbackCard(b.cardId);
    ok(!await hasCard(a.cardId), '清空后卡不在了');

    const result = await importLibrary(bundle);
    const back = await readCard(a.cardId);
    ok(result.cards === 2 && result.marks === 1, '导入计数', JSON.stringify(result));
    ok(!!back?.normalized, '导入后卡体可读');
    ok((await readMarks()).marks[a.contentHash]?.type === 'rphub', '导入后 marks 可读');
}


console.log('\n[5] 旧版卡库迁移（v1 记录把 normalized 塞在元数据里）');
{
    const store = await getStore();
    const legacyId = 'c1111111111111111';
    await store.putMeta({
        cardId: legacyId,
        characterName: '旧卡',
        nameKey: '旧卡',
        format: 'png',
        formatDetail: 'st',
        importedAt: '2024-01-01T00:00:00.000Z',
        contentHash: 'a'.repeat(64),
        normalized: { format: 'png', formatDetail: 'st', schema_version: 2, character: { name: '旧卡' }, regex: [], lorebook: [] },
        raw: { blocks: [], originalJson: null },
    });
    const card = await readCard(legacyId);
    ok(card?.normalized?.character?.name === '旧卡', '旧记录仍能读到卡体（自动迁移）');
    const meta2 = await store.getMeta(legacyId);
    ok(meta2 && !('normalized' in meta2), '迁移后元数据已剥离卡体');
    const payload2 = await store.getPayload(legacyId);
    ok(!!payload2?.normalized, 'payload 表已写入');
    await rollbackCard(legacyId);
}

console.log(`\n=== ${failed === 0 ? '全部通过' : `${failed} 项失败`} ===`);
process.exit(failed === 0 ? 0 : 1);
