// SPDX-License-Identifier: AGPL-3.0-or-later
// variants/tt/st-bridge.js —— TT 变体：不 import 酒馆前端内部模块，全部从公开上下文取
//
// 何时使用：宿主**没有** /script.js（TauriTavern 等纯前端封装）。
// 构建：node tools/build-variant.mjs --target tt   → dist/tt/src/st-bridge.js
//
// 与标准版（src/st-bridge.js）的差异只有数据来源，导出的 22 个符号名与语义保持不变：
//   标准版：import { … } from '../../../../../script.js'（ST 的活绑定，this_chid 等随切卡自动更新）
//   TT 版：SillyTavern.getContext() + 事件/轮询刷新到同名 export let（保持导入方看到的值会变）
//
// 已知降级（真机验证清单里逐条打勾）：
//   - streamingProcessor 缺失 → 流式即时正则拦截不生效（legacy-hook 自身有 typeof 守卫，不会报错）
//   - getPresetManager 缺失 → 预设分组相关功能不可用（返回安全空壳）
//   - renderExtensionTemplateAsync 缺失 → 返回空串（当前代码未使用）

const FALLBACK_EVENT_TYPES = {
    APP_READY: 'app_ready',
    CHAT_CHANGED: 'chat_id_changed',
    CHARACTER_CHANGED: 'character_changed',
    CHARACTER_EDITED: 'character_edited',
    MESSAGE_RECEIVED: 'message_received',
    MESSAGE_SENT: 'message_sent',
    MESSAGE_EDITED: 'message_edited',
    MESSAGE_UPDATED: 'message_updated',
    MESSAGE_SWIPED: 'message_swiped',
    MESSAGE_DELETED: 'message_deleted',
    USER_MESSAGE_RENDERED: 'user_message_rendered',
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    GENERATION_AFTER_COMMANDS: 'generation_after_commands',
    GENERATE_AFTER_DATA: 'generate_after_data',
    PRESET_CHANGED: 'preset_changed',
    WORLDINFO_UPDATED: 'worldinfo_updated',
};

/** 取酒馆上下文：当前 realm 优先，其次父窗口 */
function ctx() {
    const pick = (w) => {
        try { return w?.SillyTavern?.getContext?.() ?? null; } catch { return null; }
    };
    return pick(globalThis)
        || (typeof window !== 'undefined' ? pick(window.parent) : null)
        || {};
}

const first = () => ctx();

/* ---------------- 会变化的绑定（export let + 刷新） ---------------- */

export const event_types = first().eventTypes ?? FALLBACK_EVENT_TYPES;
export let eventSource = first().eventSource ?? null;

export let chat = first().chat ?? [];
export let characters = first().characters ?? [];
export let this_chid = first().this_chid;
export let chat_metadata = first().chatMetadata ?? first().chat_metadata ?? {};
export let name1 = first().name1 ?? '';
export let power_user = first().powerUser ?? {};
export let extension_settings = first().extensionSettings ?? {};
export let streamingProcessor = first().streamingProcessor ?? null;
export let chatElement = (() => {
    try {
        if (typeof window !== 'undefined' && typeof window.$ === 'function') return window.$('#chat');
        return typeof document !== 'undefined' ? document.querySelector('#chat') : null;
    } catch { return null; }
})();

let lastRefresh = 0;

/** 把上下文里的最新值同步到上面的 export let（导入方看到的是同一个绑定） */
export function refreshBindings() {
    lastRefresh = Date.now();
    const c = first();
    if (Array.isArray(c.characters) && c.characters !== characters) characters = c.characters;
    if (c.this_chid !== undefined && c.this_chid !== this_chid) this_chid = c.this_chid;
    if (c.chat && c.chat !== chat) chat = c.chat;
    const meta = c.chatMetadata ?? c.chat_metadata;
    if (meta && meta !== chat_metadata) chat_metadata = meta;
    if (typeof c.name1 === 'string' && c.name1 !== name1) name1 = c.name1;
    if (c.powerUser && c.powerUser !== power_user) power_user = c.powerUser;
    if (c.extensionSettings && c.extensionSettings !== extension_settings) extension_settings = c.extensionSettings;
    if (c.eventSource && c.eventSource !== eventSource) eventSource = c.eventSource;
    if (c.streamingProcessor && c.streamingProcessor !== streamingProcessor) streamingProcessor = c.streamingProcessor;
    if (!chatElement) {
        try {
            chatElement = typeof window !== 'undefined' && typeof window.$ === 'function'
                ? window.$('#chat')
                : document.querySelector('#chat');
        } catch { /* 忽略 */ }
    }
}

// 事件驱动刷新（切卡/切聊天/编辑）+ 低频轮询兜底（宿主事件名可能不同）
(() => {
    try {
        const es = eventSource;
        const et = event_types || {};
        const names = [et.CHARACTER_CHANGED, et.CHAT_CHANGED, et.APP_READY, et.CHARACTER_EDITED].filter(Boolean);
        if (es && typeof es.on === 'function') {
            for (const name of names) es.on(name, refreshBindings);
        }
    } catch { /* 忽略 */ }

    try {
        const timer = setInterval(() => {
            try { refreshBindings(); } catch { /* 忽略 */ }
        }, 1000);
        if (typeof window !== 'undefined') {
            window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
        }
    } catch { /* 忽略 */ }
})();

/* ---------------- 函数型接口（委托；缺失时安全降级） ---------------- */

export function saveSettingsDebounced() {
    try { return first().saveSettingsDebounced?.(); } catch { return undefined; }
}

export function saveChatConditional() {
    try {
        const c = first();
        return (c.saveChatConditional ?? c.saveChat ?? (() => undefined))();
    } catch { return undefined; }
}

export function messageFormatting(...args) {
    try {
        const fn = first().messageFormatting;
        if (typeof fn === 'function') return fn(...args);
    } catch { /* 落到兜底 */ }
    return String(args[0] ?? '');
}

export function substituteParams(text, ...rest) {
    try {
        const fn = first().substituteParams;
        if (typeof fn === 'function') return fn(text, ...rest);
    } catch { /* 落到兜底 */ }
    return text;
}

export function substituteParamsExtended(text, ...rest) {
    try {
        const c = first();
        const fn = c.substituteParamsExtended ?? c.substituteParams;
        if (typeof fn === 'function') return fn(text, ...rest);
    } catch { /* 落到兜底 */ }
    return text;
}

export async function reloadCurrentChat() {
    try { return await first().reloadCurrentChat?.(); } catch { return undefined; }
}

export function getCurrentChatId() {
    try {
        const c = first();
        return (typeof c.getCurrentChatId === 'function' ? c.getCurrentChatId() : c.chatId) ?? null;
    } catch { return null; }
}

export function renderExtensionTemplateAsync() {
    // 当前合并版未使用（面板走自己同源托管的 HTML）
    return Promise.resolve('');
}

export function writeExtensionField(chid, key, value) {
    const c = first();
    try {
        if (typeof c.writeExtensionField === 'function') return c.writeExtensionField(chid, key, value);
        const character = (c.characters ?? [])[chid];
        if (character?.data) {
            character.data.extensions = character.data.extensions || {};
            character.data.extensions[key] = value;
            if (typeof c.saveCharacterDebounced === 'function') c.saveCharacterDebounced();
            return Promise.resolve();
        }
    } catch (e) {
        return Promise.reject(e);
    }
    return Promise.resolve();
}

/** 预设管理器：宿主不提供时返回安全空壳（预设分组功能降级，不抛错） */
export function getPresetManager(apiId) {
    const c = first();
    try {
        if (typeof c.getPresetManager === 'function') return c.getPresetManager(apiId);
    } catch { /* 落到空壳 */ }
    return {
        getSelectedPresetName: () => '',
        getPresetList: () => [],
        getPresetSettings: () => ({}),
        selectPreset: async () => undefined,
        savePreset: async () => undefined,
    };
}

export function trimSpaces(value) {
    return String(value ?? '').trim();
}

/** 酒馆 utils.js 的 uuidv4（store/scripts.js 建脚本 id 用） */
export function uuidv4() {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch { /* 落到手写实现 */ }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : ((r & 0x3) | 0x8);
        return v.toString(16);
    });
}

/** 诊断用：TT 变体标记（console 里能一眼看出装的是哪一版） */
export const BRIDGE_KIND = 'tt-ctx';
console.info(`[rphub] 已装载 TT 变体 st-bridge（${BRIDGE_KIND}）：数据来自 SillyTavern.getContext()，未 import /script.js`);
