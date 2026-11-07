// tools/build-variant.mjs —— 生成 ST / TT 两套产物
//
// 为什么需要构建期换文件：
//   src/st-bridge.js 与 src/panel/ui.js 直接 import 酒馆前端的内部模块
//   （script.js / utils.js / templates.js / popup.js …）。宿主没有这些文件时，
//   ESM 静态图求值会 404 失败，而且 this_chid 这类**活绑定**无法用异步方式伪造，
//   所以只能在构建期换掉，而不是运行时兜底。
//
// 用法：
//   node tools/build-variant.mjs --target tt     → dist/tt/
//   node tools/build-variant.mjs --target st     → dist/st/
//   node tools/build-variant.mjs --target both   → 两套都出
//
// tt 变体做三件事，并在最后跑「禁止跨出扩展目录的 import」校验：
//   1. src/st-bridge.js  ← variants/tt/st-bridge.js（全部从 SillyTavern.getContext() 取）
//   2. src/panel/ui.js   ← variants/tt/panel-ui-stub.js（不挂酒馆原版正则面板）
//   3. src/store/scripts.js：uuidv4 改为从本地 st-bridge 导入

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const EXCLUDE = new Set(['.git', 'node_modules', 'dist', '_ref', '.cache']);

const targetArgIdx = process.argv.indexOf('--target');
const target = targetArgIdx > -1 ? process.argv[targetArgIdx + 1] : 'both';
if (!['st', 'tt', 'both'].includes(target)) {
    console.error(`未知 target：${target}（可选 st | tt | both）`);
    process.exit(1);
}

async function copyTree(src, dst) {
    await fs.mkdir(dst, { recursive: true });
    for (const entry of await fs.readdir(src, { withFileTypes: true })) {
        if (EXCLUDE.has(entry.name)) continue;
        const from = path.join(src, entry.name);
        const to = path.join(dst, entry.name);
        if (entry.isDirectory()) await copyTree(from, to);
        else await fs.copyFile(from, to);
    }
}

async function walkJs(dir, out = []) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (EXCLUDE.has(entry.name)) continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) await walkJs(p, out);
        else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(p);
    }
    return out;
}

/** 去掉注释，避免把文档里示例路径当成真 import */
function stripComments(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
}

/** 扫描“跨出扩展目录”的 import（../ 四级及以上），返回违规清单 */
async function findExternalImports(rootDir) {
    const offenders = [];
    const re = /(?:from\s*|import\s*\(\s*)'((?:\.\.\/){4,}[^']*)'/g;
    for (const file of await walkJs(rootDir)) {
        const text = stripComments(await fs.readFile(file, 'utf8'));
        let m;
        while ((m = re.exec(text)) !== null) {
            offenders.push({ file: path.relative(rootDir, file), spec: m[1] });
        }
    }
    return offenders;
}

async function dirSize(dir) {
    let total = 0;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        total += entry.isDirectory() ? await dirSize(p) : (await fs.stat(p)).size;
    }
    return total;
}

/** tt 变体的三处替换（找不到目标时直接失败，避免“以为换了其实没换”） */
async function patchForTT(outDir) {
    const patches = [
        {
            from: path.join(repoRoot, 'variants', 'tt', 'st-bridge.js'),
            to: path.join(outDir, 'src', 'st-bridge.js'),
            label: 'src/st-bridge.js ← 上下文适配版',
        },
        {
            from: path.join(repoRoot, 'variants', 'tt', 'panel-ui-stub.js'),
            to: path.join(outDir, 'src', 'panel', 'ui.js'),
            label: 'src/panel/ui.js ← 面板替身（不 import 酒馆内部模块）',
        },
    ];
    for (const p of patches) {
        await fs.copyFile(p.from, p.to);
        console.log(`[build-variant]   · ${p.label}`);
    }

    const scriptsPath = path.join(outDir, 'src', 'store', 'scripts.js');
    const before = await fs.readFile(scriptsPath, 'utf8');
    const after = before.replace(
        /import\s*\{\s*uuidv4\s*\}\s*from\s*'[^']*utils\.js';/,
        "import { uuidv4 } from '../st-bridge.js';",
    );
    if (after === before) {
        throw new Error('未能在 src/store/scripts.js 找到 uuidv4 的 utils.js 导入 —— 上游可能改过，请更新本脚本');
    }
    await fs.writeFile(scriptsPath, after, 'utf8');
    console.log('[build-variant]   · src/store/scripts.js 的 uuidv4 改为本地导入');
}

/** manifest.json 必须在产物里是「无 BOM 的合法 JSON」——TT 用 serde 解析，BOM 会直接报
 *  `Invalid extension manifest.json: expected value at line 1 column 1` 导致更新失败。 */
async function assertManifestValid(outDir) {
    const file = path.join(outDir, 'manifest.json');
    const bytes = await fs.readFile(file);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        throw new Error(`产物 manifest.json 带 UTF-8 BOM（宿主会拒绝解析）：${file}`);
    }
    const text = bytes.toString('utf8');
    if (!text.trimStart().startsWith('{')) {
        throw new Error(`产物 manifest.json 不是 JSON 对象：${file}`);
    }
    try {
        JSON.parse(text);
    } catch (e) {
        throw new Error(`产物 manifest.json 不是合法 JSON：${e.message}`);
    }
}

async function build(kind) {
    const outDir = path.join(repoRoot, 'dist', kind);
    await fs.rm(outDir, { recursive: true, force: true });
    await copyTree(repoRoot, outDir);

    if (kind === 'tt') await patchForTT(outDir);
    await assertManifestValid(outDir);

    const offenders = await findExternalImports(outDir);
    if (kind === 'tt' && offenders.length > 0) {
        console.error('[build-variant] ✗ TT 变体仍存在跨出扩展目录的 import：');
        for (const o of offenders) console.error(`    ${o.file}  →  ${o.spec}`);
        throw new Error('TT 变体校验失败');
    }

    await fs.writeFile(path.join(outDir, 'BUILD.json'), JSON.stringify({
        variant: kind,
        builtAt: new Date().toISOString(),
        externalImports: offenders.length,
        note: kind === 'tt'
            ? 'TT 变体：st-bridge 走 getContext()；原版正则面板被替换；无跨出扩展目录的 import'
            : '标准版：st-bridge 静态 import ../../../../../script.js（酒馆内部模块）',
    }, null, 2), 'utf8');

    const size = await dirSize(outDir);
    console.log(`[build-variant] ${kind} → ${path.relative(repoRoot, outDir)}（${(size / 1024).toFixed(0)} KB，跨目录 import ${offenders.length} 处）`);
}

for (const kind of target === 'both' ? ['st', 'tt'] : [target]) await build(kind);
console.log('[build-variant] 完成。安装：整目录放进 <ST>/data/<user>/extensions/third-party/<任意名>/，或按 branch 方式用 git URL 安装。');
