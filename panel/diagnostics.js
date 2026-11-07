// SPDX-License-Identifier: AGPL-3.0-or-later
// panel/diagnostics.js —— 不需要控制台的诊断浮层（v2：移动端布局 + iframe RPC）
//
// 设计要点：
//   1. 布局自适应：宽度 min(460, 视口-16)，底边抬高避开输入框与宿主悬浮球；
//      长 URL / 长报错一律断行，不再横向溢出。
//   2. 当前卡与「卡内正则是否放行」由酒馆助手 iframe 通过 RPC 提供
//      （页面 realm 的 getContext() 在 TauriTavern 里可能是裁剪版）。
//   3. by-name 的 404 是正常探测，不计入失败（已由 fetch-shim 过滤）。
//   4. 卡库列表走 GET /cards，用来回答「卡到底有没有进本地库」。

const PANEL_ID = 'rphub-diagnostics-panel';
const BTN_ID = 'rphub-diagnostics-btn';

let forwardedFailure = null;
let lastState = null;      // 来自 iframe 的 regex-state
let lastCards = null;      // GET /cards 结果
let modeInfo = null;       // { text, notInLibrary }
let autoState = null;      // { config, last } 来自 iframe 的 auto-get

const pendingRpc = new Map();

/* ------------------------------ 工具 ------------------------------ */

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function backend() {
    try { return window.__rphubLocalBackend__ ?? null; } catch { return null; }
}

/** 「上次自动处理」的人话摘要 */
function autoText(last) {
    if (!last) return '尚未执行';
    const bits = [];
    if (last.mode) bits.push(`模式=${last.mode}`);
    if (Array.isArray(last.actions) && last.actions.length) bits.push(last.actions.join(' + '));
    else if (last.skipped) bits.push(`跳过：${last.skipped}`);
    if (last.error) bits.push(`错误：${last.error}`);
    if (last.worldbookError) bits.push(`世界书失败：${last.worldbookError}`);
    return `上次：${bits.join(' · ') || '无动作'}`;
}

function toast(message) {
    try {
        if (typeof window.toastr !== 'undefined') { window.toastr.info(message, 'RP-Hub'); return; }
    } catch { /* 忽略 */ }
    console.info('[rphub]', message);
}

/** 向所有子 frame 广播（酒馆助手 iframe 在里面） */
function broadcast(message) {
    try {
        const frames = window.frames || [];
        for (let i = 0; i < frames.length; i++) {
            try { frames[i].postMessage(message, '*'); } catch { /* 单个失败忽略 */ }
        }
    } catch { /* 忽略 */ }
}

/** 调 iframe 的 RPC；超时返回 null（表示没有 iframe 接） */
function rpc(method, params = {}, timeoutMs = 1500) {
    return new Promise((resolve) => {
        const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        pendingRpc.set(id, resolve);
        broadcast({ type: 'rphub:rpc', id, method, params });
        setTimeout(() => {
            if (pendingRpc.delete(id)) resolve(null);
        }, timeoutMs);
    });
}

try {
    window.addEventListener('message', (event) => {
        const data = event?.data;
        if (!data || typeof data !== 'object') return;

        if (data.type === 'rphub:rpc:result') {
            const done = pendingRpc.get(data.id);
            if (done) { pendingRpc.delete(data.id); done({ result: data.result ?? null, error: data.error ?? null }); }
            return;
        }

        if (data.type === 'rphub:failure') {
            forwardedFailure = { ...data.payload, from: 'tavern-helper-iframe', at: new Date().toISOString() };
            try {
                if (typeof window.toastr !== 'undefined' && forwardedFailure?.status >= 400) {
                    const code = forwardedFailure?.body?.error?.code || '';
                    window.toastr.error(`卡处理失败：${forwardedFailure.status} ${code}`, 'RP-Hub', { timeOut: 10000 });
                }
            } catch { /* 忽略 */ }
            if (typeof window.__rphubRenderDiagnostics === 'function') window.__rphubRenderDiagnostics();
            try { window.__rphubShowDiagnostics?.(); } catch { /* 忽略 */ }
        }
    });
} catch { /* 忽略 */ }

/** 汇总诊断（复制/报告用） */
export function collectReport(extra = {}) {
    const be = backend();
    const recent = typeof be?.recent === 'function' ? be.recent() : [];
    const failure = (typeof be?.lastFailure === 'function' ? be.lastFailure() : null) || forwardedFailure;
    return {
        at: new Date().toISOString(),
        extension: extra.version ? { version: extra.version } : undefined,
        backend: be ? { mode: be.mode, base: be.base, version: be.version } : null,
        host: {
            href: (() => { try { return location.href; } catch { return null; } })(),
            viewport: (() => { try { return { w: window.innerWidth, h: window.innerHeight }; } catch { return null; } })(),
            hasSillyTavern: (() => { try { return typeof SillyTavern !== 'undefined'; } catch { return false; } })(),
            hasTavernHelper: (() => { try { return !!window.TavernHelper; } catch { return false; } })(),
            hasTauriTavernDev: (() => { try { return !!window.__TAURITAVERN__?.api?.dev; } catch { return false; } })(),
        },
        currentCharacter: lastState,
        library: lastCards ? { count: lastCards.count, names: (lastCards.cards || []).slice(0, 10).map((c) => c.characterName) } : null,
        lastFailure: failure,
        recentRequests: recent,
    };
}

export function reportText(extra = {}) {
    return JSON.stringify(collectReport(extra), null, 2);
}

async function copyText(text) {
    try {
        if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
    } catch { /* 落到 execCommand */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    } catch {
        return false;
    }
}

/* ------------------------------ 渲染 ------------------------------ */

function layout(panel, btn) {
    const vw = Math.max(320, window.innerWidth || 360);
    const vh = Math.max(420, window.innerHeight || 640);
    const width = Math.min(460, vw - 16);

    Object.assign(btn.style, {
        right: '8px',
        bottom: '76px',          // 抬高，避开输入框与宿主悬浮球
    });
    Object.assign(panel.style, {
        width: `${width}px`,
        right: '8px',
        left: 'auto',
        bottom: '116px',
        maxHeight: `${Math.round(vh * 0.62)}px`,
    });
}

function renderPanel(panel, extra) {
    const report = collectReport(extra);
    const f = report.lastFailure;
    const state = lastState;
    const cards = lastCards;

    const recentRows = report.recentRequests.map((r) => (
        `<tr><td style="white-space:nowrap">${new Date(r.at).toLocaleTimeString()}</td>`
        + `<td style="word-break:break-all">${esc(r.method)} ${esc(r.path)}</td>`
        + `<td style="color:${r.status >= 400 ? '#c22' : '#1f8a4c'};white-space:nowrap">${r.status}</td>`
        + `<td style="white-space:nowrap">${r.byteLength}B</td></tr>`
    )).join('');

    const allowedText = state?.allowed === null || state?.allowed === undefined
        ? (state ? '未知' : '未知（未取到酒馆上下文）')
        : (state.allowed ? '已允许' : '未允许');
    const allowedColor = state?.allowed ? '#1f8a4c' : '#c22';

    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px">
        <strong style="font-size:13px">RP-Hub 诊断</strong>
        <span style="font-size:11px;opacity:.65">${esc(extra.version || '')}</span>
        <span style="flex:1"></span>
        <button data-act="copy" style="font-size:11px;padding:2px 6px">复制</button>
        <button data-act="logs" style="font-size:11px;padding:2px 6px">宿主日志</button>
        <button data-act="close" style="font-size:11px;padding:2px 6px">收起</button>
      </div>

      <div style="font-size:11px;line-height:1.6;margin-bottom:6px;word-break:break-all">
        后端：<b>${esc(report.backend?.mode ?? '未安装')}</b>${report.backend?.base ? `<br><span style="opacity:.7">${esc(report.backend.base)}</span>` : ''}<br>
        宿主：ST=${report.host.hasSillyTavern ? '✓' : '✗'} · 酒馆助手=${report.host.hasTavernHelper ? '✓' : '✗'} · TT调试API=${report.host.hasTauriTavernDev ? '✓' : '✗'}
      </div>

      <div style="font-size:11px;background:#f7f4ff;border:1px solid #d9d2f0;border-radius:6px;padding:6px;margin-bottom:6px">
        <b>自动化（免手动）</b>
        <div style="margin-top:3px;display:flex;flex-direction:column;gap:2px">
          <label><input type="checkbox" data-auto="regex" ${autoState?.config?.regex !== false ? 'checked' : ''}> 自动放行卡内正则（scoped）</label>
          <label><input type="checkbox" data-auto="worldbook" ${autoState?.config?.worldbook !== false ? 'checked' : ''}> 自动落地并绑定卡内世界书</label>
        </div>
        <div style="margin-top:4px;display:flex;gap:6px;align-items:center">
          <button data-act="auto-run" style="font-size:11px;padding:1px 8px">立即执行一次</button>
          <span style="opacity:.72">${esc(autoText(autoState?.last))}</span>
        </div>
      </div>

      <div style="font-size:11px;background:#f2f6ff;border:1px solid #ccd9f2;border-radius:6px;padding:6px;margin-bottom:6px;word-break:break-all">
        <b>当前卡</b>：${esc(state?.name ?? '未知')}${state?.avatar ? `<br><span style="opacity:.7">${esc(state.avatar)}</span>` : ''}
        ${state ? `<br><span style="opacity:.7">解析途径：${esc(state.resolvedVia || '?')} · 角色数：${esc(state.characterCount ?? '?')} · 酒馆助手：${state.hasTavernHelper ? '✓' : '✗'}</span>` : ''}<br>
        <b>正则引擎模式</b>：<span data-role="mode">${esc(modeInfo?.text ?? '查询中…')}</span><br>
        <b>识别来源</b>：自动判定=${esc(modeInfo?.auto ?? '?')} · 手动标记=${modeInfo?.marked ? '有' : '无'}<br>
        <b>卡内正则（scoped）</b>：<b style="color:${allowedColor}">${esc(allowedText)}</b>
        <div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap">
          <button data-act="allow" style="font-size:11px;padding:1px 8px">允许</button>
          <button data-act="deny" style="font-size:11px;padding:1px 8px">撤销</button>
          ${modeInfo?.cardId ? '<button data-act="inspect" style="font-size:11px;padding:1px 8px">卡面体检</button>' : ''}
          ${modeInfo?.cardId ? '<button data-act="install-lorebook" style="font-size:11px;padding:1px 8px">导入卡面世界书</button>' : ''}
          ${modeInfo?.marked ? '<button data-act="unmark" style="font-size:11px;padding:1px 8px">取消标记</button>' : ''}
          ${modeInfo?.notInLibrary ? '<button data-act="mark-rp" style="font-size:11px;padding:1px 8px">手动标记为 RP</button>' : ''}
        </div>
        <div style="opacity:.72;margin-top:4px">只能有一个正则引擎：请关闭酒馆内置「正则」扩展后，再在这里放行本卡。</div>
        <div data-role="inspect" style="margin-top:4px"></div>
      </div>

      <div style="font-size:11px;margin-bottom:6px;word-break:break-all">
        <b>本地卡库</b>：${cards ? `${cards.count} 张` : '读取中…'}
        ${cards && cards.cards?.length ? `<div style="opacity:.75;margin-top:2px">${cards.cards.slice(0, 4).map((c) => esc(c.characterName || '(无名)')).join(' · ')}${cards.count > 4 ? ' …' : ''}</div>` : ''}
      </div>

      ${f ? `<div style="font-size:11px;background:#fff3f3;border:1px solid #f3c9c9;border-radius:6px;padding:6px;margin-bottom:6px;word-break:break-all">
        <b>最近失败</b>：${esc(f.method)} <span style="opacity:.8">${esc(f.path)}</span> → <b style="color:#c22">${f.status}</b> ${esc(f.body?.error?.code || f.code || '')}<br>
        ${esc(f.body?.error?.message || f.message || '')}<br>
        体积 ${f.byteLength ?? 0}B · 前 16 字节 <code>${esc(f.headHex || '(空)')}</code>
        ${f.hint ? `<br>提示：${esc(f.hint)}` : ''}
      </div>` : '<div style="font-size:11px;margin-bottom:6px;opacity:.75">最近失败：无</div>'}

      <div style="font-size:11px;max-height:132px;overflow:auto">
        ${recentRows
            ? `<table style="width:100%;border-collapse:collapse;font-size:11px">
                 <thead><tr><th align="left">时间</th><th align="left">接口</th><th align="left">码</th><th align="left">体积</th></tr></thead>
                 <tbody>${recentRows}</tbody></table>`
            : '<div style="opacity:.7">本页暂无请求记录（请求可能发生在酒馆助手 iframe 里，那属正常）</div>'}
      </div>
      <div data-role="logs" style="font-size:11px;max-height:120px;overflow:auto;margin-top:6px;word-break:break-all"></div>
    `;

    panel.querySelector('[data-act="close"]').addEventListener('click', () => { panel.style.display = 'none'; });

    panel.querySelector('[data-act="copy"]').addEventListener('click', async () => {
        const ok = await copyText(reportText(extra));
        toast(ok ? '诊断报告已复制' : '复制失败：请手动抄写');
    });

    panel.querySelector('[data-act="logs"]').addEventListener('click', async () => {
        const box = panel.querySelector('[data-role="logs"]');
        box.textContent = '读取宿主日志…';
        try {
            const dev = await (window.__TAURITAVERN__?.ready ?? window.__TAURITAVERN_MAIN_READY__).then(() => window.__TAURITAVERN__?.api?.dev);
            if (!dev?.frontendLogs?.list) { box.textContent = '当前宿主没有 frontendLogs API'; return; }
            const entries = await dev.frontendLogs.list({ limit: 200 });
            const picked = (entries || []).filter((e) => String(e.message || '').includes('rphub')).slice(-40);
            box.innerHTML = picked.length
                ? picked.map((e) => `<div style="white-space:pre-wrap;margin-bottom:2px">[${esc(e.level)}] ${esc(e.message)}</div>`).join('')
                : '宿主日志里没有含 "rphub" 的条目';
        } catch (e) {
            box.textContent = `读取失败：${e?.message || e}`;
        }
    });

    panel.querySelector('[data-act="allow"]').addEventListener('click', async () => {
        const res = await rpc('regex-set', { allow: true });
        if (!res || res.error || !res.result?.ok) { toast(`放行失败：${res?.error || res?.result?.reason || '酒馆助手未响应'}`); return; }
        toast('已允许本卡内嵌正则；重新打开聊天后生效');
        await refresh(panel, extra);
    });

    panel.querySelector('[data-act="deny"]').addEventListener('click', async () => {
        const res = await rpc('regex-set', { allow: false });
        if (!res || res.error || !res.result?.ok) { toast(`撤销失败：${res?.error || res?.result?.reason || '酒馆助手未响应'}`); return; }
        toast('已撤销本卡内嵌正则的允许');
        await refresh(panel, extra);
    });

    // 卡不在本地库时的兜底：按「当前卡头像」的哈希写一条 rphub 标记（与 rp-mode 的探测口径一致）
    const markBtn = panel.querySelector('[data-act="mark-rp"]');
    if (markBtn) {
        markBtn.addEventListener('click', async () => {
            const be = backend();
            const avatar = lastState?.avatar;
            if (!be?.base || !avatar) { toast('缺少卡信息，无法标记'); return; }
            try {
                const res = await fetch(`/characters/${encodeURIComponent(avatar)}`);
                if (!res.ok) throw new Error(`读取卡图失败 HTTP ${res.status}`);
                const bytes = new Uint8Array(await res.arrayBuffer());
                const { sha256HexBytes } = await import('../local/sha256.js');
                const hash = sha256HexBytes(bytes);
                const put = await fetch(`${be.base}/marks/${hash}`, {
                    method: 'PUT',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ type: 'rphub' }),
                });
                if (!put.ok) throw new Error(`写入标记失败 HTTP ${put.status}`);
                try { window.__rphub__?.clearModeCache?.(); } catch { /* 忽略 */ }
                toast('已按当前卡标记为 RP；重新打开聊天后按 RP 语义渲染');
                await refresh(panel, extra);
            } catch (e) {
                toast(`标记失败：${e?.message || e}`);
            }
        });
    }

    // 卡面体检：把本地库真正存下来的东西摊开（回答「为什么识别成普通卡 / 为什么没有模板」）
    const inspectBtn = panel.querySelector('[data-act="inspect"]');
    if (inspectBtn) {
        inspectBtn.addEventListener('click', async () => {
            const be = backend();
            const cardId = modeInfo?.cardId;
            const box = panel.querySelector('[data-role="inspect"]');
            if (!be?.base || !cardId || !box) return;
            box.textContent = '体检中…';
            try {
                const res = await fetch(`${be.base}/cards/${cardId}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                const extKeys = Object.keys(data.character?.extensions || {});
                const rpKeys = extKeys.filter((k) => k.startsWith('rp_hub') || k === 'ui_templates' || k === 'rp_hub_watermark');
                const ui = data.variables?.uiTemplates?.length ?? 0;
                const runtime = data.variables?.runtimeByCharacter != null;
                box.innerHTML = `<div style="background:#fff;border:1px dashed #bbb;border-radius:6px;padding:6px;margin-top:4px">
                  formatDetail=<b>${esc(data.formatDetail)}</b><br>
                  regex=${(data.regex || []).length} · lorebook=${(data.lorebook || []).length} · uiTemplates=<b>${ui}</b> · runtimeByCharacter=${runtime ? '有' : '无'}<br>
                  extensions：${extKeys.length ? esc(extKeys.slice(0, 10).join(', ')) : '（无）'}<br>
                  RP-Hub 特征字段：${rpKeys.length ? esc(rpKeys.join(', ')) : '（无 → 上游会判为普通 ST 卡）'}
                </div>`;

                // 世界书现状：存在哪些书、当前卡绑的是哪本（RP助手 注入依赖 primary）
                const wb = await rpc('worldbooks');
                if (wb?.result) {
                    const names = Array.isArray(wb.result.names) ? wb.result.names : [];
                    const bound = wb.result.bound || null;
                    box.insertAdjacentHTML('beforeend', `<div style="background:#fff;border:1px dashed #bbb;border-radius:6px;padding:6px;margin-top:4px">
                      世界书：${names.length} 本${names.length ? `<br><span style="opacity:.75">${esc(names.slice(0, 6).join(' · '))}${names.length > 6 ? ' …' : ''}</span>` : ''}<br>
                      当前卡绑定：primary=<b>${esc(bound?.primary ?? '（无）')}</b> · additional=${(bound?.additional || []).length}
                    </div>`);
                }
            } catch (e) {
                box.textContent = `体检失败：${e?.message || e}`;
            }
        });
    }

    // 取消标记
    const unmarkBtn = panel.querySelector('[data-act="unmark"]');
    if (unmarkBtn) {
        unmarkBtn.addEventListener('click', async () => {
            const be = backend();
            const hash = modeInfo?.contentHash;
            if (!be?.base || !hash) { toast('缺少 contentHash，无法取消标记'); return; }
            try {
                const res = await fetch(`${be.base}/marks/${hash}`, { method: 'DELETE' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                try { window.__rphub__?.clearModeCache?.(); } catch { /* 忽略 */ }
                toast('已取消 RP 标记');
                await refresh(panel, extra);
            } catch (e) {
                toast(`取消标记失败：${e?.message || e}`);
            }
        });
    }

    // 自动化开关 + 立即执行
    panel.querySelectorAll('input[data-auto]').forEach((el) => {
        el.addEventListener('change', async () => {
            const patch = {};
            patch[el.dataset.auto] = el.checked;
            const res = await rpc('auto-set', patch, 25000);
            if (res?.result?.config) autoState = res.result;
            await refresh(panel, extra);
        });
    });
    const autoRunBtn = panel.querySelector('[data-act="auto-run"]');
    if (autoRunBtn) {
        autoRunBtn.addEventListener('click', async () => {
            const res = await rpc('auto-run', {}, 30000);
            await refresh(panel, extra);
            const last = res?.result;
            if (res?.error) toast(`自动处理失败：${res.error}`);
            else if (last?.actions?.length) toast(`已自动处理：${last.actions.join(' / ')}`);
            else toast(last?.skipped ? `无需处理（${last.skipped}）` : '自动处理完成，无动作');
        });
    }

    // 导入卡面世界书：卡内 character_book 在酒馆里不会自动变成世界书文件，这里补上并绑定到当前卡
    const loreBtn = panel.querySelector('[data-act="install-lorebook"]');
    if (loreBtn) {
        loreBtn.addEventListener('click', async () => {
            const be = backend();
            const cardId = modeInfo?.cardId;
            if (!be?.base || !cardId) { toast('没有可用的卡记录'); return; }
            try {
                const res = await fetch(`${be.base}/cards/${cardId}/lorebook`);
                if (!res.ok) throw new Error(`读取世界书失败 HTTP ${res.status}`);
                const data = await res.json();
                const entries = Array.isArray(data.lorebook) ? data.lorebook : [];
                if (entries.length === 0) { toast('这张卡没有卡内世界书条目'); return; }
                const out = await rpc('install-lorebook', { entries }, 30000);
                if (!out || out.error) throw new Error(out?.error || '酒馆助手未响应');
                const r = out.result || {};
                if (!r.ok) throw new Error(r.reason || '未知失败');
                toast(`世界书就绪：${r.name}（${r.entries} 条${r.imported ? '，已新建' : '，已存在'}${r.bound ? '，已绑定当前卡' : `，未绑定${r.bindError ? `：${r.bindError}` : ''}`}）`);
                await refresh(panel, extra);
            } catch (e) {
                toast(`导入世界书失败：${e?.message || e}`);
            }
        });
    }
}

/** 查当前卡在本地库里的语义模式 */
async function lookupMode(be) {
    const name = lastState?.name;
    if (!be?.base) return { text: '后端未安装' };
    if (!name) return { text: '未选中角色' };
    try {
        const res = await fetch(`${be.base}/cards/by-name/${encodeURIComponent(name)}`);
        if (res.status === 404) {
            const probe = await fetch(`${be.base}/status`);
            const reachable = probe.ok;
            return {
                text: reachable ? '卡不在本地库（按 st 语义运行）' : '后端不可达',
                notInLibrary: reachable,
            };
        }
        if (!res.ok) return { text: `HTTP ${res.status}` };
        const data = await res.json();
        const info = {
            text: `${data.formatDetail}${data.marked ? '（手动标记）' : ''}`,
            cardId: data.cardId ?? null,
            contentHash: data.contentHash ?? null,
            marked: !!data.marked,
            auto: data.formatDetail ?? null,
        };
        // 再读一次卡体，取「自动判定」的原始 formatDetail（它与 marks 覆盖后的生效值可能不同）
        if (info.cardId) {
            try {
                const r2 = await fetch(`${be.base}/cards/${info.cardId}`);
                if (r2.ok) {
                    const d2 = await r2.json();
                    if (d2?.formatDetail) info.auto = d2.formatDetail;
                    info.lorebookCount = Array.isArray(d2?.lorebook) ? d2.lorebook.length : null;
                    info.regexCount = Array.isArray(d2?.regex) ? d2.regex.length : null;
                }
            } catch { /* 忽略 */ }
        }
        return info;
    } catch {
        return { text: '查询失败' };
    }
}

/** 拉取 iframe 状态 + 卡库 + 当前卡模式，然后一次性重绘 */
async function refresh(panel, extra) {
    const be = backend();
    const [stateRes, cardsRes, autoRes] = await Promise.all([
        rpc('regex-state'),
        (async () => {
            if (!be?.base) return null;
            try {
                const res = await fetch(`${be.base}/cards`);
                return res.ok ? await res.json() : null;
            } catch { return null; }
        })(),
        rpc('auto-get'),
    ]);
    if (stateRes?.result) lastState = stateRes.result;
    if (cardsRes) lastCards = cardsRes;
    if (autoRes?.result) autoState = autoRes.result;

    modeInfo = await lookupMode(be);
    renderPanel(panel, extra);
}

/**
 * 挂载诊断浮层（幂等）。
 * @param {{version?: string}} [extra]
 */
export function mountDiagnostics(extra = {}) {
    if (typeof document === 'undefined' || !document.body) return null;
    if (document.getElementById(BTN_ID)) return document.getElementById(PANEL_ID);

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.textContent = 'RP-Hub 诊断';
    btn.title = '打开本地后端诊断（不需要控制台）';
    Object.assign(btn.style, {
        position: 'fixed', zIndex: '99998',
        padding: '4px 8px', fontSize: '11px', lineHeight: '1.4',
        background: 'rgba(30,30,30,.82)', color: '#eee', border: '1px solid #555',
        borderRadius: '6px', cursor: 'pointer', opacity: '.8',
    });

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
        position: 'fixed', zIndex: '99999', overflow: 'auto',
        background: 'rgba(255,255,255,.98)', color: '#222',
        border: '1px solid #bbb', borderRadius: '8px', boxShadow: '0 6px 24px rgba(0,0,0,.25)',
        padding: '10px', fontFamily: 'system-ui, sans-serif', display: 'none',
        boxSizing: 'border-box',
    });

    layout(panel, btn);
    window.addEventListener('resize', () => layout(panel, btn));

    // 默认不显示：诊断只是排障入口，正常使用不该占屏。
    // 出现失败时自动出现；也可用 ?rphub=debug 或控制台 __rphubShowDiagnostics() 调出。
    const debugRequested = (() => { try { return /[?&]rphub=debug\b/.test(location.search); } catch { return false; } })();
    btn.style.display = debugRequested ? '' : 'none';
    window.__rphubShowDiagnostics = () => { btn.style.display = ''; };

    btn.addEventListener('click', () => {
        const open = panel.style.display === 'none' || !panel.style.display;
        panel.style.display = open ? 'block' : 'none';
        if (open) {
            panel.innerHTML = '<div style="font-size:11px">读取中…</div>';
            void refresh(panel, extra);
        }
    });

    document.body.appendChild(btn);
    document.body.appendChild(panel);

    // 供 iframe 转发失败时重绘
    window.__rphubRenderDiagnostics = () => { if (panel.style.display !== 'none') void refresh(panel, extra); };

    // 页面 realm 自己的失败（例如导入拦截走父页面时）
    const be = backend();
    if (be?.onFailure) {
        be.onFailure((failure) => {
            const code = failure?.body?.error?.code || '';
            try {
                if (typeof window.toastr !== 'undefined') {
                    window.toastr.error(`卡处理失败：${failure.status} ${code}`, 'RP-Hub', { timeOut: 10000 });
                }
            } catch { /* 忽略 */ }
            panel.style.display = 'block';
            renderPanel(panel, extra);
            try { window.__rphubShowDiagnostics?.(); } catch { /* 忽略 */ }
        });
    }

    return panel;
}
