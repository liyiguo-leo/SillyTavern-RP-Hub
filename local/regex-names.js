// SPDX-License-Identifier: AGPL-3.0-or-later
// local/regex-names.js —— 给卡内正则按功能起名（纯函数，无副作用）
//
// 目的：RP 卡的 regex_scripts 只有 `name` 字段，酒馆正则面板读写的是 `scriptName`，
// 于是面板里全显示成“未命名”，也没法改。这里按正则内容推断用途并写入 scriptName。
//
// 硬约束：
//   - 只补空值（已有 scriptName 一律不动，用户改过的名字不会被覆盖）
//   - 只写 scriptName，不改 findRegex / replaceString / placement / disabled
//   - 确定性：同一份脚本永远得到同一批名字（重导入不会变来变去）

const RULES = [
    // 剥离类：把给模型看的标记从显示里去掉
    { label: '剥离·变量更新', test: (s) => /<UpdateVariable|ui_template_updates/i.test(s) },
    { label: '剥离·状态占位', test: (s) => /<StatusPlaceHolderImpl|statusplaceholder/i.test(s) },
    // 结构类：把文本代码块包成界面容器
    { label: '结构·界面容器', test: (s) => /```|<div\s+class=|<iframe|<html[\s>]|TH-render/i.test(s) },
    // 样式类：按 CSS 属性判断
    { label: '样式·颜色', test: (s) => /(^|[^-])color\s*:|background(-color)?\s*:|--[a-z-]+\s*:/i.test(s) },
    { label: '样式·字体', test: (s) => /font-|letter-spacing|text-shadow|line-height/i.test(s) },
    { label: '样式·布局', test: (s) => /display\s*:\s*(flex|grid)|padding|margin|border(-radius)?\s*:|width\s*:|height\s*:/i.test(s) },
];

/** 仅提示词通道的正则（不参与显示美化） */
function isPromptOnlyScript(script) {
    if (script?.promptOnly === true) return true;
    const placement = script?.placement;
    if (Array.isArray(placement) && placement.length > 0) {
        return placement.every((p) => p === 0 || p === 5);
    }
    return false;
}

/** 取用于判断的文本（findRegex + replaceString） */
function textOf(script) {
    const find = String(script?.findRegex ?? script?.regex ?? '');
    const replace = String(script?.replaceString ?? script?.replacement ?? '');
    return `${find}\n${replace}`;
}

/**
 * 单条脚本 → 分类名（不含序号）
 * @param {object} script
 * @returns {string}
 */
export function classifyRegex(script) {
    const text = textOf(script);
    for (const rule of RULES) {
        if (rule.test(text)) return rule.label;
    }
    if (isPromptOnlyScript(script)) return '提示词';
    const find = String(script?.findRegex ?? script?.regex ?? '').replace(/\s+/g, ' ').trim();
    const snippet = find.slice(0, 10);
    return snippet ? `替换·${snippet}` : '替换';
}

/**
 * 给一组脚本生成名字（不改入参）。
 * 同类多条 → 追加两位序号，保证唯一且稳定。
 * @param {Array<object>} scripts
 * @returns {string[]}
 */
export function buildRegexNames(scripts) {
    const list = Array.isArray(scripts) ? scripts : [];
    const labels = list.map((script) => classifyRegex(script));
    const counts = new Map();
    for (const label of labels) counts.set(label, (counts.get(label) || 0) + 1);

    const seen = new Map();
    return labels.map((label) => {
        const total = counts.get(label) || 1;
        if (total === 1) return `RP·${label}`;
        const index = (seen.get(label) || 0) + 1;
        seen.set(label, index);
        return `RP·${label}·${String(index).padStart(2, '0')}`;
    });
}

/** 卡内可能放正则的位置 */
export function collectRegexArrays(cardData) {
    const arrays = [];
    const push = (arr) => {
        if (Array.isArray(arr) && arr.length > 0) arrays.push(arr);
    };
    const ext = cardData?.extensions && typeof cardData.extensions === 'object' ? cardData.extensions : null;
    push(ext?.regex_scripts);
    push(cardData?.regex_scripts);
    push(ext?.rp_hub_regex_scripts);
    push(cardData?.rp_hub_regex_scripts);
    return arrays;
}

/**
 * 就地为卡数据补 scriptName（只补空值）。
 * @param {object} cardData 角色数据对象（chara 块里的 data）
 * @param {{onlyEmpty?: boolean}} [options]
 * @returns {{changed: number, arrays: number}}
 */
export function nameRegexScriptsInCard(cardData, options = {}) {
    const onlyEmpty = options.onlyEmpty !== false;
    if (!cardData || typeof cardData !== 'object') return { changed: 0, arrays: 0 };

    const arrays = collectRegexArrays(cardData);
    let changed = 0;

    for (const scripts of arrays) {
        const names = buildRegexNames(scripts);
        scripts.forEach((script, index) => {
            if (!script || typeof script !== 'object') return;
            const current = typeof script.scriptName === 'string' ? script.scriptName.trim() : '';
            if (onlyEmpty && current) return;
            const next = names[index];
            if (!next) return;
            if (script.scriptName !== next) {
                script.scriptName = next;
                changed += 1;
            }
        });
    }

    return { changed, arrays: arrays.length };
}

/** 是否为 RP-Hub 卡（只对这类卡动名字，普通卡完全让位） */
export function looksLikeRpHubCard(cardData) {
    if (!cardData || typeof cardData !== 'object') return false;
    const ext = cardData.extensions && typeof cardData.extensions === 'object' ? cardData.extensions : {};
    if (ext.rp_hub_watermark !== undefined || cardData.rp_hub_watermark !== undefined) return true;
    if (ext.rp_hub_ui_templates !== undefined || ext.rp_hub_regex_scripts !== undefined) return true;
    if (Array.isArray(cardData.uiTemplates) || Array.isArray(cardData.ui_templates)) return true;
    if (Array.isArray(cardData.regex_scripts) && cardData.regex_scripts.length > 0) return true;
    return false;
}
