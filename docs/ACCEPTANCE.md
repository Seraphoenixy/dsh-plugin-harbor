# 验收记录

每条记录写明：改了什么、为什么、如何验证。**夹具结论与真实验收必须分开记载**
（AGENTS.md 的硬约束）。

## 2026-11-02 · 开发时的自动重载

**用户要求**：给本插件也加上自动重载。当前是开发阶段；将来正式使用时，插件与源码项目
之间不会有关系（像这台机器上 dsh-channel-hub 的安装副本与它的 clone 那样）。

### 实现

新增 `src/ops/watch.ts`，在 `apply` 末尾接线：

| 决定 | 理由 |
|---|---|
| 监视 `dist/` 产物，而不是 `src/` | 构建是 `npm run build` 的事，插件不该在运行时跑编译器；谁构建的都无所谓 |
| 重载走 `pluginManager.setBundleEnabled(name, true)` | 与「热重载」按钮同一条宿主通道，不碰内核内部结构（对比 channel-hub 的 `reload.ts` 手动清 `loadCache`） |
| 开关判据是「包里有没有 `src/index.ts`」 | `package.json` 的 `files` 不含 `src/`，所以检出目录有、正式安装副本没有 —— **正式环境里监视器根本不启动** |
| 只认 `index.js` / `catalog-worker.js` | `client.js` 是浏览器入口，改它刷新页面即可 |
| 700ms 防抖 + 单飞 + 排队一次 | 一次构建连写多个文件；重载进行中再来的变更不该叠着跑 |
| `realpathSync` 后再监视 | `link:` 安装时 profile 里那条是 junction，直接监视收不到从另一条路径写入的事件 |
| watcher 与定时器都 `unref()` | 空闲的桌面进程仍能正常退出，测试也不会挂住 |

`PLUGIN_HARBOR_HOT_RELOAD=0` 可显式关闭。宿主没有 `hmr` 服务时如实记一行、不假装重载成功。

### 验证

| 检查 | 结果 |
|---|---|
| `npm run check` | **全绿**：主测试 155（新增 4）、client 32、host 8、package 8 files |
| 单元用例 `shouldWatch` | 检出目录（有 `src/index.ts` + `dist`）→ true；**只有 `dist/` 的正式副本 → false**；`PLUGIN_HARBOR_HOT_RELOAD=0` → false；`dist` 缺失 → false |
| 单元用例 `watchDist` 防抖 | 写 `client.js` 不触发（过滤生效）；连写三次 `index.js` 只触发一次 |
| 单元用例 `watchDist` 停止 | 停止后可重复调用、不再回调 |
| 单元用例 目录不存在 | 返回可用的空停止函数，不抛错 |
| **真实宿主用例** | 真跑一遍：插件起来后（`hot: true`）用 `utimesSync` 只改 `dist/index.js` 的 mtime（**内容不动**，避免污染后续用例加载的产物），断言桩 `pluginManager` 收到且仅收到一次 `setBundleEnabled("plugin-harbor", true)` |

**没覆盖的**：真实桌面窗口里「`npm run build` → 面板自己换掉自己」的观感（需要人工看一次）。
首次启用自动重载仍需重启一次 DSH（监视器本身是新代码）。

## 2026-11-02 · 市场浏览支持点击在浏览器中打开数据源详情页

**用户要求**：市场对插件的浏览时，应提供点击浏览器打开对应源网址的功能。

**口径纠正（同一天）**：第一版做成了指向 GitHub 代码仓库，用户指出「源站」指的是**数据源站**
（dsh-plugin.org 上该插件的详情页），不是代码仓库。已改为详情页地址。

### 实现

| 位置 | 改动 |
|---|---|
| 市场页每行 | 仓库名由 `<span>` 改成 `<a href="<站点基址>/zh/plugins/<owner>/<slug>" target="_blank" rel="noopener noreferrer">`；右侧新增显式「详情页」按钮（同为 `<a>`，指向同一地址） |
| 已装页 | 仓库名同样可点，指向同一个详情页 |
| 服务端 | `installed.list` 从目录行把 `slug`/`owner` 带出来（`InstalledRow.slug`/`owner`）——已装事实里只有 `repo`，不能从它反推 |
| 基址 | 跟随设置页的「站点基址」（自建镜像也对得上），默认 `https://dsh-plugin.org` |
| 安全 | 新增 `siteUrl()` + `normalizeSiteBase()`：owner/slug 逐字符校验、基址只接受 http/https 且拒绝带凭据的地址，不合法返回空串、调用方退回纯文本 |

### 为什么路径段是 owner + slug，不是 repo

详情页地址是 `/<lang>/plugins/<owner>/<slug>`（`docs/DATA-SOURCES.md` §4），而 **slug 会重名**
——单分片实测 23 组，`dsh-purge` 同时属于 yujunzhixue / kingcharleslzy-ai / mmparko 等 4 个不同
仓库（§2.1 正是因此把身份键定成 `repo`）。详情页按 slug 路由，所以必须用目录行自己的
`owner`/`slug`；拿 `repo` 切在两者不一致时会指到别的插件的页面。目录里查不到这个插件时
（未收录 / 自研本地插件）这两个字段缺省 → 不渲染链接，只显示纯文本。


### 为什么用 `<a>` 而不是 `window.open`

宿主主窗口的 `setWindowOpenHandler` 是「http/https → `shell.openExternal(url)`，然后一律
`deny`」：

```js
window.webContents.setWindowOpenHandler(({ url }) => {
  if (["http:", "https:"].includes(new URL(url).protocol)) shell.openExternal(url);
  return { action: "deny" };
});
```

所以 `<a target="_blank">` 正好落在「宿主拦下 → 交给系统浏览器」这条路径上，不会在应用里
开内嵌网页。`window.open` 也走这条拦截，但会先撞上弹窗拦截、且拿不到 `rel` 保护，故不用。

### 为什么必须校验后拼

目录数据与站点基址都是外部输入。把 owner/slug 直接拼进 `href` 等于把外部字符串放进 HTML 属性，
`javascript:` 之类会被执行。`siteUrl()` 要求 `^[\w.-]+$`；`normalizeSiteBase()` 只接受
http/https、拒绝带凭据的地址；拼不出安全地址就返回空串、退回纯文本。

### 验证

| 检查 | 结果 |
|---|---|
| `npm run check` | **全绿**：主测试 151、client 32、host 7、package 8 files |
| 用例「市场行提供「在浏览器中打开数据源详情页」的链接」 | 通过：断言 `type === "a"`、`href` 是 `https://dsh-plugin.org/zh/plugins/owner2/plugin-2`、**不含 `github.com`**、`target="_blank"`、`rel="noopener noreferrer"`；两个入口指向同一地址；行高仍是 `pc-row` |
| 用例「详情页链接用 owner + slug 拼」 | 通过：两个同 slug 的 `dsh-purge`（yujunzhixue / kingcharleslzy-ai）各自指向自己的详情页；`repo` 与 `slug` 不一致时路径段用 slug |
| 用例「详情页链接只接受安全的 owner/slug」 | 通过：`javascript:alert(1)`、`../../etc`、带引号注入的串、空 owner/slug 逐个验证**不出 `<a>`、不出可疑 href**，且整行仍照常渲染 |
| 用例「详情页链接跟随设置里的站点基址」 | 通过：`siteBase` 改成 `https://mirror.example.com/` 后 href 变成该基址下的详情页，尾斜杠归一化不出现双斜杠 |
| 宿主用例 | `catalog.list` 返回的行确实带 `slug: "dsh-purge"` / `owner: "yujunzhixue"`（`installed.list` 靠它转给界面） |
| 用例「does not use APIs the host GUI does not implement」 | 有 `assert.doesNotMatch(source, /window\.open\s*\(/)` 守着 |

**夹具踩坑**：vm 沙箱默认没有 `URL`，`normalizeSiteBase()` 会走 catch 返回空串，表现是
「链接一个都不渲染」，看起来像产品缺陷。已在 `createHarness` 的 sandbox 里显式注入 `URL`。

**没覆盖的**：真实桌面窗口里点一下、系统浏览器真的弹出来的那一下（需要人工点一次）。

## 2026-11-02 · 更新完成后自动复查该插件的更新状态

**用户要求**：update 完成后，应自动对被更新插件再做一次更新状态检查。

### 问题

`updates.check` 的结论是落库的缓存，`installed.list` 只读缓存、自己不出网。更新成功后若不
复查，已装页会一直显示**更新前**的结论（「可更新」）—— 刚更新完的插件看起来还是旧的。

### 实现

队列运行器里，`kind === "update"` 且任务已有结果之后、**进入终态之前**再查一次：

| 决定 | 理由 |
|---|---|
| 在终态之前复查 | 客户端看到「已完成」会重读清单（`liveCount` 由 >0 回 0 的 effect），此时库里必须已是新结论，否则会闪一次「可更新」 |
| 只查 `[task.target]` | 一次更新不该把所有插件的 registry / `git ls-remote` 都打一遍 |
| 复用 `checkUpdates()` | 与 `updates.check` 同一条判据：拿不到仍 `updateAvailable: null` + 原因，绝不当「已最新」 |
| 复查失败不改判更新结果 | 更新成功就是成功，复查问题只附在结论后（「更新后复查失败：…」） |
| 插件已不在依赖里则跳过 | 更新失败且没装回来时没有可复查对象，如实记一行日志，不编结论 |

`updates.check` 与复查共用同一个 `checkUpdates(store, only?)`，避免两处各写一套判据。

### 验证

| 检查 | 结果 |
|---|---|
| `npm run check` | **全绿**：主测试 151、client 28、host 7、package 8 files |
| 宿主契约（`tests/host.test.mjs`） | 通过。桩 manager 现在会真的把 `node_modules` 里的版本号改成目标版本（否则复查只能读到旧版本，「已是最新」这条路根本没被验证）。断言：结论含「更新后已复查」「已是最新」；日志含「更新后复查 dsh-cost-meter」；`installed.list` 里该行 `updateAvailable` 变成 `false`、`installedVersion` 变成 `1.9.30`、`checkedAt` 晚于更新前那次；registry 桩上该包**只被查两次**（更新前一次 + 复查一次），证明没有重查整张表 |
| 客户端用例「更新完成后：队列回到空闲，已装页自动换成复查后的结论」 | 通过。断言队列由运行中回到空闲后会重读 `installed.list`，页面从「可更新」变成「已最新」、版本号跟着变；任务结论里的「更新后已复查」在「操作」页可见 |
| 夹具改进 | `setInterval` 原本是空实现（`() => 0`），轮询回调从不执行 —— 「队列跑完 → 重读清单」这条路径在夹具里根本走不到。改为记录回调并提供 `runIntervals()` 显式驱动 |

## 2026-11-02 · 导入支持系统文件浏览器（`import.upload`）

**用户要求**：导入部分应支持通过文件浏览器选择文件。

### 实现

| 层 | 改动 |
|---|---|
| 服务端 | 新增 RPC `import.upload`：收 `{name, content}` → 先按导出格式校验 → 落到 `<dataDir>/exports/<时间>-<profile>-<原名>.json` → 返回 `{name, path, bytes}` |
| 客户端 | 导入区加「选择文件…」按钮 + 真实 `<input type="file" accept=".json">`（`display:none`，按钮代理点击）；选中后读文本 → 上传 → **立刻预检**，并显示「已选择：…」 |
| 交互 | 文件优先级固定为「刚选的 > 手填绝对路径 > 导出目录下拉」；改下拉或改手填会清掉「刚选的」，避免两者打架 |

### 为什么必须多这一跳

浏览器给的 `File` 内容只在页面内存里，而预检 / 导入都只接受服务端读得到的路径；宿主也**没有**
给插件用的原生文件对话框（在 `app.asar` 里检索 `showOpenDialog` / `showSaveDialog` 无结果）。
所以只能由客户端读出文本经 RPC 交给服务端落盘。落点固定在本插件自己的 `exports/`，
**先校验再落盘**（选错文件当场报错且不留垃圾），文件名剥掉路径片段与非法字符。

### 验证

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run check`（typecheck + 主测试 + 构建 + client + host + package） | **全绿**：client 27 项、host 7 项、package 8 files |
| 客户端用例「文件浏览器选中文件 → 上传落盘 → 立刻预检该文件」 | 通过：断言上传载荷、断言预检用的是**上传返回的路径**而不是下拉框里第一个文件、断言选完清空 `input.value` |
| 客户端用例「选错文件时如实报错，不留半截状态」 | 通过：错误条出现、不显示「已选择」、不出现「开始导入」 |
| 宿主契约用例（`tests/host.test.mjs` 第 10 段） | 通过：真实 RPC 路由下 `import.upload` 落盘、落点确在 `dataDir/exports`、路径里的 `../../evil name` 被清洗、落盘内容与上传一致、返回的路径能直接预检、出现在 `export.list` 里；非导出文件与空文件均报错且**不落盘**（`readdirSync` 计数不变） |
| 宿主请求体上限 | 300MB（`client-connection` 的 `maxRequestBodyBytes` 默认 314572800），本插件 8MB 上限不冲突 |

**没覆盖的**：真实桌面窗口里点系统文件浏览器的那一下（需要人工点），以及把选中文件
真装进 profile 的端到端变更 —— 后者仍属 AGENTS.md 要求「用户同意后单独验收」的范围。

## 2026-11-02 · 真实报障：`Unknown method: export.run`（客户端与宿主的构建错配）

**用户报障**：点「导出」后界面回 `Unknown method: export.run`。这是刚加的功能，方法名也对，
需要分清楚是「方法没注册」还是「宿主跑的还是旧代码」。

### 证据

| 检查 | 结果 |
|---|---|
| `grep -c "export.run" dist/index.js` | **1**（构建产物里有这个方法） |
| `grep -c "export.run" dist/client.js` | **1**（新面板确实在调它） |
| `Unknown method` 的来源 | 本插件的分发器（`plugin-harbor/unknown-method`）—— 说明面板连得上插件，只是**宿主里那个实例不认识这个方法** |

**根因**：客户端 `client.js` 是**页面加载时从磁盘现取**的，宿主侧 `index.js` 是**进程启动 / 上次
profile 重新组合时载入**的。本项目是 `link:` 安装，`dist/` 一重建，浏览器刷新就拿新客户端，
而宿主进程里还是旧实例 —— 于是新面板调用新方法必然报 `Unknown method`。

### 修复（不是修一句文案，而是让这种错配自己说出来）

1. **构建标识握手**：`scripts/build.mjs` 以 `src/**` 内容哈希（12 位）作为构建标识，用 esbuild
   `define` 注入宿主与客户端两个产物；`/status` 返回 `build`，面板与自己的值比对，不一致就在
   页面顶部给提示条，写明原因与修法（重启 DSH，或对**另一个**插件做一次启用/停用/更新）。
   用内容哈希而非时间戳：`dist/` 是入库产物，时间戳会让每次构建都产生无谓 diff。
2. **构建期自检**：构建脚本校验两个产物是否真的带上了该标识 —— 只注入不引用时 esbuild 的
   `define` 是静默空操作，这种失效必须构建期就炸。
3. **未知方法翻译**：`call()` 把 `Unknown method: X` 翻成同一句可照做的话并附原始报文。

### 验证（夹具，全离线）

`npm run check` 全绿：`npm run check` 全绿：**151 单元 + 25 客户端 + 7 真实宿主契约** + 包校验
（92,948 B）。新增：客户端两条（构建不一致时出提示条且两个构建号都写出来；`export.run` 回
`Unknown method` 时面板给可照做的提示并保留原始报文）、宿主契约断言 `status.build` 形如 12 位
十六进制；夹具默认把宿主桩配成与面板同一构建，避免每个用例都被提示条干扰。

### 真机结论与用户操作

用户此刻的面板是新构建、宿主是旧构建。修法：**重启一次 DSH**，或对任意**另一个**插件做一次
启用 / 停用 / 更新（任何一次 profile 重新组合都会把磁盘上已变化的插件代码换进来）。注意
「热重载」按钮本身也是新方法（`op.reload`），旧宿主同样没有 —— 第一次脱离旧构建不能靠它。

## 2026-11-02 · 已装插件及其配置的导出 / 导入

**用户要求**：「增加已装插件及其配置导出和导入功能」。

### 先确认宿主能给什么（只读查证，决定功能边界）

| 来源 | 事实 | 结论 |
|---|---|---|
| `dsh-plugin-manager` 的 `@Remote` 方法面 | `listVersionExemptions / setVersionExemption / listPlugins / listBundles / registries / inspect / setPluginEnabled / setBundleEnabled / installBundle / waitForInstall / cancelInstall / removeBundle` | 能装、能启停、能改**条目**开关；**没有写任意 `config` 的接口** |
| `plugin-manager/lib/types/patch.js#writePluginEnabled` | 写的是 `profile.patchPath`（`cordis.patch.yml`）里的 `id + name + disabled` | 「条目开关」可以自动导入，「config」不行 |
| `plugin-manager#listPlugins()` / `readPluginInventory()` | 条目是 `{entryId, moduleName, enabled, fiberPhase, meta?, patchId?, readOnlyReason?}`，**不带 config** | 条目级信息只能靠宿主；配置行只能自己读 profile 补丁 |
| `listBundles()` / `declaredRows()` | 给出 bundle 自己声明的 `rows[]`（rowId/moduleName）与 `overrides[]`，也不含 config 值 | 归属只能按「行 id / 行里的 name」自己算 |

因此功能被切成两块：**能自动做的**（插件清单、bundle 启用状态、条目开关、本插件设置）与
**只能人工的**（带 `config` 的补丁行 → 生成可粘贴片段）。

### 实现

- `src/core/transfer.ts`：导出组装（清单 + 归属配置行 + 本插件设置 + 可选插件设置文件）、
  脱敏、省略清单、格式校验、导入预检（plan）、配置片段生成、安装地址换算。
- RPC：`export.run`（要 `confirm`，写到 `<dataDir>/exports/`）、`export.list`、
  `import.preview`（**不写任何东西**）、`op.import`（服务端算计划并入队）。
- 执行：新增操作种类 `import`，`ops/execute.ts#doImport` 逐步执行
  `installBundle` / `setBundleEnabled` / `setPluginEnabled`，单项失败不中断，`already-installed`
  记为「已装」（重跑幂等），任一步要重启则整个任务是「待重启」。
- 界面：已装页新增「导出 / 导入」面板（导出勾选是否包含插件设置；导入先预检再确认）。

### 写测试时抓到的两个真实缺陷（都已修）

1. **配置行没脱敏**：最初只对「插件设置文件」和本插件设置做了脱敏，`config` 行里的
   `apiToken: sk-live-…` 会**原样进导出文件**（而导出文件是拿去分享/换机的）。
   现在 `config` 行与 `unattributed` 行都过同一套脱敏，并统计次数写进 `warnings`。
2. **`!!js` 表达式被转成布尔**：`disabled: !!js "ctx.get('hmr') === undefined"` 原来被
   `Boolean(值)` 变成 `true`（语义完全变了）。现在按字符串原样保留，片段里也照写成 `!!js "…"`。

### 验证（夹具，全离线）

`npm run check` 全绿：**151 单元 + 23 客户端 + 7 真实宿主契约** + 包校验（88,416 B）。

- `tests/transfer.test.ts`（12 项）：归属（自己声明的行 id / 行里的 name）、`!!js` 解析、
  脱敏（config 行 + 设置文件 + 键名/取值两条路径）、省略清单（数据库 / 缓存 / 二进制 /
  认不出归属的目录）、格式校验拒绝外来 JSON 与版本不符、预检五类步骤
  （install / enable / disable / entries / skip / blocked）、安装地址（registry 用确切版本、
  git 原样、本地路径不存在则阻塞）、配置片段。
- `tests/execute.test.ts`（7 项导入）：逐步执行与日志、只增不删（不出现 `remove`）、
  `already-installed` 记「已装」、单项失败不中断并带首个失败原因、要重启则整任务待重启、
  缺宿主服务如实报错不用子进程、空计划直接完成、老宿主没有 `setPluginEnabled` 时如实记失败。
- `tests/host.test.mjs`（真实 Cordis + 桩 manager）：`export.run` 要确认并真的落盘、
  `export.list` 能看到、同 profile 的导出导回来全「已一致」、外来 JSON 被拒、
  手工造一份「另一台机器」的导出让桩 manager 真的收到 `installBundle("dsh-missing@1.0.3")`
  与 `setBundleEnabled("dsh-cost-meter", false)`、片段文件落盘且含 `budgetUsd`、全程无 `remove`。
- `tests/client.test.mjs`（1 项）：面板默认不展开；勾选后导出带 `includeData: true`；
  预检**不下发任何变更**且把计划逐条列出（含无法处理原因、设置覆盖、未归属行数）；
  开始导入只发 `{path, confirm: true}`。

### 真实验收（只读预演，2026-11-02，真实 desktop profile）

`node --experimental-transform-types scripts/verify-export.mjs --profile desktop [--include-data]`
（默认**不写盘**，只把导出对象在内存里组装并打印计数摘要；全程不出网，也不打印任何配置取值）：

| 项 | 结果 |
|---|---|
| 已装第三方插件 | 8 个（modsearch 5.10.11 / archive-manager 1.1.22 / channel-hub / context 0.74.0 / cost-meter 1.9.46 / mnemon 0.5.34 / ops 0.4.1 / plugin-harbor） |
| 导出体积 / 组装耗时 | 9.4 KB / 13ms（不含插件设置文件）；加 `--include-data` 后 15.0 KB / 31ms |
| profile 补丁归属 | 认领 **4 行**（dsh-mnemon 1、dsh-ops 3），认不出归属 **13 行**（多半是宿主自带条目的配置，已原样带在 `profilePatch.unattributed`） |
| 插件设置文件 | channel-hub 2 个（文本）；`ledger.sqlite` 等 4 个数据库/日志/锁被省略 |
| 脱敏 | **2 处**疑似凭据的字段/取值被替换为 `[已脱敏]`（真实插件数据里确实有这类字段，证明脱敏不是多余的） |
| 本插件数据目录 | 作为「设置已单独导出」省略，`exports/` 不会被自己的导出扫进去 |

**真机预演抓到的真实缺陷（已修 + 已加回归测试）**：`dsh-channel-hub` 的数据目录叫
`channel-hub`（= 它**自己声明的条目 id**），既不是包名也不是包名尾段 —— 最初只按「包名 / 尾段 /
宿主条目 id」归属，于是离线导出（宿主服务不可用的场合，例如这个维护脚本）把这个真实目录
整个略过，还把它列进「认不出归属」。现在归属候选名里加入「插件自己补丁文件里声明的行 id」，
并把「哪些目录属于导出范围」收敛成一个共用函数（`ownedDataDirNames`），避免两处各算一套。

### 未做 / 明确的限制

- **不改 profile 补丁**：带 `config` 的行不自动写入（宿主无接口 + 本项目纪律），只生成片段。
  若以后要自动写，正确做法是请宿主暴露配置写入接口，而不是本插件去动那个文件。
- **插件自己的设置文件不导入**：那是各插件的数据，本项目不代写（导出也仅限白名单文本）。
- **真实验收**：导出侧已做真机只读预演（见上表）；**真机导入未做**（那是对正在使用的 profile
  做变更，需要用户明确同意）。导入本身的危险面已被口径压住：只增不删、不动 profile 文件、
  计划由服务端算、地址过 `validateSpec`。

## 2026-11-02 · 支持热加载：以宿主的结论为准 + 「热重载」动作

**用户报障**：「改为支持热加载」。上文里我让他「重启 DSH 让新代码生效」「装完需要重启」，
而桌面宿主其实默认就有热重载 —— 那些「需要重启」大多是我们自己编出来的。

### 证据（宿主实现与配置，只读）

| 来源 | 事实 |
|---|---|
| `dsh-base` 的 `cordis.patch.yml`（app.asar 内） | `- id: hmr / name: '@deepseek-ai/dsh-hmr' / disabled: !!js "!ctx.get('profileContext')" / config: { root: [] }` —— **桌面启动器提供 profileContext，因此 HMR 是启用的**（Headless / SDK / ACP 组合包才在 YAML 里禁用） |
| `dsh-plugin-manager/lib/index.js#change()` | 有 `hmr` 服务时预设 `application: "applied"`，没有时预设 `restart-required` + `restartReason: "no-hmr"`；只有真正需要重启时才覆盖成 `restart-required` |
| `@deepseek-ai/dsh-hmr` 的 README | 「HMR 的 profile 监听和 Plugin Manager 执行的 profile 重新组合，还会**替换 profile 目录下已加载文件在磁盘上发生变化的插件**。这包括 `node_modules` 之下的已安装包，以及**已链接包的目标**。因此……会在下一次此类重新组合时生效，**无需重启**」 |
| 宿主 `pluginManager` 的 Remote 方法面 | 只有 `listVersionExemptions / setVersionExemption / listPlugins / listBundles / registries / inspect / setPluginEnabled / setBundleEnabled / installBundle / waitForInstall / cancelInstall / removeBundle` —— **没有 reload**，所以「重新组合」只能经 `setBundleEnabled(name, true)`（选中状态不变时它仍会 `publishAndReload`） |

### 真实缺陷①：更新路径无条件谎报「需要重启」

`doUpdate` 把宿主回的 `applied` 硬改写成 `restart-required` + 「请重启 DSH 让新代码生效」——
宿主明明已经把新代码原地装好并热加载了。修复：**原样采用宿主的 `application`**；`applied` 收尾为
「已完成（宿主已热加载，无需重启）」，`restart-required` 才提示重启并把 `restartReason` 翻成人话。

### 真实缺陷②：没有「不重启就让新代码生效」的入口

本项目是 `link:` 安装，重建 `dist/` 后文件已变，但 `root: []` 不监听源码目录，要等下一次
profile 重新组合才生效 —— 以前只能靠重启 DSH（或手工停用→启用）。修复：新增 **`op.reload`**
（已装页「热重载」按钮，只对已启用插件开放），宿主侧就是 `setBundleEnabled(name, true)`；
文案走 `status.hot` 三态（有 HMR→「立即生效，无需重启」/ 无 HMR→「需要重启」/ 未知→「由宿主决定」），
**结论仍以每次操作返回的 `application` 为准**。

### 自热重载：先回执、后动手

目标是插件港湾自己时，宿主一重新组合就会把运行中的本插件换掉，那条 RPC 的响应会随它一起消失。
所以这条路径**不进队列**：先写一条终态操作记录（如实写「已请求宿主热重载本插件」），把回执发出去，
600ms 后再请宿主重新组合；万一那次重载失败（插件还在），再把历史改成失败原因。判定「是不是自己」
不硬编码包名，而是拿本文件的真实路径去比对每个依赖的落点（`link:` 目标 / `node_modules/<name>`，
两边 realpath，兼容 pnpm 虚拟 store）。

### 另外两处顺手修掉

- 诊断新增第 7 项「热重载（hmr）」：有则说明「改动原地生效」，没有则判失败并说明「要等下次启动」；
  设置页「存储与运行」里也直接显示一行（不必跑诊断就能看见）。
- 更新路径在**宿主说需要重启**时把 `restartReason` 一起带上（以前被我改写没了）。

### 验证（夹具，全离线）

`npm run check` 全绿：**132 单元 + 22 客户端 + 7 真实宿主契约** + 包校验（74,166 B）。
新增/翻新的用例：

- `tests/execute.test.ts`：更新在 `applied` 时按「已热加载」收尾且 `needsRestart` 不为真；
  `restart-required` 时转述宿主原因；热重载三条（成功 / `no-hmr` / 无服务且不回退子进程）。
- `tests/host.test.mjs`：桩宿主注册 `hmr` 服务 → `status.hot === true`；**没有** `hmr` 的宿主
  → `status.hot === false`（两处对照）；`op.reload` 真的调 `setBundleEnabled(name, true)`、
  要确认、停用插件被拒；自热重载的回执里就有结论（不是「进行中」）+ 落历史 + 延迟后宿主才收到请求。
- `tests/client.test.mjs`：热重载按钮只给已启用插件；弹窗在「有 HMR / 无 HMR」两种 profile 下的
  文案分别断言（后者不许出现「立即生效」）；市场安装弹窗的生效说明。
- `tests/diagnostics.test.ts`：第 7 项的两条分支。

### 未做（需要真实宿主才能验的部分）

`status.hot` 的真值要在**运行中的桌面宿主**里读（本项目的夹具宿主是桩）。宿主侧的依据是
`dsh-base` 的补丁表达式与 `dsh-plugin-manager` 的 `change()`/`reload()` 实现（上表），
用户侧确认方式是：点一次「热重载」→ 面板重新连接、代码即新，无需重启。

## 2026-11-01 · 真实故障：更新把插件从 profile 里弄丢了（范围当包名）

**用户报障**：操作页两条失败 —— `enable @liustack/modsearch`（23:29:00，
「宿主的包操作失败」×4）与 `update dsh-cost-meter ← ^1.9.28`（23:29:13，40%，
「宿主的包操作失败（日志：…operation-5uHwVm\pnpm.log）」），要求分析并修复。

### 证据（真实 profile 与宿主日志，只读）

| 来源 | 事实 |
|---|---|
| `.plugin-manager/logs/operation-5uHwVm/pnpm.log` | `[ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER] "^1.9.28" isn't supported by any available resolver.` |
| `.plugin-manager/logs/operation-ssTLTw/pnpm.log` | 同一错误，`"^5.10.10"`（同形态，另一条依赖） |
| `.plugin-manager/logs/operation-i7Nydo/pnpm.log` | `dependencies: - dsh-cost-meter 1.9.28`（旧版本**已被卸载**） |
| profile `package.json` | `dsh-cost-meter`、`@liustack/modsearch` **双双不在 `dependencies` 里** |
| 本插件 `ops` 表 | `kind=update, spec=^1.9.28, via=manager, progress=40`；`kind=enable, via=manager, error=宿主的包操作失败` |
| 宿主源码 `dsh-plugin-manager/lib/index.js` | `managementError()`：非 `ManagementFailure` 一律 `{code:"operation-error", diagnostic: messageOf(error)}`；`setBundleEnabled()` 只调 `selectBundle()`（**不碰依赖**） |

### 根因（两条都成立，且第一条引发了第二条）

1. **本插件的真实缺陷**：`op.update` 把 profile 里记的**版本范围**（`^1.9.28`）
   当成安装地址交给宿主。范围不是地址，pnpm 把它当包名解析并拒绝 —— 而那时旧版本
   **已经卸载**，插件就此从 profile 里消失。同一条链把两条依赖都弄丢了。
2. **本插件的第二个缺陷**：宿主的 `operation-error` 带回了 `error.diagnostic`，
   而我们的映射先命中错误码就返回「宿主的包操作失败」，把诊断整个丢掉。用户因此
   无从判断下一步，只能自己去翻 `pnpm.log`（`enable` 那条连日志路径都没有）。

`enable` 失败是①的下游：依赖被①删掉之后，宿主「启用」只切 bundle 选中状态、
不会去装依赖，于是永远不可能成功，只抛一个原始的模块解析错误。

### 修复

- 新增 `src/ops/spec.ts#installSpecFor()`：按已装事实拼可安装地址（与宿主
  `dependencySpec()` 同口径）。`op.update` **在卸载之前**算好 `installSpec`
  （优先用更新检查核实到的目标版本）并用 `validateSpec` 校验，验不过直接报错、不动 profile。
- 安装失败后按 `restoreSpec` 回滚（`；已按原地址把 X 装回` / `；回滚也没成功…请重新安装`）；
  取消不回滚但明说依赖已被移除。
- `describeOutcome()` 不再吞诊断：`operation-error` 先看 `packageResult.kind`，再按诊断
  特征（pnpm 错误码 / `Cannot find module` …）给一句能照做的话，**原文照附**。
  失败原因的文案同时进 `error` 与 `note`（界面失败行读的是 `error`）。
- 启用失败时再读一次已装事实，依赖不在 `dependencies` 里就明说「请到市场页重新安装」。
- 顺带修掉：`validateSpec` 不接受 `\`（Windows 绝对路径形态的更新永远装不了）；
  本插件自己的 stub 服务器在用例失败时会吊住事件循环。

### 验证（夹具，全离线）

`npm run check` 全绿：新增 `tests/spec.test.ts`（6 条）、`tests/execute.test.ts`
新增 5 条（含「绝不把范围当包名」与回滚）、`tests/ops.test.ts` 新增 3 条（诊断透出）、
`tests/validate.test.ts` 补 Windows 路径、`tests/client.test.mjs` 补操作行显示实际地址、
宿主契约用例补 `installSpec/restoreSpec/历史落库`（走本机 registry 桩，目标版本 1.9.30）。

### 未做（需要用户同意）

`@liustack/modsearch` 与 `dsh-cost-meter` 目前**不在** desktop profile 的依赖里；
把它们装回来属于对正在使用的 profile 做变更，需用户明确同意后执行。

### 真实验收（隔离，真实 CLI + 真实 pnpm，2026-11-02）

`node --experimental-transform-types scripts/verify-ops.mjs --network`
（临时 `DSH_HOME` + 自建 profile `plugin-harbor-selftest`，与 desktop profile 无关；
本轮给该脚本加了「更新流程」这一步）：

| 步骤 | 结果 |
|---|---|
| 安装 git 形态 `github:Seraphoenixy/dsh-channel-hub` | 退出码 0，7.5s，依赖 / node_modules / bundle 全部落地 |
| 安装 registry 形态 `dsh-cost-meter` | 退出码 0，2.4s，落地 |
| 拼装地址 | 已装事实 `spec=^1.9.46`（范围）→ `installSpecFor()` → `dsh-cost-meter@^1.9.46` |
| **历史缺陷写法**（把 `^1.9.46` 当包名直接 add） | **退出码 1**：`ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER "^1.9.46" isn't supported by any available resolver.` —— 与用户机器上的故障逐字一致 |
| 修复后的更新（remove → add `dsh-cost-meter@^1.9.46`） | 退出码 0 / 0.7s + 0.7s + 3.1s，依赖与 node_modules 都在，版本 1.9.46 |
| 卸载两者 | 退出码 0，依赖与 node_modules 均已移除 |

结论：**故障在隔离环境里可复现，修复后的地址被真实 pnpm 接受** —— 这条链不再是推断。

## 2026-11-01 · 界面修正：清掉过时占位卡片 + 设置页重做

**用户报障**：①「设置页太丑」；②「浏览和已装还存在一个待办的设置下栏」。

### 缺陷②是真实缺陷：一张过时占位卡片挂在了三页底部

占位卡片的渲染条件写成了 `tab === "ops" ? null : placeholder` —— 本意是「操作页另有内容」，
结果变成「除操作页外都挂占位」。而市场/已装/设置三页此时都已有真实内容，于是它们底部都挂着
同一张写着「这一页在 M2–M3 落地：已装清单与更新判据…安装/更新/卸载队列与操作记录、设置与
诊断」的待办卡。

修法：**整块删除**（四个页面都不再有任何「待办」内容）。
回归：`tests/client.test.mjs` 的「四个页面都不再渲染过时的『M2–M3 落地』占位卡片」逐个页签
断言不再出现 `M2–M3 落地` 与 `这一页在`。

### 设置页重做（缺陷①）

| 旧 | 新 |
|---|---|
| 7 个字段挤在一张卡里 | 拆成 **目录与来源 / 网络与镜像 / 存储与运行 / 诊断** 四张卡，各带一句副标题 |
| 只有标签，没有说明（「API 中心基址」是什么？） | 每个字段加一行**灰字说明**（如「决定抓 /zh 还是 /en 的分片」「无变更刷新只花 253KB」） |
| 输入框复用市场页搜索框样式 `.pc-search`（带 `flex:1 1 240px`，放进网格算错宽度） | 新增独立 `.pc-input`（100% 宽、聚焦环、占位符样式），下拉框同宽 |
| 保存按钮混在字段流里 | 独立**保存条**：左侧落盘路径、右侧「保存设置」与已保存提示 |
| 中性信息（字段被退回默认值）用红色 warning 文案 | 改为琥珀色信息块 `pc-note-block` |
| 存储信息只在页头显示个 SQLite 版本 | 新增「存储与运行」卡：profile / 数据目录 / 目录库路径 / SQLite 版本 / **目录条目数（含站点自报）** / 上次同步时间 / 上次同步错误 |
| 诊断行无汇总、无对齐 | 斑马纹 + 列宽对齐；汇总为「通过 N｜失败 N｜无结论 N」或「还没有检查过」 |

**夹具验证**：新增「设置页结构」用例（四个分区齐备、每个字段都有说明且控件是 `.pc-input`、
保存条显示 `settings.json`、存储卡显示 `19,866 条` 与站点自报值）。测试自身也踩到两个夹具坑
并已修：用 `includes("pc-field")` 会把 `pc-field-hint` 也当成字段（改按空格分隔的类名 token
判断）；设置页挂载后要再渲染一次并让出微任务，否则「存储与运行」还是空值。

**未验证**：运行中 DSH 窗口里的实际观感（需要装进 profile 后目视，仍待你确认）。

## 2026-11-01 · M3 补齐：子进程通道的真实（隔离）验收 + Windows `.cmd` 缺陷

**为什么现在做**：真实验收一直卡在「变更操作会改你正在用的 profile」。这一轮改成
在**隔离的临时 `DSH_HOME` + 自建 profile（`plugin-harbor-selftest`）**里跑真实 CLI、
真实 pnpm、真实 registry/GitHub —— 覆盖承诺的代码路径，同时完全不碰 desktop profile。

工具：`node --experimental-transform-types scripts/verify-ops.mjs --network`（默认跑完即删
临时目录，`--keep` 保留）。

### 真实缺陷：Windows 上根本调不起 `dsh`（本轮实测）

| 事实 | 实测 |
|---|---|
| `spawn("dsh", args, { shell: false })` | **ENOENT** —— `dsh` 是 `.cmd`，Node 不能直接执行 |
| 用户级 shim `%LOCALAPPDATA%\deepseek-harness\bin\dsh.cmd` | 经 shell 能起，但报 `[dsh] Harness CLI not found. Please run DeepSeek Harness Desktop to install it` |
| **宿主自带 CLI**：`DeepSeek Harness.exe` + `ELECTRON_RUN_AS_NODE=1` + `app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js` | **可用**（打印 `Usage: dsh …`），打包 shim 内部就是这么调的 |

修法（`ops/subprocess.ts#resolveDshCommand`，见架构文档）：优先用宿主自带 CLI（绕开
shell 与用户 shim），其次 PATH，`PLUGIN_HARBOR_DSH` 可显式覆盖；`.cmd` 必须经 shell 时
自己拼一行加引号的命令串（参数已过白名单），避开 Node DEP0190 与注入面。

### 隔离真实验收结果（真实 CLI + 真实 pnpm）

| 步骤 | 实测 |
|---|---|
| CLI 可寻址（`version-exemptions`） | 退出码 **0**，输出 `{}`（证明隔离 DSH_HOME 生效） |
| 安装 **git 形态** `github:Seraphoenixy/dsh-channel-hub` | 退出码 **0**，**7.7s**；依赖 ✅ / `node_modules` ✅ / **bundle 选中** ✅ |
| 安装 **registry 形态** `dsh-cost-meter` | 退出码 **0**，**5.0s**；依赖 ✅ / `node_modules` ✅ / bundle 选中 ✅ |
| 卸载 `dsh-channel-hub` | 退出码 0，0.7s；依赖与 `node_modules` 均已移除 |
| 卸载 `dsh-cost-meter` | 退出码 0，2.0s；依赖与 `node_modules` 均已移除 |
| 收尾状态 | 最终 `dependencies: []`、`bundles: []`（自建 profile 干净） |
| 结果 | **全部通过** |

回退通道的进度估算也被真实输出验证（`Packages:` 阶段到 85%，`Done in …` 收尾）。

**这次验收覆盖了什么、没覆盖什么**：覆盖**子进程兜底通道**（服务不可用时的路径）在真实
CLI/pnpm/网络下的完整行为；**没覆盖宿主 `pluginManager` 服务路径**（只在桩服务下验证过
参数与结论归一）与**运行中 DSH 窗口里的四个页面渲染**。这两项仍需要你在真实 profile 上
点头后才能做。

## 2026-11-01 · M4 设置与诊断

**范围**：设置持久化（读取容错 / 写入严格 / 原子写）→ 设置 RPC 与界面 →
连通性诊断（六项，只读、手动触发）→ 诊断界面 → 真实站点只读验收补诊断。

**产物**（实测）

| 产物 | 原始 | gzip |
|---|---|---|
| `dist/client.js` | 56,387 B | 13,136 B |
| `dist/index.js` | 84,993 B | 23,905 B |
| `dist/catalog-worker.js` | 32,320 B | 9,452 B |

安装包实测 **8 个文件 / 62,542 B（压缩后）**；客户端仍远低于 ≤180KB / ≤45KB 预算。

**本轮由测试抓出的真实缺陷（都已修，且各留一条回归断言）**

| 缺陷 | 现象 | 修法 / 断言 |
|---|---|---|
| 设置文件是数组时被当成「空设置」通过 | `typeof [] === "object"`，`[1,2,3]` 会静默通过而不是报「不是对象」 | 显式排除数组；`settings.test.ts` 钉住 |
| 设置页不显示保存/校验错误 | `Settings` 只渲染了 prop 上的读取错误，`state.error`（保存失败、本地校验）从不显示，用户点保存后界面毫无反应 | 合并渲染两者；客户端用例断言「非法小时数」提示可见 |
| 诊断里「无结论」与「失败」混淆风险 | 未同步目录时若按「失败」显示，会被当成故障 | `ok: null` 单列一态并在汇总里分开计数；单元与宿主用例各钉一条 |

**夹具验证**（`npm run check` 全绿：105 单测 + 18 客户端 + 7 宿主契约 + 打包校验）

- `settings.test.ts`（7）：缺文件用默认值、坏 JSON 与坏字段**逐项**退回并说明原因
  （合法项保留）、数组不算对象、TTL 越界退回而非静默夹取、写读往返（原子写）、
  补丁合并（合法生效 / 非法报错且不改动那一项 / 尾部斜杠归一）、环境变量默认值。
- `diagnostics.test.ts`（6）：六项全过并带细节、未同步时 catalog 记「无结论」、
  上次同步失败时判失败并带原因、单项失败不影响其它项、镜像未实现 `/-/ping` 仍算可达、
  依赖抛错收敛成失败项不冒泡。
- `client.test.mjs`（新增 3 项，共 18 项）：设置页回填当前值且**小时→毫秒**换算正确、
  非法小时数本地拦截不下发、诊断三态（通过/失败/无结论）+ 明细显示。
- `host.test.mjs`（新增 1 项，共 7 项）：设置默认值读取、非法设置报错且**不落盘**、
  合法设置落盘并可被下次读取、诊断六项（未同步时 catalog 为「无结论」、同步后转为通过）、
  改 locale 后诊断与同步真的去抓 `en` 索引页。

### 真实验收（2026-11-01，真实站点，只读）

工具：`node --experimental-transform-types scripts/verify-live.mjs --network`
（临时目录建库，不读不写任何 profile）。同一轮里除同步/搜索/翻页外，新增**诊断六项**：

| 诊断项 | 实测 |
|---|---|
| 目录数据 | 通过：19,866 条，站点自报 19,866，同步于本轮（9ms） |
| 目录库 | 通过：SQLite 3.53.4，10 张表（1ms） |
| 官网目录（dsh-plugin.org） | 通过：HTTP 200，226,406 字节（213ms） |
| API 中心（stats.json） | 通过：收录 5809 / 已验证 5809（157ms） |
| npm registry | 通过：HTTP 200（558ms） |
| git 可用性 | 通过：git version 2.56.0.windows.2（53ms） |
| 汇总 | **全部 6 项通过** |

同轮回归：冷同步 11–15s（37 分片 / 19.0MB）、热同步 0.4–0.7s（253KB）、
搜索「上下文」20.4ms / 「dsh-purge」2.4ms / 「微信」（2 字回退）89.3ms、
全量翻页 398 页 0.9s —— 与 M1 结论一致，未因 M4 改动回退。

**未验证**：真实 profile 上的安装/更新/卸载/启停（M3，需要你明确同意后单独执行）；
运行中 DSH 窗口里的设置页与诊断面板渲染。

## 2026-11-01 · M3 变更操作（安装 / 更新 / 卸载 / 启停）

**范围**：宿主 `pluginManager` 适配与结果归一化 → 子进程兜底（参数、进度、超时、
杀进程树、失败归类）→ FIFO 队列（串行、进度单调、取消、历史）→ 执行编排决策表 →
RPC（`op.install` / `op.update` / `op.remove` / `op.setEnabled` / `op.list` / `op.cancel`）
→ 客户端确认弹窗、变更按钮与操作页。

**产物**（实测）

| 产物 | 原始 | gzip |
|---|---|---|
| `dist/client.js` | 47,100 B | 14,031 B |
| `dist/index.js` | 72,616 B | 21,393 B |
| `dist/catalog-worker.js` | 32,320 B | 9,894 B |

安装包实测 **8 个文件 / 53,166 B（压缩后）**；客户端仍远低于 ≤180KB / ≤45KB 预算。

**本轮由测试抓出的真实缺陷（都已修，且各留一条回归断言）**

| 缺陷 | 现象 | 修法 / 断言 |
|---|---|---|
| 队列 `drain()` 只等一次就返回 | `#idle` 是「当前任务」的 promise，任务切换后就被替换；三等任务的用例只等到前两个 | 循环等到「既无运行中、也无排队中」；`ops.test.ts` 的三任务 FIFO 用例钉住 |
| 原地覆盖给 git spec 拼了 `@latest` | `github:o/r@latest` 是无效地址；registry 形态才该用 `<name>@latest` | `latestSpec()` 按形态/长相反推；新增 git / path / tarball 原样重装的用例 |
| 编排层的决策没有进任务日志 | 「为什么回退到子进程」只写进宿主日志，操作页看不到 | 编排 `log()` 同时写任务日志与宿主日志；用例断言任务日志里能看到回退原因 |
| 归一化把「宿主没返回结果」当成功 | `application` 缺失时若按 `changed` 判，界面会报安装成功 | 缺 `application` 一律判 `failed` 并写「宿主没有返回结果，请查看操作日志」；用例钉住 |
| 夹具缺 `setInterval` | 操作页轮询路径在夹具里抛 `ReferenceError`；补真定时器会因夹具不跑 cleanup 而泄漏 | 夹具给假 `setInterval`/`clearInterval`；注释写明只验证渲染与按钮行为 |
| 跨 vm 的载荷对象 `deepEqual` 失败 | 客户端在 `vm.runInNewContext` 里构造对象，原型不同源 → 「结构相同但引用不等」 | 夹具用 `plain()` 做一次 JSON 往返再比 |

**夹具验证**（`npm run check` 全绿：92 单测 + 15 客户端 + 6 宿主契约 + 打包校验）

- `ops.test.ts`（13）：宿主结果归一化（5 种 `application` + 缺失 + 错误码文案 +
  `build-blocked` + 抛错收敛 + `cancelInstall` 缺失）、子进程兜底（参数、进度单调、
  Done→96、构建脚本/404/权限/磁盘/超时归类、ENOENT 指引、进度估算阈值）、
  队列（FIFO 串行、进度只升、日志上限、终态回调、取消运行中/排队中、运行器抛错隔离）。
- `execute.test.ts`（13）：安装走服务不碰子进程、`already-installed` → 子进程原地覆盖、
  无服务全程子进程、子进程失败原因透传、不兼容时交回豁免命令且不回退、
  更新先卸后装并标记重启、移除被拒 → 子进程 `@latest`、git/path/tarball 原样重装、
  卸载失败（非「不许移除」）停在原地、`not-bundle` → 子进程卸载、
  启停无兜底如实报错、编排决策进任务日志。
- `validate.test.ts`（4）：包名与安装地址的白名单（挡前导 `-`、空白、控制字符、超长、
  缺少包名的版本范围）、`confirm` 必须为 `true`、任务 id。
- `client.test.mjs`（新增 4 项，共 15 项）：安装/更新/停用/卸载都必须先过确认弹窗且
  确认前不下发、确认后带 `confirm: true` 与正确载荷、无 npm 包名时用 `github:owner/repo`、
  取消确认不发任何请求、操作页显示进度条宽度 / 日志 / 待重启 / 历史 / 取消按钮。
- `host.test.mjs`（新增 1 项，共 6 项）：真实 Cordis + 桩 `pluginManager` 服务：
  未确认被拒、非法 spec 被拒、安装在服务里留下正确 spec 与 `enabled`、更新先卸后装且
  结论为待重启、更新未装插件被拒、启停调用服务、终态任务写入历史且队列排空、
  取消不存在/非法 id 的返回。

### 未做真实验收（需要明确同意）

**M3 的变更操作尚未在真实 profile 上执行过**：安装/更新/卸载/启停都会**真的改动**
`~/.dsh/profiles/<profile>/package.json` 与 `node_modules`。夹具与桩服务只能证明
「决策与参数正确、宿主调用正确、失败归类正确」，不能证明「宿主流水线在这个 profile 上
真的装得上」。建议的验收方式（需你确认后单独执行、单独记载）：

1. 选一个**无副作用的小插件**（例如只在设置页显示一个面板的插件）安装 → 确认出现在
   已装列表、版本与来源正确、操作页有完成记录；
2. 更新它 → 确认提示需要重启、重启后版本变化；
3. 停用/启用 → 确认 bundle 选中状态变化且重启后生效；
4. 卸载 → 确认依赖与 bundle 条目都被移除、操作页留痕；
5. 记录每一步的实测输出与失败原因（若有）。

## 2026-11-01 · M2 已装清单与更新判据

**范围**：profile 事实采集（清单 + lockfile + node_modules）→ 更新判据
（registry / git / 本地路径）→ 详情页按需抓取与缓存 → `installed.list` /
`updates.check` / `plugin.detail` RPC → 已装页与市场「已装」徽标。
安装/更新/卸载/启停仍未接入（M3）。

**本轮由测试抓出的真实缺陷（都已修，且各留一条回归断言）**

| 缺陷 | 现象 | 修法 / 断言 |
|---|---|---|
| `npm install` 会删掉提取出来的宿主包 | `tests/host.test.mjs` 在缺宿主包时**跳过**（不是失败），`node --test` 输出看着全绿；本轮加 `yaml` 依赖后 5 项宿主契约静默变成 skip | `AGENTS.md` 写明「装/改依赖后必须重跑 `extract-host.mjs`」；`scripts/verify-host.mjs` 缺包时以退出码 2 让 `check` 失败（这条守卫本来就在，本轮确认它有效） |
| 版本比较把 build 元数据当成非法段 | `compareVersions("1.0.0+build","1.0.0")` 返回 `undefined`（不可比）→ 界面会把完全可比的版本显示成「未判定」 | 先剥 `+build` 再拆预发布；`updates.test.ts` 钉住 |

**实现**

| 位置 | 内容 |
|---|---|
| `core/installed.ts` | 三个只读来源交叉验证；`githubRepoOf` 认 `git+https://…`/`github:o/r`/`repository` 对象；`classifySpec` 分 registry/git/path/tarball；从 lockfile 的 `resolution.tarball` 取 `/tar.gz/<sha>` |
| `core/updates.ts` | registry：本地版本 vs `dist-tags.latest`（semver 子集比较）；git：lockfile commit vs `ls-remote` HEAD commit；path/tarball/unknown：恒 `null` + 中性说明；未配置查询能力时如实报错 |
| `upstream/registry.ts` | npm **精简元数据**（`application/vnd.npm.install-v1+json`），只有 dist-tags 与 dist |
| `upstream/git.ts` | 一次 `git ls-remote --symref <url> HEAD` 同时取默认分支与 commit；禁交互与凭据提示（`GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`） |
| `core/catalog.ts#fetchDetail` | 详情页按需抓取（列表页没有精确版本/安装命令） |
| `storage/catalog-db.ts` | `plugins.detail_json/detail_at`、`installed_cache` 扩列；`putDetail`/`getDetails`/`rowsByRepo`/`putChecks`/`getChecks`；缓存表结构升级直接丢弃重建 |
| `client.ts` | 已装页（结论徽标 / 统计 / 原因与说明）、市场行「已装」徽标（按 **repo** 匹配，同名不同仓库不混） |

**夹具验证**（`npm run check` 全绿：62 单测 + 11 客户端 + 5 宿主契约 + 打包校验）

- `installed.test.ts`（5）：spec 形态四类、仓库身份三种写法、commit 只从 tar.gz 取、
  完整 profile 采集（宿主包排除、两种 `repository` 写法、缺包/缺字段留空）、缺 lockfile/坏 YAML 不抛。
- `updates.test.ts`（6）：版本比较矩阵（含预发布、build 元数据、不可比返回 `undefined`）、
  registry 判定与失败路径、git 只比 commit（含远端不可达/local commit 缺失/仓库身份缺失）、
  本地路径恒未知、批量并发上限与单项抛错隔离、未配置能力时报错。
- `host.test.mjs`（新增 2 项，共 5 项）：已装清单 + 更新判据端到端（桩 registry，断言
  「未检查前不给出结论」「1.9.28 → 1.9.47 判为有更新」「本地路径标未判定」「registry 只查一次」
  「结论落库后清单即带上」）；详情页按需抓取与 24h 缓存（第二次不再抓）与非法 repo 拒绝。

### 真实验收（2026-11-01，真实 profile 只读）

工具：`node --experimental-transform-types scripts/verify-installed.mjs --profile desktop --network`
（**只读** profile 的清单/lockfile/node_modules，只发只读请求：registry 元数据与 `git ls-remote`；
不安装、不改任何文件）。

| 项 | 实测 |
|---|---|
| 识别到的第三方插件 | **7 个**（`@liustack/modsearch`、`@michengai/dsh-archive-manager`、`dsh-channel-hub`、`dsh-context`、`dsh-cost-meter`、`dsh-mnemon`、`dsh-ops`） |
| 形态判定 | 6 个 registry、1 个 git（`dsh-channel-hub`，lockfile commit `8b5f499`） |
| 检查耗时 | **2.0s**（7 个插件、4 路并发） |
| 结论分布 | 可更新 **5** / 已最新 **2** / 未判定 **0** |
| 抽查正确性 | `dsh-cost-meter` 1.9.28 → 1.9.47、`dsh-context` 0.74.0 → 0.79.0、`dsh-mnemon` 0.5.34 → 0.5.37、`dsh-ops` 0.4.1 → 0.4.4、`@liustack/modsearch` 5.10.10 → 5.10.11、`@michengai/dsh-archive-manager` 1.1.22 = 最新；`dsh-channel-hub` 的 lockfile commit 与远端 HEAD 一致 → 已最新（与此前手工 `git ls-remote` 核对一致） |

**未验证**：真实 profile 上的安装/更新/卸载/启停（M3）、运行中 DSH 窗口里的已装页渲染。

## 2026-11-01 · M1 数据管道（目录浏览）

**范围**：站点载荷解析 → 夹具回归 → SQLite 目录库 → 内容寻址增量同步 →
`catalog.list/status/refresh` RPC → 市场页（窗口化列表、搜索、分类、排序）。
插件安装/更新/卸载仍未接入（M2–M3）。

**产物**（实测）

| 产物 | 原始 | gzip |
|---|---|---|
| `dist/client.js` | 25,254 B | 8,231 B |
| `dist/index.js` | 21,987 B | 6,657 B |
| `dist/catalog-worker.js` | 19,637 B | 6,214 B |

安装包实测 **8 个文件 / 25,233 B（压缩后）**。客户端仍远低于 ≤180KB / ≤45KB 预算。

**夹具**（`tests/fixtures/`，真实载荷裁剪，来源与裁剪口径见 `provenance.json`）

| 文件 | 来源 | 保留 |
|---|---|---|
| `site-index-zh.html` | `dsh-plugin.org/zh/plugins` | 95,881 字符 Flight 载荷（3 段）；解析出 37 分片 / totalCount 19866 |
| `site-shard-agent-1.json` | `/directory/zh/agent-1-2ec2dd96.json` | 站点**原文**前 12 条（共 617 条） |
| `curated-zh.json` | `api.dsh-plugin.org/plugins.zh.json` | 9 条短键原文（8 条与分片夹具相交 + 1 条对照） |
| `detail-dsh-purge.html` | 详情页 | 该插件记录对象（5,148 B），含 `version=v1.1.85` / `install.command` |
| `sitemap-plugins-1.xml` | `/sitemaps/plugins/1.xml` | 前 8 条 URL（共 2,000 条） |

**本轮由测试抓出的真实缺陷（都已修，且各留一条回归断言）**

| 缺陷 | 现象 | 修法 / 断言 |
|---|---|---|
| **主键选错：`slug` 会重名** | 单分片 617 条里 23 组重名（`dsh-purge` ×4）；按 slug 做主键时 `on conflict(slug)` 静默覆盖同名仓库，夹具 12 条只入库 11 条 | 主键/游标兜底列/curated 合并键改为 `repo`；`catalog-db.test.ts` 断言两个 dsh-purge 仓库共存；旧 alpha 库按 DDL 检测后重建 |
| 详情页按首个键名定位会取错值 | `install.type` 读成 `application/ld+json`（页面里 JSON-LD 的 `"type"` 抢先命中），`"slug"` 也出现 3 次 | 改为「字符串掩码 + 锚点 `"install":{"type"` + 花括号配平」定位记录对象；夹具用含 JSON-LD 前缀的载荷钉住 |
| 夹具存了归一化产物而不是站点原文 | 解析器把 12 条夹具全丢弃（0 行），而夹具「看起来是对的」 | `capture-fixtures.mjs` 写入原文并附解析自检；`site.test.ts` 断言夹具仍是站点键形（有 `source.repo`、没有 `stars`） |
| 游标条件带前导 `and` | 无筛选 + 有游标时生成 `from plugins  and (…)` → SQL 语法错误 | `#filters` 返回子句数组，由 `list` 统一拼 WHERE；分页与并列排序用例钉住 |
| RSC 转义跳步算错 | `\uXXXX` / `\xNN` 的尾字符会被当成普通字符吐进载荷 | 跳步改为 5 / 3；`flight` 夹具断言 `\u4e2d\x41` → `中A` |

**未实现（如实记录）**：索引页解析失败时的 sitemap **全量枚举**兜底（枚举器与夹具
已就绪，当前只在解析失败时探测 sitemap 可达性并标降级）；en 目录同步；设置项持久化。

**夹具验证**（`npm run check` 全绿：49 单测 + 9 客户端 + 3 宿主契约 + 打包校验）

- `site.test.ts`（16）：RSC 抽取与转义、字符串掩码下定位对象、清单解析（37 片 /
  totalCount / 分类分面）、字段改名后的 URL 扫描兜底、空清单不伪造、chunk URL 形态校验、
  分片归一化（丢无主键/无来源行、缺字段留空）、curated 短键、详情页版本与安装命令、
  JSON-LD 干扰、sitemap。
- `sync.test.ts`（6）：冷启动、同哈希跳过、内容变化换 URL、消失分片清理、重复 URL 去重、三桶口径文案。
- `catalog-db.test.ts`（11）：建表、整片替换、旧分片清理、curated 按 repo 归并（含 orphans）、
  游标分页不漏不重、并列排序稳定、搜索/筛选/分面、LIKE 通配符按字面、**容量预算**
  （写入 20,000 行 220ms；搜索 P95 26.6ms；排序首页 2.1ms）。
- `catalog-sync.test.ts`（8）：冷启动取全部分片并合并 curated、二次同步全跳过且不重下
  curated、消失分片清理、索引页失败不动数据、单片失败仍写其余（并断言重试恰好一次）、
  清单为空时如实报降级、sitemap 不可用的降级说明、curated 过期后重新合并。
- `client.test.mjs`（9）：两个入口与 id 一致、样式内联、打开面板不自动出网、
  首次无缓存自动同步一次并显示失败原因、**500 行只渲染 ≤30 行 DOM**、滚动后窗口跟随、
  搜索防抖后带 q 查询、失败 RPC 显示错误条、无 `prompt()`/`innerHTML`/`document.createElement`。
- `host.test.mjs`（3，真实 Cordis + 本机 HTTP 桩站点）：路由挂载与释放、信封错误码、
  `stop()` 关闭存储；以及**端到端同步**（桩站点 → RPC → 编排 → worker → SQLite → 查询）：
  同步前 0 行 → 并发两次 `catalog.refresh` 只触发一次同步（桩站点收到 1 次索引页请求）→
  12 行 / totalCount 19866 / 分面 / 游标齐备，库文件真的落在临时 profile 下。

**未验证**：真实 profile 上的界面渲染与真实 profile 上的安装/更新/卸载/启停
（属真实验收，需另行执行并单独记载）。

### 真实验收（2026-11-01，真实站点，只读）

工具：`node --experimental-transform-types scripts/verify-live.mjs --network`
（目录库建在系统临时目录，**不读也不写任何 profile**，不做任何安装类操作）。

| 项 | 实测 |
|---|---|
| 冷同步（zh 全量） | **11.7s**；37 个分片、39 次请求、正文 19.0MB；清单来源 `manifest` |
| 热同步（无变更） | **0.7s**；跳过 37 片、1 次请求、253KB（索引页不支持 304 的固定成本） |
| 目录行数 | **19,866**，与站点自报 `totalCount` 一致；37 分片 |
| 分类分面 | 与站点 `sidebarStats.categoryCounts` 逐项一致（tools 7908 / interface 2628 / model 2044 …） |
| curated 合并 | 5,809 条全部并入、落空 0 |
| 搜索「上下文」（3 字，走索引） | 1,269 条命中，**19.2ms**（预算 ≤30ms ✅） |
| 搜索「dsh-purge」（走索引） | 22 条命中，**2.4ms** |
| 搜索「微信」（2 字，回退 LIKE） | 207 条命中，**86.1ms**（一次性；分词器限制，见下） |
| 全量翻页 | 398 页 / 19,866 行 / 去重后 19,866 行 / **0.8s**（≈2ms/页） |
| 目录库文件 | **57.4MB**（含 trigram 索引；见下） |

**真实测量暴露的预算违规与修复（这是夹具测不出来的）**

夹具（20,000 行合成数据）里搜索 P95 只有 26.6ms，**真实站点上是 126–203ms**：
一次 `catalog.list` 要跑 5 遍全文扫描（count + rows + 3 个独立 `group by` 分面），
每遍 5 列 `LIKE` 约 36ms。修复分三步，每步都有实测：

1. **分面合并成一次扫描 + 按搜索词缓存** → 扫描遍数 5 → 3。
2. **检索换 FTS5 trigram 索引**：先在真实数据上验证 trigram 与 `LIKE` 的命中数
   逐条一致（1269/1269、14/14、25/25），再改实现；`MATCH` 0.1–0.2ms。
3. **索引改 external content + 触发器**：中间版本按 repo（UNINDEXED 列）逐行删索引，
   写入 20,000 行从 220ms 退化到 **20.6s**；改成 external content 后回到 **1.29s**。

最终 3 字查询中位数 12.5ms（真实站点一次完整查询 19.2ms）。

**已知取舍（如实记录）**

- **1–2 字查询约 86ms/次**：trigram 按三字滑窗分词，短于 3 字必然 0 命中，只能回退
  单列 `LIKE`。回退目标是 `haystack` 单列（语义与长查询一致）而不是「只匹配名称」——
  后者实测搜「微信」会给出 0 条（名称里没有，描述里有 207 条）。
- **目录库 57.4MB**：trigram 索引对每行 ~500 字节的可搜文本产生大量三字窗口。
  可选的压缩手段（裁剪 haystack、给描述设上限、或改回 unikey/unicode61 + 前缀匹配）
  尚未实施，当前按「本地目录缓存」接受该体积。

## 2026-11-01 · M0 骨架

**范围**：仓库骨架、profile 路径解析、目录库 worker、版本化 RPC 信封、侧边栏整窗面板。
未接入目录同步与插件操作（M1–M3）。

**产物**（实测）

| 产物 | 原始 | gzip |
|---|---|---|
| `dist/client.js` | 9,591 B | 3,191 B |
| `dist/index.js` | 7,820 B | 2,831 B |
| `dist/catalog-worker.js` | 1,626 B | 726 B |

`dist/` 入库；安装包实测 **8 个文件 / 11,494 B（压缩后）**，不含 `src/`、依赖、数据库与日志。
客户端体积预算（§3.3 的 ≤180KB raw / ≤45KB gz）在 M0 即有约 18× 余量 —— 真正的增长压力
在市场页（M1），届时应复核。

**实现**

| 位置 | 内容 |
|---|---|
| `src/core/paths.ts` | `DSH_HOME` / profile 解析；profile 名走 ASCII 字符类白名单 + 显式拒绝 `.` 与 `..` |
| `src/core/dispatch.ts` | 信封校验（`type` / `method` / `payload.version` / `payload.method`）→ 方法表分发 → 错误脱敏；未知方法回 `plugin-harbor/unknown-method` |
| `src/storage/worker.ts` | `node:sqlite`，WAL + busy_timeout；开库前先建数据目录；M0 只有 `ping` / `close` |
| `src/storage/client.ts` | 单次调用超时（默认 5s）只拒绝该次调用并累加 `failedWrites`；worker 崩溃丢弃在途请求 |
| `src/index.ts` | `connection.fetch.register({path:'/api/plugin-harbor'})`；非 POST 405、非 JSON 415；`apply` 返回带 `stop`/`dispatch` 的可调用对象 |
| `src/client.ts` | `sidebar.panellist` 图标（`aria-hidden`）+ `main` 整窗面板，`id`/`key` 逐字相同；React `h()`，无 JSX |
| `src/client.css` | 页面不滚动、`.pc-body` 滚动；宿主令牌 `--dsw-alias-*` 优先、缺省值兜底 |

**为什么这么定**

- 侧边栏整窗面板而非设置页 section：市场是 19,866 条规模，宿主设置面板可用宽度约 564px。
- 目录库放 worker 线程：M1 起单分片 626KB、全量 19.2MB，解析与写库不能占宿主主线程。
- 存储失败只累加 `failedWrites`：浏览与管理不能因存储故障中断。

**本轮由测试抓出的真实缺陷（都已修，且各留一条回归断言）**

| 缺陷 | 现象 | 修法 / 断言 |
|---|---|---|
| profile 名白名单过宽 | `.` 与 `..` 能通过字符类，`<home>/profiles/..` 会指到 profiles 上一级 | 显式拒绝这两个值；`tests/paths.test.ts` 钉住 |
| 脱敏改写了原文分隔符 | `Authorization: Bearer abc` 被写成 `Authorization=[redacted] abc`，日志里的错误格式被篡改 | 捕获分隔符原样保留；`tests/rpc.test.ts` 钉住 `:` 与 `=` 两种形态 |
| 首次启用时开库失败 | profile 数据目录不存在 → `new DatabaseSync()` 抛错 → `status` 回 `plugin-harbor/error`，界面无任何读数 | 开库前 `mkdirSync(dirname(path), {recursive:true})`；宿主契约测试断言库文件被真实创建 |
| 打包校验黑名单误伤自身产物 | 黑名单用裸 `catalog-` 前缀，把 `dist/catalog-worker.js` 判成运行时私有文件 | 收窄成 `catalog-.*\.json$`（M1 的缓存文件）并加注释说明 |

**夹具验证**（`npm run check` 全绿；离线、不读真实 profile）

- `tests/rpc.test.ts`（5）：信封接受/拒绝矩阵、未知方法与抛错的收敛、脱敏去 `token=`/`Cookie:`/`Authorization:` 并限长 200。
- `tests/paths.test.ts`（3）：profile 名白名单（拒 `../escape` / `a/b` / `.` / `..` / 空 / 含空格）、数据目录与库路径拼接。
- `tests/client.test.mjs`（5）：只注册两个入口且 `id === key`、图标 `aria-hidden`、无 `settings.*` 入口、`<style>` 内容与 `src/client.css` 逐字一致、状态载荷经 RPC 进入界面、失败 RPC 显示错误条、产物无 `prompt()` / `innerHTML` / `document.createElement`。
- `tests/host.test.mjs`（2，需 `node scripts/extract-host.mjs`）：真实 Cordis fiber 达 `state === 2`、注册且仅注册一条 `/api/plugin-harbor` 路由、`status` 的 `dbPath` 落在本 profile 且库文件被创建、外来 method → `invalid-envelope`、未知方法 → `unknown-method`、非 JSON 415、非 POST 405、fiber 释放后路由 disposer 被调用、`stop()` 后 `store.call` 抛 `closed`。

**未验证**：19,866 条目录的真实同步（M1）；真实 profile 上的安装/更新/卸载/启停（M3）；
运行中 DSH 窗口里的实际渲染（M1 起逐页验收）；桌面端与 web 端两种宿主形态。