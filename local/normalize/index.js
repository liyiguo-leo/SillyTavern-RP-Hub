// SPDX-License-Identifier: AGPL-3.0-or-later
// local/normalize/index.js —— 规范化编排（输出结构 = 后端 normalized/{cardId}.json）

import { SCHEMA_VERSION } from '../constants.js';
import { normalizeCharacter } from './character.js';
import { normalizeRegex } from './regex.js';
import { normalizeLorebook } from './lorebook.js';
import { collectVariables } from './variables.js';
import { collectUnmapped, buildMapping } from '../mapping.js';
import { isPlainObject } from '../util.js';

/**
 * 组装规范化数据。
 * @param {{spec:string,data:object,blocks:Array,features:Array}} parsed
 * @param {'rphub'|'st'|'unknown'} formatDetail
 */
export function buildNormalized(parsed, formatDetail) {
    const data = isPlainObject(parsed.data) ? parsed.data : {};

    const charResult = normalizeCharacter(data, formatDetail);
    const regexResult = normalizeRegex(data);
    const loreResult = normalizeLorebook(data, formatDetail === 'rphub' ? 'rphub' : 'st');
    const varsResult = collectVariables(data, formatDetail === 'rphub' ? 'rphub' : 'st');
    const unmappedResult = collectUnmapped(data);

    const allItems = [
        ...charResult.mappingItems,
        ...regexResult.mappingItems,
        ...loreResult.mappingItems,
        ...varsResult.mappingItems,
        ...unmappedResult.mappingItems,
    ];

    const { mapping, summary } = buildMapping(allItems);

    return {
        schema_version: SCHEMA_VERSION,
        formatDetail,
        character: charResult.character,
        regex: regexResult.regex,
        lorebook: loreResult.lorebook,
        variables: varsResult.variables,
        mapping,
        mappingSummary: summary,
        raw: {
            unmapped: unmappedResult.unmapped,
        },
    };
}

export { normalizeCharacter, normalizeRegex, normalizeLorebook, collectVariables };
