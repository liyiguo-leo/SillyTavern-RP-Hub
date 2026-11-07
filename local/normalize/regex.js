// SPDX-License-Identifier: AGPL-3.0-or-later
// local/normalize/regex.js —— 正则归一（rphub / st 双来源 → 统一形态）
//
// 来源优先级与去重规则完全沿用后端：同 findRegex+replaceString+flags 判重，rphub 版本胜出。

import { stableId, toBoolean, toNumber, splitRegexLiteral, isPlainObject } from '../util.js';

const CHARACTER_FIELD_NAMES = ['name', 'scriptName'];
const GLOBAL_SYSTEM_NAMES = ['NAI画图正则'];

function collectRegexSources(data) {
    const sources = [];
    const ext = isPlainObject(data.extensions) ? data.extensions : {};
    if (Array.isArray(ext.regex_scripts)) {
        sources.push({ source: 'st', base: 'data.extensions.regex_scripts', list: ext.regex_scripts });
    }
    if (Array.isArray(data.regex_scripts)) {
        sources.push({ source: 'rphub', base: 'data.regex_scripts', list: data.regex_scripts });
    }
    if (Array.isArray(ext.rp_hub_regex_scripts)) {
        sources.push({ source: 'rphub', base: 'data.extensions.rp_hub_regex_scripts', list: ext.rp_hub_regex_scripts });
    }
    if (Array.isArray(data.rp_hub_regex_scripts)) {
        sources.push({ source: 'rphub', base: 'data.rp_hub_regex_scripts', list: data.rp_hub_regex_scripts });
    }
    return sources;
}

function pickName(raw) {
    for (const key of CHARACTER_FIELD_NAMES) {
        if (typeof raw[key] === 'string' && raw[key]) return raw[key];
    }
    return null;
}

export function normalizeRegexEntry(raw, source) {
    const rawObj = isPlainObject(raw) ? raw : {};

    const literalResult = splitRegexLiteral(rawObj.findRegex || rawObj.regex || '');
    let findRegex = literalResult.pattern;
    if (!findRegex && typeof rawObj.regex === 'string') findRegex = rawObj.regex;
    let regexFlags = literalResult.flags !== undefined
        ? literalResult.flags
        : (typeof rawObj.regexFlags === 'string'
            ? rawObj.regexFlags
            : (typeof rawObj.flags === 'string' ? rawObj.flags : undefined));

    let enabled = true;
    if (rawObj.enabled !== undefined) enabled = toBoolean(rawObj.enabled, true);
    else if (rawObj.disabled !== undefined) enabled = !toBoolean(rawObj.disabled, false);

    let markdownOnly = toBoolean(rawObj.markdownOnly, false);
    let promptOnly = toBoolean(rawObj.promptOnly, false);
    if (markdownOnly && promptOnly) promptOnly = false;

    let placement = [];
    if (Array.isArray(rawObj.placement)) {
        placement = rawObj.placement.map(Number).filter(Number.isInteger);
    } else if (rawObj.placement !== undefined && rawObj.placement !== null) {
        const n = Number(rawObj.placement);
        if (Number.isInteger(n)) placement = [n];
    }
    if (placement.length === 0) placement = [1, 2];

    const depth = toNumber(rawObj.minDepth, null);

    const rawScope = rawObj.scope;
    const scope = rawScope === 'global'
        || GLOBAL_SYSTEM_NAMES.includes(rawObj.name || rawObj.scriptName || '')
        ? 'global' : 'character';

    const name = pickName(rawObj) || 'Regex Script';
    const replaceString = (typeof rawObj.replaceString === 'string' ? rawObj.replaceString : '')
        || (typeof rawObj.replacement === 'string' ? rawObj.replacement : '');

    return {
        id: stableId('rx', source, name, findRegex, replaceString),
        scriptName: name,
        findRegex,
        replaceString,
        regexFlags,
        enabled,
        trimOutput: toBoolean(rawObj.trimOutput, false),
        markdownOnly,
        promptOnly,
        userOnly: toBoolean(rawObj.userOnly, false),
        substituteRegex: toBoolean(rawObj.substituteRegex, false),
        placement,
        depth,
        scope,
        source,
        raw: rawObj,
    };
}

export function normalizeRegex(data) {
    const sources = collectRegexSources(data);
    const mappingItems = [];
    const duplicates = [];
    const seen = new Map();
    const seenEntries = [];

    for (const { source, base, list } of sources) {
        list.forEach((raw, index) => {
            const entry = normalizeRegexEntry(raw, source);
            seenEntries.push({ source, base, index, entry });
            const dedupKey = `${entry.findRegex}\u0000${entry.replaceString}\u0000${entry.regexFlags || ''}`;
            const existing = seen.get(dedupKey);
            if (existing) {
                if (source === 'rphub' && existing.source === 'st') {
                    duplicates.push({ base, index, dropped: existing.entry });
                    existing.entry = entry;
                    existing.source = source;
                    existing.base = base;
                    existing.index = index;
                } else {
                    duplicates.push({ base, index, dropped: entry });
                }
                return;
            }
            seen.set(dedupKey, { entry, source, base, index });
        });
    }

    const regex = [...seen.values()].map((item) => item.entry);

    for (const { source, base, index, entry } of seenEntries) {
        const dedupKey = `${entry.findRegex}\u0000${entry.replaceString}\u0000${entry.regexFlags || ''}`;
        const kept = seen.get(dedupKey);
        const isKept = kept && kept.source === source;
        mappingItems.push({
            category: 'regex',
            sourcePath: `${base}[${index}]`,
            targetField: 'regex[]',
            status: isKept ? 'mapped' : 'raw',
            note: isKept ? '已归一为 ST 正则字段' : '与另一来源同正则，保留 raw（优先级 rphub > st）',
        });
    }

    return { regex, mappingItems, duplicates };
}
