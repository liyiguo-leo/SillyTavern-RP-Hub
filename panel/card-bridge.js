// SPDX-License-Identifier: AGPL-3.0-or-later
// panel/card-bridge.js —— 卡内前端（iframe）与酒馆输入框之间的兼容桥
//
// 背景：很多 RP 风格卡的前端界面是按「宿主页面」写的 —— 点选项时向宿主发消息
// （或直接写父页面 DOM）来「填充输入框 / 发送」。在酒馆里这类消息本来没有宿主接收，
// 点击就表现为「有反馈但什么也没发生」。
//
// 本桥只做一件保守的事：识别「要求写入文本」的消息并落到酒馆输入框；
// 类型/字段都要求命中，避免误伤其它扩展的消息。可用 localStorage 关闭：
//   localStorage.setItem('rphub:card-bridge', '0')

const FLAG_KEY = 'rphub:card-bridge';

function isEnabled() {
    try { return localStorage.getItem(FLAG_KEY) !== '0'; } catch { return true; }
}

function findText(data) {
    for (const key of ['text', 'content', 'value', 'message', 'prompt', 'insert', 'fill']) {
        const value = data?.[key];
        if (typeof value === 'string' && value.trim()) return value;
    }
    return null;
}

/** 把文本写进酒馆输入框（带 input 事件，保证酒馆自己的监听生效） */
export function fillInput(text) {
    const box = document.querySelector('#send_textarea');
    if (!box) return false;
    box.value = String(text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    try { box.focus(); } catch { /* 忽略 */ }
    return true;
}

/** 触发酒馆的发送按钮 */
export function sendMessage() {
    const btn = document.querySelector('#send_but');
    if (!btn) return false;
    btn.click();
    return true;
}

/**
 * 安装桥。幂等。
 * @param {{verbose?: boolean}} [options]
 */
export function installCardBridge(options = {}) {
    const verbose = options.verbose !== false;
    if (window.__rphubCardBridgeInstalled) return window.__rphubCardBridge;

    const handler = (event) => {
        if (!isEnabled()) return;
        const data = event?.data;
        if (!data || typeof data !== 'object') return;

        const type = String(data.type ?? data.action ?? data.event ?? data.command ?? '');
        // 只认「写入/发送文本」这一类意图
        if (!/(input|insert|fill|send|prompt|choice|option)/i.test(type)) return;

        const text = findText(data);
        if (!text) return;

        const ok = fillInput(text);
        const wantSend = /send|submit/i.test(type);
        const sent = wantSend ? sendMessage() : false;

        if (verbose) {
            console.info('[rphub:bridge] 拦截到卡内消息并写入输入框', { type, length: text.length, ok, sent, data });
        }
        try {
            window.dispatchEvent(new CustomEvent('rphub:card-bridge', { detail: { type, text, ok, sent } }));
        } catch { /* 忽略 */ }
    };

    window.addEventListener('message', handler);
    window.__rphubCardBridgeInstalled = true;
    window.__rphubCardBridge = {
        enable: () => { try { localStorage.setItem(FLAG_KEY, '1'); } catch { /* 忽略 */ } },
        disable: () => { try { localStorage.setItem(FLAG_KEY, '0'); } catch { /* 忽略 */ } },
        isEnabled,
        fillInput,
        sendMessage,
        _handler: handler,
    };
    console.info(`[rphub:bridge] 卡内消息桥已安装（${isEnabled() ? '启用' : '已禁用'}）。`);
    return window.__rphubCardBridge;
}
