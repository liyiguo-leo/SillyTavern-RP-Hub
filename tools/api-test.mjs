// tools/api-test.mjs —— 本地后端接口层测试（无需浏览器：store 自动退化为内存库）
//
// 覆盖 RP助手 / RegexPlus 真正会调用的全部端点，校验响应形状与后端契约一致：
//   /cards/analyze → /cards/upload?writeBack=1 → /status → /cards/by-name/:name
//   → /cards/:id/variables?fields=uiTemplates → /cards/exists/:hash
//   → /marks/{hash} PUT/GET/DELETE → by-name 的 marks 兜底 → 普通卡（st）让位
//
// 运行：node tools/api-test.mjs

import { handleRequest, getLastFailure } from '../local/api.js';
import { buildPng, rpCardJson, stCardJson } from './fixtures.mjs';

let failed = 0;
const ok = (cond, label, extra = '') => {
    if (cond) console.log(`  ✓ ${label}${extra ? ` · ${extra}` : ''}`);
    else { failed++; console.log(`  ✗ ${label}${extra ? ` · ${extra}` : ''}`); }
};

const call = (method, path, opts = {}) => handleRequest({
    method,
    path,
    query: new URLSearchParams(opts.query || ''),
    headers: opts.headers || {},
    body: opts.body,
    jsonBody: opts.jsonBody,
    hooks: opts.hooks || {},
});

const rpBytes = new Uint8Array(buildPng({ text: { keyword: 'chara', value: Buffer.from(JSON.stringify(rpCardJson())).toString('base64') } }));
const stBytes = new Uint8Array(new TextEncoder().encode(JSON.stringify(stCardJson())));

console.log('\n[1] analyze —— RP 卡识别（导入拦截的分流依据）');
{
    const res = await call('POST', '/cards/analyze', { headers: { 'x-filename': encodeURIComponent('合成RP卡.png') }, body: rpBytes });
    ok(res.status === 200, 'HTTP 200', `status=${res.status}`);
    ok(res.body.format === 'png', 'format=png', res.body.format);
    ok(res.body.features.some((f) => f.startsWith('rphub_')), 'features 含 rphub_* 特征', res.body.features.join(','));
    ok(/^[0-9a-f]{64}$/.test(res.body.contentHash), 'contentHash 为 64 位十六进制');
    ok(res.body.summary.regex === 5, '归一后正则 5 条（3 来源去重后）', String(res.body.summary.regex));
    ok(res.body.summary.variables === 2, 'uiTemplates 2 个', String(res.body.summary.variables));
}

console.log('\n[2] upload?writeBack=1 —— 入本地库 + 交给 ST 原生导入');
let cardId, contentHash;
{
    let imported = null;
    const res = await call('POST', '/cards/upload', {
        query: 'writeBack=1',
        headers: { 'x-filename': encodeURIComponent('合成RP卡.png') },
        body: rpBytes,
        hooks: { importToSt: async (bytes, filename) => { imported = { size: bytes.length, filename }; return '合成RP卡.png'; } },
    });
    ok(res.status === 200, 'HTTP 200', `status=${res.status}`);
    ok(/^c[0-9a-f]{16}$/.test(res.body.cardId), 'cardId 形状 c+16hex', res.body.cardId);
    ok(res.body.standardCard?.avatar === '合成RP卡.png', 'standardCard.avatar 来自原生导入', JSON.stringify(res.body.standardCard));
    ok(imported?.size === rpBytes.length, '钩子拿到原始字节', `${imported?.size}B / ${imported?.filename}`);
    ok(res.body.summary.counts.lorebook === 3, '世界书 3 条', String(res.body.summary.counts.lorebook));
    cardId = res.body.cardId;
    contentHash = res.body.contentHash;
}

console.log('\n[3] status / by-name / variables / exists —— 面板与引擎的取数链路');
{
    const status = await call('GET', '/status');
    ok(status.body.cards_count === 1, 'cards_count=1', String(status.body.cards_count));
    ok(status.body.backend === 'local', 'backend=local', status.body.backend);

    const byName = await call('GET', `/cards/by-name/${encodeURIComponent('对拍用RP卡')}`, { query: `contentHash=${contentHash}` });
    ok(byName.status === 200 && byName.body.cardId === cardId, 'by-name 命中（含 contentHash 精确匹配）', byName.body.cardId);
    ok(byName.body.formatDetail === 'rphub', 'formatDetail=rphub（引擎走 RP 语义）', byName.body.formatDetail);

    const vars = await call('GET', `/cards/${cardId}/variables`, { query: 'fields=uiTemplates' });
    ok(Array.isArray(vars.body.variables.uiTemplates) && vars.body.variables.uiTemplates.length === 2, 'variables?fields=uiTemplates 可读', String(vars.body.variables?.uiTemplates?.length));

    const exists = await call('GET', `/cards/exists/${contentHash}`);
    ok(exists.body.exists === true && exists.body.cardId === cardId, 'exists 去重预检', exists.body.cardId);

    const stView = await call('GET', `/cards/${cardId}/st`);
    ok(stView.status === 501 && stView.body.error.code === 'LOCAL_NOT_IMPLEMENTED', 'st 视图明确 501（本地不伪造）', String(stView.status));
}

console.log('\n[4] marks —— 手动把普通卡标成 RP（RegexPlus 的 RP 模式开关）');
{
    const put = await call('PUT', `/marks/${contentHash}`, { jsonBody: { type: 'rphub', note: '手动标记' } });
    ok(put.status === 200 && put.body.marked === true, 'PUT marks 成功', put.body.mark?.type);
    const get = await call('GET', `/marks/${contentHash}`);
    ok(get.body.marked === true && get.body.mark?.type === 'rphub', 'GET marks 回读', JSON.stringify(get.body.mark));
    const list = await call('GET', '/marks');
    ok(Array.isArray(list.body.marks) && list.body.marks.length === 1, 'GET /marks 列表', String(list.body.marks.length));
    const del = await call('DELETE', `/marks/${contentHash}`);
    ok(del.body.marked === false, 'DELETE marks 清除');
}

console.log('\n[5] 普通 ST 卡 —— 必须完全让位（不产生 RP 特征）');
{
    const res = await call('POST', '/cards/analyze', { body: stBytes, headers: { 'x-filename': 'stock.json' } });
    ok(res.body.features.filter((f) => f.startsWith('rphub_')).length === 0, '无 rphub_* 特征', res.body.features.join(','));
    const up = await call('POST', '/cards/upload', { body: stBytes, headers: { 'x-filename': 'stock.json' } });
    ok(up.body.formatDetail === 'st', 'formatDetail=st', up.body.formatDetail);
    ok(up.body.standardCard === undefined, '未请求 writeBack 时不写回', String(up.body.standardCard));
}

console.log('\n[6] 错误路径');
{
    const bad = await call('POST', '/cards/analyze', { body: new Uint8Array([1, 2, 3]) });
    ok(bad.status === 422 && bad.body.error.code === 'UNSUPPORTED_FORMAT', '未知格式 → 422', `${bad.status}/${bad.body.error?.code}`);
    const nf = await call('GET', '/cards/c0000000000000000');
    ok(nf.status === 404, '不存在的 cardId → 404', String(nf.status));
    const route = await call('GET', '/nope');
    ok(route.status === 404 && route.body.error.code === 'ROUTE_NOT_FOUND', '未知路径 → ROUTE_NOT_FOUND', route.body.error?.code);
}

console.log('\n[7] 编码 / 容器兼容（真实世界 422 的两大来源）');
{
    const json = JSON.stringify(rpCardJson());
    const utf8 = new TextEncoder().encode(json);

    const bomUtf8 = new Uint8Array(3 + utf8.length);
    bomUtf8.set([0xef, 0xbb, 0xbf]);
    bomUtf8.set(utf8, 3);
    const r1 = await call('POST', '/cards/analyze', { body: bomUtf8, headers: { 'x-filename': 'bom.json' } });
    ok(r1.status === 200 && r1.body.features.some((f) => f.startsWith('rphub_')), 'UTF-8 BOM 的 JSON 卡可识别', `status=${r1.status}`);

    const u16 = new Uint8Array(2 + json.length * 2);
    u16[0] = 0xff; u16[1] = 0xfe;
    for (let i = 0; i < json.length; i++) {
        const code = json.charCodeAt(i);
        u16[2 + i * 2] = code & 0xff;
        u16[3 + i * 2] = code >> 8;
    }
    const r2 = await call('POST', '/cards/analyze', { body: u16, headers: { 'x-filename': 'u16.json' } });
    ok(r2.status === 200, 'UTF-16LE + BOM 的 JSON 卡可识别', `status=${r2.status}`);

    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]);
    const r3 = await call('POST', '/cards/analyze', { body: zip, headers: { 'x-filename': 'card.charx' } });
    ok(r3.status === 422 && r3.body.error.code === 'UNSUPPORTED_FORMAT', 'zip 容器（.charx/.byaf）→ 422', `${r3.status}/${r3.body.error?.code}`);
    const snapshot = getLastFailure();
    ok(snapshot?.status === 422 && String(snapshot.headHex).startsWith('50 4b'), '失败快照记下首字节', snapshot?.headHex);
    ok(typeof snapshot?.hint === 'string' && snapshot.hint.length > 0, '失败快照带排查提示', `${String(snapshot?.hint).slice(0, 20)}…`);

    const empty = await call('POST', '/cards/analyze', { body: new Uint8Array(0), headers: { 'x-filename': 'empty.png' } });
    ok(empty.status === 422 && empty.body.error.code === 'EMPTY_BODY', '空请求体 → EMPTY_BODY', `${empty.status}/${empty.body.error?.code}`);
    ok(getLastFailure()?.byteLength === 0, '空请求体也在快照里注明 0 字节');
}

console.log(`\n=== ${failed === 0 ? '全部通过' : `${failed} 项失败`} ===`);
process.exit(failed === 0 ? 0 : 1);
