/**
 * 插件港湾共享类型。
 *
 * 口径（AGENTS.md）：**拿不到就留空，不填默认值、不推算**。因此这里的字段
 * 大多是可选；界面遇到 undefined 一律显示 `—`。
 */

/** 存储 worker 的存活报告：路径、SQLite 版本与已建表数。 */
export interface StorePing {
  path: string;
  sqlite: string;
  tables: number;
}

/** `status` 方法的返回：宿主身份与存储连通性。 */
export interface PluginStatus {
  plugin: string;
  version: string;
  /**
   * 宿主侧构建标识（源码内容哈希）。
   *
   * 面板拿自己的同一个值比对：不等就说明**界面已是新构建、宿主里运行的是旧构建**
   * （客户端 bundle 是页面加载时从磁盘现取的，宿主侧要等重启或一次 profile 重新组合）。
   */
  build: string;
  profile: string;
  dataDir: string;
  dbPath: string;
  store: StorePing;
  /**
   * 宿主是否提供热重载服务（`hmr`）：为 true 时安装/更新/启停/热重载由宿主原地生效，
   * 不需要重启 DSH；为 false 时宿主会回 `restart-required`。
   */
  hot: boolean;
}

/** 目录同步状态。 */
export interface CatalogStatus {
  rows: number;
  /** 已入库的分片数。 */
  chunks: number;
  /** 站点自报的收录总数（读不到为 null，不填 0）。 */
  totalCount: number | null;
  lastSyncAt: number | null;
  /** 上次同步的失败原因；为 null 表示最近一次同步没有失败项。 */
  error: string | null;
  /** 是否有一次同步正在进行。 */
  syncing: boolean;
  /** curated 增强里落不进目录的条目数（如实暴露，不静默丢弃）。 */
  curatedOrphans: number;
  /** 已完成的最小可用里程碑（M0 骨架 → M1 数据管道）。 */
  milestone: string;
}

/** 设置项。默认值只用于界面显示，不作为目录或版本判断的依据。 */
export interface CenterSettings {
  locale: "zh" | "en";
  syncTtlMs: number;
  /** 官网基址；可在设置里指向镜像。 */
  siteBase: string;
  /** API 中心基址。 */
  apiBase: string;
  registry: string;
  proxy: string;
  /**
   * 读取设置时被退回默认值的字段说明（坏字段逐项退回，原因如实显示）。
   * 保存成功后为空数组。
   */
  notes?: string[];
}

/** 官网目录分片（`/directory/<lang>/<category>-<page>-<hash>.json`）的一条记录。 */
export interface CatalogRow {
  slug: string;
  owner: string;
  name: string;
  displayName: string;
  category: string;
  topics: string[];
  features: string[];
  description: string;
  /** 站点给出的页面主标题（`h1`）。 */
  h1: string;
  /** `owner/repo`；分片记录必有，缺失的记录会被丢弃。 */
  repo: string;
  /** npm 包名；站点可能给空串。 */
  npmPackage: string;
  /** `verified` / `unconfirmed`。 */
  status: string;
  repoCreatedAt: string;
  /** 仓库最近推送时间：没有 release 的仓库靠它判断「有没有新提交」。 */
  repoUpdatedAt: string;
  addedAt: string;
  pageUpdatedAt: string;
  stars: number;
  forks: number;
  language: string;
  license: string;
  dshTopic: boolean;
}

/** 清单里的一个分片引用（哈希即内容指纹）。 */
export interface ChunkRef {
  url: string;
  lang: string;
  category: string;
  page: number;
  hash: string;
}

/** 索引页载荷给出的分片清单 + 站点自报的计数。 */
export interface ShardManifest {
  lang: string;
  chunks: ChunkRef[];
  /** 站点自报的收录总数（`sidebarStats.totalCount`），读不到则 undefined。 */
  totalCount?: number;
  /** 站点自报的分类计数。 */
  categoryCounts?: Record<string, number>;
  /** 清单来自 `shardManifest` 字段还是 URL 正则兜底。 */
  source: "manifest" | "url-scan";
}

/** curated API（短键载荷）里与分片相交的增强字段。 */
export interface CuratedRecord {
  slug: string;
  repo: string;
  npmPackage: string;
  /** 版本 tag，如 `v1.1.85`；站点只对部分记录下发。 */
  versionTag?: string;
  installNpm?: string;
  installGit?: string;
  stars?: number;
  forks?: number;
  updatedAt?: string;
}

/** 详情页载荷里与安装/兼容相关的精确事实。 */
export interface DetailRecord {
  slug: string;
  repo: string;
  npmPackage: string;
  /** 精确版本（如 `v1.1.85`）；站点未下发则 undefined。 */
  version?: string;
  installType?: string;
  /** 站点给出的准确安装命令。 */
  installCommand?: string;
  webInstallable?: boolean;
  /** 站点标注的 DSH 目标版本（如 `rc.6`），空串表示站点未标注。 */
  dshTarget?: string;
  status?: string;
  platforms?: string[];
  /** 站点说明「为什么不能一键装」的原因，例如需要手工重启后 Apply。 */
  manualInstallReason?: string;
}

/** 一次同步的取数计划。 */
export interface SyncPlan {
  /** 需要下载的分片（文件名哈希在本地不存在或已变化）。 */
  fetch: ChunkRef[];
  /** 本地已有且哈希未变、本次跳过的分片数。 */
  skipped: number;
  /** 本地有、但清单里已消失的分片 URL：其行需要清理。 */
  remove: string[];
}

/** `catalog.list` 的查询参数。 */
export interface CatalogQuery {
  q?: string;
  category?: string;
  /** `stars` / `updated` / `added` / `name`。 */
  sort?: string;
  /** `installed` / `not-installed`；由 M2 的已装表驱动，M1 只用 `all`。 */
  installed?: string;
  language?: string;
  status?: string;
  /** 游标：上一页最后一条的排序键与身份（`owner/repo`，不是 slug）。 */
  cursor?: { key: string; repo: string };
  limit?: number;
}

/** `catalog.list` 的返回：一页行 + 总数 + 分面计数。 */
export interface CatalogPage {
  rows: CatalogRow[];
  total: number;
  facets: {
    category: Record<string, number>;
    language: Record<string, number>;
    status: Record<string, number>;
  };
  nextCursor: { key: string; repo: string } | null;
}

/**
 * 已装插件的事实（只读采集，见 `core/installed.ts`）。
 *
 * 拿不到的字段一律可选；判定「有没有更新」时必须先看得到的东西够不够，
 * 不够就标 `unknown`，不用目录信号或版本号推算。
 */
export interface InstalledPlugin {
  /** profile `dependencies` 里的键。 */
  name: string;
  /** 已装包自己声明的名字；与依赖键不同时（别名安装在别的键下）拼地址要用。 */
  packageName?: string;
  /** 声明用的 spec（`github:owner/repo` / `^1.9.28` / `file:…`）。 */
  spec: string;
  /** spec 形态。 */
  kind: "registry" | "git" | "path" | "tarball" | "unknown";
  /** 磁盘上那份包的版本。 */
  version?: string;
  /** 从 `repository` 或 spec 反查的 `owner/repo`。 */
  repo?: string;
  /** lockfile 里解析到的 git commit（仅 git 形态）。 */
  commit?: string;
  /** lockfile 里的 integrity（registry / tarball 形态）。 */
  integrity?: string;
  /** 是否在 `dsh.profile.bundles` 里被选中。 */
  selected: boolean;
  /** 包是否真的在磁盘上。 */
  present: boolean;
  /** 是否自带 bundle patch（`dsh.bundle.patch`）。 */
  bundle: boolean;
  /** 是否带浏览器界面（`dsh.client`）。 */
  hasClient: boolean;
}

/** 一次更新判定的结果。`updateAvailable` 为 null 表示**判不了**（不是「已最新」）。 */
export interface UpdateCheck {
  name: string;
  repo?: string;
  /** 声明 spec（展示用）。 */
  spec?: string;
  kind: InstalledPlugin["kind"];
  installedVersion?: string;
  installedCommit?: string;
  latestVersion?: string;
  latestCommit?: string;
  /** 最新值的来源：registry / git / detail / catalog。 */
  latestSource?: "registry" | "git" | "detail" | "catalog";
  updateAvailable: boolean | null;
  /** 判定失败的原因（网络、git 缺失、版本不可比…），供界面如实显示。 */
  error?: string;
  /** 非失败的中性说明（例如「本地路径安装，没有远端可比」）。 */
  note?: string;
  checkedAt: number;
}

/** 已装页一行：已装事实 + 目录信息 + 更新结论。 */
export interface InstalledRow extends InstalledPlugin {
  /** 目录里这一行的展示名（没有则 undefined）。 */
  displayName?: string;
  category?: string;
  /**
   * 目录里这一行的 slug 与 owner：拼**站点详情页**地址要用（`/<lang>/plugins/<owner>/<slug>`）。
   *
   * ⚠️ 不能用 `repo` 拼：详情页的路径段是 owner + **slug**，而 slug 会重名（见
   * `docs/DATA-SOURCES.md` §2.1），所以这两个值必须来自目录行本身，不能从 repo 里切。
   */
  slug?: string;
  owner?: string;
  /** 站点的精确版本与安装命令（按需拉详情页才有）。 */
  detailVersion?: string;
  installCommand?: string;
  /** 站点标注的 DSH 目标版本。 */
  dshTarget?: string;
  stars?: number;
  /** 缓存的更新结论。 */
  update?: UpdateCheck;
}