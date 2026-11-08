// SPDX-License-Identifier: AGPL-3.0-or-later
// panel/enabler.js —— 运行在酒馆助手脚本 iframe 内（独立 realm）
//
// 职责（精简版，无诊断面板）：
//   1. 在这个 realm 里再装一次本地后端（父窗口的 patch 不跨 iframe）
//   2. 加载真正的面板 bundle（RP助手，可选产物）
//   3. 自动化：放行卡内 scoped 正则 + 把卡内世界书落地并绑定（幂等、不重复 rebind）

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
        console.warn('[rphub:panel] 本地后端安装失败：', e);
    }

    if (await panelBundleExists()) {
        try {
            await import(PANEL_BUNDLE);
            console.info('[rphub:panel] 面板 bundle 已加载。');
        } catch (e) {
            console.error('[rphub:panel] 面板 bundle 加载失败：', e);
        }
    } else {
        console.info('[rphub:panel] 未找到面板产物，跳过面板加载（引擎与自动化不受影响）。');
    }

    try {
        startAuto();
    } catch (e) {
        console.warn('[rphub:panel] 自动化启动失败：', e);
    }
}

void main();

/* ---------------- 模块级：上下文 / 当前卡 ---------------- */

function stCtx() {
    try { return SillyTavern.getContext(); } catch { return null; }
}

function resolveCurrentChar() {
    const c = stCtx();
    const th = (() => { try { return window.TavernHelper ?? null; } catch { return null; } })();

    // TT 某些版本里 ctx.this_chid 为 null → 用酒馆助手的公开 API 兜底
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

/* ---------------- 自动化 ---------------- */

const AUTO_KEY = 'rphub:auto';
/** 本会话已处理过的（卡 + 世界书目标），避免重复 rebind 触发整页重渲染 */
const autoDone = new Set();

function readAutoConfig() {
    try {
        const raw = JSON.parse(localStorage.getItem(AUTO_KEY) || '{}');
        // 默认：放行卡内正则（原卡自带美化）+ 世界书只复用/绑定（**不新建**，避免与
        // 酒馆原生导入、RP助手 的建书路径撞成两本）
        return { regex: true, worldbook: true, worldbookCreate: false, consolidate: true, ...(raw && typeof raw === 'object' ? raw : {}) };
    } catch {
        return { regex: true, worldbook: true, worldbookCreate: false, consolidate: true };
    }
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

/* ---------------- 世界书内容指纹（防重复创建） ---------------- */

function normEntry(entry) {
    const name = String(entry?.name ?? entry?.comment ?? '').trim();
    const content = String(entry?.content ?? '').replace(/\s+/g, '');
    return `${name}::${content.slice(0, 60)}`;
}

function signatureKey(list) {
    const parts = (Array.isArray(list) ? list : []).map(normEntry).sort();
    return `${parts.length}#${parts.join('|').slice(0, 400)}`;
}

async function bookMatches(bookName, key) {
    try {
        const list = await getWorldbook(bookName);
        return signatureKey(list) === key;
    } catch {
        return false;
    }
}

async function findBookBySignature(names, key, limit = 40) {
    for (const bookName of (names || []).slice(0, limit)) {
        if (await bookMatches(bookName, key)) return bookName;
    }
    return null;
}

/**
 * 世界书合并：把“同一份卡内容的重复书”和“RP助手 的 [RP] 专用书”合并到一本，删掉多余的。
 *
 * 判定非常保守：
 *   - 只有内容指纹与卡内世界书完全一致的书，才算“同一本”；
 *   - 只删除“所有条目都已存在于目标书里”的书（按 name+content 精确比对）；
 *   - 绝不新建；找不到卡内容书就什么都不做。
 */
async function consolidateWorldbooks(name, entries, bound) {
    const out = { actions: [] };
    try {
        if (typeof getWorldbookNames !== 'function' || typeof getWorldbook !== 'function'
            || typeof createWorldbookEntries !== 'function' || typeof deleteWorldbook !== 'function') {
            return out;
        }

        const names = (() => { try { return getWorldbookNames(); } catch { return []; } })();
        if (!Array.isArray(names) || names.length === 0) return out;

        const wantedKey = signatureKey(entries);
        const sigs = new Map();
        for (const book of names.slice(0, 40)) {
            try { sigs.set(book, signatureKey(await getWorldbook(book))); } catch { /* 跳过读失败的书 */ }
        }

        const cardBooks = names.filter((book) => sigs.get(book) === wantedKey);
        if (cardBooks.length === 0) return out;   // 没有卡内容书：不建、不合并

        // RP助手 的书：条目名里带 [RP]（如 [RP]变量更新），且不是卡内容书
        const rpBooks = names.filter((book) => {
            if (cardBooks.includes(book)) return false;
            const key = sigs.get(book) || '';
            return key.includes('[RP]') || key.includes('变量更新');
        });

        const target = (bound?.primary && cardBooks.includes(bound.primary)) ? bound.primary : cardBooks[0];
        out.target = target;

        const targetEntries = await getWorldbook(target).catch(() => []);
        const seen = new Set((targetEntries || []).map((e) => `${e?.name ?? ''}\u0000${e?.content ?? ''}`));

        // 先重新绑定，再删旧书：避免出现「primary 指向已删除书」的瞬间（RP助手 会因此再建一本）
        if (bound?.primary !== target) {
            try {
                await rebindCharWorldbooks('current', {
                    primary: target,
                    additional: Array.isArray(bound?.additional) ? bound.additional : [],
                });
                out.actions.push('rebind');
            } catch (e) {
                out.error = e?.message || String(e);
            }
        }

        const extras = [
            ...cardBooks.filter((book) => book !== target),
            ...rpBooks.filter((book) => book !== target),
        ];

        for (const book of extras) {
            let list = [];
            try { list = await getWorldbook(book); } catch { continue; }
            if (!Array.isArray(list) || list.length === 0) continue;

            const toAdd = list.filter((e) => !seen.has(`${e?.name ?? ''}\u0000${e?.content ?? ''}`));
            try {
                if (toAdd.length > 0) await createWorldbookEntries(target, toAdd);
            } catch (e) {
                out.error = e?.message || String(e);
                continue;   // 合并失败就保留这本，不删
            }
            for (const e of toAdd) seen.add(`${e?.name ?? ''}\u0000${e?.content ?? ''}`);

            // 只有当这本书的每一条都已存在于目标书里，才删除它
            const allCovered = list.every((e) => seen.has(`${e?.name ?? ''}\u0000${e?.content ?? ''}`));
            if (allCovered) {
                try {
                    await deleteWorldbook(book);
                    out.actions.push(`merge:${book}`);
                } catch (e) {
                    out.error = e?.message || String(e);
                }
            }
        }

    } catch (e) {
        out.error = e?.message || String(e);
    }
    return out;
}

/* ---------------- 自动准备 ---------------- */

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
    const out = { at: new Date().toISOString(), reason, name, actions: [] };

    if (!be?.base || !name) return out;
    if (!config.regex && !config.worldbook) return out;

    try {
        const res = await fetch(`${be.base}/cards/by-name/${encodeURIComponent(name)}`);
        if (!res.ok) return out; // 不在本地库：什么都不做
        const info = await res.json();
        if (info.formatDetail !== 'rphub') return out; // 普通卡完全让位

        // ① 放行卡内 scoped 正则（原卡自带美化）：默认开，且**不再自动撤销**
        if (config.regex && avatar) {
            const key = `regex:${avatar}`;
            const c = ctx ?? stCtx();
            const list = c?.extensionSettings?.character_allowed_regex;
            if (!autoDone.has(key) && (!Array.isArray(list) || !list.includes(avatar))) {
                c.extensionSettings = c.extensionSettings || {};
                c.extensionSettings.character_allowed_regex = Array.isArray(list) ? list : [];
                c.extensionSettings.character_allowed_regex.push(avatar);
                try { c.saveSettingsDebounced?.(); } catch { /* 忽略 */ }
                autoDone.add(key);
                out.actions.push('allow-regex');
            }
        }

        // ② 卡内世界书：只复用/绑定，不新建（避免与酒馆原生导入、RP助手 撞成多本）
        //    每张卡只扫描一次内容指纹（扫描要读多本世界书，不能每 3 秒重来）
        if (config.worldbook && !autoDone.has(`wb-scan:${name}`)) {
            const lr = await fetch(`${be.base}/cards/${encodeURIComponent(info.cardId)}/lorebook`)
                .then((r) => (r.ok ? r.json() : null)).catch(() => null);
            const entries = Array.isArray(lr?.lorebook) ? lr.lorebook : [];
            if (entries.length === 0) {
                autoDone.add(`wb-scan:${name}`);
            } else {
                const wantedKey = signatureKey(entries);
                const names = (() => { try { return getWorldbookNames(); } catch { return []; } })();
                const bound = (() => { try { return getCharWorldbookNames('current'); } catch { return null; } })();
                const boundPrimary = bound?.primary || null;

                let target = null;
                if (boundPrimary && names.includes(boundPrimary) && await bookMatches(boundPrimary, wantedKey)) {
                    target = boundPrimary;
                }
                if (!target) target = await findBookBySignature(names, wantedKey);
                if (!target && boundPrimary && names.includes(boundPrimary)) target = boundPrimary;

                // 不新建：酒馆原生导入与 RP助手 各有自己的建书路径，我们再建就会多一本。
                // 需要时（worldbookCreate=true）才兜底建 `<卡名>'s Lorebook`。
                if (!target && config.worldbookCreate === true) {
                    const fallback = `${name}'s Lorebook`;
                    if (!names.includes(fallback)) target = fallback;
                }
                if (!target) {
                    out.worldbookSkipped = 'no-match-no-create';
                    autoDone.add(`wb-scan:${name}`);   // 扫描过且无可复用 → 本会话不再重复扫描
                }

                const doneKey = `wb:${name}:${target ?? 'none'}`;
                if (target && !autoDone.has(doneKey)) {
                    if (!names.includes(target)) {
                        try {
                            await importRawWorldbook(target, toStWorldbookJson(entries));
                            out.actions.push('create-worldbook');
                        } catch (e) {
                            out.worldbookError = e?.message || String(e);
                        }
                    }
                    // 只有「绑定确实不一致」时才 rebind —— 这是正文重复刷新的根源，必须幂等
                    if (boundPrimary !== target) {
                        try {
                            await rebindCharWorldbooks('current', {
                                primary: target,
                                additional: Array.isArray(bound?.additional) ? bound.additional : [],
                            });
                            out.actions.push('bind-worldbook');
                            if (bound) bound.primary = target;   // 本地同步，避免随后 consolidate 再绑一次
                        } catch (e) {
                            out.bindError = e?.message || String(e);
                        }
                    }
                    autoDone.add(doneKey);
                }
                autoDone.add(`wb-scan:${name}`);       // 本会话该卡的世界书已处理完

                // 合并重复世界书（默认开；只合并“同内容”与“[RP] 专用”两类，删除前逐条校验覆盖）
                if (config.consolidate !== false && !autoDone.has(`merge:${name}`)) {
                    const merged = await consolidateWorldbooks(name, entries, bound);
                    autoDone.add(`merge:${name}`);
                    if (merged.actions.length > 0) out.actions.push(...merged.actions);
                    if (merged.error) out.mergeError = merged.error;
                }
            }
        }
    } catch (e) {
        out.error = e?.message || String(e);
    }

    if (out.actions.length > 0) {
        console.info('[rphub:panel] 自动处理完成：', out);
        try {
            if (typeof toastr !== 'undefined') {
                toastr.success(`RP-Hub 自动处理：${out.actions.join(' / ')}`, 'RP-Hub', { timeOut: 5000 });
            }
        } catch { /* 忽略 */ }
    }
    return out;
}

/** 事件驱动（不再轮询，避免无谓的重复处理与重渲染） */
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

    // 导入完成后没有事件通知（导入是宿主行为）→ 前 60 秒轻量轮询：
    // 只在「本地库出现该卡」时才会真正动作，且 autoDone 保证每卡只处理一次。
    try {
        let ticks = 0;
        const timer = setInterval(() => {
            ticks += 1;
            if (ticks > 20) { clearInterval(timer); return; }
            run();
        }, 3000);
    } catch { /* 忽略 */ }

    console.info('[rphub:panel] 自动化已启动（放行正则 / 复用并绑定世界书，不新建）');
}
