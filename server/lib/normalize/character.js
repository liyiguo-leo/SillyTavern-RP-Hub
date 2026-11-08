// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

// lib/normalize/character.js — 角色信息归一
//
// 输入：角色数据对象 data；输出 ST 标准字段，缺失补 null。
// extensions 原样透传。

import { isPlainObject } from '../util.js';

export function normalizeCharacter(data, formatDetail) {
    const stringOrNull = (v) => (typeof v === 'string' ? v : null);
    const stringArrayOrNull = (v) => (Array.isArray(v) ? v.filter((t) => typeof t === 'string') : null);
    const character = {
        name: stringOrNull(data.name) ?? stringOrNull(data.char_name),
        description: stringOrNull(data.description),
        personality: stringOrNull(data.personality),
        first_mes: stringOrNull(data.first_mes),
        mes_example: stringOrNull(data.mes_example),
        scenario: stringOrNull(data.scenario),
        system_prompt: stringOrNull(data.system_prompt),
        post_history_instructions: stringOrNull(data.post_history_instructions),
        creator_notes: stringOrNull(data.creator_notes) ?? stringOrNull(data.creatorcomment),
        creator: stringOrNull(data.creator),
        character_version: stringOrNull(data.character_version),
        nickname: stringOrNull(data.nickname),
        alternate_greetings: stringArrayOrNull(data.alternate_greetings),
        group_only_greetings: stringArrayOrNull(data.group_only_greetings),
        assets: Array.isArray(data.assets) ? data.assets.filter((a) => isPlainObject(a)) : null,
        tags: stringArrayOrNull(data.tags),
        extensions: isPlainObject(data.extensions) ? data.extensions : null,
    };

    const mappingItems = [];
    for (const key of ['name', 'description', 'personality', 'first_mes', 'mes_example', 'scenario', 'system_prompt', 'post_history_instructions', 'creator_notes', 'creator', 'character_version', 'nickname', 'alternate_greetings', 'group_only_greetings', 'assets', 'tags']) {
        if (character[key] !== null && character[key] !== undefined) {
            mappingItems.push({
                category: 'character',
                sourcePath: `data.${key}`,
                targetField: `character.${key}`,
                status: 'mapped',
                note: '直接对应',
            });
        }
    }
    if (character.extensions !== null) {
        mappingItems.push({
            category: 'character',
            sourcePath: 'data.extensions',
            targetField: 'character.extensions',
            status: 'mapped',
            note: '原样透传',
        });
    }

    return { character, mappingItems };
}
