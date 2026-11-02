# dsh-plugin-harbor

DeepSeek Harness 插件，在一个侧边栏整窗面板里**浏览社区插件市场**并**管理已装插件**。目录数据来自 [dsh-plugin.org](https://dsh-plugin.org)（全量 19,866 条收录仓库），安装/更新/卸载经宿主 `pluginManager` 服务执行，缺能力时回退 `dsh plugin` 子进程。

> [!NOTE]
> 当前进度 **M4（设置与诊断）**：四个里程碑的功能都已落地。**唯一未做的验收是
> 真实 profile 上的安装/更新/卸载/启停**（M3 的变更操作会真的改你的 profile，
> 需要你明确同意后单独执行并单独记载）。

## 功能状态

| 能力 | 状态 |
|---|---|
| 目录同步（官网全量分片，内容寻址增量） | ✅ M1 |
| 市场浏览（搜索 / 11 分类 / 4 种排序 / 游标分页 / 窗口化列表） | ✅ M1 |
| 一键在系统浏览器打开插件在 dsh-plugin.org 上的详情页（市场页与已装页） | ✅ M6 |
| 目录状态与失败原因透传（stale 时不伪装成空目录） | ✅ M1 |
| 已装清单（清单 + lockfile + node_modules 交叉验证，含 git commit） | ✅ M2 |
| 更新判据（registry `dist-tags.latest` / git lockfile commit vs `ls-remote`） | ✅ M2 |
| 站点详情按需拉取（精确版本 / 安装命令 / dshTarget，24h 缓存） | ✅ M2 |
| 安装 / 更新 / 卸载 / 启停 / 热重载（`pluginManager` 优先 + 子进程兜底） | ✅ M3（真实 profile 验收待你同意） |
| 开发时自动重载（检出目录安装才启用，正式安装里惰性） | ✅ M6 |
| 操作队列、进度、取消、跨重启历史 | ✅ M3 |
| 设置持久化（语言 / 刷新间隔 / 基址 / registry / 代理） | ✅ M4 |
| 连通性诊断（站点 / API / registry / git / 目录库 / 热重载，只读、手动触发） | ✅ M4 |
| 已装插件及其配置的导出 / 导入（预检差异 + 经宿主执行的增量导入） | ✅ M5 |
| 导入源可选：系统文件浏览器 / 导出目录下拉 / 绝对路径 | ✅ M5 |

**变更操作的口径**：每次变更都要过确认弹窗（服务端还会再校验一次 `confirm: true`）；
安装/卸载走宿主流水线，宿主拒绝时按决策表回退子进程；**要不要重启以宿主的结论为准**
（桌面宿主默认加载 `@deepseek-ai/dsh-hmr`，此时安装/更新/启停/热重载由宿主原地生效，
面板会照实显示；宿主回「需要重启」时才提示重启，并带上原因）；
启停与热重载没有子进程兜底（子进程改不了运行中的宿主），缺服务时如实报错而不是假装成功。

**热重载**：已装页对已启用的插件有「热重载」按钮 —— 它让宿主按**磁盘上当前的代码**重新组合并
加载（等价宿主的 `setBundleEnabled(name, true)`）。重建过 `dist/` 的 `link:` 插件靠它生效，
不用重启 DSH；对插件港湾自己则先回执、后重载（面板会重新连接）。

**开发时的自动重载**：从**检出目录**（`link:` 指向 clone）安装时，插件会监视自己的 `dist/`，
产物一变就自动请宿主重新组合 —— 不用再点「热重载」。判据是包里有没有 `src/index.ts`：
`package.json` 的 `files` 不含 `src/`，所以从 tarball / registry 装进来的正式副本里这段
完全惰性，不会有任何文件监视。`PLUGIN_HARBOR_HOT_RELOAD=0` 可显式关闭。
只认 `dist/index.js` 与 `dist/catalog-worker.js`（`client.js` 是浏览器入口，改它只需刷新页面）；
一次构建连写多个文件会防抖合并成一次重载；宿主没有 `hmr` 服务时如实记一行、不假装重载成功。
**首次启用仍需重启一次 DSH**（监视器本身是新代码）。

**更新判据的诚实口径**：registry 形态比 `dist-tags.latest` 与本地版本；git 形态比
lockfile 里的 commit 与远端 HEAD commit；**本地路径 / 压缩包装的插件没有远端可比，
一律标「未判定」并说明原因** —— 判不出来的绝不当成「已最新」。打开面板不会自动
检查更新，必须点「检查更新」。

**更新完成后会自动复查那个插件**：任务进终态之前，服务端就按同一条判据重查一遍并落库，
所以更新完再看已装页，徽标已经是「已是最新」而不是更新前那句「可更新」；复查结论也会写进
任务结论（「更新后已复查：已是最新（1.9.30）」）。复查只查被更新的那一个，不会把整张表
重查一遍；复查失败不会把一次成功的更新改判成失败，只把原因如实附在结论后面。

**在浏览器中打开数据源详情页**：市场页每行的仓库名是可点的外链，右侧另有一个「详情页」按钮，
两者都用系统默认浏览器打开**该插件在 dsh-plugin.org 上的详情页**
（`<站点基址>/zh/plugins/<owner>/<slug>`）；已装页的仓库名同样可点。站点基址跟随设置页的
「站点基址」（自建镜像也对得上），默认 `https://dsh-plugin.org`。

链接一律是真 `<a target="_blank" rel="noopener noreferrer">`，桌面宿主会把 http/https 交给
`shell.openExternal`（所以不会在应用里开一个内嵌网页）。**路径段用 owner + slug，不是 repo**：
slug 会重名（`dsh-purge` 同时属于 4 个仓库），拿 repo 切会指到别的插件的页面。owner/slug 与
基址都来自外部数据，逐字符校验后才拼进 `href`，拼不出安全地址时该处只显示纯文本、不给链接。

**导出 / 导入（已装页「导出 / 导入」）**：导出一份 JSON 到
`<dataDir>/exports/<时间>-<profile>.json`，内容有插件清单（包名 / 记录取值 / 形态 / 版本 /
是否启用）、归属到各插件的 profile 补丁行（含你写过的 `config`）、本插件设置，以及**可选**的
各插件自己的设置文件（勾选才导，脱敏后只收文本文件）。导入先在面板里**预检**：列出
「将安装（含确切版本）/ 将启用 / 将停用 / 恢复条目开关 / 已一致 / 无法处理」，确认后才交给宿主
逐步执行，进度与逐项结果在「操作」页。

**导入源的三种给法**：点「选择文件…」用系统文件浏览器挑一份导出文件（选完立刻预检）、
从下拉框里挑本插件导出目录里已有的文件、或直接填一个绝对路径（例如从另一台机器拷来的）。
「选择文件…」读到的内容会先按导出格式校验、再存进本插件自己的 `<dataDir>/exports/` 目录，
文件名只取你那份文件的名字做后缀 —— 选错文件当场报错且不落盘。

三条必须知道的限制：

- **只增不删**：导入只装缺失的、按导出恢复启用状态，**从不卸载**任何插件，也不改 profile 的
  `package.json` / `cordis.patch.yml` / `pnpm-lock.yaml`；重跑同一个导入是幂等的。
- **带 `config` 的补丁行要人工粘**：宿主 `pluginManager` 没有写 `config` 的接口，导入时会生成
  一份 YAML 片段文件（路径写在任务结论里），需要你确认后自行粘贴。
- **插件自己的设置文件只导出、不导入**：那是各插件自己的数据，本项目不代写；导出时疑似凭据的
  字段/取值会替换成 `[已脱敏]`，数据库 / 缓存 / 日志 / 二进制一律不导出（明细在文件的
  `omissions` 里）。

**已知限制**：搜索用 FTS5 trigram 索引，**3 字及以上**走索引（实测整次查询约
19ms）；**1–2 字**因分词器按三字滑窗而无法命中，退回单列 `LIKE`（语义一致，
与长查询命中同一份文本，但一次约 86ms）。目录库文件约 57MB（含索引）。

**改完代码后**：客户端的 `client.js` 刷新页面即新，宿主侧 `index.js` 要等重启或一次 profile
重新组合。两者不一致时面板顶部会直接说明（「宿主里运行的插件还是旧构建」+ 修法），不会再让你
对着 `Unknown method` 猜 —— 第一次脱离旧构建请重启 DSH，或对**另一个**插件做一次启用/停用/更新
（「热重载」按钮本身也是新方法，旧宿主同样没有）。

## 数据来源与出网

| 用途 | 地址 |
|---|---|
| 目录分片（全集） | `https://dsh-plugin.org/directory/<lang>/<category>-<page>-<hash>.json` |
| 目录清单 | `https://dsh-plugin.org/<lang>/plugins`（解析 RSC 载荷，不抓 DOM） |
| 版本与安装命令增强 | `https://api.dsh-plugin.org/plugins.<lang>.json`、`https://api.dsh-plugin.org/stats.json` |
| 单插件详情（按需） | `https://dsh-plugin.org/<lang>/plugins/<owner>/<slug>` |
| 更新判据 | npm registry（`pluginManager.inspect` / `pnpm view`）、`git ls-remote <repo>` |

**打开面板不会自动联网检查更新**；只有刷新目录、检查更新、安装/卸载等用户动作（或首次无缓存进入市场页）才出网。没有遥测端点。

## 数据与隐私

- 数据在 `$DSH_HOME/profiles/<profile>/plugin-harbor/`（默认 `~/.dsh`），按 profile 隔离：
  `catalog.sqlite`（目录库，实测约 57MB）、`settings.json`（本插件设置），操作历史也在同一个库；
  **导出文件与导入用的配置片段在 `exports/` 子目录**（只会被导出流程排除在外，不会被扫进去）。
- **不写 profile 的 `package.json` / `cordis.patch.yml`**：变更操作交给宿主 `pluginManager`
  或 `dsh plugin` 子进程；本插件只写自己数据目录里的文件。
- 本插件**不读取任何凭据**（凭据由宿主凭据服务保存）。
- 出网只发往：`dsh-plugin.org`、`api.dsh-plugin.org`、npm registry（可配镜像）、
  `github.com`（`git ls-remote`）。没有遥测端点。
- 打开面板不自动检查更新；「检查更新」「运行诊断」「刷新目录」都由你点按触发
  （只有「首次无缓存进入市场页」会自动拉一次目录）。

## 安装

`dist/` 随仓库提交，安装无需构建：

```powershell
dsh plugin --profile desktop add "D:\path\to\dsh-plugin-harbor"
```

安装后重启 DSH（或刷新页面），侧边栏出现「插件港湾」图标。

## 开发

```powershell
npm install --ignore-scripts
node scripts/extract-host.mjs   # 从本机 DSH app.asar 提取真实宿主包（宿主契约测试用）
npm run check
```

> [!IMPORTANT]
> **装/改依赖后必须重跑 `node scripts/extract-host.mjs`**：`npm install` 会把提取出来的
> 宿主包当成多余依赖删掉，而 `tests/host.test.mjs` 在缺宿主包时是**跳过**而不是失败
> —— 只看 `node --test` 的输出会以为一切正常。`npm run test:host` 走 `verify-host.mjs`，
> 缺包时以退出码 2 结束。

| 命令 | 作用 |
|---|---|
| `npm run build` | 构建 `dist/`（esbuild，产物入库） |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` / `test:client` / `test:host` / `test:package` | 分项测试 |
| `npm run check` | 以上全部串跑 |
| `npm run pack:local` | 构建并生成 `artifacts/*.tgz` |

维护用的真实环境脚本（都必须显式 `--network`，都**不改任何 profile**）：

| 脚本 | 作用 |
|---|---|
| `scripts/verify-live.mjs` | 真实站点只读验收：冷/热同步、搜索、翻页、诊断六项 |
| `scripts/verify-installed.mjs --profile <name>` | 真实 profile 只读验收：已装事实 + 更新判据 |
| `scripts/verify-ops.mjs` | **隔离**真实执行验收：临时 DSH_HOME + 自建 profile，用真实 CLI/pnpm 安装与卸载（不碰你的 profile） |
| `scripts/verify-search-plan.mjs` | 检索方案对比（LIKE vs FTS5 trigram）的设计证据 |
| `scripts/capture-fixtures.mjs` | 重新抓取并裁剪测试夹具（含解析自检） |

### 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_HOME` | DSH 数据根目录，默认 `~/.dsh` |
| `DSH_PROFILE` | 未取到 profile 上下文时的缺省 profile 名 |
| `DSH_ASAR` | `extract-host.mjs` 使用的宿主 `app.asar` 路径 |
| `PLUGIN_HARBOR_SITE` / `PLUGIN_HARBOR_API` / `PLUGIN_HARBOR_REGISTRY` | 覆盖默认基址与 registry（自建镜像、离线验收用；持久化设置优先） |
| `PLUGIN_HARBOR_DSH` | 子进程兜底所用的 `dsh` 可执行文件路径 |

## 仓库结构

```
src/
  index.ts        插件生命周期、profile 路径、RPC 路由、队列与设置装配
  core/           类型与路径、RPC 信封、数据面解析（flight/site/sync/catalog）、
                  已装事实、更新判据、设置、诊断
  upstream/       只读上游客户端（站点/registry/git，统一超时与 ETag）
  storage/        目录库工作线程与其客户端（SQLite + FTS5）
  ops/            宿主服务适配、子进程兜底、FIFO 队列、编排决策、入参校验
  client.ts       浏览器入口（React h()，无 JSX）
  client.css      样式（esbuild text loader 内联为字符串）
tests/            离线夹具测试；host.test.mjs 需要真实宿主包
scripts/          构建、宿主提取、打包、校验与真实环境验收脚本
docs/             架构、数据源、验收记录
dist/             构建产物，入库
```

## 文档

- [架构说明](docs/ARCHITECTURE.md)
- [数据源与同步口径](docs/DATA-SOURCES.md)
- [验收记录](docs/ACCEPTANCE.md)

## 许可证

[MIT](LICENSE)