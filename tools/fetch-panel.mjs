// tools/fetch-panel.mjs —— 取上游 RP助手 面板产物，落到 panel/rp-hub-panel.js
//
// RP助手（SillyTavern-RP-HUB）是 webpack 工程，产物 dist/RP-HUB/index.js 已随仓库提交，
// 因此合并版不需要现场构建：直接取产物即可（同源托管，不再依赖 CDN）。
//
// 用法：
//   node tools/fetch-panel.mjs                 # 依次尝试 raw / jsDelivr 镜像
//   node tools/fetch-panel.mjs --ref v1.0.0    # 指定分支或 tag
//   node tools/fetch-panel.mjs --from D:/tmp/index.js   # 用本地已下载的文件

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const target = path.join(repoRoot, 'panel', 'rp-hub-panel.js');

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
    const i = args.indexOf(name);
    return i > -1 && args[i + 1] ? args[i + 1] : fallback;
};

const ref = opt('--ref', 'master');
const from = opt('--from', null);

async function writeBundle(text, source) {
    if (!text || text.length < 1000) throw new Error(`内容异常（${text?.length ?? 0} 字节）`);
    await fs.writeFile(target, text, 'utf8');
    console.log(`[fetch-panel] 来源：${source}`);
    console.log(`[fetch-panel] 已写入 ${path.relative(repoRoot, target)}（${(Buffer.byteLength(text) / 1024).toFixed(1)} KB）`);
    console.log('[fetch-panel] 刷新酒馆页面，酒馆助手扩展设置里即出现 RP-Hub 面板。');
}

if (from) {
    const text = await fs.readFile(path.resolve(from), 'utf8');
    await writeBundle(text, `本地文件 ${from}`);
    process.exit(0);
}

const urls = [
    `https://raw.githubusercontent.com/ReikoYuzuka/SillyTavern-RP-HUB/${ref}/dist/RP-HUB/index.js`,
    `https://cdn.jsdelivr.net/gh/ReikoYuzuka/SillyTavern-RP-HUB@${ref}/dist/RP-HUB/index.js`,
    `https://ghproxy.net/https://raw.githubusercontent.com/ReikoYuzuka/SillyTavern-RP-HUB/${ref}/dist/RP-HUB/index.js`,
];

let lastError = null;
for (const url of urls) {
    try {
        console.log(`[fetch-panel] 尝试 ${url}`);
        const res = await fetch(url, {
            headers: { 'user-agent': 'rp-hub-unified-fetch-panel' },
            signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await writeBundle(await res.text(), url);
        process.exit(0);
    } catch (e) {
        lastError = e;
        console.warn(`[fetch-panel] 失败：${e?.message || e}`);
    }
}

console.error('\n[fetch-panel] 所有镜像都失败（常见于无代理的 Node 出网）。两种替代：');
console.error('  1) 用浏览器/迅雷下载后本地导入：node tools/fetch-panel.mjs --from <下载好的 index.js>');
console.error('  2) 直接手动：把 dist/RP-HUB/index.js 复制成 panel/rp-hub-panel.js');
console.error(`  最后错误：${lastError?.message || lastError}`);
process.exit(1);
