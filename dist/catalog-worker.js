// src/storage/worker.ts
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

// src/storage/catalog-db.ts
import { DatabaseSync } from "node:sqlite";

// src/core/site.ts
var text = (value) => typeof value === "string" ? value : "";
var list = (value) => Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
var num = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
function normalizeShardRecord(raw) {
  if (!raw || typeof raw !== "object") return void 0;
  const record = raw;
  const slug = text(record.slug);
  const repo = text(record.source?.repo);
  if (slug === "" || repo === "") return void 0;
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
    dshTopic: metadata.dshTopic === true
  };
}
function normalizeShardBody(body) {
  const parsed = JSON.parse(body);
  if (!Array.isArray(parsed)) throw Error("\u5206\u7247\u4E0D\u662F JSON \u6570\u7EC4");
  const rows = [];
  for (const item of parsed) {
    const row = normalizeShardRecord(item);
    if (row) rows.push(row);
  }
  return rows;
}
function normalizeCuratedRecord(raw) {
  if (!raw || typeof raw !== "object") return void 0;
  const record = raw;
  const slug = text(record.s);
  const repo = text(record.r?.repo);
  if (slug === "" || repo === "") return void 0;
  const out = {
    slug,
    repo,
    npmPackage: text(record.r?.npmPackage)
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
function normalizeCuratedBody(body) {
  const parsed = JSON.parse(body);
  const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.plugins) ? parsed.plugins : [];
  const out = [];
  for (const item of items) {
    const record = normalizeCuratedRecord(item);
    if (record) out.push(record);
  }
  return out;
}

// src/storage/catalog-db.ts
var COLUMNS = [
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
  "synced_at"
];
var SHARD_COLUMNS = COLUMNS.filter(
  (column) => !["ver_tag", "install_npm", "install_git", "chunk_url", "synced_at"].includes(
    column
  )
);
var SORTS = {
  stars: { column: "stars", direction: "desc", numeric: true },
  updated: { column: "repo_updated_at", direction: "desc", numeric: false },
  added: { column: "added_at", direction: "desc", numeric: false },
  name: { column: "name", direction: "asc", numeric: false }
};
var DEFAULT_SORT = "stars";
var MAX_LIMIT = 50;
var MAX_QUERY_CHARS = 80;
var CatalogDb = class _CatalogDb {
  db;
  /**
   * 分面计数缓存（键＝搜索词）。
   *
   * 分面只依赖搜索词，却被每个分页请求重算：一次 `catalog.list` 原本要跑
   * count + rows + 3 个 GROUP BY，共 **5 遍**全文扫描（真实站点实测 126ms/次）。
   * 任何写入都会清空缓存。
   */
  #facetsCache = /* @__PURE__ */ new Map();
  /** 缓存条数上限：搜索词换来换去时只保留最近的几个。 */
  static FACETS_CACHE_LIMIT = 8;
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec("pragma journal_mode = wal");
    this.db.exec("pragma busy_timeout = 5000");
    this.#migrate();
  }
  #migrate() {
    const existing = this.db.prepare(
      "select sql from sqlite_master where type = 'table' and name = 'plugins'"
    ).get();
    if (existing?.sql && (!/repo\s+text\s+primary\s+key/i.test(existing.sql) || !/haystack/i.test(existing.sql))) {
      this.db.exec(
        "drop table if exists plugins; drop table if exists chunks; drop table if exists plugins_search;"
      );
    }
    const cache = this.db.prepare(
      "select sql from sqlite_master where type = 'table' and name = 'installed_cache'"
    ).get();
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
        -- \u68C0\u7D22\u7528\u7684\u5C0F\u5199\u62FC\u63A5\u6587\u672C\uFF1A\u5185\u5BB9\u5FC5\u987B\u4E0E FTS \u7D22\u5F15\u8868\u4E00\u81F4\uFF08\u540C\u4E00\u4E2A searchText()\uFF09
        haystack text not null default '',
        -- \u8BE6\u60C5\u9875\u6309\u9700\u6293\u53D6\u7684\u539F\u59CB\u8BB0\u5F55\uFF08\u7AD9\u70B9\u7CBE\u786E\u7248\u672C / \u5B89\u88C5\u547D\u4EE4 / dshTarget\uFF09
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
        -- null = \u5224\u4E0D\u4E86\uFF08\u4E0D\u662F\u300C\u5DF2\u6700\u65B0\u300D\uFF09
        update_available integer,
        note text,
        error text,
        checked_at integer
      );
      /*
       * \u64CD\u4F5C\u8BB0\u5F55\u3002\u961F\u5217\u662F\u8FD0\u884C\u6001\u7684\u6743\u5A01\uFF0C\u8FD9\u5F20\u8868\u53EA\u5B58\u7EC8\u6001\uFF08\u542B\u5931\u8D25\u7684\uFF09\u4F9B\u300C\u64CD\u4F5C\u9875\u300D
       * \u8DE8\u91CD\u542F\u56DE\u770B\uFF1Blog_tail \u53EA\u7559\u6700\u540E\u82E5\u5E72\u884C\uFF0C\u907F\u514D\u628A pnpm \u5168\u6587\u5199\u8FDB\u5E93\u91CC\u3002
       */
      create table if not exists ops (
        id text primary key,
        kind text not null,
        target text not null,
        spec text,
        /** \u5B9E\u9645\u4EA4\u7ED9 pnpm \u7684\u5730\u5740\uFF08\u66F4\u65B0\u65F6\u4E0E spec \u4E0D\u540C\uFF1Aspec \u662F\u8BB0\u7684\u8303\u56F4\uFF09\u3002 */
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
    const opsTable = this.db.prepare("select sql from sqlite_master where type = 'table' and name = 'ops'").get();
    if (opsTable?.sql && !/install_spec/i.test(opsTable.sql))
      this.db.exec("alter table ops add column install_spec text");
    const hasSearch = this.db.prepare(
      "select count(*) as n from sqlite_master where name = 'plugins_search'"
    ).get();
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
    if (Number(hasSearch.n) === 0)
      this.db.exec("insert into plugins_search(plugins_search) values('rebuild')");
  }
  get meta() {
    const version = this.db.prepare("select sqlite_version() as v").get();
    const tables = this.db.prepare("select count(*) as n from sqlite_master where type = 'table'").get();
    return { tables: Number(tables.n), sqlite: version.v };
  }
  /** 本地已入库的分片（供 `planSync` 比对哈希）。 */
  knownChunks(lang) {
    const rows = lang === void 0 ? this.db.prepare("select url, hash from chunks").all() : this.db.prepare("select url, hash from chunks where lang = ?").all(lang);
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
  applyChunk(chunk, body, now = Date.now()) {
    const rows = normalizeShardBody(body);
    const chunkUrl = chunk.url;
    this.db.exec("begin");
    try {
      this.db.prepare("delete from plugins where chunk_url = ?").run(chunkUrl);
      const insert = this.db.prepare(
        `insert into plugins (${SHARD_COLUMNS.join(",")}, haystack, chunk_url, synced_at)
         values (${SHARD_COLUMNS.map(() => "?").join(",")}, ?, ?, ?)
         on conflict(repo) do update set ${SHARD_COLUMNS.map(
          (column) => `${column}=excluded.${column}`
        ).join(", ")}, haystack=excluded.haystack, chunk_url=excluded.chunk_url, synced_at=excluded.synced_at`
      );
      for (const row of rows)
        insert.run(
          ...SHARD_COLUMNS.map((column) => shardValue(row, column)),
          searchText(row),
          chunkUrl,
          now
        );
      this.db.prepare(
        `insert into chunks (url, lang, category, page, hash, rows, fetched_at)
           values (?, ?, ?, ?, ?, ?, ?)
           on conflict(url) do update set rows=excluded.rows, fetched_at=excluded.fetched_at`
      ).run(chunk.url, chunk.lang, chunk.category, chunk.page, chunk.hash, rows.length, now);
      this.#facetsCache.clear();
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
    return rows.length;
  }
  /** 清理已从清单里消失的分片及其行（索引由触发器一并清理）。返回清理的行数。 */
  removeChunks(urls) {
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
  applyCurated(body) {
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
         where repo = ?`
      );
      for (const record of records) {
        const result = update.run(
          record.versionTag ?? null,
          record.installNpm ?? null,
          record.installGit ?? null,
          record.npmPackage,
          record.npmPackage,
          record.repo
        );
        if (Number(result.changes) === 0) orphans += 1;
        else merged += 1;
      }
      this.db.prepare(
        `insert into sync_state (lang, curated_orphans) values (?, ?)
           on conflict(lang) do update set curated_orphans = excluded.curated_orphans`
      ).run("curated", orphans);
      this.db.exec("commit");
      return { merged, orphans };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }
  setSyncState(state) {
    this.db.prepare(
      `insert into sync_state (lang, index_etag, total_count, last_sync_at, last_error)
         values (?, ?, ?, ?, ?)
         on conflict(lang) do update set
           index_etag = coalesce(excluded.index_etag, sync_state.index_etag),
           total_count = coalesce(excluded.total_count, sync_state.total_count),
           last_sync_at = coalesce(excluded.last_sync_at, sync_state.last_sync_at),
           last_error = excluded.last_error`
    ).run(
      state.lang,
      state.indexEtag ?? null,
      state.totalCount ?? null,
      state.lastSyncAt ?? null,
      state.lastError === void 0 ? null : state.lastError
    );
  }
  /** 按需抓到的详情页事实写回目录行（缓存，`detail_at` 用于 TTL）。 */
  putDetail(repo, record, now = Date.now()) {
    this.db.prepare("update plugins set detail_json = ?, detail_at = ? where repo = ?").run(JSON.stringify(record), now, repo);
  }
  /** 读若干 repo 的详情缓存；解析失败的条目不返回（当作没有）。 */
  getDetails(repos) {
    const out = /* @__PURE__ */ new Map();
    if (repos.length === 0) return out;
    const rows = this.db.prepare(
      `select repo, detail_json, detail_at from plugins where repo in (${repos.map(() => "?").join(",")})`
    ).all(...repos);
    for (const row of rows) {
      if (typeof row.detail_json !== "string" || row.detail_json === "") continue;
      try {
        out.set(row.repo, {
          record: JSON.parse(row.detail_json),
          at: Number(row.detail_at ?? 0)
        });
      } catch {
      }
    }
    return out;
  }
  /** 按 repo 取目录行（已装清单与目录合并用）。 */
  rowsByRepo(repos) {
    const out = /* @__PURE__ */ new Map();
    if (repos.length === 0) return out;
    const rows = this.db.prepare(
      `select * from plugins where repo in (${repos.map(() => "?").join(",")})`
    ).all(...repos);
    for (const raw of rows) {
      const row = toRow(raw);
      out.set(row.repo, row);
    }
    return out;
  }
  /** 写入更新结论缓存（`update_available` 为 null 表示判不了，必须原样保留）。 */
  putChecks(checks) {
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
         error=excluded.error, checked_at=excluded.checked_at`
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
          check.checkedAt
        );
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
    return checks.length;
  }
  /** 读全部更新结论缓存。 */
  getChecks() {
    const rows = this.db.prepare("select * from installed_cache").all();
    const out = /* @__PURE__ */ new Map();
    for (const row of rows) {
      const check = {
        name: String(row.name),
        kind: row.kind ?? "unknown",
        updateAvailable: row.update_available === null || row.update_available === void 0 ? null : Boolean(row.update_available),
        checkedAt: Number(row.checked_at ?? 0)
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
        ["error", "error"]
      ]) {
        const value = row[column];
        if (typeof value === "string" && value !== "")
          check[key] = value;
      }
      out.set(check.name, check);
    }
    return out;
  }
  /** 写入一条操作记录（终态；同一 id 覆盖）。 */
  putOp(task, maxLogLines = 40) {
    this.db.prepare(
      `insert into ops (id, kind, target, spec, install_spec, status, progress, via, note, error,
                          needs_restart, log_tail, queued_at, started_at, ended_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(id) do update set
           status=excluded.status, progress=excluded.progress, via=excluded.via,
           note=excluded.note, error=excluded.error, needs_restart=excluded.needs_restart,
           log_tail=excluded.log_tail, started_at=excluded.started_at, ended_at=excluded.ended_at`
    ).run(
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
      task.endedAt ?? null
    );
  }
  /** 读操作历史（最近 N 条，按结束时间倒序；没有结束时间的按入队时间）。 */
  listOps(limit = 50) {
    const rows = this.db.prepare(
      `select * from ops order by coalesce(ended_at, queued_at) desc limit ?`
    ).all(Math.min(Math.max(limit, 1), 200));
    return rows.map((row) => {
      const task = {
        id: String(row.id),
        kind: row.kind,
        target: String(row.target),
        status: row.status,
        log: typeof row.log_tail === "string" && row.log_tail !== "" ? row.log_tail.split("\n") : [],
        queuedAt: Number(row.queued_at ?? 0)
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
  counts(lang = "zh") {
    const rows = this.db.prepare("select count(*) as n from plugins").get();
    const chunks = this.db.prepare("select count(*) as n from chunks").get();
    const state = this.db.prepare(
      "select total_count, last_sync_at, last_error, curated_orphans from sync_state where lang = ?"
    ).get(lang);
    return {
      rows: Number(rows.n),
      chunks: Number(chunks.n),
      totalCount: state?.total_count ?? null,
      lastSyncAt: state?.last_sync_at ?? null,
      lastError: state?.last_error ?? null,
      curatedOrphans: Number(state?.curated_orphans ?? 0)
    };
  }
  /**
   * 查询一页。排序稳定（`(sortKey, repo)`），游标分页不会漏行或重行。
   *
   * ⚠️ 游标与排序的兜底列必须是 `repo` 而不是 `slug`：slug 会重名（实测单分片
   * 23 组），用它兜底会让并列行在分页时互相顶掉或重复出现。
   */
  list(query) {
    const sortKey = SORTS[query.sort ?? ""] ? query.sort : DEFAULT_SORT;
    const sort = SORTS[sortKey];
    const limit = Math.min(Math.max(query.limit ?? 50, 1), MAX_LIMIT);
    const { clauses, params } = this.#filters(query);
    const cursorClause = query.cursor ? sort.direction === "desc" ? `(${sort.column} < ? or (${sort.column} = ? and repo > ?))` : `(${sort.column} > ? or (${sort.column} = ? and repo > ?))` : "";
    const allClauses = [...clauses, cursorClause].filter((part) => part !== "");
    const where = allClauses.length > 0 ? "where " + allClauses.join(" and ") : "";
    const cursorParams = query.cursor ? [
      cursorValue(query.cursor.key, sort.numeric),
      query.cursor.key,
      query.cursor.repo
    ] : [];
    const total = this.db.prepare(`select count(*) as n from plugins ${where}`).get(...params, ...cursorParams).n;
    const rows = this.db.prepare(
      `select * from plugins ${where}
         order by ${sort.column} ${sort.direction === "desc" ? "desc" : "asc"}, repo asc
         limit ?`
    ).all(...params, ...cursorParams, limit);
    const page = rows.map(toRow);
    const last = rows[rows.length - 1];
    return {
      rows: page,
      total: Number(total),
      facets: this.facets(query),
      nextCursor: rows.length === limit && last ? { key: String(last[sort.column]), repo: String(last.repo) } : null
    };
  }
  /** 分面计数：按搜索词缓存；只施加搜索词过滤（不施加分类/语言自身的过滤，
   *  否则选了分类后分类分面恒为 1）。 */
  facets(query) {
    const key = (query.q ?? "").slice(0, MAX_QUERY_CHARS).trim().toLowerCase();
    const cached = this.#facetsCache.get(key);
    if (cached) return cached;
    const { clauses, params } = this.#filters({ q: query.q });
    const where = clauses.length > 0 ? "where " + clauses.join(" and ") : "";
    const out = this.#groupFacets(where, params);
    if (this.#facetsCache.size >= _CatalogDb.FACETS_CACHE_LIMIT)
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
  #groupFacets(where, params) {
    const rows = this.db.prepare(
      `select category, language, status, count(*) as n from plugins ${where}
         group by category, language, status`
    ).all(...params);
    const category = {};
    const language = {};
    const status = {};
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
  #filters(query) {
    const clauses = [];
    const params = [];
    const q = (query.q ?? "").slice(0, MAX_QUERY_CHARS).trim();
    if (q !== "") {
      if ([...q].length >= 3) {
        clauses.push(
          "rowid in (select rowid from plugins_search where plugins_search match ?)"
        );
        params.push(ftsPhrase(q));
      } else {
        clauses.push("haystack like ? escape '\\'");
        params.push(`%${escapeLike(q.toLowerCase())}%`);
      }
    }
    for (const [column, value] of [
      ["category", query.category],
      ["language", query.language],
      ["status", query.status]
    ]) {
      if (typeof value === "string" && value !== "") {
        clauses.push(`${column} = ?`);
        params.push(value);
      }
    }
    return { clauses, params };
  }
  close() {
    this.db.close();
  }
};
function cursorValue(key, numeric) {
  if (!numeric) return key;
  const parsed = Number(key);
  return Number.isFinite(parsed) ? parsed : 0;
}
function searchText(row) {
  return [
    row.name,
    row.displayName,
    row.description,
    row.features.join(" "),
    row.topics.join(" "),
    row.repo
  ].join(" ").toLowerCase();
}
function ftsPhrase(query) {
  return '"' + query.replace(/"/g, '""') + '"';
}
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (ch) => "\\" + ch);
}
function shardValue(row, column) {
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
      return row[column] ?? "";
  }
}
function toRow(raw) {
  const array = (value) => {
    if (typeof value !== "string" || value === "") return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
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
    dshTopic: raw.dsh_topic === 1 || raw.dsh_topic === true
  };
}

// src/storage/worker.ts
var catalog = null;
function open(path) {
  if (catalog) return catalog;
  mkdirSync(dirname(path), { recursive: true });
  catalog = new CatalogDb(path);
  return catalog;
}
function handle(path, method, payload) {
  if (method === "ping") {
    const db2 = open(String(payload?.path ?? path));
    return { path: String(payload?.path ?? path), ...db2.meta };
  }
  const db = open(path);
  switch (method) {
    case "catalog.applyChunk": {
      const chunk = payload?.chunk;
      if (!chunk?.url) throw Error("applyChunk \u7F3A\u5C11 chunk.url");
      return { rows: db.applyChunk(chunk, String(payload.body ?? "")) };
    }
    case "catalog.removeChunks":
      return { removed: db.removeChunks(Array.isArray(payload?.urls) ? payload.urls : []) };
    case "catalog.applyCurated":
      return db.applyCurated(String(payload?.body ?? ""));
    case "catalog.setSyncState":
      db.setSyncState(payload?.state ?? {});
      return { ok: true };
    case "catalog.knownChunks":
      return { chunks: [...db.knownChunks(payload?.lang).entries()] };
    case "catalog.counts":
      return db.counts(payload?.lang);
    case "catalog.list":
      return db.list(payload?.query ?? {});
    case "catalog.rowsByRepo": {
      const repos = Array.isArray(payload?.repos) ? payload.repos : [];
      return { rows: [...db.rowsByRepo(repos).values()] };
    }
    case "catalog.putDetail":
      db.putDetail(String(payload?.repo ?? ""), payload?.record ?? null);
      return { ok: true };
    case "catalog.getDetails": {
      const repos = Array.isArray(payload?.repos) ? payload.repos : [];
      return { details: [...db.getDetails(repos).entries()] };
    }
    case "installed.putChecks": {
      const checks = Array.isArray(payload?.checks) ? payload.checks : [];
      return { written: db.putChecks(checks) };
    }
    case "installed.getChecks":
      return { checks: [...db.getChecks().values()] };
    case "op.putOp":
      db.putOp(payload?.task);
      return { ok: true };
    case "op.listOps":
      return { tasks: db.listOps(Number(payload?.limit ?? 50)) };
    case "close":
      db.close();
      catalog = null;
      return { closed: true };
    default:
      throw Error("Unknown catalog store method: " + method);
  }
}
var dbPath = String(workerData?.dbPath ?? "");
parentPort?.on("message", (request) => {
  try {
    parentPort?.postMessage({
      id: request.id,
      ok: true,
      value: handle(dbPath, request.method, request.payload)
    });
  } catch (error) {
    parentPort?.postMessage({
      id: request.id,
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    });
  }
});
