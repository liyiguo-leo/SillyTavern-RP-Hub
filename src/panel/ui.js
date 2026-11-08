// SPDX-License-Identifier: AGPL-3.0-or-later
// variants/tt/panel-ui-stub.js —— TT 变体里的“原版正则设置面板”替身
//
// 为什么替换：src/panel/ui.js 为了复刻酒馆原版正则设置界面，直接 import 了 8 个
// 酒馆前端内部模块（script.js / utils.js / templates.js / popup.js / AccountStorage.js /
// i18n.js / extensions.js / preset-manager.js / group-chats.js）。这些模块在
// TauriTavern 这类纯前端封装里不存在，整条 import 会让模块求值失败。
//
// 做法：保留同名导出 init()，但不挂任何界面。引擎管道与 RP助手 面板不受影响；
// 正则脚本的管理走卡内/预设/全局脚本（酒馆助手或卡作者提供的入口）。

/**
 * 与 src/panel/ui.js 的 init 保持同名（boot.js 会调用它）。
 * 不抛错、不挂界面，只在控制台说明一次。
 */
export async function init() {
    console.info(
        '[rphub] TT 变体：已跳过酒馆原版正则设置面板（它依赖酒馆内部前端模块）。\n'
        + '  正则脚本仍然由引擎按「卡内 scoped → 预设 → 全局」三层合并执行；\n'
        + '  需要可视化编辑时，用酒馆助手的脚本面板或卡内正则条目。',
    );
}

/** 面板里的诊断/调试入口在 TT 版不存在，这里给出明确的空实现，避免调用方解构报错 */
export const PANEL_AVAILABLE = false;
