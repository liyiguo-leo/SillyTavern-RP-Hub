// SPDX-License-Identifier: AGPL-3.0-or-later
// local/api.js —— 后端 REST 契约的浏览器实现（与 server/lib/router.js 一一对应）
//
// 对外只暴露 handleRequest({ method, path, query, headers, body, hooks })，
// 由 local/fetch-shim.js 把 fetch('/api/plugins/rp-hub-compat/v1/...') 转发进来。
//
// 与后端的差异（明确清单，便于审计）：
//   1. 落盘 → IndexedDB（local/store.js）；无 FS、无进程。
//   2. writeBack=1 → 委托 hooks.importToSt(bytes, filename) 调 ST 原生
//      POST /api/characters/import（浏览器能做的「写回」），不再生成标准卡 PNG。
//   3. /cards/{id}/st 视图未实现（无 PNG 编码器）→ 501 LOCAL_NOT_IMPLEMENTED。
//   4. ETag/304 不实现（前端只在诊断里用，不依赖）。

import { runPipeline } from './pipeline.js';
import {
    readIndex, hasCard, readCard, writeCard, rollbackCard, readMarks, writeMark,
    findByContentHash, findByName, stats,
} from './store.js';
import { setMark, clearMark, listMarks, getMarkStatus, isSupportedMarkType } from './marks.js';
import { sha256HexBytes, sha256HexString } from './sha256.js';
import { SCHEMA_VERSION, LOCAL_BACKEND_VERSION } from './constants.js';

const STARTED_AT = Date.now();
const CARD_ID_RE = /^c[0-9a-f]{16}$/;
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;

const isValidCardId = (id) => typeof id === 'string' && CARD_ID_RE.test(id);
const isValidContentHash = (h) => typeof h === 'string' && CONTENT_HASH_RE.test(h);

const json = (status, body) => ({ status, body });
const err = (status, code, message) => ({ status, body: { error: { code, message } } });

function summaryCounts(normalized) {
    return {
        regex: normalized.regex.length,
        lorebook: normalized.lorebook.length,
        firstMes: !!(normalized.character && normalized.character.first_mes),
        variables: normalized.variables ? (normalized.variables.uiTemplates?.length || 0) : 0,
    };
}

function pickFields(obj, fields) {
    if (!fields || !obj || typeof obj !== 'object') return obj;
    const out = {};
    if (Object.prototype.hasOwnProperty.call(obj, 'id')) out.id = obj.id;
    for (const f of fields) {
        if (Object.prototype.hasOwnProperty.call(obj, f)) out[f] = obj[f];
    }
    return out;
}

function parseFields(query) {
    const raw = query.get('fields');
    if (!raw || !raw.trim()) return null;
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function parsePage(query) {
    const offset = Number(query.get('offset'));
    const limit = Number(query.get('limit'));
    return {
        offset: Number.isInteger(offset) && offset >= 0 ? offset : 0,
        limit: Number.isInteger(limit) && limit > 0 ? limit : null,
    };
}

function decodeName(raw) {
    try { return decodeURIComponent(raw); } catch { return raw; }
}

function toBytes(input) {
    if (!input) return new Uint8Array(0);
    // 跨 realm 安全：ArrayBuffer.isView 依赖内部槽；ArrayBuffer 用品牌标记判断
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (Object.prototype.toString.call(input) === '[object ArrayBuffer]'
        || Object.prototype.toString.call(input) === '[object SharedArrayBuffer]') {
        return new Uint8Array(input);
    }
    return new Uint8Array(0);
}

/* ------------------------------ 失败现场 ------------------------------ */

/** 最近一次失败请求的快照（TT 真机排障用：window.__rphubLocalBackend__.lastFailure） */
let lastFailure = null;

export function getLastFailure() {
    return lastFailure;
}

function headHex(bytes, count = 16) {
    if (!bytes || bytes.length === 0) return '';
    return Array.from(bytes.subarray(0, count)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function recordFailure({ method, path, status, code, message, bytes }) {
    lastFailure = {
        at: new Date().toISOString(),
        method,
        path,
        status,
        code,
        message,
        byteLength: bytes ? bytes.length : 0,
        headHex: headHex(bytes),
        hint: status === 422 && bytes && bytes.length > 0
            ? '首字节既不是 PNG 签名也不是 JSON 起始符：可能是 .charx/.byaf（zip 容器）或带特殊编码的文本卡'
            : (bytes && bytes.length === 0 ? '请求体为空：拖入的是文件还是纯文本/链接？' : ''),
    };
    try {
        if (typeof globalThis !== 'undefined') globalThis.__rphubLocalLastFailure__ = lastFailure;
    } catch { /* 忽略 */ }
    return lastFailure;
}

/* --------------------------------- 路由 --------------------------------- */

/**
 * @param {object} req
 * @param {'GET'|'POST'|'PUT'|'DELETE'} req.method
 * @param {string} req.path 已去掉 base 前缀，如 '/cards/analyze'
 * @param {URLSearchParams} req.query
 * @param {Record<string,string>} [req.headers] 小写键
 * @param {Uint8Array} [req.body]
 * @param {{importToSt?: (bytes: Uint8Array, filename: string|null, meta: object) => Promise<string|null>}} [req.hooks]
 */
export async function handleRequest(req) {
    const method = String(req.method || 'GET').toUpperCase();
    const path = req.path || '/';
    const query = req.query || new URLSearchParams();
    const headers = req.headers || {};
    const hooks = req.hooks || {};
    const seg = path.split('/').filter(Boolean);

    try {
        /* ---------- POST /cards/upload ---------- */
        if (method === 'POST' && seg[0] === 'cards' && seg[1] === 'upload') {
            const bytes = toBytes(req.body);
            if (bytes.length === 0) {
                const message = '上传内容为空：请求体 0 字节（拖入的是链接/纯文本，还是文件读取失败？）';
                recordFailure({ method, path, status: 422, code: 'EMPTY_BODY', message, bytes });
                return err(422, 'EMPTY_BODY', message);
            }

            let sourceFile = typeof headers['x-filename'] === 'string' ? headers['x-filename'] : null;
            if (sourceFile) { try { sourceFile = decodeURIComponent(sourceFile); } catch { /* 原样 */ } }
            if (typeof sourceFile === 'string') sourceFile = sourceFile.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255);

            const contentHash = sha256HexBytes(bytes);
            const marksData = await readMarks();
            const mark = marksData.marks[contentHash];
            const forcedFormatDetail = mark && mark.type === 'rphub' ? 'rphub' : undefined;

            const payload = await runPipeline(bytes, forcedFormatDetail);
            const { format, formatDetail, normalized, features, data, blocks, spec } = payload;

            const characterName = (normalized.character && normalized.character.name) || 'Unknown';
            const importedAt = new Date().toISOString();
            const cardId = 'c' + sha256HexString(contentHash + characterName + importedAt).slice(0, 16);

            const meta = {
                cardId,
                format,
                formatDetail,
                importedAt,
                sourceFile,
                characterName,
                contentHash,
                regexCount: normalized.regex.length,
                lorebookCount: normalized.lorebook.length,
                uiTemplateCount: Array.isArray(normalized.variables?.uiTemplates) ? normalized.variables.uiTemplates.length : 0,
                hasRuntimeByCharacter: normalized.variables?.runtimeByCharacter != null,
                schema_version: SCHEMA_VERSION,
            };
            const cardPayload = {
                cardId,
                normalized: {
                    ...normalized,
                    schema_version: SCHEMA_VERSION,
                    cardId,
                    format,
                    formatDetail,
                    importedAt,
                    sourceFile,
                },
                raw: {
                    blocks,
                    originalJson: { spec, data },
                },
            };

            // 元数据与卡体分表落库：by-name/exists/status 这类高频查询不再拖正文
            await writeCard({ meta, payload: cardPayload });

            const responseData = {
                cardId,
                contentHash,
                marked: !!mark,
                format,
                formatDetail,
                summary: {
                    formatDetail,
                    detectedAt: new Date().toISOString(),
                    features,
                    counts: summaryCounts(normalized),
                    mappingSummary: normalized.mappingSummary,
                },
                backend: 'local',
            };

            if (query.get('writeBack') === '1') {
                try {
                    if (typeof hooks.importToSt !== 'function') {
                        throw new Error('当前环境没有提供 ST 角色导入通道（纯离线模式）');
                    }
                    const avatar = await hooks.importToSt(bytes, sourceFile, { cardId, format });
                    responseData.standardCard = { avatar, overwritten: query.get('overwrite') === '1' };
                    if (normalized.regex.length > 0) responseData.standardCard.whitelistRequired = true;
                } catch (e) {
                    console.error('[rphub-local] writeBack 失败（卡已入本地库）:', e);
                    responseData.standardCard = { avatar: null, error: { message: e instanceof Error ? e.message : String(e) } };
                }
            }

            return json(200, responseData);
        }

        /* ---------- POST /cards/analyze ---------- */
        if (method === 'POST' && seg[0] === 'cards' && seg[1] === 'analyze') {
            const bytes = toBytes(req.body);
            if (bytes.length === 0) {
                const message = '分析内容为空：请求体 0 字节（拖入的是链接/纯文本，还是文件读取失败？）';
                recordFailure({ method, path, status: 422, code: 'EMPTY_BODY', message, bytes });
                return err(422, 'EMPTY_BODY', message);
            }

            const contentHash = sha256HexBytes(bytes);
            const marksData = await readMarks();
            const mark = marksData.marks[contentHash];
            const forcedFormatDetail = mark && mark.type === 'rphub' ? 'rphub' : undefined;

            const payload = await runPipeline(bytes, forcedFormatDetail);
            const character = payload.normalized.character || {};
            const confidence = payload.formatDetail === 'rphub' || payload.formatDetail === 'st' ? 0.99 : 0.5;

            return json(200, {
                format: payload.format,
                confidence,
                features: payload.features,
                contentHash,
                marked: !!mark,
                characterName: character.name || null,
                summary: summaryCounts(payload.normalized),
                backend: 'local',
            });
        }

        /* ---------- GET /status ---------- */
        if (method === 'GET' && seg[0] === 'status') {
            const index = await readIndex();
            const s = await stats();
            return json(200, {
                plugin: 'rp-hub-compat',
                version: LOCAL_BACKEND_VERSION,
                status: 'ok',
                backend: 'local',
                schema_version: SCHEMA_VERSION,
                data_dir: `indexeddb:${s.backend}`,
                cards_count: Object.keys(index.cards || {}).length,
                marks_count: s.marks,
                uptime_ms: Date.now() - STARTED_AT,
            });
        }

        /* ---------- GET /cards ---------- */
        // 卡库列表（诊断面板/自检用）：只读元数据，不碰卡体
        if (method === 'GET' && seg.length === 1 && seg[0] === 'cards') {
            const index = await readIndex();
            const marksData = await readMarks();
            const cards = Object.entries(index.cards || {})
                .map(([cardId, meta]) => ({
                    cardId,
                    characterName: meta.characterName ?? null,
                    format: meta.format ?? null,
                    formatDetail: meta.formatDetail ?? null,
                    marked: !!(meta.contentHash && marksData.marks?.[meta.contentHash]),
                    importedAt: meta.importedAt ?? null,
                    regexCount: meta.regexCount ?? 0,
                    lorebookCount: meta.lorebookCount ?? 0,
                    uiTemplateCount: meta.uiTemplateCount ?? null,
                    hasRuntimeByCharacter: meta.hasRuntimeByCharacter ?? null,
                    contentHash: meta.contentHash ?? null,
                }))
                .sort((a, b) => String(b.importedAt || '').localeCompare(String(a.importedAt || '')));
            return json(200, { cards, count: cards.length, backend: 'local' });
        }

        /* ---------- GET /cards/by-name/:name ---------- */
        if (method === 'GET' && seg[0] === 'cards' && seg[1] === 'by-name') {
            const decodedName = decodeName(seg.slice(2).join('/') || '');
            const targetHash = (query.get('contentHash') || '').trim() || null;
            const normalizedTargetName = decodedName.trim().toLowerCase();

            if (!normalizedTargetName && !targetHash) {
                return err(400, 'INVALID_CARD_NAME', '角色名或 contentHash 不能为空');
            }

            const index = await readIndex();
            let best = null;
            for (const [cardId, meta] of Object.entries(index.cards || {})) {
                if (!meta || typeof meta !== 'object') continue;
                if (targetHash && meta.contentHash === targetHash) { best = { cardId, ...meta }; break; }
                const entryName = String(meta.characterName || '').trim().toLowerCase();
                if (normalizedTargetName && entryName === normalizedTargetName) {
                    if (!best || String(meta.importedAt || '') > String(best.importedAt || '')) {
                        best = { cardId, ...meta };
                    }
                }
            }
            if (!best) {
                const marksData = await readMarks();
                if (targetHash && marksData.marks?.[targetHash]) {
                    const mark = marksData.marks[targetHash];
                    return json(200, {
                        cardId: 'marked_' + targetHash.slice(0, 16),
                        characterName: decodedName || targetHash,
                        format: 'png',
                        formatDetail: mark.type === 'rphub' ? 'rphub' : 'st',
                        contentHash: targetHash,
                        marked: true,
                        importedAt: mark.markedAt ?? null,
                        regexCount: 0,
                        lorebookCount: 0,
                        backend: 'local',
                    });
                }
                return err(404, 'NOT_FOUND', `未找到角色「${decodedName}」的导入记录`);
            }
            const marksData = await readMarks();
            const mark = best.contentHash ? (marksData.marks?.[best.contentHash] || null) : null;
            return json(200, {
                cardId: best.cardId,
                characterName: best.characterName,
                format: best.format ?? null,
                formatDetail: mark && mark.type === 'rphub' ? 'rphub' : (best.formatDetail ?? 'st'),
                contentHash: best.contentHash ?? null,
                marked: !!mark,
                importedAt: best.importedAt ?? null,
                regexCount: best.regexCount ?? 0,
                lorebookCount: best.lorebookCount ?? 0,
                backend: 'local',
            });
        }

        /* ---------- GET /cards/exists/:contentHash ---------- */
        if (method === 'GET' && seg[0] === 'cards' && seg[1] === 'exists') {
            const contentHash = seg[2];
            if (!isValidContentHash(contentHash)) return err(400, 'INVALID_CONTENT_HASH', 'contentHash 需为 64 位十六进制');
            const cardId = await findByContentHash(contentHash);
            return json(200, { contentHash, exists: !!cardId, cardId });
        }

        /* ---------- GET /cards/:cardId[/view] ---------- */
        if (method === 'GET' && seg[0] === 'cards' && seg.length >= 2) {
            const cardId = seg[1];
            if (!isValidCardId(cardId)) return err(400, 'INVALID_CARD_ID', 'cardId 需形如 c + 16 位十六进制');
            if (!await hasCard(cardId)) return err(404, 'NOT_FOUND', '卡不存在（可能已被移除或换浏览器导入）');

            const rec = await readCard(cardId);
            const normalized = rec.normalized;
            const category = seg[2] || 'all';
            const fields = parseFields(query);
            const { offset, limit } = parsePage(query);

            switch (category) {
                case 'all':
                    return json(200, {
                        cardId,
                        schema_version: normalized.schema_version,
                        format: normalized.format,
                        formatDetail: normalized.formatDetail,
                        importedAt: normalized.importedAt,
                        character: pickFields(normalized.character, fields),
                        regex: fields ? (normalized.regex || []).map((r) => pickFields(r, fields)) : normalized.regex,
                        lorebook: fields ? (normalized.lorebook || []).map((r) => pickFields(r, fields)) : normalized.lorebook,
                        variables: normalized.variables,
                        backend: 'local',
                    });
                case 'character':
                    return json(200, { cardId, character: pickFields(normalized.character, fields) });
                case 'regex':
                    return json(200, {
                        cardId,
                        regex: (normalized.regex || []).map((r) => pickFields(r, fields)).slice(offset, limit === null ? undefined : offset + limit),
                    });
                case 'lorebook':
                    return json(200, {
                        cardId,
                        lorebook: (normalized.lorebook || []).map((r) => pickFields(r, fields)).slice(offset, limit === null ? undefined : offset + limit),
                    });
                case 'variables':
                    return json(200, { cardId, variables: pickFields(normalized.variables, fields) });
                case 'mapping':
                    return json(200, {
                        cardId,
                        mapping: fields ? (normalized.mapping || []).map((m) => pickFields(m, fields)) : (normalized.mapping || []),
                    });
                case 'normalized':
                    return json(200, {
                        cardId,
                        schema_version: normalized.schema_version,
                        format: normalized.format,
                        formatDetail: normalized.formatDetail,
                        importedAt: normalized.importedAt,
                        normalized: {
                            character: normalized.character,
                            regex: normalized.regex,
                            lorebook: normalized.lorebook,
                            variables: normalized.variables,
                        },
                        backend: 'local',
                    });
                case 'raw':
                    return json(200, {
                        cardId,
                        format: rec.format || 'png',
                        blocks: rec.raw?.blocks || [],
                        originalJson: rec.raw?.originalJson || null,
                    });
                case 'st':
                    return err(501, 'LOCAL_NOT_IMPLEMENTED', '本地模式不做标准卡 PNG 写回；/cards/{id}/st 视图仅在服务端插件提供');
                default:
                    return err(422, 'UNSUPPORTED_TYPE', `未知数据类别：${category}`);
            }
        }

        /* ---------- marks ---------- */
        if (seg[0] === 'marks') {
            if (method === 'GET' && seg.length === 1) {
                const marksData = await readMarks();
                return json(200, { marks: listMarks(marksData), backend: 'local' });
            }
            const contentHash = seg[1];
            if (!isValidContentHash(contentHash)) return err(400, 'INVALID_CONTENT_HASH', 'contentHash 需为 64 位十六进制');

            if (method === 'GET' && seg.length === 2) {
                return json(200, getMarkStatus(await readMarks(), contentHash));
            }
            if (method === 'PUT' && seg.length === 2) {
                const body = req.jsonBody && typeof req.jsonBody === 'object' ? req.jsonBody : {};
                const type = typeof body.type === 'string' && body.type ? body.type : 'rphub';
                if (!isSupportedMarkType(type)) return err(422, 'UNSUPPORTED_MARK_TYPE', `不支持标记类型：${type}`);
                const note = typeof body.note === 'string' ? body.note : undefined;
                const marksData = await readMarks();
                const result = setMark(marksData, contentHash, type, note);
                await writeMark(contentHash, result.mark);
                return json(200, result);
            }
            if (method === 'DELETE' && seg.length === 2) {
                const marksData = await readMarks();
                const result = clearMark(marksData, contentHash);
                await writeMark(contentHash, null);
                return json(200, result);
            }
        }

        return err(404, 'ROUTE_NOT_FOUND', `路径不存在：${method} ${path}`);
    } catch (e) {
        // 4xx 是契约内的正常拒绝（未知格式/坏卡），只 warn；5xx 才是实现问题
        const status = e?.code === 'UNSUPPORTED_FORMAT' ? 422 : 500;
        const baseMessage = e instanceof Error ? e.message : String(e);
        const withHead = status === 422 ? `${baseMessage}（请求体 ${req.body?.length ?? 0} 字节，前 16 字节：${headHex(req.body)}）` : baseMessage;
        const log = status >= 500 ? console.error : console.warn;
        log(`[rphub-local] ${method} ${path} 未完成：`, withHead);
        recordFailure({ method, path, status, code: e?.code || 'INTERNAL', message: withHead, bytes: req.body });
        return err(status, e?.code || 'INTERNAL', withHead);
    }
}
