# 架构

`dsh-plugin-harbor` 是 DeepSeek Harness（Cordis 体系）的一个插件，提供插件市场浏览与已装插件管理。

| 部分 | 源码 | 构建 | 产物 |
|---|---|---|---|
| 服务端 | `src/index.ts`、`src/core/`、`src/storage/` | esbuild（`platform: node`，ESM） | `dist/index.js` |
| 目录库 worker | `src/storage/worker.ts` | esbuild（`platform: node`，ESM） | `dist/catalog-worker.js` |
| 浏览器 | `src/client.ts`、`src/client.css` | esbuild（`platform: browser`，IIFE，CSS 走 text loader） | `dist/client.js` |

## 服务端

- `index.ts`：解析 profile 路径 → 装配目录库 worker → 用 `connection.fetch.register` 挂载 `/api/plugin-harbor` → 暴露 `dispatch` 供契约测试。`apply` 返回带 `stop`/`dispatch` 的可调用对象。
- `core/dispatch.ts`：版本化 RPC 信封（`{type:'client-request', method:'plugin-harbor', rpcId, payload:{version:1, method, payload}}`）的校验、分发与错误脱敏。信封校验先于一切业务处理。
- `core/paths.ts`：`DSH_HOME` / profile 解析；profile 名过白名单正则（会被拼进文件路径）。
- `storage/worker.ts`：SQLite（`node:sqlite`，WAL + busy_timeout）。M0 只有 `ping`/`close`；M1 加目录表、FTS5 与增量同步。
- `storage/client.ts`：worker 客户端。单次调用超时只拒绝该次调用并累加 `failedWrites`；worker 崩溃丢弃在途请求，下次调用重新拉起。**存储是旁路**，不阻塞浏览与管理。

## 浏览器

- 注册**两个**宿主入口：`sidebar.panellist`（图标）与 `main`（整窗面板），两者的 `id`/`key` 必须逐字相同（宿主据此绑定；写错则点图标抛 `unknown panel`）。
- 不注册 `settings.section`：宿主设置面板可用宽度仅约 564px，市场大列表放不下。
- React 由宿主 `window.__ModuleLoader__` 提供（`require("react")`），组件用 `h()` 手写；样式来自 `src/client.css`，作为 `<style>` 节点随面板挂载。
- 布局契约：页面本身不滚动，只有 `.pc-body` 滚动。
- **外链一律用 `<a target="_blank" rel="noopener noreferrer">`**，不用 `window.open`（宿主主窗口的
  `setWindowOpenHandler` 对 http/https 走 `shell.openExternal` 再 `deny`，所以真 `<a>` 才是
  「交给系统浏览器」的正确表达；`window.open` 还会被弹窗拦截）。外链地址**只能**由
  `siteUrl()` 从 `owner` + `slug` 拼出，绝不把目录数据直接塞进 `href`（见下）。

## 数据流（M1 已实现）

```
dsh-plugin.org/zh/plugins ──┐  （索引页 253KB：shardManifest + sidebarStats）
                            ▼
              core/flight.ts   抽取 RSC 载荷并反转义
                            ▼
              core/site.ts     readShardManifest → 分片清单
                            ▼
              core/sync.ts     planSync：同哈希跳过 / 消失分片待清理
                            ▼
       upstream/fetch.ts（上限 3 并发，失败重试一次）
                            ▼
   storage/worker.ts → storage/catalog-db.ts（解析 + SQLite 写入都在线程内）
                            ▲
   api.dsh-plugin.org/plugins.zh.json ──► applyCurated（按 repo 合并，落空计数）
                            ▼
              catalog.list / catalog.status / catalog.refresh（RPC）
                            ▼
        浏览器：窗口化列表（行高 64，只渲染可见窗 ± 6 行，DOM ≤ ~30 行）
```

要点：

- **身份键是 `repo`**：站点数据里 slug 会重名（见 `DATA-SOURCES.md` §2.1），
  主键、游标兜底列与 curated 合并键都用 repo。
- **搜索用 FTS5 trigram（external content）**：≥3 字符走索引（`MATCH` 实测
  0.1–0.2ms，整次查询中位数 12.5ms）；1–2 字符因分词器限制退回单列 `LIKE`
  （语义一致，实测约 86ms/次）。分面三个计数合并成**一次**扫描并按搜索词缓存，
  否则一次请求要扫 5 遍（真实数据实测 126ms）。索引由触发器随行维护 ——
  按 UNINDEXED 列逐行删除会让 20,000 行写入从 1.3s 退化到 20.6s。
- **索引页不支持 304**，所以「无变更刷新」的固定成本是 253KB；分片则是内容寻址
  （文件名 8 位哈希 + 一年 immutable 缓存），未变分片永不重取。
- **同步合并**：同一时刻只跑一次（`catalog.refresh` 的并发调用复用同一次运行），
  否则两次 `applyChunk` 会按 `chunk_url` 互相清行。
- **失败不致命**：单个分片失败只记进 `failures` 并重试一次；索引页失败**不动数据**，
  把原因写进 `sync_state.last_error` 由界面显示。

## 本地索引 vs 直连（为什么要有这个库）

**先说不是什么**：这不是网页爬虫。内容全部来自站点**公开发布的 JSON 数据文件**
（`/directory/<lang>/<category>-<page>-<hash>.json`，内容寻址、`immutable` 缓存）；
唯一解析 HTML 的地方是索引页里内嵌的 shard 清单（站点没有 manifest 接口，
`/directory/<lang>/manifest.json` 等 5 个候选路径实测 404）。

**站点没有查询接口**（实测见 `docs/DATA-SOURCES.md` §6.1）：`?q=…` 返回逐字节相同的页面。
所以「让站点按需过滤」这条路不存在；可选的只有「把数据拿到本地再过滤」。

两条路的实测代价：

| | 本地索引（现在的实现） | 直连（每次打开现取） |
|---|---|---|
| 首次打开 | 冷同步 11.7s / 19.0MB（一次性） | 同样要 11.7s / 19.0MB |
| 再次打开 | **0.4ms 出列表**、搜索 2.4–20.4ms（读本地库） | 分片 immutable 可缓存，但每次要重新解析 ~19MB（约 50ms）并持有 **+31.8MB 堆** |
| 无变更刷新 | **0.7s / 253KB**（分片按内容哈希全部跳过） | 同 |
| 换查询 / 翻页 | 2ms/页（库内索引） | 浏览器端过滤 8.9ms/键（可行），但 19,866 条要一直驻留 |
| 离线 | 面板照常可用（只有「刷新目录」需要网） | 打不开 |
| 覆盖 | 19,866 条（官网全集） | 全集同上；只取 curated 子集则降到 5,809 条（29%） |

**结论**：库的价值不在「缓存」本身，而在**把 19MB 的数据变成能按字段查询、能跨页稳定排序、
能与「已装事实」在 SQL 里 join 的本地索引**，顺带把每次打开的代价从「下 19MB + 解析 +
32MB 堆」降到毫秒级。代价是**磁盘占用**（实测 55.0MB），而其中 **34.7MB 是我们自己的检索索引**
（trigram 24.2MB + haystack 列），数据本身只占 5.4MB —— 见 `docs/DATA-SOURCES.md` §6.2 与
`scripts/verify-catalog-size.mjs`。

因此若要「实时化 / 轻量化」，可调旋钮按代价从小到大：

1. **刷新更勤**：`syncTtlMs` 已是设置项（15 分钟–30 天）。无变更刷新只要 253KB，24h 调到 6h 代价很小。
2. **去掉检索索引**（省 34.7MB → 库 20.3MB）：搜索退回单列 `LIKE`（单遍约 35ms，配合分面缓存约 70ms/次）。
3. **直连模式**（不落库）：内存里只持 curated 子集（4.16MB，ETag 可 304 复用，堆 +7.6MB），浏览器端过滤；
   代价是**只覆盖 5,809 条（29%）**，且缺 `h1`/`language`/`license`/`repoUpdatedAt` 等筛选与徽标字段。
4. **最小字段库**（→5.4MB）：保留 19,866 条的清单与已装合并能力，但**放弃全文检索**（只剩名称匹配）。

以上 2–4 尚未实现；要做的话按 1 → 2 → 3 的顺序，前两项是小改动，第 3 项需要一个不落库的
取数与查询路径（新增一批测试）。

## 已装事实与更新判据（M2）

```
profile/package.json ──┐
profile/pnpm-lock.yaml ┼─→ core/installed.ts ─→ InstalledPlugin[]
node_modules/<n>/*.json┘     （清单名/spec/选中、真实版本、仓库身份、git commit）
                                       │
                     core/updates.ts ──┼── registry：dist-tags.latest（upstream/registry.ts）
                                       └── git：ls-remote HEAD commit（upstream/git.ts）
                                       ▼
                         installed_cache（结论缓存，界面打开只读它）
```

- **三个来源交叉验证**：`node_modules` 里 git 安装的副本**没有任何 git 元数据**，
  commit 只能从 lockfile 的 `resolution.tarball`（`/tar.gz/<sha>`）取；registry 依赖的
  integrity 同样来自 lockfile。
- **判定口径**：registry 比 `dist-tags.latest` 与本地版本（semver 子集，含预发布）；
  git 比 lockfile commit 与远端 HEAD commit；**本地路径/压缩包恒 `null`** 并给中性说明；
  任一侧缺失 → `null` + 原因。`updateAvailable === null` 与 `false` 在类型与界面上都分开。
- **详情页按需**：列表分片里没有精确版本与安装命令，只有详情页有；已装项逐个按需抓
  （约 152KB/个），24h 缓存写回 `plugins.detail_json`。全量抓 19,866 个不可行。
- **出网纪律**：打开面板不检查更新；`updates.check` 必须由用户点按钮触发。
  出网域名：`dsh-plugin.org`、`api.dsh-plugin.org`、npm registry（可配镜像）、`github.com`。

## 设置与诊断（M4）

- **设置**存在 `<profile>/plugin-harbor/settings.json`（本插件自己的数据目录，与目录库同级），
  **原子写**（先写 `.tmp` 再 rename）。可配：语言、自动刷新间隔、官网/API 基址、registry、代理。
- **读取容错、写入严格**：读取时坏字段**逐项**退回默认值并把原因记进 `notes`（界面如实显示，
  不静默吞掉）；`settings.set` 遇到非法值**报错**而不是替用户改写意图（非法设置不落盘）。
- 默认值可由 `PLUGIN_HARBOR_SITE` / `PLUGIN_HARBOR_API` / `PLUGIN_HARBOR_REGISTRY` 覆盖
  （自建镜像与离线验收用），持久化设置优先于环境变量。
- **诊断**：`diagnostics.run` 一次跑六项 —— 目录数据（含上次失败原因）、目录库（worker 真连）、
  官网索引页、API 中心 `stats.json`、npm registry `/-/ping`、本机 `git --version`。
  口径：**只读**、**只在用户点按钮时跑**、单项失败不影响其它项、拿不到结论记 `ok: null`
  （与「失败」严格区分）。镜像没实现 `/-/ping` 时回 4xx 也算「可达」并说明。

## 执行通道（M3 已实现）

```
RPC（op.install / op.update / op.remove / op.setEnabled / op.list / op.cancel）
        │  入参白名单校验 + confirm:true
        ▼
   OpQueue（FIFO，同一时刻只跑一个变更任务，进度只升不降，取消落到运行器）
        ▼
   ops/execute.ts 决策
        ├── 有 pluginManager 服务 → 宿主流水线（写锁 / registry 回退 / 失败还原 /
        │     构建脚本审批 / 兼容性闸门 / install-log 与 install-state 事件）
        └── 无服务或被拒 → `dsh plugin --profile <p> add|remove <spec>` 子进程
              （自己捕获输出、估进度、超时、**杀进程树**、归类失败）
        ▼
   ops 表（终态 + 日志尾部）→「操作页」跨重启回看
```

决策细节：

| 动作 | 首选 | 回退 |
|---|---|---|
| 安装 | `manager.installBundle(spec, {enabled:true, requestId})` | 无服务、或宿主回 `already-installed` / `not-bundle` → 子进程 `add` |
| 更新 | `removeBundle` → `installBundle(installSpec)`（HMR 下宿主不能原地覆盖） | 移除被拒（`not-removable` / `stop-profile` / `bundle-in-use`）→ 子进程原地覆盖 |
| 卸载 | `manager.removeBundle(name)` | 宿主回 `not-bundle` / `unknown-plugin` → 子进程 `remove` |
| 启停 | `manager.setBundleEnabled(name, bool)` | **不回退**：子进程改不了启用状态，如实报错 |
| 热重载 | `manager.setBundleEnabled(name, true)`（重新组合） | **不回退**：子进程改不了运行中的宿主 |

其它硬口径：

- **要不要重启由宿主说，不由我们猜**：`application: "applied"` = 已原地生效（桌面宿主默认加载
  `@deepseek-ai/dsh-hmr`），只有宿主回 `restart-required` 才提示重启，并把它的 `restartReason`
  （`no-hmr` / `package-moved` / `host-module` / `unmanaged-plugin` / `module-comparison`）翻成人话。
  子进程兜底那条路**必然**要重启：改动来自宿主进程之外，运行中的实例不会自己换代码。
- **安装地址由服务端从已装事实拼出来（`ops/spec.ts`）**，入队前就用 `validateSpec`
  校验：`package.json` / lockfile 里记的是**取值**（registry 形态是版本范围
  `^1.9.28`），不是安装地址。`pnpm add ^1.9.28` 会把范围当**包名**解析，直接报
  `ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER`。
- 子进程原地覆盖时，`registry` 形态拼 `<name>@latest`，**git / 路径 / 压缩包形态按原地址重装**
  （`github:o/r@latest` 是无效地址）。
- 启停与安装的「形态」由**服务端**从已装事实里取，不接受客户端传 spec。
- 取消：宿主路径调 `cancelInstall(requestId)`；子进程路径杀进程树（Windows 用
  `taskkill /T /F`，否则只杀 `dsh` 会留下继续改 profile 的 pnpm 子树）。
- 出网/副作用纪律：所有变更都要过确认弹窗，服务端再校验一次 `confirm: true`。

### 更新的「先卸后装」为什么必须配两件保险

热重载下宿主对已装包直接回 `already-installed`（它不能原地覆盖正在运行的模块），
所以更新只能 `removeBundle` → `installBundle`。这条路的固有代价是：**卸载一旦成功、
安装再失败，插件就从 profile 里消失了**。真实故障（2026-11-01，desktop profile）
就是这么发生的：地址是范围 → pnpm 拒绝 → 旧版本已经卸掉，`dsh-cost-meter` 与
`@liustack/modsearch` 双双从 `dependencies` 里没了。因此：

1. **地址先拼好、先验过再动手**：`op.update` 在**卸载之前**算出 `installSpec`
   （registry 带上更新检查核实到的目标版本，git / 路径按形态拼）并用 `validateSpec`
   校验；验不过就直接报错，绝不先卸载。拼装规则与宿主内部的 `dependencySpec()`
   同口径（registry → `<名>@<取值>`；`file:`/`link:` → 相对 profile 解析成绝对路径；
   其它协议原样透传，不拼 `@latest`）。
2. **安装失败按原地址回滚**：用 `restoreSpec`（不带目标版本的原地址）装回去，并把
   「装回了」还是「回滚也失败、请重新安装」如实写进结论。**取消不回滚**：用户要求
   停止，就只如实说明依赖已被移除，不背着用户再装一次。

### 宿主报错为什么要连诊断一起显示

宿主的 `operation-error` 是兜底错误码：pnpm 失败、模块加载失败、重载失败都用它，
真正的原因只写在 `error.diagnostic` 里（宿主源码：
`managementError()` → `{code:"operation-error", diagnostic: messageOf(error)}`）。
所以 `describeOutcome()` **不允许**只回一句「宿主的包操作失败」：先看
`packageResult.kind`（network / not-found / build-blocked …），再按诊断里的已知特征
（`ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER`、`ERR_PNPM_FETCH_404`、
`Cannot find module` …）给一句能照做的话，**诊断原文照附**（截断而不替换：映射是给
下一步用的，原文是证据）。同理，失败原因的文案必须同时进 `error` 与 `note`，
界面上的失败行读的是 `error`。

### 打开数据源详情页：为什么必须是 `<a>`，以及为什么用 owner+slug 而不是 repo

市场页每行（以及已装页的仓库名）都能点开**该插件在 dsh-plugin.org 上的详情页**。
三条实现约束：

**1. 用真 `<a target="_blank" rel="noopener noreferrer">`，不用 `window.open`。**
桌面宿主主窗口注册了 `setWindowOpenHandler`：

```js
window.webContents.setWindowOpenHandler(({ url }) => {
  if (["http:", "https:"].includes(new URL(url).protocol)) shell.openExternal(url);
  return { action: "deny" };
});
```

即「新窗口一律拒绝，但 http/https 先交给系统浏览器」。所以 `<a target="_blank">` 正好落在
这条规则上：点击 → 宿主拦下 → `shell.openExternal` → 系统默认浏览器。`window.open` 走的是
同一条拦截路径，但会先被浏览器的弹窗拦截器盯上，也拿不到 `rel` 那层保护，所以不用它
（`tests/client.test.mjs` 里有一条 `assert.doesNotMatch(source, /window\.open\s*\(/)` 守着）。

**2. 路径段是 owner + `slug`，不能用 `repo` 切。**
详情页地址是 `/<lang>/plugins/<owner>/<slug>`（`docs/DATA-SOURCES.md` §4）。而 `slug` 会重名
——单分片实测 23 组，`dsh-purge` 同时属于 yujunzhixue / kingcharleslzy-ai / mmparko 等 4 个
不同仓库（§2.1 正是因此把身份键定成 `repo`）。详情页按 slug 路由，所以**必须**用目录行自己的
`owner`/`slug` 两个字段拼；拿 `repo` 切（`owner` + 仓库名）在两者不一致时就会指到别的页面。
因此：

- 目录行本来就有 `owner`/`slug`（`CatalogRow`），市场页直接用；
- 已装页的行是 `InstalledPlugin`（只有 `repo`），所以 `installed.list` 从目录行把
  `slug`/`owner` 一并带出来（`InstalledRow.slug`/`owner`），**不从 repo 反推**；
- 目录里查不到这个插件（未收录 / 本地路径装的自研插件）时这两个字段缺省 → 不渲染链接，
  只显示纯文本。宁可不给入口，也不给一个可能指错的入口。

**3. 地址只能由 `siteUrl()` 拼，且每段都校验。**
owner、slug、站点基址都是外部数据（目录来自 dsh-plugin.org，基址来自用户设置），直接拼进
`href` 就等于把外部字符串放进 HTML 属性，`javascript:` 之类会被浏览器执行。所以：

```ts
function siteUrl(row, siteBase) {
  const owner = row?.owner?.trim() ?? "";
  const slug = row?.slug?.trim() ?? "";
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(slug)) return "";
  const base = normalizeSiteBase(siteBase);   // 只接受 http/https、拒绝带凭据的地址
  return base === "" ? "" : `${base}/zh/plugins/${owner}/${slug}`;
}
```

基址跟随设置页的「站点基址」（自建镜像也对得上），不合法时返回空串、调用方**退回纯文本**
（仓库名照常显示，只是不可点）。`tests/client.test.mjs` 里用 `javascript:alert(1)`、
`../../etc`、带引号注入的串等逐个验证不出链接、也不丢整行。

### 更新完成后自动复查被更新的那个插件

### 更新完成后自动复查被更新的那个插件

`updates.check` 的结论是**落库的缓存**（`installed_cache` 表），`installed.list` 只读这份缓存、
自己不出网。所以一次更新成功后如果不再复查，已装页会一直显示**更新前**那次的结论（「可更新」），
刚更新完的插件看起来还是旧的 —— 界面在骗人，而且用户会以为更新没生效。

因此队列运行器在 `kind === "update"` 且任务**已有结果**之后、**进入终态之前**再查一次：

```
executeTask(update) ──► 结果（done / failed / cancelled …）
                          │
                          ├─ 插件还在 dependencies 里？不在 → 跳过复查并记一行日志
                          └─ checkUpdates(store, [被更新的那个]) ──► putChecks ──► 追加进 note
```

四条口径：

- **在终态之前做**：客户端看到「已完成」时会重读已装清单（`liveCount` 由 >0 回到 0 的 effect），
  那时库里必须已经是新结论，否则会出现一次可见的竞态（先闪「可更新」，下次刷新才变）。
- **只查那一个**：复查传 `[task.target]`，不重查整张表 —— 一次更新不该把所有插件的 registry /
  `git ls-remote` 都打一遍。
- **判据不变**：复查走的就是 `updates.check` 用的同一个 `checkUpdates()`，拿不到仍然
  `updateAvailable: null` + 原因，绝不当成「已最新」。
- **复查失败不改判更新结果**：更新成功就是成功，复查出问题只把原因附在结论后面
  （「更新后复查失败：…」），不把一次成功的更新变成失败。插件已被更新失败弄丢时
  （没装回来）没有可复查对象，如实跳过。

### 「启用」失败的真正原因往往不在启用本身

宿主 `setBundleEnabled` 的语义是「只切 bundle 选中状态、**保留已装依赖**」
（宿主源码：`selectBundle()` 只改 `dsh.profile.bundles`）。依赖若已被上一次失败的
更新删掉，启用**永远不可能成功**，只会抛出一个原始的模块解析错误。因此启用失败时，
执行层再读一次已装事实：依赖不在 `dependencies` 里就明说「请到市场页重新安装」，
不让用户对着「宿主的包操作失败」猜。

### 热重载（HMR）：能力探测、结论口径与「自热重载」

宿主侧由 `@deepseek-ai/dsh-hmr` 提供 `hmr` 服务；`dsh-base` 的补丁里这一条是
`disabled: !!js "!ctx.get('profileContext')"`，即**桌面启动器启用它**（`root: []`：profile 配置默认
重载、源码目录监听是可选项），Headless / SDK / ACP 组合包则在 YAML 里禁用它。宿主内部据此
决定结论：有 `hmr` → `change()` 预设 `application: "applied"` 并走 `hmr.runExclusive` /
`reconcileProfile`；没有 → 预设 `restart-required` + `restartReason: "no-hmr"`。

本插件的做法：

- **能力探测**：`ctx.get("hmr") !== undefined`（晚绑定，每次现读），只用于**文案与诊断**
  （`status.hot`、设置页一行、诊断里的「热重载（hmr）」项）；结论仍以宿主的 `application` 为准。
- **「热重载」动作（`op.reload`）**：宿主侧就是 `setBundleEnabled(name, true)` —— 选中状态没变
  时 `selectBundle()` 直接返回，但 `publishAndReload()` 照样跑，于是 HMR 会替换 profile 目录下
  磁盘已变化的插件代码。**这正是「重建了 `dist/` 但不想重启 DSH」要的那一步**（本项目就是
  `link:` 安装，改的正是已链接包的目标）。只对已启用的插件开放：重载不改启用状态。
- **自热重载单独处理**：目标是本插件自己时，宿主一重新组合就把运行中的本插件换掉，那条 RPC 的
  响应会随它一起消失。所以 `op.reload` 对「自己」走**先回执、后动手**：先写一条终态操作记录
  （如实写「已请求宿主热重载本插件」），把回执发出去，`SELF_RELOAD_DELAY_MS`(600ms) 之后再请宿主
  重新组合；若那次重载失败（此时插件还在），再把历史改成失败原因。判定「是不是自己」不靠硬编码
  包名：拿本文件的真实路径去比对每个依赖的落点（`link:` 目标解析后 / `node_modules/<name>`，
  两边都 realpath，兼容 pnpm 虚拟 store）。
  浏览器侧由 `dsh-web-app` 补丁里的 `client-hmr`（注释写明 **always mounted**，空闲直到客户端
  bundle 被重写）负责重载插件界面；因此文案只说「面板会重新连接，界面没自动更新就刷新一次」，
  不承诺浏览器一定会自己刷新。

### 开发时的自动重载：为什么监视 dist、为什么只对检出目录生效

`src/ops/watch.ts` 监视本包自己的 `dist/`，产物一变就调
`pluginManager.setBundleEnabled(name, true)`（与「热重载」按钮同一条路），宿主据此按磁盘上
当前的代码重新组合本插件。

**为什么不自己清模块缓存**：`dsh-channel-hub` 的 `src/reload.ts` 是另一条路 —— 它手动把包内
模块从 Node 的 ESM `loadCache` 与 CJS `require.cache` 里清掉，再经内核 loader 重新 import，
然后释放旧 fiber、按原 config 注册新实例。那套做法要摸 `ctx.loader.internal.loadCache` 与
`ctx.registry` 这些**内核内部结构**，源码注释自己也承认脆弱：

> The loadCache is duck-typed on purpose: Node 24.12+ replaced the Map subclass with its own
> structure, so `instanceof Map` is false on newer runtimes even though `keys/get/delete` still
> behave like a map.

本项目已经有宿主提供的重新组合通道（`setBundleEnabled` → `publishAndReload` → HMR），
没必要再维护一份运行时补丁；失败时宿主会回滚它自己的状态，我们只负责如实记一行。

**为什么用「有没有 `src/index.ts`」当开关**：`package.json` 的 `files` 里不含 `src/`，所以
检出目录（`link:` 指向 clone）有 `src/index.ts`，而 tarball / registry 装进来的正式副本只有
`dist/`。这条判据把开发形态与正式形态分开 —— **正式安装里监视器根本不会启动**，不会有任何
文件句柄与后台定时器。`PLUGIN_HARBOR_HOT_RELOAD=0` 可显式关闭。

**三个实现细节**：

- **只认宿主侧产物**：`dist/index.js` 与 `dist/catalog-worker.js` 变化才重载；`dist/client.js`
  是浏览器入口（页面加载时现取），改它刷新页面即可，不必重新组合宿主。
- **防抖 + 单飞**：一次构建会连写多个文件，`watchDist()` 把 700ms 内的变更合并成一次回调；
  重载进行中再来的变更只记一个 `queued` 标记，等这次结束再跑一次，不叠着跑。
- **先解析真实目录**：`link:` 安装时 profile 里那条是 junction，直接监视它收不到「从另一条
  路径写入」的事件，所以 `watchDist()` 先 `realpathSync`。watcher 与定时器都 `unref()`，
  空闲的桌面进程仍能正常退出。

### 「怎么调 dsh」的解析（Windows 上的真实坑）

`dsh` 在本机是 **`dsh.cmd` 批处理**，而 `spawn("dsh", args, { shell: false })` 会
**ENOENT**（Node 不能直接执行 `.cmd`）；用户级 shim 在某些机器上还会报
`Harness CLI not found`。因此 `ops/subprocess.ts#resolveDshCommand()` 的解析顺序是：

1. `PLUGIN_HARBOR_DSH` 显式指定；
2. **宿主自带 CLI**：`<安装根>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`
   + `ELECTRON_RUN_AS_NODE=1`，用安装目录里的 Electron 可执行文件直接跑（打包 shim 内部就是
   这么做的）—— 完全绕开 shell 解析，也绕开坏掉的用户 shim；
3. PATH 上的 `dsh`（Windows 下 `.cmd`/`.bat` 走 shell）。

第 3 条经 shell 时把整行命令**自己拼成字符串**（参数全部来自白名单校验，逐个加引号），
既避开 Node 的 DEP0190（`shell: true` + 参数数组会未转义地拼接），也不引入注入面。

### 导出 / 导入（已装插件及其配置）

```
export.run ──► <dataDir>/exports/<时间>-<profile>.json      （清单 + 归属到插件的补丁行 + 本插件设置 + 可选插件设置文件）
export.list ─► 列出导出目录里的文件（界面下拉用）
import.upload ─► 浏览器选中的文件：格式校验 → 落到 <dataDir>/exports/<时间>-<profile>-<原名>.json → 返回路径
import.preview ─► 读回 + 格式校验 + 与当前 profile 求差 → 计划（不写任何东西）
op.import ──► 队列任务 "import" ──► 逐步 installBundle / setBundleEnabled / setPluginEnabled
                                    └─ 带 config 的补丁行 → 生成 <…>-patch.yml，人工粘贴
```

**导入源为什么多一个 `import.upload`**：界面上的「选择文件…」拿到的是浏览器 `File` 对象，
内容只在页面内存里，而预检与导入都只接受**服务端读得到的路径**；宿主也没有给插件用的原生
文件对话框（`app.asar` 里没有对插件开放的 `showOpenDialog` 通道）。因此只能由客户端读出
文本、经 RPC 交给服务端落盘，再由 `import.preview` 按路径读回。

三条硬约束：落点固定在本插件自己的 `exports/` 目录（这是本插件唯一有写权限的位置，也不
会碰到 profile 的补丁与清单）；**先校验再落盘**（选错文件当场报错，不在 `exports/` 留垃圾）；
文件名只取原名的安全后缀（剥掉路径片段与非法字符，前缀仍用本插件的导出命名规则），
避免 `..\\..\\` 这类名字把文件写到目录外或覆盖已有导出。宿主 RPC 的请求体上限是
300MB（`client-connection` 的 `maxRequestBodyBytes`），本插件另有 8MB 的导出文件上限，
两者不冲突。

硬口径（都能在 `tests/transfer.test.ts` 里找到对应用例）：

- **只读导出 + 不静默少东西**：没进导出的每一项都要在 `omissions` 里带原因（数据库 / 日志 /
  锁 / 压缩包、二进制、超过 256KB、缓存目录、认不出属于哪个插件的目录）；解析不了 profile
  补丁也要写成 `profilePatch.error` 而不是「当作没有配置」。
- **配置怎么归属**：profile 补丁行按「该插件自己补丁文件里声明的行 id」或「行里的 `name`
  指向该包」认领；认领不到的行走 `profilePatch.unattributed` **原样带出**。条目级信息
  （`entryId` / `moduleName` / 启用状态）来自宿主 `pluginManager.listPlugins()`，服务不可用
  时这一节整个缺席并在 `warnings` 里说明 —— 不编一份空表。
- **数据目录怎么归属**：候选名 = 包名 / 包名尾段 / **插件自己声明的行 id** / 宿主条目 id
  （去掉 `include:` 前缀）。真实 profile 上 `dsh-channel-hub` 的目录就叫 `channel-hub`，
  只按包名判断会在「宿主服务不可用」的离线场合把整个目录略过（真机预演抓到）。所有候选名
  由 `dataDirCandidates()` 一处产出，「哪些目录在导出范围内」也只用 `ownedDataDirNames()`
  一个入口 —— 两处各写一套迟早会漂。
- **凭据必须脱敏**：`config` 行、本插件设置、插件设置文件都要过脱敏（键名含
  token/secret/password/apikey/credential/cookie/authorization… 的整值替换；值里出现
  `sk-…` / `ghp_…` / JWT / `Bearer …` / URL 用户信息 的按段替换），并统计次数写进 `warnings`。
- **导入只增不删**：只装缺失的、按导出恢复 bundle 启用状态与条目开关，**从不卸载**，也不动
  `package.json` / `cordis.patch.yml` / `pnpm-lock.yaml`。计划由**服务端**算好（客户端只给文件
  路径与确认），每个安装地址再过一次 `validateSpec`；`already-installed` 记为「已装」而不是
  失败，因此重跑同一个导入是幂等的。单项失败不中断，结论里给「N 项安装 / M 项改状态 /
  K 项已一致 / 无法处理」与首个失败原因。
- **为什么配置行要人工粘**：宿主 `pluginManager` 的 Remote 方法面里只有
  `setPluginEnabled`（写 `disabled`），**没有写任意 `config` 的接口**；本项目也不允许手工改
  profile 的补丁文件。因此带 `config` 的行由服务端生成一份 YAML 片段文件（路径随任务结论给出），
  由用户确认后自行粘贴 —— 不假装能一键还原。
- **导入地址怎么来**：registry 形态按导出的**确切版本**装（拿不到确切版本才退回记录的取值），
  git / https 压缩包原样，`file:` / `link:` 形态必须在目标机器上真实存在，否则记为「无法处理」
  并说明原因，而不是让 pnpm 去猜一个别的机器上的路径。
- **插件自己的设置文件只导出、不导入**：那是各插件自己的数据，本项目不代写；导出时也只收
  白名单扩展名的文本文件（`json/yaml/txt/toml/ini/…`），一眼认不出是文本的一律略过。

### 界面上的三个导入源，为什么「选完立刻预检」要显式传路径

导入区同时给三种来源：系统文件浏览器（`<input type="file">`，按钮代理点击、控件本身 `display:none`，
原生 file 控件在各平台的宽度与文案不受控，会把这行撑变形）、导出目录下拉、手填绝对路径。
选中文件后**立即预检**，用户不用再点一次「预检」。

⚠️ 这里有个必须显式传参的坑：选中文件后立刻预检时，`useState` 还没重新渲染，闭包里读到的
`source` 仍是上一轮的值（实测会预检到「导出目录里第一个文件」上，用户以为在看自己选的那份）。
所以预检逻辑抽成 `previewOf(path)`，选文件那条路**把上传返回的路径直接传进去**，只有按钮
才读当前的 `source`。文件优先级也按「刚选的 > 手填 > 下拉」固定，选过的文件不会被下拉框
的默认值盖回去；选完还要清空 `input.value`，否则连续选同一个文件不会再触发 `change`。

### 客户端与宿主的构建错配（真实踩坑：`Unknown method: export.run`）

两半代码的**加载时机不同**：客户端的 `client.js` 是**页面加载时从磁盘现取**的；宿主侧
`index.js` 是**进程启动 / 上次 profile 重新组合时载入**的。于是本插件是 `link:` 安装时会出现
「面板已经是新代码、宿主里跑的还是旧的」：新面板点「导出」→ 宿主回
`Unknown method: export.run`（本轮实测报障）。

处理方式有两层，都不靠猜：

1. **构建标识握手**：`scripts/build.mjs` 按 `src/**` 内容哈希出一个 12 位标识（用内容哈希而非
   时间戳，免得每次构建都让入库的 `dist/` 产生无谓 diff），用 esbuild `define` 同时注入
   `dist/index.js` 与 `dist/client.js`。`/status` 返回 `build`，面板拿自己的值比对：不一致
   （老宿主根本不报 `build`，同样算不一致）就在页面顶部给出提示条，写明「宿主里运行的还是旧
   构建」以及修法（重启 DSH，或对任意另一个插件做一次启用 / 停用 / 更新 —— 任何一次 profile
   重新组合都会把磁盘上已变化的插件代码换进来）。构建脚本还会自检两个产物确实带上了这个
   标识：只注入不引用时 esbuild 的 define 是静默空操作，那种失效必须构建期就炸。
2. **未知方法的翻译**：即便没看到提示条，`call()` 也会把 `Unknown method: X` 翻成同一句话并附上
   原始报文（`src/client.ts`），而不是把一句无从下手的错直接甩给用户。

⚠️ 注意这个坑的自我困局：**「热重载」按钮本身也是新方法**（`op.reload`），旧宿主同样没有 ——
所以第一次脱离旧构建只能靠重启 DSH，或去动**另一个**插件的启用状态。

## 边界

- 不修改 profile 的 `package.json` / `cordis.patch.yml` / `pnpm-lock.yaml`；文件路径只在确认后由 `dsh plugin` 或宿主服务改动。
- 不写 `dsh-plugin-hub` 的版本信号文件（`gro.ngilp-hsd-versions.json`），本项目自持 `installed_cache`。
- 不打印凭据、Cookie、令牌或完整认证响应。