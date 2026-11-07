// SPDX-License-Identifier: AGPL-3.0-or-later
// local/detect.js —— 后端 lib/detect.js 移植（语义来源判定 formatDetail + 特征）
//
// 判定完全由「卡内是否出现 RP-Hub 特有字段/块」驱动：
//   命中任一 rphub_* → formatDetail='rphub'（专属优化生效）
//   否则 chara_card_v2/v3 → 'st'（普通卡：引擎完全让位）

/**
 * 汇总原始角色对象的 RP-Hub 特征。
 * @param {object} data
 * @param {Array<{keyword:string}>} blocks
 */
export function detectRphub(data, blocks = []) {
    const features = [];
    if (!data || typeof data !== 'object') {
        return { features, isRphub: false };
    }

    const ext = data.extensions && typeof data.extensions === 'object' ? data.extensions : {};
    const blockKeywords = new Set((blocks || []).map((b) => b.keyword));

    if (blockKeywords.has('RoleplayHubCard')) features.push('rphub_block_roleplayhubcard');
    if (blockKeywords.has('rp_hub_credit')) features.push('rphub_block_credit');
    if (blockKeywords.has('rp_hub_fingerprint')) features.push('rphub_block_fingerprint');

    if (Array.isArray(data.uiTemplates) && data.uiTemplates.length > 0) features.push('rphub_ui_templates');
    if (Array.isArray(ext.rp_hub_ui_templates) && ext.rp_hub_ui_templates.length > 0) features.push('rphub_ui_templates');
    if (Array.isArray(data.ui_templates) && data.ui_templates.length > 0) features.push('rphub_ui_templates');
    if (data.uiTemplates !== undefined) features.push('rphub_ui_templates');
    if (data.ui_templates !== undefined) features.push('rphub_ui_templates');
    if (data.runtimeByCharacter !== undefined) features.push('rphub_runtime_by_character');
    if (ext.rp_hub_watermark !== undefined) features.push('rphub_watermark');
    if (ext.rp_hub_ui_templates !== undefined) features.push('rphub_ui_templates');
    if (ext.rp_hub_regex_scripts !== undefined) features.push('rphub_regex');
    if (data.rp_hub_watermark !== undefined) features.push('rphub_watermark');
    if (Array.isArray(data.regex_scripts) && data.regex_scripts.length > 0) features.push('rphub_top_level_regex_scripts');

    return { features, isRphub: features.length > 0 };
}

/**
 * 判定语义来源。
 * @param {object} data
 * @param {Array} blocks
 * @param {{spec?: string}} [opts]
 */
export function detectFormatDetail(data, blocks = [], opts = {}) {
    const rphubResult = detectRphub(data, blocks);
    if (rphubResult.isRphub) {
        return { formatDetail: 'rphub', features: rphubResult.features };
    }

    const spec = opts.spec;
    if (spec === 'chara_card_v2' || spec === 'chara_card_v3'
        || data?.spec === 'chara_card_v2' || data?.spec === 'chara_card_v3') {
        return { formatDetail: 'st', features: rphubResult.features };
    }

    return { formatDetail: 'unknown', features: rphubResult.features };
}
