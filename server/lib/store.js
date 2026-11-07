// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

// lib/store.js — data/ 目录读写、cardId 生成、index.json/marks.json 原子更新
//
// 布局（见 数据存储/README.md）：
//   data/
//   ├── index.json            cardId → 轻量元数据（接口查询入口）
//   ├── marks.json            手动标记（contentHash → 标记）
//   ├── raw/{cardId}/         blocks.json + original.json
//   ├── normalized/{cardId}.json
//   └── imports/{cardId}.json 导入记录
//
// 写入约定：upload 内串行；normalized/raw/imports 先写，最后原子替换 index.json。

import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { errorIo } from './errors.js';

export const SCHEMA_VERSION = 2;

/** 进程内读缓存上限（LRU） */
const CACHE_LIMIT = 50;

export function computeContentHash(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

/**
 * 生成 cardId：c + 16 位十六进制。
 * 哈希输入 = 规范化前原始字节 sha256 前 8 字节 + 角色名 + 导入时间戳，
 * 保证同一张卡重复导入得到不同 cardId。
 */
export function generateCardId(buffer, characterName, importedAtIso) {
    const hash = createHash('sha256')
        .update(computeContentHash(buffer))
        .update(characterName || '')
        .update(importedAtIso)
        .digest('hex');
    return 'c' + hash.slice(0, 16);
}

export const CARD_ID_RE = /^c[0-9a-f]{16}$/;
export const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;

export function isValidCardId(id) {
    return typeof id === 'string' && CARD_ID_RE.test(id);
}

export function isValidContentHash(hash) {
    return typeof hash === 'string' && CONTENT_HASH_RE.test(hash);
}

/**
 * 异步原子写 JSON：写临时文件 + rename 替换。compact 序列化（省磁盘，机器数据无需 pretty）。
 */
async function atomicWriteJson(filePath, data) {
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
        await fsPromises.writeFile(tmpPath, JSON.stringify(data), 'utf8');
        await fsPromises.rename(tmpPath, filePath);
    } catch (err) {
        try {
            await fsPromises.unlink(tmpPath);
        } catch { /* ignore */ }
        throw errorIo(`写入文件失败：${filePath}`, { operation: filePath });
    }
}

export class Store {
    /**
     * @param {string} dataDir data/ 目录绝对路径
     */
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.rawDir = path.join(dataDir, 'raw');
        this.normalizedDir = path.join(dataDir, 'normalized');
        this.importsDir = path.join(dataDir, 'imports');
        this.indexPath = path.join(dataDir, 'index.json');
        this.marksPath = path.join(dataDir, 'marks.json');

        // 读缓存：
        // normalized 文件写入后不可变（cardId 每次导入唯一），Map 命中直接返回数据，不再重复 stat；
        // index 内存直接同步维护，避免每次重新从磁盘读取。
        this._normalizedCache = new Map(); // cardId -> data
        this._indexCache = null;           // { mtimeMs, size, data } | null

        // marks.json 并发更新锁（链式 Promise 互斥）
        this._marksMutex = Promise.resolve();

        // index.json 并发更新锁（F-4：链式 Promise 互斥，读写同锁串行化，
        // 关闭「读者旧 stat × 写者新缓存」交错导致的脏缓存投毒与并发上传丢条目）
        this._indexMutex = Promise.resolve();

        // 获锁无进展检查超时（BE-P2-05，八轮 N-1 修订）：见 _withIndexLock 注释。3s 是
        // 检查周期而非获锁时限——临界区均为内存操作+原子写盘（毫秒级），正常获锁远快于此；
        // 排队拥塞（检查期内锁链有获锁进展）只记诊断日志并继续等待，仅"零进展"才判死锁嫌疑。
        this._lockAcquireTimeoutMs = 3000;

        // index 锁获锁进展计数（每次任一等待者获锁 +1）与在途调用计数（诊断用）：见 _withIndexLock
        this._indexLockProgress = 0;
        this._indexLockInFlight = 0;

        // 异步确保目录初始化 Promise
        this._dirsReady = this._ensureDirs();
    }

    async _ensureDirs() {
        for (const dir of [this.dataDir, this.rawDir, this.normalizedDir, this.importsDir]) {
            try {
                await fsPromises.mkdir(dir, { recursive: true });
            } catch (err) {
                this._dirsReady = null; // 允许后续重试
                throw errorIo(`创建目录失败：${dir}`, { operation: dir });
            }
        }
    }

    // ---------- index.json ----------

    /**
     * index 临界区统一入口（F-4）。链式 Promise 互斥，读写全部串行化。
     *
     * 约束（见《修复方案验证报告》§二 A，违反将死锁/丢修改）：
     *   - 链式 Promise 锁【不可重入】：fn 内部严禁再调用任何公开加锁方法
     *     （readIndex/writeIndex/addCardEntry/updateIndexSafely/updateMarksSafely），
     *     只能使用 _readIndexUnlocked/_writeIndexUnlocked 无锁原语——否则 fn 会等待
     *     自己正持有的锁而永久死锁；
     *   - 进锁前先 await this._dirsReady，避免持锁等待目录初始化拉长临界区；
     *   - fn 返回值（含 Promise）会被 await：允许异步函数，但请保持临界区短小。
     * @param {() => Promise<any>|any} fn 临界区内执行的操作
     */
    async _withIndexLock(fn) {
        // 重入防护（BE-P2-05，八轮 N-1 修订）：链式 Promise 锁不可重入——fn 内部再调公开
        // 加锁方法会排队等待自己正持有的锁而永久死锁。防护不用共享计数/异步上下文：共享
        // depth 在持锁期间恒 >0，会把排队等待者（含持锁挂起期间错峰发起的合法并发）误判为
        // 重入（六审 BE-P2-05★ 回归：三并发上传必现 500 丢卡）；AsyncLocalStorage 在 Node 24
        // 存在嵌套 run + 同步 throw 时错误逃逸 try/catch 的传播缺陷（fix7-1l 实测）。
        // 获锁无进展判定（八轮 N-1，取代七轮"等待 3s 即判死锁"）：死锁与排队拥塞的可观测
        // 区别是锁链是否仍有获锁进展——死锁/持锁者挂起时锁链冻结（无人获锁），拥塞锁链仍
        // 周期性放行。因此以 _lockAcquireTimeoutMs 为窗口周期检查进展计数：窗口内有获锁
        // （delta ≥1）= 排队拥塞，合法等待（排队时长 = 前序临界区时长之和，与重入无关），
        // 仅记诊断日志并继续排队，不脱离队列不误杀（七审 07e：12 路串行 #9/#11 被误杀的
        // 根因即把排队时长当重入）；整个窗口零获锁（delta = 0）= 锁链冻结，报错脱离队列。
        // 零进展报错的文案同时列出"疑似重入死锁"与"临界区异常挂起"两种可能（锁视角不可
        // 区分，不诬指单一原因），并保留「重入调用等待获锁超时」子串兼容既有回归断言。
        // 已知权衡：单个临界区自身挂起 >3s 同样零进展会被报错（7~8 轮压测 A~F 的毫秒级
        // 临界区现状下不可达）；拥塞诊断后看门狗按窗口重臂，拥塞期间新形成的死锁仍会被
        // 后续零进展窗口检出。
        let release;
        const currentLock = this._indexMutex;
        this._indexMutex = new Promise((resolve) => { release = resolve; });
        const waiterStack = new Error('stack').stack; // 等待者发起栈（超时报错/诊断日志用）
        let abandoned = false; // 零进展报错脱离队列（未获锁即放弃）
        // 进展基线在调用时同步采样（任何 await 之前）：首窗口判据 = "自我开始等待以来锁链
        // 是否有获锁"。若改在 await _dirsReady 之后采样，Store 冷启动（dirsReady 未定）时
        // 采样会与前序等待者的获锁微任务竞争，可能把别人在自己入队前的获锁算进首窗口，
        // 多等一个窗口（行为良性但非确定）。
        let progressBaseline = this._indexLockProgress;
        try {
            await this._dirsReady;
            if (this._lockAcquireTimeoutMs <= 0) {
                await currentLock;
            } else {
                // 获锁看门狗：按窗口检查锁链获锁进展（delta），拥塞继续排队、零进展报错。
                for (;;) {
                    let windowTimer = null;
                    try {
                        const winner = await Promise.race([
                            currentLock.then(() => 'acquired'),
                            new Promise((resolveWindow, rejectWindow) => {
                                windowTimer = setTimeout(() => {
                                    if (this._indexLockProgress !== progressBaseline) {
                                        // 排队拥塞（N-1 核心）：只诊断，不脱离队列——继续等下一窗口
                                        console.warn(`[rp-hub-compat] store._withIndexLock 等待获锁已超过 ${this._lockAcquireTimeoutMs}ms（排队拥塞诊断：窗口内锁链仍有获锁进展，非重入死锁；本调用继续排队，不中断不报错）。在途临界区=${this._indexLockInFlight}，发起栈首帧: ${(waiterStack.split('\n')[1] || '').trim() || 'unknown'}`);
                                        resolveWindow('congested');
                                    } else {
                                        rejectWindow(new Error([
                                            'store._withIndexLock 等待获锁超时且窗口内锁链零获锁进展（重入调用等待获锁超时：疑似重入死锁——fn 内部再调公开加锁方法会排队等待自身释放；若确非重入，则可能是临界区异常挂起，请结合以下发起栈排查）。',
                                            'fn 内部请改用 _readIndexUnlocked/_writeIndexUnlocked 无锁原语。',
                                            waiterStack,
                                        ].join('\n')));
                                    }
                                }, this._lockAcquireTimeoutMs);
                            }),
                        ]);
                        if (winner === 'acquired') break;
                        // 'congested'：重臂下一窗口（重新采样进展基线），继续排队
                        progressBaseline = this._indexLockProgress;
                    } catch (err) {
                        abandoned = true;
                        throw err;
                    } finally {
                        if (windowTimer !== null) clearTimeout(windowTimer);
                    }
                }
            }
            this._indexLockProgress++; // 获锁进展计数（看门狗 delta 判据）
            this._indexLockInFlight++;
            try {
                return await fn();
            } finally {
                this._indexLockInFlight--;
            }
        } finally {
            if (abandoned) {
                // N-2（八轮修订）：零进展报错放弃时，本等待者的 pending 令牌此刻仍排在持锁者
                // 之后——立即 release 会把令牌交给下一等待者，形成"持锁者未退出、下一等待者
                // 已进入"的互斥重叠窗口（七审 07f3 实证）。故延迟到前序令牌落定（持锁者真正
                // 退出临界区）后再移交：放弃期间队列对后续等待者保持"未获锁"，互斥不破。
                // currentLock 只会 resolve 不会 reject，第二个 onRejected 仅为防御。
                currentLock.then(() => release(), () => release());
            } else {
                release();
            }
        }
    }

    /** 无锁读 index（仅供持锁上下文使用；逻辑与旧 readIndex 一致：stat 校验 → 缓存命中 → 读盘直更缓存） */
    async _readIndexUnlocked() {
        let st;
        try {
            st = await fsPromises.stat(this.indexPath);
        } catch (err) {
            if (err.code === 'ENOENT') return { version: 1, cards: {} };
            throw errorIo('读取索引元数据失败', { operation: this.indexPath });
        }

        if (this._indexCache && this._indexCache.mtimeMs === st.mtimeMs && this._indexCache.size === st.size) {
            return this._indexCache.data;
        }

        let data;
        try {
            data = JSON.parse(await fsPromises.readFile(this.indexPath, 'utf8'));
        } catch (err) {
            if (err.code === 'ENOENT') return { version: 1, cards: {} };
            throw errorIo('读取索引文件失败', { operation: this.indexPath });
        }

        this._indexCache = { mtimeMs: st.mtimeMs, size: st.size, data };
        return data;
    }

    /** 无锁原子写 index 并直更内存缓存（仅供持锁上下文使用；rename 后 stat+赋值与写同处一个临界区，杜绝交错投毒） */
    async _writeIndexUnlocked(index) {
        await atomicWriteJson(this.indexPath, index);
        try {
            const st = await fsPromises.stat(this.indexPath);
            this._indexCache = { mtimeMs: st.mtimeMs, size: st.size, data: index };
        } catch {
            this._indexCache = null;
        }
    }

    /** 读 index（加锁）。所有查询路径经此获得与写入一致的视图 */
    readIndex() {
        return this._withIndexLock(() => this._readIndexUnlocked());
    }

    /** 整体覆盖写 index（加锁）。常规「读-改-写」应使用 updateIndexSafely 而非先读后写两段式 */
    writeIndex(index) {
        return this._withIndexLock(() => this._writeIndexUnlocked(index));
    }

    /**
     * index 读-改-写原子操作（F-4）：锁内读出 → updater 原地变异 → 锁内原子落盘并直更缓存。
     * updater 的返回值作为本方法返回值透传。
     * @param {(index: object) => Promise<any>|any} updater 同步或异步变异函数（会被 await；
     *   内部不得调用任何公开加锁方法，见 _withIndexLock 约束）
     */
    updateIndexSafely(updater) {
        return this._withIndexLock(async () => {
            const index = await this._readIndexUnlocked();
            const result = await updater(index);
            await this._writeIndexUnlocked(index);
            return result;
        });
    }

    /** 卡是否存在 */
    async hasCard(cardId) {
        const index = await this.readIndex();
        return !!(index.cards && index.cards[cardId]);
    }

    /** 成功路径的收尾：把元数据原子写进 index.json（F-4：经互斥锁，杜绝并发上传丢条目） */
    addCardEntry(cardId, meta) {
        return this.updateIndexSafely((index) => {
            if (!index.cards) index.cards = {};
            index.cards[cardId] = meta;
        });
    }

    /**
     * 回滚一次上传（F-3 补偿）：锁内摘除 index 条目并原子落盘，锁外删除本次已写的全部文件，
     * 保证「索引-磁盘」最终一致。修复前 upload 收尾只裸删文件——addCardEntry 成功后的失败会
     * 留下指向缺失文件的索引条目（exists 预检误报 true、列表查询 404 的自相矛盾状态）。
     * 补偿路径尽力而为：索引摘除失败不阻塞文件清理，错误上报由调用方的原始异常主导。
     * @param {string} cardId 本次上传的 cardId
     */
    async rollbackUpload(cardId) {
        try {
            await this.updateIndexSafely((index) => {
                if (index.cards) delete index.cards[cardId];
            });
        } catch { /* 尽力而为：索引摘除失败仍继续删文件 */ }
        await this.removeCardFiles(cardId);
    }

    /** 按 contentHash 查已导入的 cardId（导入去重预检）；未导入返回 null */
    async findByContentHash(contentHash) {
        const index = await this.readIndex();
        for (const [cid, meta] of Object.entries(index.cards || {})) {
            if (meta && typeof meta === 'object' && meta.contentHash === contentHash) return cid;
        }
        return null;
    }

    // ---------- marks.json ----------

    async readMarks() {
        await this._dirsReady;
        try {
            const content = await fsPromises.readFile(this.marksPath, 'utf8');
            const parsed = JSON.parse(content);
            return { version: 1, marks: (parsed && typeof parsed.marks === 'object') ? parsed.marks : {} };
        } catch (err) {
            if (err.code === 'ENOENT') return { version: 1, marks: {} };
            throw errorIo('读取 marks.json 失败', { operation: this.marksPath });
        }
    }

    async writeMarks(marksData) {
        await this._dirsReady;
        await atomicWriteJson(this.marksPath, marksData);
    }

    /**
     * 并发安全标记修改（读取-修改-落盘互斥锁）
     * @param {(marksData: { version: number, marks: object }) => any} updater
     * @returns {Promise<any>} updater 的返回值
     */
    async updateMarksSafely(updater) {
        // marks 锁无重入防护（八轮 N-3，区别于 _withIndexLock）：updater 为同步调用不 await
        //（下方 `const result = updater(marksData)`），临界区仅覆盖 updater 的同步段 + 读写盘，
        // async updater 的续体在锁释放后才执行——结构上不存在"等待自己正持有的锁"的死锁路径
        //（七审 07c-C1/07h 实证），七轮加的 3s 哨兵是永不可达分支，已移除。
        // 代价：updater 必须同步变异（返回值若为 Promise 会被透传但不被等待，await 之后的
        // 变异跑在锁外，两路并发 async updater 有丢失更新面——N-6 既有登记，勿在 updater 内
        // await 后继续变异）。生产调用方 router.js 两处均为同步 updater。
        let release;
        const currentLock = this._marksMutex;
        this._marksMutex = new Promise((resolve) => { release = resolve; });
        try {
            await currentLock;
            const marksData = await this.readMarks();
            const result = updater(marksData);
            await this.writeMarks(marksData);
            return result;
        } finally {
            release();
        }
    }

    // ---------- 卡数据文件 ----------

    /** 写 raw/、normalized/、imports/ 三处；失败时回滚已写文件 */
    async writeCardFiles(cardId, { blocksData, originalData, normalizedData, importRecord }) {
        await this._ensureDirs();
        const rawDir = path.join(this.rawDir, cardId);
        const written = [];
        try {
            await fsPromises.mkdir(rawDir, { recursive: true });
            written.push({ type: 'dir', p: rawDir });

            const blocksPath = path.join(rawDir, 'blocks.json');
            await fsPromises.writeFile(blocksPath, JSON.stringify(blocksData), 'utf8');
            written.push({ type: 'file', p: blocksPath });

            const originalPath = path.join(rawDir, 'original.json');
            await fsPromises.writeFile(originalPath, JSON.stringify(originalData), 'utf8');
            written.push({ type: 'file', p: originalPath });

            const normalizedPath = path.join(this.normalizedDir, `${cardId}.json`);
            await fsPromises.writeFile(normalizedPath, JSON.stringify(normalizedData), 'utf8');
            written.push({ type: 'file', p: normalizedPath });

            const importPath = path.join(this.importsDir, `${cardId}.json`);
            await fsPromises.writeFile(importPath, JSON.stringify(importRecord), 'utf8');
            written.push({ type: 'file', p: importPath });

            // 写入成功后，直接放入内存缓存
            this._setNormalizedCache(cardId, normalizedData);
        } catch (err) {
            await this._rollbackAsync(written);
            if (err instanceof Error && err.code === 'ENOENT') {
                throw errorIo('写入卡文件失败（目录不可写）', { operation: this.dataDir });
            }
            throw errorIo('写入卡文件失败', { operation: cardId });
        }
    }

    async _rollbackAsync(written) {
        // 逆序清理：先文件后目录
        for (let i = written.length - 1; i >= 0; i--) {
            const item = written[i];
            try {
                if (item.type === 'file') {
                    await fsPromises.unlink(item.p);
                } else {
                    await fsPromises.rmdir(item.p);
                }
            } catch { /* ignore */ }
        }
    }

    /** 回滚 upload：删除某 cardId 全部已写文件（index.json 不在此列，调用方保证未写） */
    async removeCardFiles(cardId) {
        try {
            this._normalizedCache.delete(cardId);
            const rawDir = path.join(this.rawDir, cardId);
            await fsPromises.rm(rawDir, { recursive: true, force: true }).catch(() => {});
            const normalizedPath = path.join(this.normalizedDir, `${cardId}.json`);
            await fsPromises.unlink(normalizedPath).catch(() => {});
            const importPath = path.join(this.importsDir, `${cardId}.json`);
            await fsPromises.unlink(importPath).catch(() => {});
        } catch { /* ignore */ }
    }

    // ---------- 读路径 ----------

    _setNormalizedCache(cardId, data) {
        this._normalizedCache.set(cardId, data);
        if (this._normalizedCache.size > CACHE_LIMIT) {
            const oldest = this._normalizedCache.keys().next().value;
            this._normalizedCache.delete(oldest);
        }
    }

    async readNormalized(cardId) {
        // normalized 卡片数据具备不可变性（cardId 导入唯一），优先命中内存 Map，不再重复 stat
        if (this._normalizedCache.has(cardId)) {
            const data = this._normalizedCache.get(cardId);
            // LRU 刷新
            this._normalizedCache.delete(cardId);
            this._normalizedCache.set(cardId, data);
            return data;
        }

        const filePath = path.join(this.normalizedDir, `${cardId}.json`);
        let data;
        try {
            const content = await fsPromises.readFile(filePath, 'utf8');
            data = JSON.parse(content);
        } catch (err) {
            if (err.code === 'ENOENT') return null;
            throw errorIo('读取文件失败', { operation: filePath });
        }

        this._setNormalizedCache(cardId, data);
        return data;
    }

    async readRawBlocks(cardId) {
        try {
            const p = path.join(this.rawDir, cardId, 'blocks.json');
            return JSON.parse(await fsPromises.readFile(p, 'utf8'));
        } catch (err) {
            if (err instanceof Error && err.code === 'ENOENT') return null;
            throw errorIo('读取原始块失败', { operation: cardId });
        }
    }

    async readRawOriginal(cardId) {
        try {
            const p = path.join(this.rawDir, cardId, 'original.json');
            return JSON.parse(await fsPromises.readFile(p, 'utf8'));
        } catch (err) {
            if (err instanceof Error && err.code === 'ENOENT') return null;
            throw errorIo('读取原始 JSON 失败', { operation: cardId });
        }
    }

    // ---------- 元数据（ETag 用，避免读全文件） ----------

    /** normalized 文件元数据：{ mtimeMs, size }；不存在返回 null */
    async statNormalized(cardId) {
        try {
            const p = path.join(this.normalizedDir, `${cardId}.json`);
            const st = await fsPromises.stat(p);
            return { mtimeMs: st.mtimeMs, size: st.size };
        } catch (err) {
            if (err instanceof Error && err.code === 'ENOENT') return null;
            throw errorIo('读取规范化数据元数据失败', { operation: cardId });
        }
    }

    /** raw 目录元数据（blocks + original 文件的真实合并元数据：mtime 取最大、size 取和）；不存在返回 null */
    async statRaw(cardId) {
        try {
            const dir = path.join(this.rawDir, cardId);
            const blocks = path.join(dir, 'blocks.json');
            const original = path.join(dir, 'original.json');
            let mtimeMs = 0;
            let size = 0;
            for (const p of [blocks, original]) {
                const st = await fsPromises.stat(p);
                if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
                size += st.size;
            }
            return { mtimeMs, size };
        } catch (err) {
            if (err instanceof Error && err.code === 'ENOENT') return null;
            throw errorIo('读取原始数据元数据失败', { operation: cardId });
        }
    }
}
