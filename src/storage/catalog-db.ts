/**
 * 目录库（SQLite）——查询层。
 *
 * ⚠️ 为什么把它与 worker 分开：这一层是**纯函数式**的（只依赖一个 DatabaseSync
 * 句柄），因此可以用 `:memory:` 在夹具测试里直接跑真实 SQL，而不必起线程、写
 * 消息协议。worker 只做消息适配（见 `worker.ts`）。
 *
 * 存储是旁路：这里不联网、不抛「业务错误」以外的异常；调用方（客户端）负责
 * 超时与 `failedWrites` 记账。
 *
 * 搜索用 `LIKE` 而不是 FTS5：实测 19,744 行三字段 `LIKE` 为 **8ms**（预算
 * ≤30ms），而 FTS5 需要第二张表与其同步维护。本机 FTS5 可用（已实测），
 * 一旦行数或查询复杂度让 P95 越过预算，再按 `plugins_fts` 升级。
 */
import { DatabaseSync } from "node:sqlite";
import { normalizeCuratedBody, normalizeShardBody } from "../core/site.ts";
import type {
  CatalogPage,
  CatalogQuery,
  CatalogRow,
  ChunkRef,
  UpdateCheck,
} from "../core/types.ts";
import type { OpTask } from "../ops/types.ts";

/** 目录行 → 库中扁平列。数组字段按 JSON 存，读回时再解析。 */
const COLUMNS = [
  "repo",
  "slug",
  "owner",
  "name",
  "display_name",
  "category",
  "topics",
  "features",
  "description",
  "h1",
  "repo",
  "npm_package",
  "status",
  "repo_created_at",
  "repo_updated_at",
  "added_at",
  "page_updated_at",
  "stars",
  "forks",
  "language",
  "license",
  "dsh_topic",
  "ver_tag",
  "install_npm",
  "install_git",
  "chunk_url",
  "synced_at",
] as const;

/** 由分片记录写入的列（不含 curated 增强列，避免覆盖已合并的值）。 */
const SHARD_COLUMNS = COLUMNS.filter(
  (column) =>
    !["ver_tag", "install_npm", "install_git", "chunk_url", "synced_at"].includes(
      column,
    ),
);

/** 排序口径：列、方向、是否数值。别名固定用 `(sortKey, slug)` 做稳定游标。 */
const SORTS: Record<
  string,
  { column: string; direction: "asc" | "desc"; numeric: boolean }
> = {
  stars: { column: "stars", direction: "desc", numeric: true },
  updated: { column: "repo_updated_at", direction: "desc", numeric: false },
  added: { column: "added_at", direction: "desc", numeric: false },
  name: { column: "name", direction: "asc", numeric: false },
};

export const DEFAULT_SORT = "stars";
export const MAX_LIMIT = 50;
/** 搜索词上限：超长输入只会拖慢查询，截断而不是拒绝。 */
const MAX_QUERY_CHARS = 80;

export interface CatalogCounts {
  rows: number;
  chunks: number;
  totalCount: number | null;
  lastSyncAt: number | null;
  lastError: string | null;
  curatedOrphans: number;
}

export class CatalogDb {
  readonly db: DatabaseSync;
  /**
   * 分面计数缓存（键＝搜索词）。
   *
   * 分面只依赖搜索词，却被每个分页请求重算：一次 `catalog.list` 原本要跑
   * count + rows + 3 个 GROUP BY，共 **5 遍**全文扫描（真实站点实测 126ms/次）。
   * 任何写入都会清空缓存。
   */
  #facetsCache = new Map<string, CatalogPage["facets"]>();
  /** 缓存条数上限：搜索词换来换去时只保留最近的几个。 */
  static readonly FACETS_CACHE_LIMIT = 8;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("pragma journal_mode = wal");
    this.db.exec("pragma busy_timeout = 5000");
    this.#migrate();
  }

  #migrate(): void {
    /**
     * 主键是 `repo`（`owner/repo`），**不是** `slug`。
     *
     * ⚠️ 真实缺陷（夹具测试抓到）：站点数据里 slug 会重名 —— 单分片 617 条中
     * 有 23 组重名，`dsh-purge` 同时属于 4 个不同仓库。按 slug 做主键时
     * `insert ... on conflict(slug)` 会把后来的仓库覆盖掉，12 条夹具只入库 11 条，
     * 而且**完全静默**。repo 在同一分片内实测 0 重复，才是正确身份。
     *
     * 早期 alpha 可能已建过错主键的表：目录只是站点数据的缓存，可直接重建。
     */
    const existing = this.db
      .prepare(
        "select sql from sqlite_master where type = 'table' and name = 'plugins'",
      )
      .get() as { sql?: string } | undefined;
    if (
      existing?.sql &&
      (!/repo\s+text\s+primary\s+key/i.test(existing.sql) ||
        !/haystack/i.test(existing.sql))
    ) {
      this.db.exec(
        "drop table if exists plugins; drop table if exists chunks; drop table if exists plugins_search;",
      );
    }
    /**
     * 详情页缓存与更新结论都是**可重建的缓存**：结构升级时直接丢弃重建，
     * 不做数据迁移（`plugins` 里新增 detail 两列同理，见上）。
     */
    const cache = this.db
      .prepare(
        "select sql from sqlite_master where type = 'table' and name = 'installed_cache'",
      )
      .get() as { sql?: string } | undefined;
    if (cache?.sql && !/latest_commit/i.test(cache.sql))
      this.db.exec("drop table if exists installed_cache;");
    this.db.exec(`
      create table if not exists plugins (
        repo text primary key,
        slug text not null default '',
        owner text not null default '',
        name text not null default '',
        display_name text not null default '',
        category text not null default '',
        topics text not null default '[]',
        features text not null default '[]',
        description text not null default '',
        h1 text not null default '',
        npm_package text not null default '',
        status text not null default '',
        repo_created_at text not null default '',
        repo_updated_at text not null default '',
        added_at text not null default '',
        page_updated_at text not null default '',
        stars integer not null default 0,
        forks integer not null default 0,
        language text not null default '',
        license text not null default '',
        dsh_topic integer not null default 0,
        ver_tag text,
        install_npm text,
        install_git text,
        -- 检索用的小写拼接文本：内容必须与 FTS 索引表一致（同一个 searchText()）
        haystack text not null default '',
        -- 详情页按需抓取的原始记录（站点精确版本 / 安装命令 / dshTarget）
        detail_json text,
        detail_at integer,
        chunk_url text not null default '',
        synced_at integer not null default 0
      );
      create table if not exists chunks (
        url text primary key,
        lang text not null default '',
        category text not null default '',
        page integer not null default 0,
        hash text not null default '',
        rows integer not null default 0,
        fetched_at integer not null default 0
      );
      create table if not exists sync_state (
        lang text primary key,
        index_etag text,
        total_count integer,
        last_sync_at integer,
        last_error text,
        curated_orphans integer not null default 0
      );
      create table if not exists installed_cache (
        name text primary key,
        kind text,
        spec text,
        repo text,
        version text,
        commit_sha text,
        latest_version text,
        latest_commit text,
        latest_source text,
        -- null = 判不了（不是「已最新」）
        update_available integer,
        note text,
        error text,
        checked_at integer
      );
      /*
       * 操作记录。队列是运行态的权威，这张表只存终态（含失败的）供「操作页」
       * 跨重启回看；log_tail 只留最后若干行，避免把 pnpm 全文写进库里。
       */
      create table if not exists ops (
        id text primary key,
        kind text not null,
        target text not null,
        spec text,
        /** 实际交给 pnpm 的地址（更新时与 spec 不同：spec 是记的范围）。 */
        install_spec text,
        status text not null,
        progress integer,
        via text,
        note text,
        error text,
        needs_restart integer not null default 0,
        log_tail text,
        queued_at integer,
        started_at integer,
        ended_at integer
      );
      create index if not exists ops_ended on ops(ended_at desc);
      create index if not exists plugins_slug on plugins(slug);
      create index if not exists plugins_category on plugins(category);
      create index if not exists plugins_language on plugins(language);
      create index if not exists plugins_status on plugins(status);
      create index if not exists plugins_stars on plugins(stars desc, repo asc);
      create index if not exists plugins_updated on plugins(repo_updated_at desc, repo asc);
      create index if not exists plugins_added on plugins(added_at desc, repo asc);
    `);
    /**
     * `ops.install_spec` 是后加的列。与目录表不同，操作历史是**用户自己的记录**，
     * 不重建、只补列（`alter table` 是纯加法，老行留空）。
     */
    const opsTable = this.db
      .prepare("select sql from sqlite_master where type = 'table' and name = 'ops'")
      .get() as { sql?: string } | undefined;
    if (opsTable?.sql && !/install_spec/i.test(opsTable.sql))
      this.db.exec("alter table ops add column install_spec text");
    /**
     * 检索索引：FTS5 **trigram** 分词 + **external content**（内容取自 plugins）。
     *
     * ⚠️ 为什么不用默认的 unicode61：它把连续 CJK 当成一个整词，搜「上下文」
     * 匹配不到「上下文可视化」这类连写文本；trigram 是子串语义，实测与 LIKE
     * 命中数逐条一致（1269/1269、14/14、25/25）。
     *
     * ⚠️ 为什么必须走 external content + 触发器：早先的实现按 repo 逐行
     * `delete from plugins_search where repo = ?`，而 repo 是 FTS5 的
     * **UNINDEXED 列**，删除等于全表扫描 —— 实测写入 20,000 行从 220ms
     * 退化到 20.6s。改成 external content 后索引随 plugins 的增删改由触发器
     * 维护（`delete` 走 rowid 索引），写入路径不需要任何额外语句。
     *
     * ⚠️ trigram 的代价是**少于 3 个字符的查询无法命中**（实测「微信」命中 0），
     * 因此 1–2 字查询走 `name/display_name` 的 LIKE 快路径（见 `#filters`）。
     */
    const hasSearch =
      this.db
        .prepare(
          "select count(*) as n from sqlite_master where name = 'plugins_search'",
        )
        .get() as { n: number | bigint };
    this.db.exec(`
      create virtual table if not exists plugins_search using fts5(
        haystack,
        content='plugins',
        content_rowid='rowid',
        tokenize='trigram'
      );
      create trigger if not exists plugins_search_ai after insert on plugins begin
        insert into plugins_search(rowid, haystack) values (new.rowid, new.haystack);
      end;
      create trigger if not exists plugins_search_ad after delete on plugins begin
        insert into plugins_search(plugins_search, rowid, haystack)
          values ('delete', old.rowid, old.haystack);
      end;
      create trigger if not exists plugins_search_au after update on plugins begin
        insert into plugins_search(plugins_search, rowid, haystack)
          values ('delete', old.rowid, old.haystack);
        insert into plugins_search(rowid, haystack) values (new.rowid, new.haystack);
      end;
    `);
    // 首次为本库建索引（或索引与内容表失配时重建）。
    if (Number(hasSearch.n) === 0)
      this.db.exec("insert into plugins_search(plugins_search) values('rebuild')");
  }

  get meta(): { tables: number; sqlite: string } {
    const version = this.db
      .prepare("select sqlite_version() as v")
      .get() as { v: string };
    const tables = this.db
      .prepare("select count(*) as n from sqlite_master where type = 'table'")
      .get() as { n: number | bigint };
    return { tables: Number(tables.n), sqlite: version.v };
  }

  /** 本地已入库的分片（供 `planSync` 比对哈希）。 */
  knownChunks(lang?: string): Map<string, string> {
    const rows = (
      lang === undefined
        ? this.db.prepare("select url, hash from chunks").all()
        : this.db.prepare("select url, hash from chunks where lang = ?").all(lang)
    ) as { url: string; hash: string }[];
    return new Map(rows.map((row) => [row.url, row.hash]));
  }

  /**
   * 写入一个分片：先清掉**该分片此前贡献的行**，再写新行。
   *
   * 之所以按 `chunk_url` 清理而不是按 slug 覆盖：分片是内容寻址的，内容变化会
   * 换 URL，旧 URL 的行必须整片让位，否则被删掉的插件会永远留在库里。
   *
   * ⚠️ 检索索引由 `plugins` 上的触发器维护（external content FTS5），这里**不要**
   * 手工去写 `plugins_search`：早先按 repo 逐行删除会退化成全表扫描（实测
   * 20,000 行写入从 220ms 变成 20.6s）。
   */
  applyChunk(chunk: ChunkRef, body: string, now = Date.now()): number {
    const rows = normalizeShardBody(body);
    const chunkUrl = chunk.url;
    this.db.exec("begin");
    try {
      this.db.prepare("delete from plugins where chunk_url = ?").run(chunkUrl);
      const insert = this.db.prepare(
        `insert into plugins (${SHARD_COLUMNS.join(",")}, haystack, chunk_url, synced_at)
         values (${SHARD_COLUMNS.map(() => "?").join(",")}, ?, ?, ?)
         on conflict(repo) do update set ${SHARD_COLUMNS.map(
           (column) => `${column}=excluded.${column}`,
         ).join(", ")}, haystack=excluded.haystack, chunk_url=excluded.chunk_url, synced_at=excluded.synced_at`,
      );
      for (const row of rows)
        insert.run(
          ...SHARD_COLUMNS.map((column) => shardValue(row, column)),
          searchText(row),
          chunkUrl,
          now,
        );
      this.db
        .prepare(
          `insert into chunks (url, lang, category, page, hash, rows, fetched_at)
           values (?, ?, ?, ?, ?, ?, ?)
           on conflict(url) do update set rows=excluded.rows, fetched_at=excluded.fetched_at`,
        )
        .run(chunk.url, chunk.lang, chunk.category, chunk.page, chunk.hash, rows.length, now);
      this.#facetsCache.clear();
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
    return rows.length;
  }

  /** 清理已从清单里消失的分片及其行（索引由触发器一并清理）。返回清理的行数。 */
  removeChunks(urls: string[]): number {
    if (urls.length === 0) return 0;
    this.db.exec("begin");
    try {
      let removed = 0;
      const delRows = this.db.prepare("delete from plugins where chunk_url = ?");
      const delChunk = this.db.prepare("delete from chunks where url = ?");
      for (const url of urls) {
        removed += Number(delRows.run(url).changes);
        delChunk.run(url);
      }
      this.#facetsCache.clear();
      this.db.exec("commit");
      return removed;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  /**
   * 合并 curated API 的增强字段。
   *
   * 只并入**目录里已存在**的 slug：分片全集是「有哪些插件」的权威，curated 是
   * 子集。落不进目录的条目会被计数（`curated_orphans`）并在状态里如实暴露，
   * 不静默丢弃。
   */
  applyCurated(body: string): { merged: number; orphans: number } {
    const records = normalizeCuratedBody(body);
    let merged = 0;
    let orphans = 0;
    this.db.exec("begin");
    try {
      const update = this.db.prepare(
        `update plugins set
           ver_tag = coalesce(?, ver_tag),
           install_npm = coalesce(?, install_npm),
           install_git = coalesce(?, install_git),
           npm_package = case when ? <> '' then ? else npm_package end
         where repo = ?`,
      );
      for (const record of records) {
        const result = update.run(
          record.versionTag ?? null,
          record.installNpm ?? null,
          record.installGit ?? null,
          record.npmPackage,
          record.npmPackage,
          record.repo,
        );
        if (Number(result.changes) === 0) orphans += 1;
        else merged += 1;
      }
      this.db
        .prepare(
          `insert into sync_state (lang, curated_orphans) values (?, ?)
           on conflict(lang) do update set curated_orphans = excluded.curated_orphans`,
        )
        .run("curated", orphans);
      this.db.exec("commit");
      return { merged, orphans };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  setSyncState(state: {
    lang: string;
    indexEtag?: string;
    totalCount?: number;
    lastSyncAt?: number;
    lastError?: string | null;
  }): void {
    this.db
      .prepare(
        `insert into sync_state (lang, index_etag, total_count, last_sync_at, last_error)
         values (?, ?, ?, ?, ?)
         on conflict(lang) do update set
           index_etag = coalesce(excluded.index_etag, sync_state.index_etag),
           total_count = coalesce(excluded.total_count, sync_state.total_count),
           last_sync_at = coalesce(excluded.last_sync_at, sync_state.last_sync_at),
           last_error = excluded.last_error`,
      )
      .run(
        state.lang,
        state.indexEtag ?? null,
        state.totalCount ?? null,
        state.lastSyncAt ?? null,
        state.lastError === undefined ? null : state.lastError,
      );
  }

  /** 按需抓到的详情页事实写回目录行（缓存，`detail_at` 用于 TTL）。 */
  putDetail(repo: string, record: unknown, now = Date.now()): void {
    this.db
      .prepare("update plugins set detail_json = ?, detail_at = ? where repo = ?")
      .run(JSON.stringify(record), now, repo);
  }

  /** 读若干 repo 的详情缓存；解析失败的条目不返回（当作没有）。 */
  getDetails(repos: string[]): Map<string, { record: any; at: number }> {
    const out = new Map<string, { record: any; at: number }>();
    if (repos.length === 0) return out;
    const rows = this.db
      .prepare(
        `select repo, detail_json, detail_at from plugins where repo in (${repos
          .map(() => "?")
          .join(",")})`,
      )
      .all(...repos) as {
      repo: string;
      detail_json: string | null;
      detail_at: number | null;
    }[];
    for (const row of rows) {
      if (typeof row.detail_json !== "string" || row.detail_json === "") continue;
      try {
        out.set(row.repo, {
          record: JSON.parse(row.detail_json),
          at: Number(row.detail_at ?? 0),
        });
      } catch {
        // 坏缓存当作没有：下次按需重抓
      }
    }
    return out;
  }

  /** 按 repo 取目录行（已装清单与目录合并用）。 */
  rowsByRepo(repos: string[]): Map<string, CatalogRow> {
    const out = new Map<string, CatalogRow>();
    if (repos.length === 0) return out;
    const rows = this.db
      .prepare(
        `select * from plugins where repo in (${repos.map(() => "?").join(",")})`,
      )
      .all(...repos) as Record<string, any>[];
    for (const raw of rows) {
      const row = toRow(raw);
      out.set(row.repo, row);
    }
    return out;
  }

  /** 写入更新结论缓存（`update_available` 为 null 表示判不了，必须原样保留）。 */
  putChecks(checks: UpdateCheck[]): number {
    if (checks.length === 0) return 0;
    const statement = this.db.prepare(
      `insert into installed_cache
         (name, kind, spec, repo, version, commit_sha, latest_version, latest_commit,
          latest_source, update_available, note, error, checked_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(name) do update set
         kind=excluded.kind, spec=excluded.spec, repo=excluded.repo, version=excluded.version,
         commit_sha=excluded.commit_sha, latest_version=excluded.latest_version,
         latest_commit=excluded.latest_commit, latest_source=excluded.latest_source,
         update_available=excluded.update_available, note=excluded.note,
         error=excluded.error, checked_at=excluded.checked_at`,
    );
    this.db.exec("begin");
    try {
      for (const check of checks)
        statement.run(
          check.name,
          check.kind ?? "unknown",
          check.spec ?? null,
          check.repo ?? null,
          check.installedVersion ?? null,
          check.installedCommit ?? null,
          check.latestVersion ?? null,
          check.latestCommit ?? null,
          check.latestSource ?? null,
          check.updateAvailable === null ? null : check.updateAvailable ? 1 : 0,
          check.note ?? null,
          check.error ?? null,
          check.checkedAt,
        );
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
    return checks.length;
  }

  /** 读全部更新结论缓存。 */
  getChecks(): Map<string, UpdateCheck> {
    const rows = this.db
      .prepare("select * from installed_cache")
      .all() as Record<string, any>[];
    const out = new Map<string, UpdateCheck>();
    for (const row of rows) {
      const check: UpdateCheck = {
        name: String(row.name),
        kind: (row.kind ?? "unknown") as UpdateCheck["kind"],
        updateAvailable:
          row.update_available === null || row.update_available === undefined
            ? null
            : Boolean(row.update_available),
        checkedAt: Number(row.checked_at ?? 0),
      };
      for (const [key, column] of [
        ["spec", "spec"],
        ["repo", "repo"],
        ["installedVersion", "version"],
        ["installedCommit", "commit_sha"],
        ["latestVersion", "latest_version"],
        ["latestCommit", "latest_commit"],
        ["latestSource", "latest_source"],
        ["note", "note"],
        ["error", "error"],
      ] as const) {
        const value = row[column];
        if (typeof value === "string" && value !== "")
          (check as any)[key] = value;
      }
      out.set(check.name, check);
    }
    return out;
  }

  /** 写入一条操作记录（终态；同一 id 覆盖）。 */
  putOp(task: OpTask, maxLogLines = 40): void {
    this.db
      .prepare(
        `insert into ops (id, kind, target, spec, install_spec, status, progress, via, note, error,
                          needs_restart, log_tail, queued_at, started_at, ended_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(id) do update set
           status=excluded.status, progress=excluded.progress, via=excluded.via,
           note=excluded.note, error=excluded.error, needs_restart=excluded.needs_restart,
           log_tail=excluded.log_tail, started_at=excluded.started_at, ended_at=excluded.ended_at`,
      )
      .run(
        task.id,
        task.kind,
        task.target,
        task.spec ?? null,
        task.installSpec ?? null,
        task.status,
        typeof task.progress === "number" ? Math.round(task.progress) : null,
        task.via ?? null,
        task.note ?? null,
        task.error ?? null,
        task.needsRestart ? 1 : 0,
        task.log.slice(-maxLogLines).join("\n"),
        task.queuedAt,
        task.startedAt ?? null,
        task.endedAt ?? null,
      );
  }

  /** 读操作历史（最近 N 条，按结束时间倒序；没有结束时间的按入队时间）。 */
  listOps(limit = 50): OpTask[] {
    const rows = this.db
      .prepare(
        `select * from ops order by coalesce(ended_at, queued_at) desc limit ?`,
      )
      .all(Math.min(Math.max(limit, 1), 200)) as Record<string, any>[];
    return rows.map((row) => {
      const task: OpTask = {
        id: String(row.id),
        kind: row.kind as OpTask["kind"],
        target: String(row.target),
        status: row.status as OpTask["status"],
        log: typeof row.log_tail === "string" && row.log_tail !== "" ? row.log_tail.split("\n") : [],
        queuedAt: Number(row.queued_at ?? 0),
      };
      if (typeof row.spec === "string" && row.spec !== "") task.spec = row.spec;
      if (typeof row.install_spec === "string" && row.install_spec !== "")
        task.installSpec = row.install_spec;
      if (typeof row.progress === "number") task.progress = row.progress;
      if (row.via === "manager" || row.via === "subprocess") task.via = row.via;
      if (typeof row.note === "string" && row.note !== "") task.note = row.note;
      if (typeof row.error === "string" && row.error !== "") task.error = row.error;
      if (row.needs_restart === 1) task.needsRestart = true;
      if (typeof row.started_at === "number") task.startedAt = row.started_at;
      if (typeof row.ended_at === "number") task.endedAt = row.ended_at;
      return task;
    });
  }

  counts(lang = "zh"): CatalogCounts {
    const rows = this.db.prepare("select count(*) as n from plugins").get() as {
      n: number | bigint;
    };
    const chunks = this.db.prepare("select count(*) as n from chunks").get() as {
      n: number | bigint;
    };
    const state = this.db
      .prepare(
        "select total_count, last_sync_at, last_error, curated_orphans from sync_state where lang = ?",
      )
      .get(lang) as
      | {
          total_count: number | null;
          last_sync_at: number | null;
          last_error: string | null;
          curated_orphans: number | bigint;
        }
      | undefined;
    return {
      rows: Number(rows.n),
      chunks: Number(chunks.n),
      totalCount: state?.total_count ?? null,
      lastSyncAt: state?.last_sync_at ?? null,
      lastError: state?.last_error ?? null,
      curatedOrphans: Number(state?.curated_orphans ?? 0),
    };
  }

  /**
   * 查询一页。排序稳定（`(sortKey, repo)`），游标分页不会漏行或重行。
   *
   * ⚠️ 游标与排序的兜底列必须是 `repo` 而不是 `slug`：slug 会重名（实测单分片
   * 23 组），用它兜底会让并列行在分页时互相顶掉或重复出现。
   */
  list(query: CatalogQuery): CatalogPage {
    const sortKey = SORTS[query.sort ?? ""] ? (query.sort as string) : DEFAULT_SORT;
    const sort = SORTS[sortKey]!;
    const limit = Math.min(Math.max(query.limit ?? 50, 1), MAX_LIMIT);
    const { clauses, params } = this.#filters(query);
    // 游标条件不能带前导 `and`：没有筛选时 WHERE 关键字根本不存在（曾因此
    // 生成 `from plugins  and (…)` 的语法错误）。
    const cursorClause = query.cursor
      ? sort.direction === "desc"
        ? `(${sort.column} < ? or (${sort.column} = ? and repo > ?))`
        : `(${sort.column} > ? or (${sort.column} = ? and repo > ?))`
      : "";
    const allClauses = [...clauses, cursorClause].filter((part) => part !== "");
    const where = allClauses.length > 0 ? "where " + allClauses.join(" and ") : "";
    const cursorParams = query.cursor
      ? [
          cursorValue(query.cursor.key, sort.numeric),
          query.cursor.key,
          query.cursor.repo,
        ]
      : [];
    const total = (
      this.db
        .prepare(`select count(*) as n from plugins ${where}`)
        .get(...params, ...cursorParams) as { n: number | bigint }
    ).n;
    const rows = this.db
      .prepare(
        `select * from plugins ${where}
         order by ${sort.column} ${sort.direction === "desc" ? "desc" : "asc"}, repo asc
         limit ?`,
      )
      .all(...params, ...cursorParams, limit) as Record<string, any>[];
    const page: CatalogRow[] = rows.map(toRow);
    const last = rows[rows.length - 1];
    return {
      rows: page,
      total: Number(total),
      facets: this.facets(query),
      nextCursor:
        rows.length === limit && last
          ? { key: String(last[sort.column]), repo: String(last.repo) }
          : null,
    };
  }

  /** 分面计数：按搜索词缓存；只施加搜索词过滤（不施加分类/语言自身的过滤，
   *  否则选了分类后分类分面恒为 1）。 */
  facets(query: CatalogQuery): CatalogPage["facets"] {
    const key = (query.q ?? "").slice(0, MAX_QUERY_CHARS).trim().toLowerCase();
    const cached = this.#facetsCache.get(key);
    if (cached) return cached;
    const { clauses, params } = this.#filters({ q: query.q });
    const where = clauses.length > 0 ? "where " + clauses.join(" and ") : "";
    const out = this.#groupFacets(where, params);
    if (this.#facetsCache.size >= CatalogDb.FACETS_CACHE_LIMIT)
      this.#facetsCache.clear();
    this.#facetsCache.set(key, out);
    return out;
  }

  /**
   * 三个分面**一次扫描**算出来。
   *
   * ⚠️ 早先是三条独立的 `group by`，在真实 19,866 行上每条都要跑一遍搜索过滤，
   * 一次 `catalog.list` 因此要扫 **5 遍**（count + rows + 3 个分面），实测
   * 126ms。改成一次 `group by category, language, status` 后在 JS 里按列归并，
   * 扫描遍数降到 3（count + rows + facets），分面本身只花一遍。
   */
  #groupFacets(
    where: string,
    params: any[],
  ): CatalogPage["facets"] {
    const rows = this.db
      .prepare(
        `select category, language, status, count(*) as n from plugins ${where}
         group by category, language, status`,
      )
      .all(...params) as {
      category: string;
      language: string;
      status: string;
      n: number | bigint;
    }[];
    const category: Record<string, number> = {};
    const language: Record<string, number> = {};
    const status: Record<string, number> = {};
    for (const row of rows) {
      const count = Number(row.n);
      if (row.category !== "")
        category[row.category] = (category[row.category] ?? 0) + count;
      if (row.language !== "")
        language[row.language] = (language[row.language] ?? 0) + count;
      if (row.status !== "") status[row.status] = (status[row.status] ?? 0) + count;
    }
    return { category, language, status };
  }

  #filters(query: CatalogQuery): { clauses: string[]; params: any[] } {
    const clauses: string[] = [];
    const params: any[] = [];
    const q = (query.q ?? "").slice(0, MAX_QUERY_CHARS).trim();
    if (q !== "") {
      if ([...q].length >= 3) {
        // external content 表只暴露索引列与 rowid，因此按 rowid 关联回 plugins。
        clauses.push(
          "rowid in (select rowid from plugins_search where plugins_search match ?)",
        );
        params.push(ftsPhrase(q));
      } else {
        /**
         * 1–2 字查询：trigram 按三字滑窗分词，短于 3 字必然 0 命中，只能回退。
         *
         * ⚠️ 回退目标是**单列 `haystack`** 而不是「只匹配名称」：后者语义错误
         * （实测搜「微信」在名称里没有，但描述里有 207 条），前者与长查询同一份
         * 文本，命中口径一致。代价是单遍约 35ms（无索引），因此分面缓存对短查询
         * 尤其重要 —— 缓存后一次查询只跑 count + rows 两遍。
         */
        clauses.push("haystack like ? escape '\\'");
        params.push(`%${escapeLike(q.toLowerCase())}%`);
      }
    }
    for (const [column, value] of [
      ["category", query.category],
      ["language", query.language],
      ["status", query.status],
    ] as const) {
      if (typeof value === "string" && value !== "") {
        clauses.push(`${column} = ?`);
        params.push(value);
      }
    }
    return { clauses, params };
  }

  close(): void {
    this.db.close();
  }
}

/** 游标里的排序键还原成与列一致的比较类型。 */
function cursorValue(key: string, numeric: boolean): string | number {
  if (!numeric) return key;
  const parsed = Number(key);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 检索文本：小写拼接的「可搜字段」。
 *
 * 与 `plugins_search` 里存的内容必须**完全一致**（同一函数生成），否则
 * 短查询（走 haystack LIKE）与长查询（走 FTS）会给出不同结果。
 */
function searchText(row: CatalogRow): string {
  return [
    row.name,
    row.displayName,
    row.description,
    row.features.join(" "),
    row.topics.join(" "),
    row.repo,
  ]
    .join(" ")
    .toLowerCase();
}

/** 用户输入 → FTS5 短语：整串当成一个短语，内部引号按 FTS5 规则双写。 */
function ftsPhrase(query: string): string {
  return '"' + query.replace(/"/g, '""') + '"';
}

/** LIKE 通配符按字面处理（`%` / `_` / `\` 都要转义，配 `escape '\'`）。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => "\\" + ch);
}

/** 分片行 → 库参数（列名与类型一一对应）。 */
function shardValue(row: CatalogRow, column: string): any {
  switch (column) {
    case "topics":
      return JSON.stringify(row.topics);
    case "features":
      return JSON.stringify(row.features);
    case "dsh_topic":
      return row.dshTopic ? 1 : 0;
    case "display_name":
      return row.displayName;
    case "npm_package":
      return row.npmPackage;
    case "repo_created_at":
      return row.repoCreatedAt;
    case "repo_updated_at":
      return row.repoUpdatedAt;
    case "added_at":
      return row.addedAt;
    case "page_updated_at":
      return row.pageUpdatedAt;
    default:
      return (row as any)[column] ?? "";
  }
}

/** 库行 → 目录行；数组字段与布尔字段还原类型。 */
export function toRow(raw: Record<string, any>): CatalogRow {
  const array = (value: unknown): string[] => {
    if (typeof value !== "string" || value === "") return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  };
  return {
    slug: String(raw.slug),
    owner: String(raw.owner ?? ""),
    name: String(raw.name ?? ""),
    displayName: String(raw.display_name ?? ""),
    category: String(raw.category ?? ""),
    topics: array(raw.topics),
    features: array(raw.features),
    description: String(raw.description ?? ""),
    h1: String(raw.h1 ?? ""),
    repo: String(raw.repo ?? ""),
    npmPackage: String(raw.npm_package ?? ""),
    status: String(raw.status ?? ""),
    repoCreatedAt: String(raw.repo_created_at ?? ""),
    repoUpdatedAt: String(raw.repo_updated_at ?? ""),
    addedAt: String(raw.added_at ?? ""),
    pageUpdatedAt: String(raw.page_updated_at ?? ""),
    stars: Number(raw.stars ?? 0),
    forks: Number(raw.forks ?? 0),
    language: String(raw.language ?? ""),
    license: String(raw.license ?? ""),
    dshTopic: raw.dsh_topic === 1 || raw.dsh_topic === true,
  };
}