// SPDX-License-Identifier: AGPL-3.0-or-later
// panel/enabler.js —— 运行在酒馆助手脚本 iframe 内（独立 realm）
//
// 职责只有两件：
//   1. 在**这个 realm** 里再装一次本地后端（父窗口的 patch 不会跨 iframe 生效）；
//   2. 加载真正的面板 bundle（panel/rp-hub-panel.js，来自 RP助手 的构建产物）。
//
// 性能注意：用 HEAD 探测产物是否存在，再 import —— 不要 GET 一遍再 import（236 KB 会下两次）。

import { installLocalBackend, getLocalBackend } from '../local/fetch-shim.js';
import { importToSt } from './st-import.js';

const PANEL_BUNDLE = new URL('./rp-hub-panel.js', import.meta.url).href;

async function panelBundleExists() {
    try {
        const res = await fetch(PANEL_BUNDLE, { method: 'HEAD' });
        return res.ok;
    } catch {
        return false;
    }
}

async function main() {
    try {
        const info = await installLocalBackend({ hooks: { importToSt } });
        console.info(`[rphub:panel] 本地后端已装入酒馆助手 iframe · 模式=${info.mode}`);
    } catch (e) {
        console.warn('[rphub:panel] 本地后端安装失败，面板将依赖服务端插件：', e);
    }

    // 失败上报：本 realm 是隐藏 iframe，界面不可见 → 转发给父页面（诊断浮层会展示）
    try {
        const be = getLocalBackend();
        if (be?.onFailure) {
            be.onFailure((failure) => {
                try {
                    (window.parent ?? window.top ?? window).postMessage(
                        { type: 'rphub:failure', payload: failure },
                        '*',
                    );
                } catch { /* 跨源时忽略 */ }
            });
        }
    } catch { /* 忽略 */ }

    // RPC：父页面的诊断面板拿不到「当前卡 / 白名单」，但本 realm 的 getContext() 是完整的
    try {
        installRpc();
    } catch (e) {
        console.warn('[rphub:panel] RPC 安装失败：', e);
    }

    try {
        startAuto();
    } catch (e) {
        console.warn('[rphub:panel] 自动化启动失败：', e);
    }

    if (!await panelBundleExists()) {
        console.info(`[rphub:panel] 未找到面板产物 ${PANEL_BUNDLE}。`
            + '把 RP助手 的构建产物放到 panel/rp-hub-panel.js（或跑 node tools/fetch-panel.mjs）即可启用面板。');
        return;
    }

    try {
        await import(PANEL_BUNDLE);
        console.info('[rphub:panel] 面板 bundle 已加载。');
    } catch (e) {
        console.error('[rphub:panel] 面板 bundle 加载失败：', e);
    }

    // 控制台诊断：window.__rphubPanel__.backend().mode === 'local' | 'server'
    try {
        window.__rphubPanel__ = { backend: () => getLocalBackend() };
    } catch { /* 忽略 */ }
}

void main();

/* ------------------------------ 诊断 RPC ------------------------------ */
//
// 页面 realm 里 `SillyTavern.getContext()` 可能是裁剪版（拿不到 characters/this_chid），
// 而酒馆助手脚本 iframe 里是完整的。所以「当前卡是谁 / 卡内正则是否放行 / 放行与撤销」
// 都由本 iframe 执行，页面只负责显示。

function installRpc() {
    const ctx = stCtx;
    const currentChar = resolveCurrentChar;

    const handlers = {
        'regex-state': () => {
            const { ctx: c, avatar, name, char } = currentChar();
            const list = c?.extensionSettings?.character_allowed_regex;
            const th = (() => { try { return window.TavernHelper ?? null; } catch { return null; } })();
            return {
                hasContext: !!c,
                hasCharacter: !!char || !!avatar,
                avatar,
                name,
                allowed: Array.isArray(list) && avatar ? list.includes(avatar) : null,
                characterCount: Array.isArray(c?.characters) ? c.characters.length : null,
                thisChid: c?.this_chid ?? null,
                hasTavernHelper: !!th,
                resolvedVia: char ? 'characters' : (avatar ? 'tavern-helper' : 'none'),
            };
        },
        'regex-set': ({ allow } = {}) => {
            const { ctx: c, avatar } = currentChar();
            if (!c) return { ok: false, reason: '没有酒馆上下文' };
            if (!avatar) return { ok: false, reason: '未选中角色' };
            c.extensionSettings = c.extensionSettings || {};
            if (!Array.isArray(c.extensionSettings.character_allowed_regex)) {
                c.extensionSettings.character_allowed_regex = [];
            }
            const list = c.extensionSettings.character_allowed_regex;
            const idx = list.indexOf(avatar);
            if (allow && idx < 0) list.push(avatar);
            if (!allow && idx >= 0) list.splice(idx, 1);
            try { c.saveSettingsDebounced?.(); } catch { /* 忽略 */ }
            return { ok: true, allowed: !!allow, avatar, count: list.length };
        },
        'cards': () => {
            const be = getLocalBackend();
            if (!be?.base) return { ok: false, reason: '本地后端未安装' };
            return fetch(`${be.base}/cards`).then((r) => (r.ok ? r.json() : { ok: false, reason: `HTTP ${r.status}` }));
        },
        /**
         * 把本地库里解析出的角色卡世界书装进酒馆：创建世界书 → 绑定到当前角色。
         * 卡内 character_book 在 ST/TT 里不会自动变成世界书文件，所以 RP助手 的注入找不到目标。
         */
        'install-lorebook': async ({ name, entries } = {}) => {
            const { name: charName } = currentChar();
            const bookName = String(name || '').trim() || `${charName || 'Character'}'s Lorebook`;
            const list = Array.isArray(entries) ? entries : [];
            if (list.length === 0) return { ok: false, reason: '没有可导入的条目' };

            // 转成酒馆 world info JSON（交给 importRawWorldbook，避免自己猜 TH 的结构化字段）
            const json = toStWorldbookJson(list);

            const result = { ok: true, name: bookName, entries: list.length, imported: false, bound: false };
            try {
                const existing = (() => { try { return getWorldbookNames(); } catch { return []; } })();
                if (!existing.includes(bookName)) {
                    await importRawWorldbook(bookName, json);
                    result.imported = true;
                }
            } catch (e) {
                return { ok: false, reason: `导入世界书失败：${e?.message || e}` };
            }

            try {
                const current = (() => { try { return getCharWorldbookNames('current'); } catch { return null; } })();
                if (current) {
                    await rebindCharWorldbooks('current', {
                        primary: bookName,
                        additional: Array.isArray(current.additional) ? current.additional : [],
                    });
                    result.bound = true;
                }
            } catch (e) {
                result.bindError = e?.message || String(e);
            }
            return result;
        },

        /* ---- 自动化（免手动） ---- */
        'auto-get': () => ({ config: readAutoConfig(), last: globalThis.__rphubAutoLast ?? null }),
        'auto-set': async (patch = {}) => {
            const next = { ...readAutoConfig(), ...(patch && typeof patch === 'object' ? patch : {}) };
            writeAutoConfig(next);
            const run = await autoPrepare('config');
            return { config: next, last: run };
        },
        'auto-run': () => autoPrepare('manual'),
        'worldbook-duplicates': () => findDuplicateGroups(),
        'worldbook-delete': async ({ names: toDelete } = {}) => {
            const bound = (() => { try { return getCharWorldbookNames('current'); } catch { return null; } })();
            const deleted = [];
            const skipped = [];
            for (const bookName of Array.isArray(toDelete) ? toDelete : []) {
                if (!bookName) continue;
                if (bound?.primary === bookName) { skipped.push(bookName); continue; }
                try { await deleteWorldbook(bookName); deleted.push(bookName); } catch { skipped.push(bookName); }
            }
            return { deleted, skipped, boundPrimary: bound?.primary ?? null };
        },
        'worldbooks': () => {
            const names = (() => { try { return getWorldbookNames(); } catch { return []; } })();
            const bound = (() => { try { return getCharWorldbookNames('current'); } catch { return null; } })();
            return { names, bound, charName: currentChar().name };
        },
    };

    window.addEventListener('message', async (event) => {
        const data = event?.data;
        if (!data || typeof data !== 'object' || data.type !== 'rphub:rpc') return;
        const fn = handlers[data.method];
        let result = null;
        let error = null;
        try {
            if (!fn) error = `未知方法：${data.method}`;
            else result = await fn(data.params || {});
        } catch (e) {
            error = e?.message || String(e);
        }
        try {
            (event.source ?? window.parent)?.postMessage({ type: 'rphub:rpc:result', id: data.id, result, error }, '*');
        } catch { /* 忽略 */ }
    });

    console.info('[rphub:panel] 诊断 RPC 已就绪（regex-state / regex-set / cards）。');
}

/* ---------------- 模块级：上下文 / 当前卡 ---------------- */

function stCtx() {
    try { return SillyTavern.getContext(); } catch { return null; }
}

function resolveCurrentChar() {
    const c = stCtx();
    const th = (() => { try { return window.TavernHelper ?? null; } catch { return null; } })();

    // TT/某些版本里 ctx.this_chid 为 null → 用酒馆助手的公开 API 兜底
    let name = null;
    try { name = th?.getCurrentCharacterName?.() ?? null; } catch { /* 忽略 */ }

    let char = null;
    if (Array.isArray(c?.characters)) {
        if (name) char = c.characters.find((x) => x?.name === name) ?? null;
        if (!char && c.this_chid !== null && c.this_chid !== undefined) char = c.characters[c.this_chid] ?? null;
    }

    let avatar = char?.avatar ?? null;
    if (!avatar) {
        try {
            const path = th?.getCharAvatarPath?.('current');
            if (typeof path === 'string' && path) avatar = decodeURIComponent(path.split('/').pop() || '') || null;
        } catch { /* 忽略 */ }
    }

    return { ctx: c, char, avatar, name: name ?? char?.name ?? null };
}

/* ---------------- 自动化：免手动放行 + 免手动建世界书 ---------------- */

const AUTO_KEY = 'rphub:auto';

function readAutoConfig() {
    try {
        const raw = JSON.parse(localStorage.getItem(AUTO_KEY) || '{}');
        return { regex: true, worldbook: true, ...(raw && typeof raw === 'object' ? raw : {}) };
    } catch {
        return { regex: true, worldbook: true };
    }
}

function writeAutoConfig(config) {
    try { localStorage.setItem(AUTO_KEY, JSON.stringify(config)); } catch { /* 忽略 */ }
}

/** 归一化条目 → 酒馆 world info JSON 文本 */
function toStWorldbookJson(list) {
    const stEntries = {};
    list.forEach((entry, index) => {
        stEntries[String(index)] = {
            uid: index,
            key: Array.isArray(entry.keys) ? entry.keys : [],
            keysecondary: [],
            comment: entry.name || entry.comment || `Entry ${index}`,
            content: entry.content || '',
            constant: !!entry.constant,
            selective: !!entry.selective,
            selectiveLogic: 0,
            addMemo: true,
            order: 100,
            position: typeof entry.position === 'number' ? entry.position : 4,
            disable: !!entry.disable,
            excludeRecursion: !!entry.excludeRecursion,
            preventRecursion: false,
            delayUntilRecursion: false,
            probability: typeof entry.probability === 'number' ? entry.probability : 100,
            useProbability: true,
            depth: typeof entry.depth === 'number' ? entry.depth : 4,
            group: '',
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: 0,
            vectorized: false,
            sticky: 0,
            cooldown: 0,
            delay: 0,
        };
    });
    return JSON.stringify({ entries: stEntries }, null, 2);
}

/**
 * 自动准备当前卡：放行 scoped 正则 + 把卡内世界书落地并绑定。
 * 幂等；只在真正做了动作时提示。
 *
 * 防重建世界书的关键：**先按内容指纹找已有的那本**（TT 在你点“导入附带世界书”时
 * 已经建过一本，但绑定是异步的，我们若只看 primary 就会重复创建 → 两张书）。
 *
 * @param {'event'|'manual'|'config'} reason
 */
/**
 * 串行化包装：换卡事件 + 卡名轮询 + 手动触发可能同时到达，
 * 并发进入会各自看到「世界书还不存在」→ 重复创建。这里排队执行。
 */
let autoChain = Promise.resolve();
function autoPrepare(reason = 'event') {
    autoChain = autoChain.then(
        () => doAutoPrepare(reason),
        () => doAutoPrepare(reason),
    );
    return autoChain;
}

async function doAutoPrepare(reason = 'event') {
    const config = readAutoConfig();
    const be = getLocalBackend();
    const { name, avatar, ctx } = resolveCurrentChar();
    const out = { at: new Date().toISOString(), reason, name, actions: [], mode: null, cardId: null };

    if (!be?.base) { out.skipped = 'no-backend'; globalThis.__rphubAutoLast = out; return out; }
    if (!name) { out.skipped = 'no-character'; globalThis.__rphubAutoLast = out; return out; }

    try {
        const res = await fetch(`${be.base}/cards/by-name/${encodeURIComponent(name)}`);
        if (!res.ok) { out.skipped = 'not-in-library'; globalThis.__rphubAutoLast = out; return out; }
        const info = await res.json();
        out.mode = info.formatDetail ?? null;
        out.cardId = info.cardId ?? null;
        if (info.formatDetail !== 'rphub') { out.skipped = 'not-rphub'; globalThis.__rphubAutoLast = out; return out; }

        // ① 放行卡内 scoped 正则
        if (config.regex && avatar) {
            const c = ctx ?? stCtx();
            const list = c?.extensionSettings?.character_allowed_regex;
            if (!Array.isArray(list) || !list.includes(avatar)) {
                c.extensionSettings = c.extensionSettings || {};
                c.extensionSettings.character_allowed_regex = Array.isArray(list) ? list : [];
                c.extensionSettings.character_allowed_regex.push(avatar);
                try { c.saveSettingsDebounced?.(); } catch { /* 忽略 */ }
                out.actions.push('allow-regex');
            }
        }

        // ② 卡内世界书落地 + 绑定
        if (config.worldbook) {
            const lr = await fetch(`${be.base}/cards/${encodeURIComponent(info.cardId)}/lorebook`)
                .then((r) => (r.ok ? r.json() : null)).catch(() => null);
            const entries = Array.isArray(lr?.lorebook) ? lr.lorebook : [];
            if (entries.length > 0) {
                const wantedKey = signatureKey(entries);
                const names = (() => { try { return getWorldbookNames(); } catch { return []; } })();
                const bound = (() => { try { return getCharWorldbookNames('current'); } catch { return null; } })();
                const boundPrimary = bound?.primary || null;

                // 候选顺序：角色卡声明的世界书 → 已绑定且存在 → 内容指纹命中 → 兜底名
                const declared = (() => { try { return resolveCurrentChar().char?.data?.extensions?.world || null; } catch { return null; } })();
                let target = null;
                const candidates = [declared, boundPrimary].filter((x) => typeof x === 'string' && x);
                for (const candidate of candidates) {
                    if (!names.includes(candidate)) continue;
                    const same = await bookMatches(candidate, wantedKey);
                    if (same) { target = candidate; break; }
                }

                if (!target) {
                    // 内容指纹扫描：TT/ST 已导入的那本（名字可能不同）会被这里认出
                    target = await findBookBySignature(names, wantedKey);
                    if (target) out.actions.push('reuse-worldbook');
                }

                if (!target && boundPrimary && names.includes(boundPrimary)) target = boundPrimary;

                if (!target) {
                    target = `${name}'s Lorebook`;
                    if (names.includes(target)) {
                        target = `（无法复用）`; // 同名但内容不同 → 不覆盖用户的书
                    }
                }

                if (target && target !== '（无法复用）') {
                    if (!names.includes(target)) {
                        try {
                            await importRawWorldbook(target, toStWorldbookJson(entries));
                            out.actions.push('create-worldbook');
                        } catch (e) {
                            out.worldbookError = e?.message || String(e);
                        }
                    }
                    out.worldbook = target;
                    try {
                        await rebindCharWorldbooks('current', {
                            primary: target,
                            additional: Array.isArray(bound?.additional) ? bound.additional : [],
                        });
                        if (bound?.primary !== target) out.actions.push('bind-worldbook');
                    } catch (e) {
                        out.bindError = e?.message || String(e);
                    }
                } else {
                    out.worldbookSkipped = '同名世界书内容不同，已跳过以免覆盖';
                }
            }
        }
    } catch (e) {
        out.error = e?.message || String(e);
    }

    globalThis.__rphubAutoLast = out;
    if (out.actions.length > 0) {
        try {
            if (typeof toastr !== 'undefined') {
                toastr.success(`RP-Hub 自动处理：${out.actions.join(' / ')}`, 'RP-Hub', { timeOut: 6000 });
            }
        } catch { /* 忽略 */ }
        console.info('[rphub:panel] 自动处理完成：', out);
    }
    return out;
}

/** 绑定事件 + 启动时跑一次（延迟给宿主让路）；再按卡名变化兜底轮询 */
let lastAutoCharName = null;

function startAuto() {
    const run = () => { void autoPrepare('event').catch(() => { }); };
    try {
        if (typeof eventOn === 'function') {
            const et = (typeof tavern_events === 'object' && tavern_events) ? tavern_events : {};
            for (const evt of [et.CHAT_CHANGED, et.CHARACTER_CHANGED, et.APP_READY].filter(Boolean)) {
                try { eventOn(evt, run); } catch { /* 单个失败忽略 */ }
            }
        }
    } catch { /* 忽略 */ }

    setTimeout(run, 2000);

    // 兜底：宿主的换卡事件名在不同版本可能不同 → 盯住当前卡名变化（开销极小，只在变化时动作）
    try {
        setInterval(() => {
            try {
                const { name } = resolveCurrentChar();
                if (name && name !== lastAutoCharName) {
                    lastAutoCharName = name;
                    run();
                }
            } catch { /* 忽略 */ }
        }, 4000);
    } catch { /* 忽略 */ }

    console.info('[rphub:panel] 自动化已启动（放行正则 / 落地世界书，可在诊断面板关闭）');
}

/* ---------------- 世界书内容指纹（防重复创建 / 查重） ---------------- */

function normEntry(entry) {
    const name = String(entry?.name ?? entry?.comment ?? '').trim();
    const content = String(entry?.content ?? '').replace(/\s+/g, '');
    return `${name}::${content.slice(0, 60)}`;
}

/** 一组条目的内容指纹：条数 + 排序后的「名字::内容前缀」摘要 */
function signatureKey(list) {
    const parts = (Array.isArray(list) ? list : []).map(normEntry).sort();
    return `${parts.length}#${parts.join('|').slice(0, 400)}`;
}

/** 某本世界书是否与给定指纹一致 */
async function bookMatches(bookName, key) {
    try {
        const list = await getWorldbook(bookName);
        return signatureKey(list) === key;
    } catch {
        return false;
    }
}

/** 在已有世界书里按内容指纹找同一本（TT/ST 已导入的那本名字可能不同） */
async function findBookBySignature(names, key, limit = 40) {
    for (const bookName of (names || []).slice(0, limit)) {
        if (await bookMatches(bookName, key)) return bookName;
    }
    return null;
}

/** 找出内容重复的世界书分组（用于体检/清理） */
async function findDuplicateGroups(limit = 60) {
    const names = (() => { try { return getWorldbookNames(); } catch { return []; } })();
    const groups = new Map();
    for (const bookName of names.slice(0, limit)) {
        let key;
        try { key = signatureKey(await getWorldbook(bookName)); } catch { continue; }
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(bookName);
    }
    const duplicates = [...groups.values()].filter((g) => g.length > 1);
    const bound = (() => { try { return getCharWorldbookNames('current'); } catch { return null; } })();
    return { total: names.length, duplicates, boundPrimary: bound?.primary ?? null };
}
