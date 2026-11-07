# RP-Hub 套件（合并版）

把三个仓库合成一个可以直接装进酒馆的扩展，并让它**在没有 Node 服务端的酒馆（TT 酒馆）里也能跑**。

| 上游 | 在本仓的位置 | 运行时 | 作用 |
| --- | --- | --- | --- |
| [RegexPlus](https://github.com/ReikoYuzuka/SillyTavern-RegexPlus) | `src/` + `boot.js` | 酒馆页面 | 自研正则引擎：RP 卡走 RP-Hub 语义，普通卡走原版 ST 语义 |
| [Backend](https://github.com/ReikoYuzuka/SillyTavern-RPHub-Backend) | `server/`（原样）+ `local/`（浏览器移植） | Node / 浏览器 | 卡的嗅探、解析、规范化、查询与标记 |
| [RP-HUB（RP助手）](https://github.com/ReikoYuzuka/SillyTavern-RP-HUB) | `panel/rp-hub-panel.js` + `panel/enabler.js` | 酒馆助手 iframe | 变量 / 模板 / 渲染 / 诊断面板 |

一次安装：**扩展管理 → Install extension → 贴本仓库 git 地址**。装完之后正则引擎立即生效、
数据后端自动选路（有插件用服务器库，没有用浏览器 IndexedDB）、面板脚本自动注册进酒馆助手。

---

## 1. 装哪一版

TT 酒馆**支持** git URL 安装（匿名 http(s)，可选 branch/tag；不支持 SSH/凭证、submodule、LFS、ZIP）。
所以两种装法都是“贴 URL”，区别只在**装哪一版**：

```bash
# ① 先测（30 秒）：宿主有没有 /script.js
#    酒馆控制台： await window.__rphub__.checkCoreScript()

# ②-a ok:true  → 直接装默认分支（标准版）
#      Install extension → https://github.com/<you>/<repo>

# ②-b ok:false → 发布并安装 TT 版（仍是一条 git URL，只是带分支）
node tools/build-variant.mjs --target tt          # 本地出 dist/tt 自检
pwsh ./tools/publish-tt-branch.ps1 -RepoUrl https://github.com/<you>/<repo>
#      Install extension → URL 同上，Branch 填 tt
```

两版的差别不止一个文件（这是复查时补上的）：

| 文件 | 标准版 | TT 版 |
| --- | --- | --- |
| `src/st-bridge.js` | 静态 import `../../../../../script.js` | `variants/tt/st-bridge.js`：全从 `SillyTavern.getContext()` 取，`export let` + 事件/轮询保持活绑定 |
| `src/panel/ui.js` | 复刻酒馆正则设置面板（import 8 个酒馆内部模块） | `variants/tt/panel-ui-stub.js`：不挂该面板（引擎与 RP助手面板照常） |
| `src/store/scripts.js` | `uuidv4` 来自 `utils.js` | 改为本地实现 |

`build-variant` 会对 TT 产物做**硬校验**：任何跨出扩展目录的 `import` 都算失败（当前 0 处）。


**30 秒判断装哪版**（酒馆控制台）：

```js
await window.__rphub__.checkCoreScript()   // ok:true 用标准版；ok:false 用 TT 版
window.__rphub__.compat()                  // 宿主兼容面：getContext / eventSource / TavernHelper / IndexedDB …
```

真机回归逐项打勾见 [`tools/tt-checklist.md`](tools/tt-checklist.md)。

### 桌面 / 自建 ST 想用服务器库（可选）

```powershell
pwsh ./tools/install-server.ps1 -StPath "D:\SillyTavern"          # 复制
pwsh ./tools/install-server.ps1 -StPath "D:\SillyTavern" -Link    # 目录联接
```
```bash
bash tools/install-server.sh /path/to/SillyTavern
```

脚本把 `server/` 放进 `<ST>/plugins/rp-hub-compat`，并把 `config.yaml` 的
`enableServerPlugins` 打开（备份 `config.yaml.bak`），重启后
`GET /api/plugins/rp-hub-compat/v1/status` 返回 JSON 即生效。

---

## 2. 目录结构

```
rp-hub-unified/
├─ manifest.json            # 扩展清单（hooks.activate → init）
├─ index.js                 # 薄入口：装本地后端 + 动态装载引擎，失败给可执行提示
├─ boot.js                  # 引擎装载主体（原 index.js）：管道 / 流式 / 面板 / 面板注册
├─ src/                     # ★ RegexPlus 原样：st-bridge.js 用 5 级相对 import 取 public/script.js
├─ variants/tt/st-bridge.js # ★ TT 变体：同样 22 个导出，改从 SillyTavern.getContext() 取
├─ local/                   # ★ 后端逻辑的浏览器实现
│   ├─ pipeline.js          #   嗅探 → 解析 → 判定 → 规范化
│   ├─ parse/png.js         #   PNG tEXt/zTXt/iTXt（DecompressionStream 流式解压 + 上限保护）
│   ├─ parse/json.js        #   JSON 卡（含包裹形态解包）
│   ├─ normalize/*.js       #   角色 / 正则 / 世界书 / 变量 / 映射（与 server/lib 逐条对齐）
│   ├─ store.js             #   IndexedDB 卡库：**元数据与卡体分表** + marks + 导出/导入
│   ├─ api.js               #   REST 契约实现（与 server/lib/router.js 一一对应）
│   ├─ fetch-shim.js        #   拦截 /api/plugins/rp-hub-compat/v1/*
│   └─ compat.js            #   宿主兼容面探测（真机排查用）
├─ panel/                   # 面板桥：enabler / 注册 / 写回（两条导入通道）/ 上游产物
├─ server/                  # 原 Node 插件（可选增强）
└─ tools/
    ├─ install-server.ps1|.sh  # 装插件 + 开 config 开关
    ├─ build-variant.mjs       # 生成 dist/st 与 dist/tt 两套可装产物
    ├─ fetch-panel.mjs         # 取上游面板产物（可 --ref / --from）
    ├─ fidelity-test.mjs       # local/ vs server/ 规范化结果对拍
    ├─ api-test.mjs            # 接口层测试
    ├─ shim-test.mjs           # fetch 拦截层测试
    ├─ store-test.mjs          # 卡库分表 / 导出导入测试
    └─ tt-checklist.md         # TT 真机回归清单
```

---

## 3. 工作原理（四个关键点）

1. **零改动接管**：两个前端都是 `BASE = origin + '/api/plugins/rp-hub-compat/v1'` 再
   `fetch(BASE + path)`。`local/fetch-shim.js` 只包一层 `window.fetch`，命中前缀就转
   `local/api.js` —— 30+ 处调用点一行不改。`auto` 模式先探 `GET /status`：
   真插件在 → 直连服务器库；不在 → 本地 IndexedDB。
2. **逐位一致**：自带同步 SHA-256（`local/sha256.js`，`crypto.subtle` 在局域网 http 下不可用），
   所以 `contentHash` / `stableId` / `cardId` 与 Node 版完全相同，marks 键也对得上。
3. **写回改道**：`upload?writeBack=1` 在本地模式下依次尝试
   ① `POST /api/characters/import`（与原生拖入同链路）→ ② `TavernHelper.importRawCharacter`，
   两条都不可用时把原因写进 `standardCard.error`，卡本身已入本地库。
4. **同源托管面板**：`panel/enabler.js` 由扩展目录同源提供，先 `HEAD` 探在不在再 `import`；
   酒馆助手脚本只写一行 `import("<扩展地址>/panel/enabler.js")`，不依赖 CDN。

---

## 4. 验证

```bash
node tools/fidelity-test.mjs   #  8 项：真实 V3 卡 + 合成 RP 卡 ×6 + sha256，与 server/ 对拍
node tools/api-test.mjs        # 28 项：analyze/upload/status/by-name/variables/exists/marks/错误码
node tools/shim-test.mjs       # 10 项：auto 探测、base 前缀接管、非 base 透传
node tools/store-test.mjs      # 17 项：卡库分表（元数据不拖卡体）、导出/导入往返
```

合计 **63 项断言**。`fidelity-test` 必须零差异 —— 它是对 `server/lib` 与 `local/` 唯一防漂移闸门，
建议进 CI。设计与取舍见 [`docs/合并方案.md`](docs/合并方案.md)。

---

## 5. 与上游同步

- `src/` + `style.css`：RegexPlus 原样拷贝（`index.js`/`boot.js`/`manifest.json` 是本仓合并版）。
- `server/`：Backend 原样拷贝。
- `panel/rp-hub-panel.js`：`node tools/fetch-panel.mjs`（`--ref <tag>` 或 `--from <本地文件>`）。
- 长期建议改成 subtree/submodule + 构建期拼装，避免手工同步漏文件。

## 6. 自动化（无需任何面板操作）

扩展在**启动 / 换卡 / 切聊天**时自动执行（幂等，只在真的做了动作时提示）：

1. 只有本地库里 `formatDetail=rphub` 的卡才处理，普通卡完全不动；
2. **自动放行**卡内 scoped 正则（写 `character_allowed_regex`）；
3. **自动落地世界书**：把卡内 `character_book` 建成 `<卡名>'s Lorebook`，
   并用 `rebindCharWorldbooks('current', { primary, additional })` 绑到当前角色。

自动化默认开启。要退回手动（不自动放行、不自动建世界书）：
```js
localStorage.setItem("rphub:auto", JSON.stringify({ regex: false, worldbook: false }))
```

### 关于导入提示里的“判定：本地”

RP助手 原始文案是 `RP 卡已上传：…（判定：本地）`，其中的“本地”指**判定通道**
（前端本地启发式判定），不是“本地卡/普通卡”。合并版在构建时把它改成
`识别通道：前端判定为 RP 卡`（`tools/patch-panel.mjs`，精确替换，命中数为 0 会构建失败）。


## 7. 与酒馆内置「正则」的关系（重要）

本扩展的引擎是酒馆正则的替代实现，**两者不能同时跑**，否则同一份正则会被执行两次（双重替换）：

1. **关掉内置「正则」扩展**（系统扩展列表里那个 `正则`）。本仓 `src/` 引擎会接管显示/prompt 两条通道。
2. **卡内 scoped 正则需要放行**：引擎取脚本用 `allowedOnly: true`，卡内正则必须出现在
   `extension_settings.character_allowed_regex`（avatar 数组）里才会执行。
   - ST 版：正则面板里有开关；
   - TT 版：由上面的自动化在启动/换卡时自动放行，无需手动点。
3. 全局正则（`extension_settings.regex`）无需放行；预设正则需 `preset_allowed_regex`（TT 版暂未提供入口）。
4. 关掉内置正则后，卡导入时酒馆不再弹「是否允许此卡正则」，所以第 2 步要手动点一次。

## 8. 已知边界

- 本地模式不实现 `/cards/{id}/st`（无 PNG 编码器）→ 明确 `501 LOCAL_NOT_IMPLEMENTED`。
- IndexedDB 卡库与服务器库不互通；跨设备用 `exportLibrary()` / `importLibrary()`（可在控制台调用 `local/store.js` 的导出函数）。
- TT 变体的已知降级：无 `streamingProcessor` → 流式即时正则不生效；无 `getPresetManager` → 预设分组降级为安全空壳；`renderExtensionTemplateAsync` 返回空串（当前代码未使用）。

## 9. 许可证

各部件沿用上游：AGPL-3.0-or-later（RegexPlus / Backend），RP助手按其仓库 LICENSE；
本仓新增的 `local/`、`panel/`、`variants/`、`tools/` 同 AGPL-3.0-or-later。
