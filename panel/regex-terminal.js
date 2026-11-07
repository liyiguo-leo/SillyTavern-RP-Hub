// SPDX-License-Identifier: AGPL-3.0-or-later
// panel/regex-terminal.js —— 「RP-Hub 正则管理」小终端
//
// 用途：卡里常带一堆正则（字体、颜色、工具栏…），只想关掉其中几条时，
// 酒馆原正则面板把它们显示成“未命名”，很难认。这里按「角色卡 / 全局」分两组列出，
// 每条显示可辨认的名字（scriptName → name → findRegex 截断），逐条开关，改完立即写回。
//
// 入口：魔术棒菜单（#extensionsMenu）里的「RP-Hub 正则管理」。
// 不依赖控制台，安卓可用。

const PANEL_ID = 'rphub-regex-terminal';
const MENU_ITEM_ID = 'rphub-regex-menu-item';
const DISABLE_KEY = 'rphub:no-regex-terminal';

const state = {
    tab: 'scoped',      // 'scoped' | 'global'
    query: '',
    onlyEnabled: false,
    charName: null,
    scoped: [],
    global: [],
    loaded: false,
};

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/* ---------------- 宿主访问 ---------------- */

function ctx() {
    const pick = (w) => { try { return w?.SillyTavern?.getContext?.() ?? null; } catch { return null; } };
    return pick(globalThis) || (typeof window !== 'undefined' ? pick(window.parent) : null) || null;
}

function th() {
    try { return window.TavernHelper ?? null; } catch { return null; }
}

function currentCharacter() {
    const c = ctx();
    let name = null;
    try { name = th()?.getCurrentCharacterName?.() ?? null; } catch { /* 忽略 */ }
    let char = null;
    if (Array.isArray(c?.characters)) {
        if (name) char = c.characters.find((x) => x?.name === name) ?? null;
        if (!char && c.this_chid !== null && c.this_chid !== undefined) char = c.characters[c.this_chid] ?? null;
    }
    return { ctx: c, name: name ?? char?.name ?? null, char };
}

/** 卡内正则所在的容器（兼容 regex_scripts 在 data 顶层或 extensions 里） */
function scopedContainer(char) {
    if (!char?.data) return null;
    const ext = char.data.extensions;
    if (Array.isArray(ext?.regex_scripts)) return { list: ext.regex_scripts, write: (scripts) => { ext.regex_scripts = scripts; } };
    if (Array.isArray(char.data.regex_scripts)) return { list: char.data.regex_scripts, write: (scripts) => { char.data.regex_scripts = scripts; } };
    return null;
}

function scriptName(script, index) {
    const name = String(script?.scriptName || script?.name || '').trim();
    if (name) return name;
    const pattern = String(script?.findRegex || script?.regex || '').trim();
    if (pattern) return pattern.length > 42 ? `${pattern.slice(0, 42)}…` : pattern;
    return `(未命名 #${index + 1})`;
}

function isEnabled(script) {
    if (script?.disabled !== undefined) return !script.disabled;
    if (script?.enabled !== undefined) return !!script.enabled;
    return true;
}

function setEnabled(script, enabled) {
    if (script?.disabled !== undefined || !('enabled' in (script || {}))) {
        script.disabled = !enabled;
    } else {
        script.enabled = enabled;
    }
}

async function saveScoped() {
    const { ctx: c, name, char } = currentCharacter();
    const container = scopedContainer(char);
    if (!c || !container) return { ok: false, reason: '拿不到角色卡数据' };

    const scripts = container.list;
    // 优先 TH 的角色写回（TT 上更可靠），其次酒馆原生接口
    try {
        const helper = th();
        if (name && typeof helper?.updateCharacterWith === 'function') {
            await helper.updateCharacterWith(name, (ch) => {
                const ext = ch?.data?.extensions;
                if (Array.isArray(ext?.regex_scripts)) ext.regex_scripts = scripts;
                else if (Array.isArray(ch?.data?.regex_scripts)) ch.data.regex_scripts = scripts;
                return ch;
            });
            return { ok: true, via: 'tavern-helper' };
        }
    } catch (e) {
        console.warn('[rphub:regex] TH 写回失败，尝试原生接口：', e);
    }

    try {
        const findIndex = Array.isArray(c.characters) ? c.characters.findIndex((x) => x?.name === name) : -1;
        if (findIndex >= 0 && typeof c.writeExtensionField === 'function') {
            await c.writeExtensionField(findIndex, 'regex_scripts', scripts);
            return { ok: true, via: 'writeExtensionField' };
        }
    } catch (e) {
        return { ok: false, reason: e?.message || String(e) };
    }
    return { ok: false, reason: '没有可用的写回接口' };
}

function saveGlobal() {
    const c = ctx();
    if (!c?.extensionSettings) return { ok: false, reason: '拿不到设置' };
    c.extensionSettings.regex = state.global;
    try { c.saveSettingsDebounced?.(); } catch { /* 忽略 */ }
    return { ok: true };
}

function loadAll() {
    const { ctx: c, name, char } = currentCharacter();
    state.charName = name;
    const container = scopedContainer(char);
    state.scoped = container ? container.list : [];
    state.global = Array.isArray(c?.extensionSettings?.regex) ? c.extensionSettings.regex : [];
    state.loaded = true;
}

/** 角色卡是否被允许执行 scoped 正则（character_allowed_regex） */
function isAllowed() {
    const { ctx: c, char } = currentCharacter();
    const avatar = char?.avatar;
    const list = c?.extensionSettings?.character_allowed_regex;
    return !!(avatar && Array.isArray(list) && list.includes(avatar));
}

function setAllowed(allow) {
    const { ctx: c, char } = currentCharacter();
    const avatar = char?.avatar;
    if (!c || !avatar) return false;
    c.extensionSettings = c.extensionSettings || {};
    const list = Array.isArray(c.extensionSettings.character_allowed_regex)
        ? c.extensionSettings.character_allowed_regex
        : (c.extensionSettings.character_allowed_regex = []);
    const idx = list.indexOf(avatar);
    if (allow && idx < 0) list.push(avatar);
    if (!allow && idx >= 0) list.splice(idx, 1);
    try { c.saveSettingsDebounced?.(); } catch { /* 忽略 */ }
    return true;
}

/* ---------------- UI ---------------- */

function toast(message) {
    try {
        if (typeof window.toastr !== 'undefined') { window.toastr.info(message, 'RP-Hub'); return; }
    } catch { /* 忽略 */ }
    console.info('[rphub]', message);
}

function render(panel) {
    const list = state.tab === 'scoped' ? state.scoped : state.global;
    const query = state.query.trim().toLowerCase();
    const rows = list
        .map((script, index) => ({ script, index, name: scriptName(script, index), enabled: isEnabled(script) }))
        .filter((row) => !query || row.name.toLowerCase().includes(query)
            || String(row.script?.findRegex || '').toLowerCase().includes(query))
        .filter((row) => !state.onlyEnabled || row.enabled);

    const allowed = isAllowed();
    const enabledCount = list.filter(isEnabled).length;

    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px">
        <strong style="font-size:13px">RP-Hub 正则管理</strong>
        <span style="font-size:11px;opacity:.65">${esc(state.charName || '未选中角色')}</span>
        <span style="flex:1"></span>
        <button data-act="close" style="font-size:11px;padding:2px 6px">收起</button>
      </div>

      <div style="font-size:11px;display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">
        <button data-tab="scoped" style="font-size:11px;padding:2px 8px;${state.tab === 'scoped' ? 'font-weight:700' : ''}">角色卡（${state.scoped.length}）</button>
        <button data-tab="global" style="font-size:11px;padding:2px 8px;${state.tab === 'global' ? 'font-weight:700' : ''}">全局（${state.global.length}）</button>
        <span style="opacity:.7">已启用 ${enabledCount}/${list.length}</span>
      </div>

      ${state.tab === 'scoped'
        ? `<label style="font-size:11px;display:flex;align-items:center;gap:4px;margin-bottom:6px">
             <input type="checkbox" data-act="allow" ${allowed ? 'checked' : ''}>
             允许本卡正则（不勾选则整组都不生效）
           </label>`
        : ''}

      <div style="display:flex;gap:6px;margin-bottom:6px">
        <input data-act="query" placeholder="搜索名称或正则…" value="${esc(state.query)}"
               style="flex:1;font-size:11px;padding:3px 6px;border:1px solid #bbb;border-radius:5px">
        <label style="font-size:11px;display:flex;align-items:center;gap:3px">
          <input type="checkbox" data-act="only-enabled" ${state.onlyEnabled ? 'checked' : ''}>仅启用
        </label>
      </div>

      <div style="max-height:52vh;overflow:auto">
        ${rows.length === 0
            ? '<div style="font-size:11px;opacity:.65;padding:6px">没有匹配的条目</div>'
            : rows.map((row) => `
              <label style="display:flex;align-items:flex-start;gap:6px;padding:4px 2px;border-bottom:1px solid #eee;font-size:11px">
                <input type="checkbox" data-toggle="${row.index}" ${row.enabled ? 'checked' : ''} style="margin-top:2px">
                <span style="flex:1;word-break:break-all">${esc(row.name)}</span>
              </label>`).join('')}
      </div>
      <div style="font-size:10px;opacity:.6;margin-top:6px">
        条目来自${state.tab === 'scoped' ? '角色卡的 regex_scripts' : '酒馆全局正则列表'}；开关立即写回。
      </div>
    `;

    panel.querySelector('[data-act="close"]').addEventListener('click', () => { panel.style.display = 'none'; });

    panel.querySelectorAll('[data-tab]').forEach((btn) => {
        btn.addEventListener('click', () => {
            state.tab = btn.dataset.tab;
            loadAll();
            render(panel);
        });
    });

    const allowBox = panel.querySelector('[data-act="allow"]');
    if (allowBox) {
        allowBox.addEventListener('change', () => {
            const ok = setAllowed(allowBox.checked);
            toast(ok ? (allowBox.checked ? '已允许本卡正则' : '已禁止本卡正则（整组不生效）') : '写入失败：没有角色上下文');
            render(panel);
        });
    }

    const queryBox = panel.querySelector('[data-act="query"]');
    if (queryBox) {
        queryBox.addEventListener('input', () => {
            state.query = queryBox.value;
            const pos = queryBox.selectionStart;
            render(panel);
            const again = panel.querySelector('[data-act="query"]');
            if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch { /* 忽略 */ } }
        });
    }

    const onlyEnabledBox = panel.querySelector('[data-act="only-enabled"]');
    if (onlyEnabledBox) {
        onlyEnabledBox.addEventListener('change', () => {
            state.onlyEnabled = onlyEnabledBox.checked;
            render(panel);
        });
    }

    panel.querySelectorAll('[data-toggle]').forEach((box) => {
        box.addEventListener('change', async () => {
            const index = Number(box.dataset.toggle);
            const list = state.tab === 'scoped' ? state.scoped : state.global;
            const script = list[index];
            if (!script) return;
            setEnabled(script, box.checked);

            if (state.tab === 'scoped') {
                const result = await saveScoped();
                if (!result.ok) { toast(`保存失败：${result.reason}`); setEnabled(script, !box.checked); render(panel); return; }
                toast(`${scriptName(script, index)} 已${box.checked ? '启用' : '关闭'}`);
            } else {
                const result = saveGlobal();
                if (!result.ok) { toast(`保存失败：${result.reason}`); return; }
                toast(`${scriptName(script, index)} 已${box.checked ? '启用' : '关闭'}（全局）`);
            }
            render(panel);
        });
    });
}

/* ---------------- 挂载 ---------------- */

function isDisabled() {
    try {
        if (/[?&]rphub=noregex\b/.test(location.search)) return true;
        return localStorage.getItem(DISABLE_KEY) === '1';
    } catch {
        return false;
    }
}

/** 把入口挂进魔术棒菜单 */
function installMenuEntry(openPanel) {
    let attempts = 0;
    const tryInstall = () => {
        if (document.getElementById(MENU_ITEM_ID)) return true;
        const menu = document.getElementById('extensionsMenu');
        if (!menu) return false;
        const template = menu.querySelector('.extension_container');
        const node = template ? template.cloneNode(true) : (() => {
            const el = document.createElement('div');
            el.className = 'extension_container';
            el.innerHTML = '<div class="extension_icon">🔤</div><div class="extension_name">RP-Hub 正则管理</div>';
            return el;
        })();
        node.id = MENU_ITEM_ID;
        const nameEl = node.querySelector('.extension_name');
        if (nameEl) nameEl.textContent = 'RP-Hub 正则管理';
        const iconEl = node.querySelector('.extension_icon');
        if (iconEl) iconEl.textContent = '🔤';
        node.addEventListener('click', (event) => {
            event.stopPropagation();
            try {
                const $ = window.jQuery;
                if ($) { $('#extensionsMenu').hide(); $('#extensionsMenu').removeClass('open'); }
                menu.style.display = 'none';
            } catch { /* 忽略 */ }
            openPanel();
        });
        menu.appendChild(node);
        return true;
    };

    if (tryInstall()) return;
    const timer = setInterval(() => {
        attempts += 1;
        if (tryInstall() || attempts > 40) clearInterval(timer);
    }, 500);
}

export function mountRegexTerminal() {
    if (typeof document === 'undefined' || !document.body) return null;
    if (isDisabled()) return null;
    if (document.getElementById(PANEL_ID)) return document.getElementById(PANEL_ID);

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
        position: 'fixed', right: '8px', bottom: '150px', zIndex: '99999',
        width: `${Math.min(440, Math.max(280, window.innerWidth - 16))}px`,
        maxHeight: '70vh', overflow: 'auto',
        background: 'rgba(255,255,255,.98)', color: '#222',
        border: '1px solid #bbb', borderRadius: '8px', boxShadow: '0 6px 24px rgba(0,0,0,.25)',
        padding: '10px', fontFamily: 'system-ui, sans-serif', display: 'none', boxSizing: 'border-box',
    });

    const openPanel = () => {
        loadAll();
        panel.style.display = 'block';
        render(panel);
    };

    document.body.appendChild(panel);
    installMenuEntry(openPanel);

    window.__rphubRegexTerminal = {
        open: openPanel,
        close: () => { panel.style.display = 'none'; },
        state,
    };
    console.info('[rphub:regex] 正则管理终端已就绪（魔术棒菜单 → RP-Hub 正则管理）');
    return panel;
}
