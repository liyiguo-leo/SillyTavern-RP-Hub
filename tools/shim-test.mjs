// tools/shim-test.mjs —— fetch 拦截层测试（Node 里模拟一个浏览器 realm）
//
// 验证三件事：
//   1. auto 模式能认出真插件（GET /status → plugin=rp-hub-compat）→ 直连服务器，不接管；
//   2. 强制 local 后，带 base 前缀的 fetch 被就地接管（含 ArrayBuffer body、X-Filename 头）；
//   3. 不带 base 前缀的请求原样透传（酒馆自身的 /api/characters/* 不受影响）。
//
// 运行：node tools/shim-test.mjs

import { buildPng, rpCardJson } from './fixtures.mjs';
import vm from 'node:vm';

globalThis.window = globalThis;
globalThis.location = new URL('http://127.0.0.1:8000/');

const passthrough = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async function recorder(input, init) {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    passthrough.push(url);
    if (url.endsWith('/status')) {
        return new Response(JSON.stringify({ plugin: 'rp-hub-compat', status: 'ok', version: '0.1.0' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }
    return new Response(JSON.stringify({ from: 'fake-server' }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const { installLocalBackend } = await import('../local/fetch-shim.js');

let failed = 0;
const ok = (cond, label, extra = '') => {
    if (cond) console.log(`  ✓ ${label}${extra ? ` · ${extra}` : ''}`);
    else { failed++; console.log(`  ✗ ${label}${extra ? ` · ${extra}` : ''}`); }
};

const BASE = 'http://127.0.0.1:8000/api/plugins/rp-hub-compat/v1';
const bytes = new Uint8Array(buildPng({ text: { keyword: 'chara', value: Buffer.from(JSON.stringify(rpCardJson())).toString('base64') } }));

console.log('\n[1] auto 模式：有真插件 → 不接管');
{
    const before = passthrough.length;
    const info = await installLocalBackend({ mode: 'auto' });
    ok(info.mode === 'server', 'mode=server', info.mode);
    const res = await fetch(`${BASE}/status`);
    const data = await res.json();
    ok(data.plugin === 'rp-hub-compat', '数据来自服务器（未经本地实现改写）', JSON.stringify(data));
    ok(passthrough.slice(before).some((u) => u.endsWith('/status')), '请求确实走了网络层', passthrough.at(-1));
}

console.log('\n[2] local 模式：带 base 前缀 → 就地接管');
{
    const info = await installLocalBackend({ mode: 'local' });
    ok(info.mode === 'local', 'mode=local', info.mode);

    const res = await fetch(`${BASE}/cards/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent('拦截测试.png') },
        body: bytes,
    });
    ok(res.status === 200, 'HTTP 200', String(res.status));
    ok(res.headers.get('x-rphub-backend') === 'local', '响应标记 x-rphub-backend=local');
    const data = await res.json();
    ok(data.features?.includes('rphub_ui_templates'), 'resolve 到 RP 特征', data.features?.join(','));

    const up = await fetch(`${BASE}/cards/upload?writeBack=0`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-filename': 'x.png' },
        body: bytes,
    });
    const upData = await up.json();
    ok(/^c[0-9a-f]{16}$/.test(upData.cardId), 'upload 返回 cardId', upData.cardId);

    // 模拟前端不带 Content-Type 的 marks PUT
    const put = await fetch(`${BASE}/marks/${upData.contentHash}`, {
        method: 'PUT',
        body: new TextEncoder().encode(JSON.stringify({ type: 'rphub' })),
    });
    const putData = await put.json();
    ok(putData.marked === true, '无 Content-Type 的 marks PUT 也能识别', JSON.stringify(putData.mark));
}

console.log('\n[3] 非 base 请求 → 原样透传');
{
    const before = passthrough.length;
    await fetch('/api/characters/import');
    ok(passthrough.length === before + 1, '透传到真实 fetch', passthrough.at(-1));
}

console.log('\n[4] 跨 realm body —— TT 真机 422 EMPTY_BODY 的复现与修复');
{
    const { toBytes, toBytesAsync } = await import('../local/fetch-shim.js');
    const cardBytes = new TextEncoder().encode(JSON.stringify(rpCardJson()));
    // 在另一个 vm context 里造 ArrayBuffer：构造器不同 → instanceof 判断会失效
    const foreign = vm.runInNewContext(`new ArrayBuffer(${cardBytes.length})`);
    new Uint8Array(foreign).set(cardBytes);

    ok(foreign instanceof ArrayBuffer === false, '确认为「异 realm」ArrayBuffer（instanceof 为 false）');
    ok(toBytes(foreign)?.length === cardBytes.length, 'toBytes 跨 realm 仍取到字节', String(toBytes(foreign)?.length));
    ok((await toBytesAsync(foreign))?.length === cardBytes.length, 'toBytesAsync 跨 realm 同样可用');

    const res = await fetch(`${BASE}/cards/upload?writeBack=0`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-filename': 'foreign-realm.json' },
        body: foreign,
    });
    const data = await res.json();
    ok(res.status === 200 && /^c[0-9a-f]{16}$/.test(data.cardId || ''),
        '跨 realm body 的 upload 成功（不再是 EMPTY_BODY）',
        `${res.status} ${data.cardId || data.error?.code}`);
}

await realFetch.call; // 保持 realFetch 引用（Lint 无意义引用消除）
console.log(`\n=== ${failed === 0 ? '全部通过' : `${failed} 项失败`} ===`);
process.exit(failed === 0 ? 0 : 1);
