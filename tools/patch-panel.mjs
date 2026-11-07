// tools/patch-panel.mjs —— 对上游面板产物做「最小文案补丁」
//
// 为什么需要：RP助手 的导入提示是 `RP 卡已上传：…（判定：本地）`，其中的「本地」指的是
// **判定通道**（前端本地判定），不是「本地卡/普通卡」。用户看到会误以为卡被当成了普通卡。
// 我们不改上游源码，只在构建产物上做一次精确字符串替换。
//
// 规则：每条补丁都必须精确命中，命中数为 0 就构建失败（上游改文案时立刻暴露，而不是静默漏改）。

import fs from 'node:fs/promises';

const PATCHES = [
    {
        name: '导入提示：判定通道 → 识别通道',
        from: '（判定：${t}）',
        to: '（识别通道：${t===\'本地\'?\'前端判定为 RP 卡\':\'后端判定为 RP 卡\'}）',
    },
];

/**
 * @param {string} file panel/rp-hub-panel.js 路径
 * @returns {Promise<{applied: string[], skipped: string[]}>}
 */
export async function patchPanelBundle(file) {
    let text = await fs.readFile(file, 'utf8');
    const applied = [];
    const skipped = [];

    for (const patch of PATCHES) {
        if (text.includes(patch.to)) {
            skipped.push(`${patch.name}（已是补丁后文案）`);
            continue;
        }
        const count = text.split(patch.from).length - 1;
        if (count !== 1) {
            throw new Error(`面板补丁未命中或命中多次（${count}）：${patch.name}`);
        }
        text = text.replace(patch.from, patch.to);
        applied.push(patch.name);
    }

    if (applied.length > 0) await fs.writeFile(file, text, 'utf8');
    return { applied, skipped };
}

// CLI：node tools/patch-panel.mjs panel/rp-hub-panel.js
const isCli = process.argv[1] && process.argv[1].endsWith('patch-panel.mjs');
if (isCli) {
    const file = process.argv[2];
    if (!file) {
        console.error('用法：node tools/patch-panel.mjs <panel/rp-hub-panel.js>');
        process.exit(1);
    }
    const result = await patchPanelBundle(file);
    console.log('[patch-panel] 已应用：', result.applied.length ? result.applied : '（无）');
    if (result.skipped.length) console.log('[patch-panel] 跳过：', result.skipped);
}
