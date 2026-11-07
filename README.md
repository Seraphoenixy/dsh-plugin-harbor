# dsh-plugin-harbor

DeepSeek Harness 插件：在一个侧边栏整窗面板里**浏览插件市场**并**管理已装插件**。
目录数据来自 [dsh-plugin.org](https://dsh-plugin.org)（全量约 2 万条收录仓库），安装 / 更新 /
卸载等变更操作经宿主 `pluginManager` 服务执行，缺能力时回退 `dsh plugin` 子进程。

## 功能

面板分四个页签：**市场**、**已装**、**操作**、**设置**。

### 市场

- 目录同步：官网全量分片、内容寻址增量；站点改版走兜底通道（sitemap 枚举）并如实标注
  degraded，不会静默返回空目录；目录状态与失败原因直接透传。
- 搜索 / 11 个一级分类 / 4 种排序 / 游标分页；窗口化列表只渲染可见行，全量目录滚动不卡。
- 搜索用 FTS5 trigram 索引，3 字及以上走索引；1–2 字退回单列 `LIKE`（语义一致，稍慢）。
- 仓库名与「详情页」按钮用系统浏览器打开该插件在 dsh-plugin.org 上的详情页
  （按 owner + slug 寻址，slug 重名也不会指错）。
- 按需拉取单插件详情（精确版本 / 安装命令 / dshTarget，24h 缓存）。

### 已装

- 已装清单由 profile 清单 + lockfile + node_modules 交叉验证得出，git 形态含 commit。
- 更新判据只认真实来源：registry `dist-tags.latest`、git lockfile commit vs `ls-remote`、
  目录 `repoUpdatedAt` 信号；都拿不到就如实标「未判定」，绝不当成「已最新」。
- 启用 / 停用 / 更新 / 卸载 / 热重载；更新完成后自动复查该插件并落库。
- 本地路径 / 压缩包装的插件没有远端可比：禁用「更新」，请自行更新源码并构建后热重载。
- 导出 / 导入与 Git 跨机器同步的入口都在这一页。

### 操作

- 变更操作的队列：进度、日志尾部、取消；跨重启的历史记录存在本插件自己的目录库里。
- 「进行中」按队列执行顺序显示；已完成记录（本次会话与历史）一律按时间从新到旧。

### 设置

- 语言、自动刷新间隔、官网 / API 基址、registry 镜像、代理，持久化在本插件数据目录。
- 连通性诊断：站点 / API / registry / git / 目录库 / 热重载六项，只读、手动触发。

## 行为口径

- **确认才动**：所有安装 / 更新 / 卸载 / 启停 / 热重载先过确认弹窗，服务端再校验一次
  `confirm: true`；更新的安装地址与形态由**服务端**从已装事实里取，不接受客户端传 spec。
- **要不要重启以宿主为准**：桌面宿主默认加载 `@deepseek-ai/dsh-hmr`，安装 / 更新 / 启停 /
  热重载由宿主原地生效（面板照实显示「已热加载」）；宿主回「需要重启」时才提示重启并带原因。
  启停与热重载没有子进程兜底（子进程改不了运行中的宿主），缺服务时如实报错。
- **打开面板不自动联网检查更新**；只有刷新目录、检查更新、安装 / 卸载、Git 远端检查 / 发布
  等用户动作（或首次无缓存进入市场页）才出网。
- **目录库是旁路**：写库失败只累加 `failedWrites` 并在界面标注，浏览与管理不因存储故障中断。
- **构建与生效**：客户端 `client.js` 刷新页面即新；宿主侧 `index.js` 要等重启或一次 profile
  重新组合。两者不一致时面板顶部会直接说明并给修法。
- **开发时自动重载**：从检出目录（`link:` 指向 clone）安装时，插件监视自己的 `dist/`，产物一变
  自动请宿主重新组合，`PLUGIN_HARBOR_HOT_RELOAD=0` 可关闭；从 tarball / registry 装的正式副本
  里这段完全惰性（包里没有 `src/`）。首次启用监视器仍需重启一次 DSH。

## 导出 / 导入（已装页）

导出一份 JSON 到 `<dataDir>/exports/<时间>-<profile>.json`：插件清单（包名 / 形态 / 版本 /
是否启用）、归属到各插件的 profile 补丁行（含 `config`）、本插件设置，以及**可选**的各插件
自己的设置文件（勾选才导，疑似凭据的取值替换成 `[已脱敏]`）。导入先在面板里**预检**
（将安装 / 将启用 / 将停用 / 已一致 / 无法处理），确认后交给宿主逐步执行，进度在「操作」页。
导入源三种：系统文件浏览器 / 导出目录下拉 / 绝对路径（如从另一台机器拷来的）。

三条硬限制：

- **只增不删**：导入只装缺失的、按导出恢复启用状态，从不卸载，也不改 profile 的
  `package.json` / `cordis.patch.yml` / `pnpm-lock.yaml`；重跑同一个导入是幂等的。
- **带 `config` 的补丁行要人工粘**：宿主 `pluginManager` 没有写 `config` 的接口，导入时生成
  一份 YAML 片段文件（路径写在任务结论里），确认后自行粘贴。
- **插件设置文件只导出、不导入**；没导出的一律写进文件的 `omissions` 并说明原因，不静默少东西。

## Git 跨机器同步（已装页 → 导出 / 导入 → Git 同步）

固定使用独立 **`harbor-sync` 分支**，快照位于 `harbor/environments/<环境名>/snapshot.json`；
可与 dsh-mnemon 共用远端地址，但港湾不读取 Mnemon 的私有状态或凭据。本地使用
`<profile>/plugin-harbor/git-sync/` 里独立的 bare mirror。不同机器填同一环境名即共享环境，
不同环境名各自保留快照。

1. 填已有仓库的 HTTPS / SSH 地址或本机裸仓库绝对路径，确认保存（不联网）。
2. 「检查远端并预检」：查看待发布完整快照、远端应用计划、版本差异与最近十次提交。
3. 源机器确认「发布本机快照」；目标机器重新检查后确认「应用远端快照」。
   安装与启停进度在「操作」页；缺失凭据需在目标机器填写。

规则与安全：

- **不自动同步**：预检保留 15 分钟，本机事实或设置变化必须重新检查；发布遇远端变化会拒绝，
  不强推。应用固定到预检时的快照并复用导入确认与校验；远端缺项不代表卸载。
- **配置自动合并走宿主**：普通配置经宿主 `configEditor` 校验与持久化，不直接改 profile 文件；
  保留本机凭据、路径与表达式，跳过密钥、脱敏占位符、机器路径与表达式；条目归属不明 / 重复或
  配置已变化的计划拒绝，列为人工项并提供片段。
- **本地开发插件保护**：`link:` / `file:` / 本地路径与压缩包不参与同步（安装来源、启停与配置
  均不同步，省略原因显示在预检中）；目标机器已有同名本地插件时忽略远端同名记录；开发机发布
  保留快照里同名的普通安装记录。
- **认证与安全**：需要系统 Git；认证走 SSH agent 或系统凭据管理器，无交互认证失败会报错，
  不弹密码提示。建议私有仓库（分支不隔离读取权限），不要在 HTTPS 地址里填凭据。
- 每条 Git 命令 30 秒超时、可取消；打开面板只读本地设置，仅「检查远端」「发布」联网。

## 数据来源与出网

| 用途 | 地址 |
|---|---|
| 目录分片（全集） | `https://dsh-plugin.org/directory/<lang>/<category>-<page>-<hash>.json` |
| 目录清单 | `https://dsh-plugin.org/<lang>/plugins`（解析 RSC 载荷，不抓 DOM） |
| 版本与安装命令增强 | `https://api.dsh-plugin.org/plugins.<lang>.json`、`https://api.dsh-plugin.org/stats.json` |
| 单插件详情（按需） | `https://dsh-plugin.org/<lang>/plugins/<owner>/<slug>` |
| 更新判据 | npm registry（可配镜像）、`git ls-remote <repo>` |
| Git 同步 | 用户配置的 Git 仓库域名（如 `github.com`、`gitee.com` 或自建 Git 主机） |

没有遥测端点。港湾不调用 GitHub API。Git 的 `url.*.insteadOf`、代理及 SSH 配置可能影响
实际连接目标，以本机 Git 配置为准。

## 数据与隐私

- 数据在 `$DSH_HOME/profiles/<profile>/plugin-harbor/`（默认 `~/.dsh`），按 profile 隔离：
  `catalog.sqlite`（目录库，含操作历史）、`settings.json`（本插件设置）、`exports/`
  （导出文件与导入用的配置片段）、`git-sync/`（同步用 bare mirror）。
- **不写 profile 的 `package.json` / `cordis.patch.yml` / `pnpm-lock.yaml`**：变更操作交给宿主
  `pluginManager` 或 `dsh plugin` 子进程；配置合并经宿主 `configEditor`；本插件只写自己数据
  目录里的文件。
- 不读取任何凭据（凭据由宿主凭据服务保存）；快照中的配置已脱敏。
- 不打印凭据、Cookie、令牌或完整认证响应；真实凭据、数据库和运行日志不入仓库。

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

夹具测试离线、不读真实 profile、不联网；真实安装 / 更新 / 卸载验收单独记载在
[docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。维护用的真实环境脚本（都必须显式 `--network`，
都**不改任何 profile**）：

| 脚本 | 作用 |
|---|---|
| `scripts/verify-live.mjs` | 真实站点只读验收：冷/热同步、搜索、翻页、诊断六项 |
| `scripts/verify-installed.mjs --profile <name>` | 真实 profile 只读验收：已装事实 + 更新判据 |
| `scripts/verify-ops.mjs` | **隔离**真实执行验收：临时 DSH_HOME + 自建 profile（不碰你的 profile） |
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
                  已装事实、更新判据、设置、诊断、导出 / 导入
  upstream/       只读上游客户端（站点/registry/git，统一超时与 ETag）
  storage/        目录库工作线程与其客户端（SQLite + FTS5）
  ops/            宿主服务适配、子进程兜底、FIFO 队列、编排决策、入参校验
  git-sync/       远端快照发布 / 应用、配置合并计划、本地开发插件保护
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
