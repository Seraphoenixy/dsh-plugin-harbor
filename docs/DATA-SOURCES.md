# 数据源与同步口径

本文件记录 `dsh-plugin.org` 数据面的实测事实与解析口径。**每一条都附实测证据**；
站点改版时先更新这里，再改解析器与夹具。

抓取时间：2026-11-01（Asia/Shanghai）。

## 1. 目录分片（全集，主数据源）

```
https://dsh-plugin.org/directory/zh/<category>-<page>-<hash>.json
https://dsh-plugin.org/directory/en/<category>-<page>-<hash>.json
```

- 覆盖 **19,866** 个收录仓库（站点 `sidebarStats.totalCount`，与 11 个分类计数求和一致：
  model 2044 / agent 879 / tools 7908 / interface 2628 / session 1498 / memory 469 /
  integration 1095 / dev 1639 / fun 535 / knowledge 636 / workflow 535）。
- zh 侧实测 **37 个分片**（tools 13 页、interface 5、model 4、dev 3、session 3、
  agent 2、integration 2、knowledge 2、fun/memory/workflow 各 1）。
- 实测单分片：617 条 / 626,189 B → 平均 1,014 B/条；全量约 **19.2 MB**（精简字段 621 B/条 ≈11.8 MB）。
- 单条字段（实测全量覆盖 617/617）：

  | 字段 | 说明 |
  |---|---|
  | `slug` / `ownerSlug` / `name` / `displayName` | 标识 |
  | `category` | 11 个一级分类之一 |
  | `topics[]` / `features[]` / `description` / `h1` | 展示与检索 |
  | `source.repo` / `source.npmPackage` | 仓库与 npm 包名（`npmPackage` 可能为空串） |
  | `compatibility.status` | `verified` / `unconfirmed` |
  | `dates.repoCreatedAt` / `repoUpdatedAt` / `addedAt` / `pageUpdatedAt` | 时间信号（`repoUpdatedAt` 是「有无新提交」的判据） |
  | `stats.stargazers_count` / `forks_count` | 活跃度 |
  | `metadata.language` / `license` / `dshTopic` | 元数据 |
  | `selfOwned` | 站点标注 |

- **没有版本号，也没有安装命令** —— 必须由 curated API 或详情页增强。
- HTTP 语义（实测）：`Cache-Control: public, max-age=31536000, immutable`，
  带 ETag；带 `If-None-Match` 条件 GET → **304 / 0 字节**。文件名中的 8 位哈希即内容指纹。

## 2. 目录清单（发现分片 URL）

清单**只存在于页面载荷里**：`https://dsh-plugin.org/zh/plugins` 的 RSC 载荷
（`self.__next_f`）内有一个 `"shardManifest":{ "<category>": ["/directory/zh/…json", …] }`
对象（实测字段名就是 `shardManifest`），同一载荷里还有
`"sidebarStats":{"totalCount":19866,"categoryCounts":{…}}`。

- 实测：索引页 253,455 B；带 `If-None-Match` 仍返回 200（**不支持 304**），
  因此每次刷新目录的固定成本就是这 253KB。
- 实测 5 个候选 manifest 路径（`/directory/zh/manifest.json`、`/directory/zh/index.json`、
  `/directory/manifest.zh.json`、`/directory/zh.json`、`/_next/static/directory-zh.json`）
  **全部 404** —— 没有官方清单接口。
- 解析分两级：先读 `shardManifest`（`source: "manifest"`），读不到则对整段载荷做
  `/directory/<lang>/<cat>-<page>-<hash>.json` 的 URL 扫描兜底（`source: "url-scan"`，
  分类由文件名推出）。两级都为空时**不伪造空目录**，走 §4 兜底并在界面标降级。

## 2.1 身份键：`repo` 而不是 `slug`

站点数据里 **`slug` 会重名**：单分片 617 条中有 **23 组**重名，`dsh-purge` 同时
属于 4 个不同仓库（yujunzhixue / kingcharleslzy-ai / mmparko / …）；而 `repo`
（`owner/repo`）在同一分片内实测 **0 重复**。

因此目录库主键、排序兜底列、游标身份、curated 合并键**一律用 `repo`**。用 slug
做主键时 `insert … on conflict(slug)` 会静默覆盖同名的其它仓库（实测 12 条夹具
只入库 11 条，且没有任何报错）。

## 2.2 详情页独有的字段（列表页没有）

详情页载荷里的插件记录对象（用锚点 `"install":{"type"` 定位，实测该串在整段载荷里
只出现一次）提供：`version`（如 `v1.1.85`）、`install.type`（`github`/`npm`）、
`install.command`（准确安装命令）、`install.webInstallable`、
`compatibility.dshTarget`（站点标注的 DSH 目标版本）、`compatibility.status`、
`compatibility.platforms`、`manualInstallReason`。

**列表分片里没有版本号与安装命令**，所以「已装项是否落后」的精确判定只能按需拉
详情页（每个已装插件一次，约 152KB），或在 curated API 交集里取 `vr` tag。

## 3. 增强来源

| 来源 | 规模 | 提供 |
|---|---|---|
| `https://api.dsh-plugin.org/plugins.zh.json`（`plugins.en.json` 同构） | **5,809** 条 / 4.16 MB | 短键载荷：`s`/`o`/`n`/`vr`(版本 tag)/`c`/`t`/`f`/`d`/`r{repo,npmPackage}`/`ic`(npm 安装命令)/`igc`(github 安装命令)/`v`/`u`/`a`/`sg`/`fk` |
| `https://api.dsh-plugin.org/stats.json` | 31 B | `{"total":5809,"verified":5809}` |
| 详情页 `https://dsh-plugin.org/zh/plugins/<owner>/<slug>` | ~152 KB/页 | 精确版本与安装命令（按需，24h 缓存） |

`api.dsh-plugin.org` 两个端点均为 `max-age=0, must-revalidate` + ETag，支持条件 GET。

**两套目录的关系**：curated API（5,809）是官网的子集，官方插件 `dsh-plugin-hub`
用的就是它；本项目以分片全集（19,866）为主档，用 curated API 补齐版本与安装命令，
两者按 `source.repo` 归并。

## 4. 兜底通道

`https://dsh-plugin.org/sitemaps/plugins.xml` → 15 个分片
（`/sitemaps/plugins/<n>.xml`，实测单片 971,368 B / 2,000 URL）→ 19,866 条详情页 URL。
只有 slug 与仓库身份，没有描述。索引页载荷解析失败时用它枚举，并在界面标注 degraded。

## 5. 归并口径

1. **身份键 `repo`**（见 §2.1）；`slug` 只用于展示与详情页 URL 的路径段。
2. 安装命令生成顺序：详情页 `install.command`（最准）→ curated `ic`/`igc` →
   `source.npmPackage` 拼 `dsh plugin --profile <p> add <npmPackage>` →
   否则 `dsh plugin --profile <p> add github:<repo>`。**不猜版本号**。
3. 版本信号优先级（更新判据）：详情页 `version` > registry `dist-tags.latest` >
   git `ls-remote` 默认分支 commit > 目录 `repoUpdatedAt` > 未知（标 `unknown`）。
4. curated 合并按 `repo` 且**只并入目录里已存在的行**；落空的条目计入
   `sync_state.curated_orphans` 并在状态里如实暴露，不静默丢弃。
5. 拿不到的一律留空；界面显示 `—`，不以默认值或推算值填充。

## 6. 出网纪律

打开面板不联网检查更新。出网只发生在：刷新目录、检查更新、安装/卸载、首次无缓存进入市场页。
会访问的域名：`dsh-plugin.org`、`api.dsh-plugin.org`、npm registry（可配置镜像）、
`github.com`（`git ls-remote`）。新增出网点必须同步更新 README 与本节。

## 6.1 站点没有查询接口（实测）

想「实时按需取数」就必须先知道站点能回答什么。逐项实测：

| 请求 | 结果 |
|---|---|
| `/zh/plugins` 与 `/zh/plugins?q=dsh-purge` | **byte 相同**（md5 一致，均 253,455 B）—— 查询参数不产生服务端过滤 |
| `/api/search?q=…`、`/zh/api/plugins?q=…`、`/search?q=…`、`/api/plugins.json` | 404 |
| `/directory/zh/search.json`、`/directory/zh/index.json` | 404 |
| 索引页 HTML 里出现的 `/(api|search)…` 端点 | **0 个** |

结论：站点的搜索是**纯客户端**的（浏览器把分片下全再过滤）。因此在这个数据源上
「按需实时查询」并不存在：要么下全量（19.0MB / 37 分片），要么只用 curated 子集
（4.16MB / 5,809 条，覆盖 29%）。

## 6.2 本地索引的体积构成（实测）

同一份 19,866 行数据，三种形态：

| 形态 | 体积 | 说明 |
|---|---|---|
| A. 完整（行 + `haystack` + FTS5 trigram） | **55.0MB** | `plugins` 25.7MB、`plugins_search_data`（trigram 索引）24.2MB、其余索引约 4.2MB |
| B. 去掉检索索引 | **20.3MB** | trigram + haystack 合计约 34.7MB |
| C. 只留最小展示字段（无描述/特性/标签、无索引） | **5.4MB** | 19,866 行仍在，但没有全文检索 |

即：**体积的大头是我们自己的检索索引，而不是站点数据**（数据本身 5.4MB）。
复现脚本：`scripts/verify-catalog-size.mjs --network`。取舍见
`docs/ARCHITECTURE.md` 的「本地索引 vs 直连」。

## 7. 检索口径（实测）

- 索引是 **FTS5 external content + `tokenize='trigram'`**，内容来自 `plugins.haystack`
  （小写拼接 `name` / `display_name` / `description` / `features` / `topics` / `repo`），
  由触发器随行维护。
- **trigram 与 LIKE 命中数逐条一致**（实测 1269/1269、14/14、25/25），因此在
  3 字符及以上用索引是安全的；实测 `MATCH` 0.1–0.2ms，整次查询（count + 分页 + 分面）
  中位数 **12.5ms**。
- **1–2 字查询无法走 trigram**（按三字滑窗，实测「微信」命中 0），退回单列
  `haystack LIKE`：语义与长查询一致（实测「微信」207 条），代价约 **86ms/次**
  （一次性；分面结果按搜索词缓存后，后续分页不再重复扫描）。
- 分面（分类 / 语言 / 兼容状态）**一次 `group by` 扫描**算出并在内存里按搜索词缓存
  （上限 8 个词），任何写入即失效 —— 早先三条独立 `group by` 让一次请求扫 5 遍，
  真实数据上实测 126ms/次。