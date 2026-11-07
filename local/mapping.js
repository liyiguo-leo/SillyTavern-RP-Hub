// SPDX-License-Identifier: AGPL-3.0-or-later
// local/mapping.js —— 映射表生成与未映射字段收纳

import { isPlainObject } from './util.js';

const HANDLED_TOP_KEYS = new Set([
    'spec', 'spec_version', 'data',
    'name', 'char_name', 'nickname', 'creator', 'character_version',
    'description', 'personality', 'scenario', 'first_mes', 'alternate_greetings', 'group_only_greetings',
    'mes_example', 'creator_notes', 'creatorcomment', 'creator_comment',
    'system_prompt', 'post_history_instructions', 'tags', 'extensions',
    'character_book', 'regex_scripts', 'rp_hub_regex_scripts',
    'uiTemplates', 'ui_templates', 'rp_hub_ui_templates', 'runtimeByCharacter',
    'assets', 'fav', 'talkativeness', 'avatar',
]);

export function collectUnmapped(data) {
    const unmapped = {};
    const mappingItems = [];
    if (!data || typeof data !== 'object') return { unmapped, mappingItems };

    for (const key of Object.keys(data)) {
        if (HANDLED_TOP_KEYS.has(key)) continue;
        const value = data[key];
        if (value === undefined || value === null) continue;
        unmapped[`data.${key}`] = value;
        mappingItems.push({
            category: 'raw',
            sourcePath: `data.${key}`,
            targetField: 'raw.unmapped',
            status: 'raw',
            note: '未定义映射规则，原样保留',
        });
    }

    return { unmapped, mappingItems };
}

export function buildMapping(mappingItems) {
    const mapping = mappingItems.slice();
    for (const item of mapping) {
        if (item.status === 'mapped') delete item.note;
    }
    const summary = { mapped: 0, raw: 0, conflict: 0, unsupported: 0 };
    for (const item of mapping) {
        if (summary[item.status] === undefined) summary[item.status] = 0;
        summary[item.status] += 1;
    }
    return { mapping, summary };
}

export { isPlainObject };
