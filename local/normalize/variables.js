// SPDX-License-Identifier: AGPL-3.0-or-later
// local/normalize/variables.js —— 变量/UI 模板收纳（原样收纳，语义化由面板负责）

import { deepClone, isPlainObject } from '../util.js';

export function collectUiTemplates(data) {
    const ext = isPlainObject(data.extensions) ? data.extensions : {};
    const candidates = [
        data.uiTemplates,
        data.ui_templates,
        data.rp_hub_ui_templates,
        ext.ui_templates,
        ext.rp_hub_ui_templates,
    ];
    for (const c of candidates) {
        if (Array.isArray(c)) return c;
    }
    return [];
}

export function collectVariables(data, source) {
    const uiTemplates = collectUiTemplates(data);
    const runtimeByCharacter = (data && 'runtimeByCharacter' in data)
        ? data.runtimeByCharacter
        : (isPlainObject(data.extensions) && 'runtimeByCharacter' in data.extensions ? data.extensions.runtimeByCharacter : null);

    const initial = {};
    for (const tpl of uiTemplates) {
        if (isPlainObject(tpl) && isPlainObject(tpl.initialVariableState)) {
            for (const [k, v] of Object.entries(tpl.initialVariableState)) {
                initial[k] = deepClone(v);
            }
        }
    }

    const hasAny = uiTemplates.length > 0 || runtimeByCharacter !== null;
    const variables = hasAny ? {
        initial,
        uiTemplates,
        runtimeByCharacter,
    } : null;

    const mappingItems = [];
    if (uiTemplates.length > 0) {
        mappingItems.push({
            category: 'variables',
            sourcePath: 'data.uiTemplates',
            targetField: 'variables.uiTemplates',
            status: 'mapped',
            note: '原样收纳（语义化处理属第三部）',
        });
    }
    if (runtimeByCharacter !== null) {
        mappingItems.push({
            category: 'variables',
            sourcePath: 'data.runtimeByCharacter',
            targetField: 'variables.runtimeByCharacter',
            status: 'mapped',
            note: '原样收纳（语义化处理属第三部）',
        });
    }
    if (!hasAny) {
        mappingItems.push({
            category: 'variables',
            sourcePath: 'data',
            targetField: 'variables',
            status: 'raw',
            note: '未发现变量/UI 模板',
        });
    }

    return { variables, mappingItems };
}
