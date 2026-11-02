/**
 * 官网目录分片清单与单条记录的读取口径。
 *
 * 分片 URL 形如 `/directory/<lang>/<category>-<page>-<hash>.json`，文件名里的
 * 8 位哈希就是内容指纹（站点对该路径给出 `immutable` 一年缓存 + ETag，
 * 条件 GET 实测 304/0 字节），因此「本地已有同哈希」＝不需要再下载。
 */
import {
  extractFlightPayload,
  findObjectEnd,
  findObjectStart,
  findOutsideString,
  readJsonObjectAfter,
  stringMask,
} from "./flight.ts";
import type {
  CatalogRow,
  ChunkRef,
  CuratedRecord,
  DetailRecord,
  ShardManifest,
} from "./types.ts";

/** `/directory/<lang>/<category>-<page>-<hash>.json` */
const CHUNK_URL = /\/directory\/([a-z]{2})\/([a-z]+)-(\d+)-([0-9a-f]{8})\.json/g;

/** 从分片 URL 拆出分类 / 页码 / 哈希；不匹配返回 undefined。 */
export function parseChunkUrl(url: string): ChunkRef | undefined {
  const match =
    /\/directory\/([a-z]{2})\/([a-z]+)-(\d+)-([0-9a-f]{8})\.json$/.exec(url);
  if (!match) return undefined;
  const page = Number(match[3]);
  // 页码从 1 开始：`<category>-0-<hash>.json` 不是站点会生成的路径。
  if (page < 1) return undefined;
  return {
    url,
    lang: match[1]!,
    category: match[2]!,
    page,
    hash: match[4]!,
  };
}

interface SidebarStats {
  totalCount?: number;
  categoryCounts?: Record<string, number>;
}

/**
 * 读索引页（`/<lang>/plugins`）的分片清单。
 *
 * 两级：先取 `"shardManifest":{…}`（站点自报的清单，含分类）；取不到时退回
 * 对整段载荷做 URL 扫描 —— 站点改了字段名也能继续工作，只是分类由文件名推出，
 * `source` 会标成 `url-scan` 供调用方在界面上注明降级。
 *
 * ⚠️ 两种情况都读不到分片时返回空清单，**不要**在这里伪造空目录：调用方必须
 * 走 sitemap 兜底或如实报错（AGENTS.md 的数据来源纪律）。
 */
export function readShardManifest(payload: string, lang: string): ShardManifest {
  const stats = readJsonObjectAfter(payload, "sidebarStats") as
    | SidebarStats
    | undefined;
  const declared = readJsonObjectAfter(payload, "shardManifest") as
    | Record<string, string[]>
    | undefined;
  const chunks: ChunkRef[] = [];
  const push = (url: unknown) => {
    if (typeof url !== "string") return;
    const ref = parseChunkUrl(url);
    if (ref && !chunks.some((entry) => entry.url === ref.url)) chunks.push(ref);
  };
  if (declared && typeof declared === "object")
    for (const urls of Object.values(declared))
      if (Array.isArray(urls)) for (const url of urls) push(url);
  const source: ShardManifest["source"] =
    chunks.length > 0 ? "manifest" : "url-scan";
  if (chunks.length === 0)
    for (const match of payload.matchAll(CHUNK_URL)) push(match[0]);
  chunks.sort((a, b) =>
    a.category === b.category
      ? a.page - b.page
      : a.category.localeCompare(b.category),
  );
  return {
    lang,
    chunks,
    totalCount:
      typeof stats?.totalCount === "number" ? stats.totalCount : undefined,
    categoryCounts:
      stats?.categoryCounts && typeof stats.categoryCounts === "object"
        ? stats.categoryCounts
        : undefined,
    source,
  };
}

/** 索引页 HTML → 分片清单（内部完成 Flight 解析）。 */
export function readShardManifestFromHtml(
  html: string,
  lang: string,
): ShardManifest {
  return readShardManifest(extractFlightPayload(html), lang);
}

const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

const list = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/**
 * 分片记录 → 目录行。
 *
 * 容错口径：`slug` 或 `source.repo` 缺失即丢弃该条（没有主键或来源的行既装不了
 * 也判不了更新）；其余字段缺失一律留空串 / 0，**不补默认值**。
 */
export function normalizeShardRecord(raw: unknown): CatalogRow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, any>;
  const slug = text(record.slug);
  const repo = text(record.source?.repo);
  if (slug === "" || repo === "") return undefined;
  const dates = record.dates ?? {};
  const stats = record.stats ?? {};
  const metadata = record.metadata ?? {};
  return {
    slug,
    owner: text(record.ownerSlug),
    name: text(record.name) || slug,
    displayName: text(record.displayName) || text(record.name) || slug,
    category: text(record.category),
    topics: list(record.topics),
    features: list(record.features),
    description: text(record.description),
    h1: text(record.h1),
    repo,
    npmPackage: text(record.source?.npmPackage),
    status: text(record.compatibility?.status),
    repoCreatedAt: text(dates.repoCreatedAt),
    repoUpdatedAt: text(dates.repoUpdatedAt),
    addedAt: text(dates.addedAt),
    pageUpdatedAt: text(dates.pageUpdatedAt),
    stars: num(stats.stargazers_count),
    forks: num(stats.forks_count),
    language: text(metadata.language),
    license: text(metadata.license),
    dshTopic: metadata.dshTopic === true,
  };
}

/** 分片正文（JSON 数组）→ 目录行。 */
export function normalizeShardBody(body: string): CatalogRow[] {
  const parsed: unknown = JSON.parse(body);
  if (!Array.isArray(parsed)) throw Error("分片不是 JSON 数组");
  const rows: CatalogRow[] = [];
  for (const item of parsed) {
    const row = normalizeShardRecord(item);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * curated API 记录（短键）→ 增强字段。
 *
 * ⚠️ 这份载荷用短键（`s`/`o`/`n`/`vr`/`r`/`ic`/`igc`…），与分片的全名字段
 * 完全不同名，**不能**用同一个归一化函数（本轮实测：把 curated 记录喂给分片
 * 归一化器时，`name`/`description` 全是 undefined，因为那条路径读的是 `n`/`d`）。
 */
export function normalizeCuratedRecord(
  raw: unknown,
): CuratedRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, any>;
  const slug = text(record.s);
  const repo = text(record.r?.repo);
  if (slug === "" || repo === "") return undefined;
  const out: CuratedRecord = {
    slug,
    repo,
    npmPackage: text(record.r?.npmPackage),
  };
  const versionTag = text(record.vr);
  if (versionTag !== "") out.versionTag = versionTag;
  const installNpm = text(record.ic);
  if (installNpm !== "") out.installNpm = installNpm;
  const installGit = text(record.igc);
  if (installGit !== "") out.installGit = installGit;
  if (typeof record.sg === "number") out.stars = record.sg;
  if (typeof record.fk === "number") out.forks = record.fk;
  const updatedAt = text(record.u);
  if (updatedAt !== "") out.updatedAt = updatedAt;
  return out;
}

/** curated API 正文（JSON 数组）→ 增强字段列表。 */
export function normalizeCuratedBody(body: string): CuratedRecord[] {
  const parsed: unknown = JSON.parse(body);
  const items = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as any)?.plugins)
      ? (parsed as any).plugins
      : [];
  const out: CuratedRecord[] = [];
  for (const item of items) {
    const record = normalizeCuratedRecord(item);
    if (record) out.push(record);
  }
  return out;
}

/**
 * 取出详情页载荷里那个「插件记录对象」的原文与解析结果。
 *
 * ⚠️ 锚点必须是 `"install":{"type"`，**不能**用 `"slug"` 或 `"type"`：详情页
 * 实测 `"slug":"dsh-purge"` 出现 3 次（还出现在相邻插件的列表项里），而
 * `"type"` 会被页面里的 JSON-LD 抢先命中（本轮实测：`install.type` 读成了
 * `application/ld+json`）。`"install":{"type"` 在整段载荷里只出现一次。
 */
export function extractPluginRecord(
  payload: string,
): { text: string; record: Record<string, any> } | undefined {
  const mask = stringMask(payload);
  const anchor =
    findOutsideString(payload, '"install":{"type"', mask) ??
    findOutsideString(payload, '"install":{', mask);
  if (anchor === undefined) return undefined;
  const start = findObjectStart(payload, anchor, mask);
  if (start === undefined) return undefined;
  const end = findObjectEnd(payload, start, mask);
  if (end === undefined) return undefined;
  const slice = payload.slice(start, end + 1);
  try {
    return { text: slice, record: JSON.parse(slice) as Record<string, any> };
  } catch {
    return undefined;
  }
}

/**
 * 详情页载荷 → 精确事实。
 *
 * 站点在详情页给出**列表页没有**的字段（实测）：`version`（如 `v1.1.85`）、
 * `install.command`（准确安装命令）、`install.type`（npm/github）、
 * `compatibility.dshTarget`（站点标注的 DSH 目标版本）与 `manualInstallReason`
 * （为什么不能一键装）。因此精确版本只能按需从这里取，不能从列表页推。
 */
export function readDetailRecord(payload: string): DetailRecord | undefined {
  const extracted = extractPluginRecord(payload);
  if (!extracted) return undefined;
  const record = extracted.record;
  const slug = text(record.slug);
  const repo = text(record.source?.repo);
  if (slug === "" || repo === "") return undefined;
  const out: DetailRecord = {
    slug,
    repo,
    npmPackage: text(record.source?.npmPackage),
  };
  const version = text(record.version);
  if (version !== "") out.version = version;
  const installType = text(record.install?.type);
  if (installType !== "") out.installType = installType;
  const command = text(record.install?.command);
  if (command !== "") out.installCommand = command;
  if (typeof record.install?.webInstallable === "boolean")
    out.webInstallable = record.install.webInstallable;
  if (typeof record.compatibility?.dshTarget === "string")
    out.dshTarget = record.compatibility.dshTarget;
  const status = text(record.compatibility?.status);
  if (status !== "") out.status = status;
  if (Array.isArray(record.compatibility?.platforms))
    out.platforms = list(record.compatibility.platforms);
  const reason = text(record.manualInstallReason);
  if (reason !== "") out.manualInstallReason = reason;
  return out;
}

/** 详情页 HTML → 精确事实。 */
export function readDetailRecordFromHtml(
  html: string,
): DetailRecord | undefined {
  return readDetailRecord(extractFlightPayload(html));
}

/**
 * sitemap 兜底通道：从 `sitemaps/plugins/<n>.xml` 里取出详情页 URL。
 *
 * 只有 slug 与仓库身份，没有描述，因此仅在索引页载荷解析失败时使用，并在界面
 * 标注降级（`degraded`）。
 */
export function readSitemapLocations(xml: string): string[] {
  const out: string[] = [];
  for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const url = match[1]!.trim();
    if (url !== "" && !out.includes(url)) out.push(url);
  }
  return out;
}