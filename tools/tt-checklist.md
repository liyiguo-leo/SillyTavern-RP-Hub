# TT 酒馆真机回归清单

> 目标：把“能不能跑”变成一串可以打勾的数字。全程约 10 分钟，其中前 30 秒决定成败。

## 0. 装哪一版

TT 的扩展安装支持 git URL（可带分支/标签），所以三种都行：

| 情况 | 装什么 |
| --- | --- |
| 先测一次 | §1 的 `checkCoreScript()`；`ok:true` → 装默认分支即可，不用 TT 版 |
| `ok:false`（大概率） | 发布并安装 TT 分支：`pwsh ./tools/publish-tt-branch.ps1 -RepoUrl <你的仓库>` → Install extension 填同一 URL，**Branch 填 `tt`** |
| 不想开分支 | 把 `dist/tt/` 整目录放进 `data/<user>/extensions/third-party/rp-hub/`（TT 不支持 ZIP 安装，只能这样手动放） |

TT 版 = 同一份代码，替换三处：`src/st-bridge.js`（getContext 适配）、`src/panel/ui.js`（面板替身）、
`src/store/scripts.js` 的 `uuidv4` 来源。`BUILD.json` 的 `variant` 字段可确认装的是哪一版。

## 1. 30 秒硬前置（决定装哪一版）

打开酒馆 → F12 → Console：

```js
await window.__rphub__.checkCoreScript()
// → { ok: true,  status: 200, contentType: 'text/javascript', advice: '宿主提供了 /script.js：直接使用标准构建即可。' }
// → { ok: false, status: 404, ..., advice: '宿主没有 /script.js：请安装 TT 变体…' }

window.__rphub__.compat()
// → { hasGetContext, hasEventSource, hasCharacters, hasThisChid, hasTavernHelper, hasIndexedDB, ... }
```

判读：
- `hasGetContext: true` 是**硬要求**（没有它 TT 版也起不来，说明宿主版本太老）。
- `hasThisChid: true` 决定切角色后正则作用域是否正确。
- `hasTavernHelper: false` → 面板不会出现，但引擎与本地后端仍然工作。

## 2. 期望的 Console 顺序

```
[rphub] 宿主兼容面 {…}
[rphub] 宿主兼容面 …
[rphub] 数据后端：浏览器本地库（http://<host>/api/plugins/rp-hub-compat/v1）
[rphub] 当前角色模式：<rphub|st>，合并脚本数：<n>。
[rphub] 事件管道已启动（合并版：引擎 + 本地后端 + 面板）。
[rphub:panel] 本地后端已装入酒馆助手 iframe · 模式=local      ← 仅当装了酒馆助手
[rphub:panel] 面板 bundle 已加载。
[rphub] 已装载 TT 变体 st-bridge（tt-ctx）…                  ← 仅 TT 版
```

出现 `[rphub] 引擎模块装载失败` + 提示 `/script.js` → 就是 §1 的 `ok:false`，换 TT 版即可。

## 3. 功能勾选

| # | 动作 | 期望 | 结果 |
| --- | --- | --- | --- |
| 1 | 拖入一张 RP 卡（PNG）到页面 | toast「RP 卡已上传（判定：本地）」+ 角色被选中 | ☐ |
| 2 | 角色列表里点「导入」选择同一张卡 | 同上（走 `#character_import_file` 通道） | ☐ |
| 3 | 拖入一张普通 ST 卡 | 走原生导入，正则/世界书弹窗与以前一致 | ☐ |
| 4 | 打开「酒馆助手 → RP-Hub 面板」 | 面板出现，无红色报错 | ☐ |
| 5 | 面板「变量」页 | 能看到该卡的 `uiTemplates`/初始变量 | ☐ |
| 6 | 面板「诊断」页 | 显示卡信息；`st` 视图按钮若存在应报 `501 LOCAL_NOT_IMPLEMENTED`（预期） | ☐ |
| 7 | 面板「模板」页 | 模板列表可拉取（来自本地库） | ☐ |
| 8 | 对话一楼渲染 | RP 卡的正则/美化生效；普通卡行为与关闭扩展时一致 | ☐ |
| 8b | 系统扩展里的「正则」已禁用 | 与内置正则同时开启会双重替换，只能留一个 | ☐ |
| 8c | 诊断浮层 → 本卡内嵌正则 → 点「允许」 | scoped 正则放行后重新渲染，卡内规则才开始生效 | ☐ |
| 9 | 关闭再打开同一聊天 | 渲染结果一致（无重复替换、无空白） | ☐ |
| 10 | 面板手动「标记为 RP 卡」一张普通卡 | 标记后引擎切到 rphub 模式；刷新后仍生效（IndexedDB） | ☐ |
| 11 | 换一张卡 / 换聊天 | `this_chid` 跟随（TT 版靠事件+1s 轮询刷新） | ☐ |
| 12 | 刷新页面 | 本地库仍在（同一浏览器 profile） | ☐ |

## 4. 失败分支处置

| 现象 | 大概率原因 | 处置 |
| --- | --- | --- |
| `引擎模块装载失败 … dynamically imported module` | 宿主无 `/script.js` | 换 TT 版（`--target tt`） |
| 面板不出现，但引擎正常 | 未装/未启用酒馆助手；或 TH 版本无 `updateScriptTreesWith` | 装 TH ≥ 4.9.1；或在 TH 里手动添加脚本：`import("<扩展地址>/panel/enabler.js")` |
| toast「RP 卡上传失败」/ `standardCard.error` | 宿主没有 `/api/characters/import`，也没有 `importRawCharacter` | 看 console 两条 warn：说明两条导入通道都不可用；卡已在本地库，可用「角色 → 导入」手动选文件 |
| 导入成功但面板/引擎认为「卡不在库」 | IndexedDB 被清（隐私模式/换 profile） | 重新导入一次；或用 `exportLibrary`/`importLibrary` 迁移 |
| 切角色后正则作用域不对 | `compat().hasThisChid === false`（TT 版拿不到 `this_chid`） | 贴 `compat()` 输出与版本号反馈 |
| 流式时正则不即时擦除 | TT 无 `streamingProcessor`（已知降级） | 属预期；非流式渲染正常即可 |

## 5. 反馈时请贴这三样

1. 第 1 节的 `checkCoreScript()` 与 `compat()` 两个对象；
2. Console 从 `[rphub]` 开始到报错处的完整片段；
3. `BUILD.json`（在扩展目录里，标明 `variant: st|tt`）。
