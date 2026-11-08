// tools/bump-version.mjs —— 统一改版本号（manifest.json + local/constants.js）
//
// 为什么单独做：PowerShell 的 Set-Content -Encoding UTF8 在 Windows PowerShell 里会写 BOM，
// 而带 BOM 的 manifest.json 会被 TauriTavern 直接拒绝（Invalid extension manifest.json）。
// 这里固定用无 BOM UTF-8 写入。
//
// 用法：node tools/bump-version.mjs 0.4.4-unified.5

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    console.error('用法：node tools/bump-version.mjs <semver，如 0.4.4-unified.5>');
    process.exit(1);
}

const manifestPath = path.join(repoRoot, 'manifest.json');
const constantsPath = path.join(repoRoot, 'local', 'constants.js');

const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
manifest.version = version;
await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`, 'utf8');

let constants = await fs.readFile(constantsPath, 'utf8');
if (!/EXTENSION_VERSION = '[^']+'/.test(constants)) {
    throw new Error('local/constants.js 里没找到 EXTENSION_VERSION');
}
constants = constants.replace(/EXTENSION_VERSION = '[^']+'/, `EXTENSION_VERSION = '${version}'`);
await fs.writeFile(constantsPath, constants, 'utf8');

// 自检：两个文件都不能有 BOM
for (const file of [manifestPath, constantsPath]) {
    const bytes = await fs.readFile(file);
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        throw new Error(`${path.basename(file)} 写入后带 BOM，宿主会拒绝`);
    }
}

console.log(`[bump-version] manifest.json → ${version}`);
console.log(`[bump-version] local/constants.js → ${version}（均无 BOM）`);
