// SPDX-License-Identifier: AGPL-3.0-or-later
// panel/register.js —— 把 RP助手（酒馆助手脚本）注册/更新到酒馆助手
//
// 为什么这样可以做到「一次安装」：
//   RP助手 本身是酒馆助手（JS-Slash-Runner）里的一条脚本，内容就是一行 import，
//   指向构建产物；构建产物现在由本扩展同源托管（panel/rp-hub-panel.js），
//   所以扩展装好之后，只要把这一行脚本写进酒馆助手的全局脚本列表即可。
//
// 幂等：按脚本名匹配，已存在就更新 content（跟随扩展 URL / 版本），不存在就新增。

const SCRIPT_NAME = 'RP-Hub 面板（随扩展自动注册）';

/** 读取酒馆助手暴露的脚本 API（未安装酒馆助手时返回 null） */
function getScriptApi() {
    const TH = window.TavernHelper;
    if (!TH) return null;
    const { getScriptTrees, updateScriptTreesWith } = TH;
    if (typeof getScriptTrees !== 'function' || typeof updateScriptTreesWith !== 'function') return null;
    return { getScriptTrees, updateScriptTreesWith };
}

/**
 * 生成面板脚本内容。
 * 用动态 import() 而不是静态 import：酒馆助手的脚本按「函数体/eval」方式执行时
 * 也能跑（静态 import 只在模块顶层合法），出错也不会炸掉整条脚本。
 * @param {string} extensionUrl 含尾斜杠
 */
export function panelScriptContent(extensionUrl) {
    const enabler = new URL('panel/enabler.js', extensionUrl).href;
    return `import(${JSON.stringify(enabler)}).catch((e) => console.error('[rphub] 面板 enabler 加载失败', e));`;
}

/**
 * 注册/更新面板脚本。
 * @param {string} extensionUrl
 * @returns {Promise<'created'|'updated'|'skipped'|'no-tavern-helper'>}
 */
export async function registerPanelScript(extensionUrl) {
    const api = getScriptApi();
    if (!api) {
        console.info('[rphub] 未检测到酒馆助手（TavernHelper），跳过面板脚本注册；需要面板时请安装酒馆助手。');
        return 'no-tavern-helper';
    }

    const content = panelScriptContent(extensionUrl);
    const trees = api.getScriptTrees({ type: 'global' }) || [];

    const flatten = (nodes, out = []) => {
        for (const node of nodes || []) {
            if (!node) continue;
            if (node.type === 'folder') flatten(node.scripts, out);
            else out.push(node);
        }
        return out;
    };

    const existing = flatten(trees).find((s) => s && s.name === SCRIPT_NAME);
    if (existing) {
        if (existing.content === content && existing.enabled !== false) {
            console.debug('[rphub] 面板脚本已是最新，跳过。');
            return 'skipped';
        }
        await api.updateScriptTreesWith((current) => mapScripts(current, (script) => (
            script.name === SCRIPT_NAME ? { ...script, content, enabled: true } : script
        )), { type: 'global' });
        console.info('[rphub] 面板脚本已更新（跟随扩展地址/版本）。');
        return 'updated';
    }

    await api.updateScriptTreesWith((current) => {
        const next = mapScripts(current, (s) => s);
        next.push({
            type: 'script',
            enabled: true,
            name: SCRIPT_NAME,
            id: `rphub-panel-${Date.now()}`,
            content,
            info: '由 RP-Hub 套件扩展自动注册，删除本脚本即关闭面板',
            button: { enabled: false, buttons: [] },
            data: {},
            export_with: { data: false, button: false },
        });
        return next;
    }, { type: 'global' });
    console.info('[rphub] 面板脚本已注册（刷新页面或重开聊天后生效）。');
    return 'created';
}

/** 递归映射脚本树（保留 folder 结构） */
function mapScripts(nodes, fn) {
    return (nodes || []).map((node) => {
        if (!node) return node;
        if (node.type === 'folder') return { ...node, scripts: mapScripts(node.scripts, fn) };
        return fn(node);
    });
}
