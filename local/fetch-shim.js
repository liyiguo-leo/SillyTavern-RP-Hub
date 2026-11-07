// SPDX-License-Identifier: AGPL-3.0-or-later
// local/fetch-shim.js —— 把 /api/plugins/rp-hub-compat/v1/* 的调用就地接管
//
// 设计目标：**不改动 RP助手 / RegexPlus 的任何调用点**。
// 两个前端都是「BASE = origin + '/api/plugins/rp-hub-compat/v1'，然后 fetch(BASE + path)」，
// 因此只要在本 realm 里包一层 window.fetch，把命中 base 前缀的请求转给 local/api.js，
// 现有 30+ 处调用（导入拦截、变量视图、模板列表、marks、诊断）全部零改动跑在纯前端。
//
// 三种模式：
//   server —— 探测到真插件（GET /status 返回 JSON 且 plugin=rp-hub-compat）→ 不接管，直连服务端。
//   local  —— 无插件（TT酒馆/未开 enableServerPlugins/手机端）→ 接管，落 IndexedDB。
//   off    —— 显式关闭。
//
// 幂等：同一 realm 重复调用只换 hooks，不重复 patch。

import { handleRequest, getLastFailure } from './api.js';
import { API_BASE_PATH } from './constants.js';

const SHIM_KEY = Symbol.for('rphub.local.backend');
const GLOBAL_KEY = '__rphubLocalBackend__';

/** 默认 base：iframe 内用父窗口 origin（与两个前端各自的 BASE 推导一致） */
export function defaultBase() {
    try {
        const origin = (window.parent ?? window)?.location?.origin;
        if (origin && origin !== 'null') return origin + API_BASE_PATH;
    } catch { /* 跨源父窗口：退回同源 */ }
    try {
        return location.origin + API_BASE_PATH;
    } catch {
        return API_BASE_PATH;
    }
}

function toBytes(body) {
    if (!body) return null;
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return null; // Blob / FormData / string：由 toBytesAsync 处理
}

/** 支持 Blob/File 作为 body（某些拖拽实现直接给 File 而不是 arrayBuffer） */
async function toBytesAsync(body) {
    if (!body) return null;
    if (typeof Blob !== 'undefined' && body instanceof Blob) {
        return new Uint8Array(await body.arrayBuffer());
    }
    return toBytes(body);
}

function headersToObject(headers) {
    const out = {};
    if (!headers) return out;
    try {
        if (typeof headers.forEach === 'function') headers.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
        else for (const [k, v] of Object.entries(headers)) out[String(k).toLowerCase()] = String(v);
    } catch { /* 忽略 */ }
    return out;
}

function jsonResponse(status, body) {
    return new Response(JSON.stringify(body ?? null), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'x-rphub-backend': 'local' },
    });
}

/**
 * 安装本地后端（可重复调用）。
 * @param {object} [options]
 * @param {string} [options.base] 接口基址，默认 defaultBase()
 * @param {'auto'|'local'|'server'|'off'} [options.mode='auto']
 * @param {{importToSt?: Function}} [options.hooks] writeBack 用：把卡导入 ST 角色目录
 * @param {boolean} [options.verbose=true]
 * @returns {Promise<{mode:string, base:string, handle:Function}>}
 */
export async function installLocalBackend(options = {}) {
    const base = String(options.base || defaultBase()).replace(/\/+$/, '');
    const requested = options.mode || 'auto';
    const verbose = options.verbose !== false;
    const win = typeof window !== 'undefined' ? window : globalThis;

    if (!win[SHIM_KEY]) {
        win[SHIM_KEY] = {
            base,
            mode: 'off',
            hooks: {},
            originalFetch: win.fetch ? win.fetch.bind(win) : null,
        };
    }
    const state = win[SHIM_KEY];
    state.base = base;
    state.hooks = { ...state.hooks, ...(options.hooks || {}) };

    const handle = (method, path, { query, headers, body, jsonBody } = {}) => handleRequest({
        method,
        path,
        query: query || new URLSearchParams(),
        headers: headers || {},
        body,
        jsonBody,
        hooks: state.hooks,
    });

    if (!state.patched && state.originalFetch) {
        const originalFetch = state.originalFetch;

        win.fetch = async function rphubShimFetch(input, init = {}) {
            let url = null;
            try {
                if (typeof input === 'string') url = new URL(input, location.href).href;
                else if (input instanceof URL) url = input.href;
                else if (input && typeof input.url === 'string') url = new URL(input.url, location.href).href;
            } catch { url = null; }

            const matches = url && state.mode === 'local' && (url === state.base || url.startsWith(state.base + '/'));

            if (!matches) return originalFetch(input, init);

            const parsed = new URL(url);
            const path = parsed.pathname.slice(new URL(state.base).pathname.length) || '/';
            const method = String(init.method || (input && input.method) || 'GET').toUpperCase();
            const headers = headersToObject(init.headers || (input && input.headers));
            const body = await toBytesAsync(init.body);

            let jsonBody = null;
            if (body && body.length) {
                const isJson = /json/i.test(headers['content-type'] || '');
                // 有些调用点不带 Content-Type，但 body 明显是 JSON（marks PUT）→ 也尝试解析
                if (isJson || body[0] === 0x7b /* { */) {
                    try { jsonBody = JSON.parse(new TextDecoder().decode(body)); } catch { jsonBody = null; }
                }
            } else if (typeof init.body === 'string') {
                try { jsonBody = JSON.parse(init.body); } catch { jsonBody = null; }
            }

            const result = await handle(method, path, { query: parsed.searchParams, headers, body, jsonBody });
            return jsonResponse(result.status, result.body);
        };
        state.patched = true;
    }

    // 模式决策
    if (requested === 'off') {
        state.mode = 'off';
    } else if (requested === 'local') {
        state.mode = 'local';
    } else if (requested === 'server') {
        state.mode = 'server';
    } else {
        // auto：有真插件就用真插件（数据在服务器，可跨设备），否则本地
        state.mode = 'local';
        try {
            const res = await state.originalFetch(`${base}/status`, { method: 'GET' });
            if (res && res.ok) {
                const data = await res.json().catch(() => null);
                if (data && data.plugin === 'rp-hub-compat') state.mode = 'server';
            }
        } catch {
            state.mode = 'local';
        }
    }

    const info = { mode: state.mode, base, handle };
    try {
        win[GLOBAL_KEY] = {
            ...info,
            version: '0.1.0-local',
            api: handle,
            /** 最近一次失败请求的快照（TT 排障：__rphubLocalBackend__.lastFailure()） */
            lastFailure: () => getLastFailure(),
            reload: () => installLocalBackend({ base, mode: requested, hooks: state.hooks }),
            _state: state,
        };
    } catch { /* 忽略 */ }

    if (verbose) {
        console.info(`[rphub-local] 本地后端已就绪 · 模式=${state.mode} · base=${base}`);
    }
    return info;
}

/** 读取当前后端模式（供诊断面板显示「后端：服务端插件 / 浏览器本地库」） */
export function getLocalBackend() {
    const win = typeof window !== 'undefined' ? window : globalThis;
    return win[GLOBAL_KEY] || null;
}
