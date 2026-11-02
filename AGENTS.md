# dsh-plugin-harbor

先读本页。此项目是独立 DSH 插件：插件市场浏览 + 已装插件管理，目录数据来自 dsh-plugin.org。

- **数据来源纪律**：目录只来自 `dsh-plugin.org` 的目录分片、`api.dsh-plugin.org` 的 curated API 与按需详情页。除索引页的 RSC 载荷外不解析站点 DOM；解析器必须版本化并配离线夹具，站点改版时必须走兜底通道（sitemap 枚举）并如实标注 degraded，**不得静默返回空目录**。
- **不猜**：安装命令按 `npm_package || github:<owner>/<repo>` 生成；版本是否落后只取自 registry（`dist-tags.latest`）、git（lockfile commit vs `ls-remote`）或目录信号（`repoUpdatedAt`），三者都拿不到就标 `unknown`，不得用默认值或推算值填充。
- **出网纪律**：打开面板不自动联网检查更新；只有用户动作（刷新目录、检查更新、安装/卸载）或首次无缓存进入市场页才出网。README 必须列出会访问的域名，新增出网点必须同步更新该清单。
- **执行通道**：`pluginManager` 宿主服务优先，`dsh plugin` 子进程兜底。禁止手工改 profile 的 `package.json` / `cordis.patch.yml` / `pnpm-lock.yaml`。
- **Windows 上 `dsh` 是 `.cmd`**：`spawn(..., { shell: false })` 直接 ENOENT，用户级 shim 还可能报 `Harness CLI not found`。兜底通道必须走 `resolveDshCommand()`（宿主自带 CLI 优先），不要退回裸 `spawn("dsh")`。
- 变更操作的真实验收在**隔离的临时 DSH_HOME + 自建 profile** 里做（`scripts/verify-ops.mjs`）；**不得**用正在使用的 profile 做安装/卸载试验，除非用户明确指定并同意。
- **变更操作纪律**：所有安装/更新/卸载/启停/热重载都要过确认弹窗，服务端再校验一次 `confirm: true`；更新的安装地址与形态由**服务端**从已装事实里取，不接受客户端传 spec；**是否要重启一律以宿主返回的 `application` 为准**（桌面宿主默认加载 `@deepseek-ai/dsh-hmr`，`applied` 就是「已热加载」，禁止自己改写成需要重启）；启停与热重载没有子进程兜底，缺服务时如实报错。
- **导出 / 导入纪律**：导出**只读**且不许静默少东西（没导出的一律写进 `omissions` 并说明原因）；凭据（`config` 行、设置文件里的 token/secret/`sk-…`/JWT/URL 用户信息）必须脱敏；导入**只增不删**（不卸载、不动 profile 的 `package.json` / `cordis.patch.yml` / `pnpm-lock.yaml`），计划由服务端算好、计划里的每个安装地址都要过 `validateSpec`；宿主的 `pluginManager` 没有写 `config` 的接口，所以带 `config` 的补丁行只能生成片段交人工粘贴，不得由本插件去改写 profile 补丁。
- 执行层的取舍必须写进 `docs/ARCHITECTURE.md` 的决策表：**为什么这里回退子进程**、**为什么那里不回退**，否则下一次改动会凭感觉改错。
- `dist/` 是构建生成物，用 `npm run build` 更新，不能手工修改。生成物入库，安装无需构建。
- 改实现后运行 `npm run check`。真实宿主依赖缺失时 `node scripts/extract-host.mjs` 提取本机宿主包到本项目；不得修改正在运行的 profile。
- **装或改依赖后必须重跑 `node scripts/extract-host.mjs`**：`npm install` 会把提取出来的宿主包（`@deepseek-ai/cordis` 等）当成多余依赖删掉，而 `tests/host.test.mjs` 在缺宿主包时是**跳过**而不是失败 —— 只看 `node --test` 的输出会以为一切正常。`npm run test:host` 走 `verify-host.mjs`，缺包时以退出码 2 结束。
- 夹具测试离线、不读真实 profile、不联网（`tests/*` 里的网络调用一律被禁止）。真实安装/更新/卸载验收必须单独记载在 `docs/ACCEPTANCE.md`，不能与夹具测试混淆。
- 不打印凭据、Cookie、令牌或完整认证响应。不将真实凭据、数据库和运行日志加入仓库。
- 目录库是旁路：写库失败只累加 `failedWrites` 并在界面标注，不得让浏览与管理操作因存储故障而中断。