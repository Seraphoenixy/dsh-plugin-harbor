/**
 * 目录库体积构成（维护用，需 --network）。
 *
 * 目的：回答「本地库到底存了什么、能不能省」。分别量：
 *   A. 完整库（plugins + haystack + FTS trigram）
 *   B. 删掉检索索引后的库
 *   C. 只留最小展示字段的库（模拟「不要全文检索」的轻量档）
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncCatalog } from "../src/core/catalog.ts";
import { CatalogDb } from "../src/storage/catalog-db.ts";
import { fetchText } from "../src/upstream/fetch.ts";

if (!process.argv.includes("--network")) {
  console.error("需要 --network");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "pcenter-size-"));
const db = new CatalogDb(join(dir, "catalog.sqlite"));
const store = {
  async call(method, payload = {}) {
    switch (method) {
      case "catalog.knownChunks":
        return { chunks: [...db.knownChunks(payload.lang).entries()] };
      case "catalog.removeChunks":
        return { removed: db.removeChunks(payload.urls ?? []) };
      case "catalog.applyChunk":
        return { rows: db.applyChunk(payload.chunk, payload.body) };
      case "catalog.applyCurated":
        return db.applyCurated(payload.body);
      case "catalog.setSyncState":
        db.setSyncState(payload.state);
        return { ok: true };
      case "catalog.counts":
        return db.counts(payload.lang);
      default:
        throw Error(method);
    }
  },
};

const sizeOf = (path) => {
  // 含 WAL：以 page_count 为准
  const pages = db.db.prepare("pragma page_count").get().page_count;
  const pageSize = db.db.prepare("pragma page_size").get().page_size;
  return pages * pageSize;
};

const mb = (bytes) => (bytes / 1048576).toFixed(1) + "MB";

try {
  await syncCatalog({
    fetch: fetchText,
    store,
    log: () => {},
    now: () => Date.now(),
    siteBase: "https://dsh-plugin.org",
    apiBase: "https://api.dsh-plugin.org",
    locale: "zh",
  });
  db.db.exec("vacuum");
  console.log(`A. 完整库（19,866 行 + haystack + FTS trigram）：${mb(sizeOf())}`);

  // 每张表占多少（dbstat 若可用）
  try {
    const rows = db.db
      .prepare(
        "select name, sum(pgsize) as bytes from dbstat group by name order by bytes desc limit 12",
      )
      .all();
    console.log("   逐对象占用：");
    for (const row of rows) console.log(`     ${String(row.name).padEnd(24)} ${mb(Number(row.bytes))}`);
  } catch (error) {
    console.log("   （本机 SQLite 未编译 dbstat，跳过逐对象统计）");
  }

  // B. 去掉检索索引
  // ⚠️ 必须先删触发器再删虚表：触发器引用了 plugins_search，直接 drop 会让
  // 随后的任何写入报 `no such table: main.plugins_search`（本轮实测踩到）。
  db.db.exec(`
    drop trigger if exists plugins_search_ai;
    drop trigger if exists plugins_search_ad;
    drop trigger if exists plugins_search_au;
    drop table if exists plugins_search;
  `);
  db.db.exec("alter table plugins drop column haystack;");
  db.db.exec("vacuum");
  console.log(`B. 去掉检索索引后：${mb(sizeOf())}`);

  // C. 只留展示与判更新所需的最小字段
  db.db.exec(`
    create table slim as select
      repo, slug, name, display_name, category, repo, npm_package, status,
      repo_updated_at, added_at, stars, forks, language, license, dsh_topic,
      ver_tag, install_npm, install_git, chunk_url, synced_at
    from plugins;
    drop table plugins;
    alter table slim rename to plugins;
  `);
  db.db.exec("vacuum");
  console.log(`C. 只留最小字段（无描述/特性/标签，无索引）：${mb(sizeOf())}`);
  const rows = db.db.prepare("select count(*) as n from plugins").get().n;
  console.log(`   行数仍为：${rows}`);
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}