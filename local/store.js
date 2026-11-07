// SPDX-License-Identifier: AGPL-3.0-or-later
// local/store.js —— 浏览器侧卡库（IndexedDB）
//
// 设计要点（v2，性能优化版）：
//   **元数据与卡体分表**。
//   旧实现一条记录同时装 normalized + raw(blocks)，于是 readIndex() 走 getAll()
//   会把所有卡的全部正文读进内存 —— by-name / exists / status 这些高频轻量查询
//   被大卡拖成 O(卡体总量)。现在：
//     cards   ：仅元数据（cardId/名字/计数/hash），index 上有 contentHash、nameKey
//     payload ：normalized + raw（只有真正读视图时才取）
//     marks   ：标记
//   DB_VERSION=2；upgrade 时自动补建 payload store（旧库不丢数据）。
//
// 无 indexedDB 的环境（Node 测试）自动退化为内存实现，接口不变。

import { SCHEMA_VERSION } from './constants.js';

const DB_NAME = 'rphub_local_backend';
const DB_VERSION = 2;
const STORE_CARDS = 'cards';
const STORE_PAYLOAD = 'payload';
const STORE_MARKS = 'marks';

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_CARDS)) {
                const s = db.createObjectStore(STORE_CARDS, { keyPath: 'cardId' });
                s.createIndex('contentHash', 'contentHash', { unique: false });
                s.createIndex('nameKey', 'nameKey', { unique: false });
            }
            if (!db.objectStoreNames.contains(STORE_PAYLOAD)) {
                db.createObjectStore(STORE_PAYLOAD, { keyPath: 'cardId' });
            }
            if (!db.objectStoreNames.contains(STORE_MARKS)) {
                db.createObjectStore(STORE_MARKS, { keyPath: 'contentHash' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/** 单事务封装：fn 内可直接发请求，事务完成后 resolve（结果由调用方在自己的请求上取）。 */
function withStore(db, storeNames, mode, fn) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeNames, mode);
        let settled = false;
        const done = (value) => { if (!settled) { settled = true; resolve(value); } };
        tx.oncomplete = () => done(undefined);
        tx.onerror = () => { if (!settled) { settled = true; reject(tx.error); } };
        tx.onabort = () => { if (!settled) { settled = true; reject(tx.error); } };
        try { fn(tx, done); } catch (e) { reject(e); }
    });
}

/** 包装单个 request：成功即 done(result) */
function request(tx, storeName, fn) {
    return new Promise((resolve, reject) => {
        const req = fn(tx.objectStore(storeName));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/** 内存兜底（Node / 隐私模式） */
class MemoryStore {
    constructor() {
        this.cards = new Map();
        this.payload = new Map();
        this.marks = new Map();
        this.backend = 'memory';
    }
    async listMetas() { return [...this.cards.values()]; }
    async getMeta(cardId) { return this.cards.get(cardId) || null; }
    async putMeta(meta) { this.cards.set(meta.cardId, meta); }
    async getPayload(cardId) { return this.payload.get(cardId) || null; }
    async putPayload(payload) { this.payload.set(payload.cardId, payload); }
    async deleteCard(cardId) { this.cards.delete(cardId); this.payload.delete(cardId); }
    async countCards() { return this.cards.size; }
    async listMarks() { return [...this.marks.values()]; }
    async putMark(mark) { this.marks.set(mark.contentHash, mark); }
    async deleteMark(hash) { this.marks.delete(hash); }
    async countMarks() { return this.marks.size; }
}

class IdbStore {
    constructor(db) {
        this.db = db;
        this.backend = 'indexeddb';
    }
    async listMetas() {
        return withStore(this.db, [STORE_CARDS], 'readonly', async (tx, done) => {
            done(await request(tx, STORE_CARDS, (s) => s.getAll()));
        });
    }
    async getMeta(cardId) {
        return withStore(this.db, [STORE_CARDS], 'readonly', async (tx, done) => {
            done((await request(tx, STORE_CARDS, (s) => s.get(cardId))) || null);
        });
    }
    async putMeta(meta) {
        return withStore(this.db, [STORE_CARDS], 'readwrite', async (tx) => {
            await request(tx, STORE_CARDS, (s) => s.put(meta));
        });
    }
    async getPayload(cardId) {
        return withStore(this.db, [STORE_PAYLOAD], 'readonly', async (tx, done) => {
            done((await request(tx, STORE_PAYLOAD, (s) => s.get(cardId))) || null);
        });
    }
    async putPayload(payload) {
        return withStore(this.db, [STORE_PAYLOAD], 'readwrite', async (tx) => {
            await request(tx, STORE_PAYLOAD, (s) => s.put(payload));
        });
    }
    async deleteCard(cardId) {
        return withStore(this.db, [STORE_CARDS, STORE_PAYLOAD], 'readwrite', async (tx) => {
            await Promise.all([
                request(tx, STORE_CARDS, (s) => s.delete(cardId)),
                request(tx, STORE_PAYLOAD, (s) => s.delete(cardId)),
            ]);
        });
    }
    async countCards() {
        return withStore(this.db, [STORE_CARDS], 'readonly', async (tx, done) => {
            done(await request(tx, STORE_CARDS, (s) => s.count()));
        });
    }
    async listMarks() {
        return withStore(this.db, [STORE_MARKS], 'readonly', async (tx, done) => {
            done(await request(tx, STORE_MARKS, (s) => s.getAll()));
        });
    }
    async putMark(mark) {
        return withStore(this.db, [STORE_MARKS], 'readwrite', async (tx) => {
            await request(tx, STORE_MARKS, (s) => s.put(mark));
        });
    }
    async deleteMark(hash) {
        return withStore(this.db, [STORE_MARKS], 'readwrite', async (tx) => {
            await request(tx, STORE_MARKS, (s) => s.delete(hash));
        });
    }
    async countMarks() {
        return withStore(this.db, [STORE_MARKS], 'readonly', async (tx, done) => {
            done(await request(tx, STORE_MARKS, (s) => s.count()));
        });
    }
}

let storePromise = null;

/** 取得卡库单例（同一 realm 内复用；跨 realm 由 IndexedDB 自身共享） */
export function getStore() {
    if (!storePromise) {
        storePromise = (async () => {
            if (typeof indexedDB === 'undefined') return new MemoryStore();
            try {
                return new IdbStore(await openDb());
            } catch (err) {
                console.warn('[rphub-local] IndexedDB 不可用，退回内存库：', err?.message || err);
                return new MemoryStore();
            }
        })();
    }
    return storePromise;
}

/* ---------------- 高层读写：保持后端语义 ---------------- */

/** 卡索引（等价 index.json）——只读元数据表，不碰卡体 */
export async function readIndex() {
    const store = await getStore();
    const metas = await store.listMetas();
    const index = { version: 1, cards: {} };
    for (const meta of metas) {
        if (!meta) continue;
        index.cards[meta.cardId] = meta;
    }
    return index;
}

export async function hasCard(cardId) {
    const store = await getStore();
    return !!(await store.getMeta(cardId));
}

/**
 * 读一张卡：元数据 + 卡体（视图接口用）。
 * @returns {Promise<null|object>} 形如 { ...meta, normalized, raw }
 */
export async function readCard(cardId) {
    const store = await getStore();
    const meta = await store.getMeta(cardId);
    if (!meta) return null;
    const payload = await store.getPayload(cardId);
    return { ...meta, normalized: payload?.normalized ?? null, raw: payload?.raw ?? null };
}

/** 写卡：元数据与卡体分开落库（调用方传 { meta, payload }） */
export async function writeCard(record) {
    const store = await getStore();
    const { meta, payload } = record;
    await store.putMeta({ ...meta, nameKey: String(meta.characterName || '').trim().toLowerCase() });
    await store.putPayload(payload);
}

export async function rollbackCard(cardId) {
    const store = await getStore();
    await store.deleteCard(cardId);
}

export async function findByContentHash(contentHash) {
    const index = await readIndex();
    for (const [cardId, meta] of Object.entries(index.cards)) {
        if (meta.contentHash === contentHash) return cardId;
    }
    return null;
}

/** 按角色名找卡（忽略大小写、取 importedAt 最新）——元数据表足够，不读卡体 */
export async function findByName(name) {
    const target = String(name || '').trim().toLowerCase();
    if (!target) return null;
    const store = await getStore();
    const metas = await store.listMetas();
    let best = null;
    for (const meta of metas) {
        if (!meta) continue;
        if (String(meta.nameKey ?? meta.characterName ?? '').trim().toLowerCase() !== target) continue;
        if (!best || String(meta.importedAt || '') > String(best.importedAt || '')) best = { ...meta };
    }
    return best;
}

/** marks 读写（结构 = { version:1, marks:{...} }） */
export async function readMarks() {
    const store = await getStore();
    const rows = await store.listMarks();
    const marks = {};
    for (const row of rows) marks[row.contentHash] = { type: row.type, note: row.note, markedAt: row.markedAt };
    return { version: 1, marks };
}

export async function writeMark(contentHash, mark) {
    const store = await getStore();
    if (!mark) {
        await store.deleteMark(contentHash);
        return;
    }
    await store.putMark({ contentHash, ...mark });
}

/** 本地库统计（诊断面板用）——count() 不付读正文的代价 */
export async function stats() {
    const store = await getStore();
    const [cards, marks] = await Promise.all([store.countCards(), store.countMarks()]);
    return { backend: store.backend, cards, marks };
}

/**
 * 导出整个卡库（跨设备迁移用）。只导出元数据 + normalized，不含 raw blocks。
 * @returns {Promise<object>}
 */
export async function exportLibrary() {
    const store = await getStore();
    const metas = await store.listMetas();
    const cards = [];
    for (const meta of metas) {
        const payload = await store.getPayload(meta.cardId);
        cards.push({ meta, normalized: payload?.normalized ?? null });
    }
    const marks = await store.listMarks();
    return {
        format: 'rphub-local-library',
        version: 1,
        schema_version: SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        cards,
        marks,
    };
}

/**
 * 导入卡库（幂等：同 cardId 覆盖）。
 * @param {object} bundle exportLibrary() 的产物
 * @returns {Promise<{cards:number, marks:number}>}
 */
export async function importLibrary(bundle) {
    if (!bundle || bundle.format !== 'rphub-local-library') throw new Error('不是有效的卡库文件');
    const store = await getStore();
    let cards = 0;
    let marks = 0;
    for (const row of bundle.cards || []) {
        if (!row?.meta?.cardId) continue;
        await writeCard({
            meta: row.meta,
            payload: { cardId: row.meta.cardId, normalized: row.normalized, raw: null },
        });
        cards++;
    }
    for (const mark of bundle.marks || []) {
        if (!mark?.contentHash) continue;
        await store.putMark(mark);
        marks++;
    }
    return { cards, marks };
}
