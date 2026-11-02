/**
 * 检索方案探测（维护用，需 --network）。
 *
 * 目标：在真实 19,866 行上比较三种检索路径，选出能落进 ≤30ms 预算、
 * 且**中文子串语义正确**的那一种：
 *   A. 现状：5 列 LIKE（每请求跑 5 遍）
 *   B. 单列 haystack LIKE（1 遍）
 *   C. FTS5 trigram MATCH（索引）
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncCatalog } from "../src/core/catalog.ts";
import { CatalogDb } from "../src/storage/catalog-db.ts";
import { fetchText } from "../src/upstream/fetch.ts";

if (!process.argv.includes("--network")) {
  console.error("需要 --network");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "pcenter-search-"));
const db = new CatalogDb(join(dir, "catalog.sqlite"));
const raw = db.db;
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

const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const time = (run, rounds = 5) => {
  const samples = [];
  for (let i = 0; i < rounds; i++) {
    const at = performance.now();
    run();
    samples.push(performance.now() - at);
  }
  return median(samples);
};

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
  console.log("行数：" + db.counts().rows);

  // --- B: 单列 haystack ---
  raw.exec("alter table plugins add column haystack text not null default ''");
  const started = Date.now();
  raw.exec(`update plugins set haystack = lower(
    name || ' ' || display_name || ' ' || description || ' ' || features || ' ' || topics || ' ' || repo || ' ' || npm_package)`);
  console.log(`haystack 列构建 ${Date.now() - started}ms`);

  // --- C: FTS5 trigram ---
  let ftsError = "";
  try {
    raw.exec("create virtual table plugins_search using fts5(repo UNINDEXED, haystack, tokenize='trigram')");
  } catch (error) {
    ftsError = String(error);
  }
  console.log("FTS5 trigram：" + (ftsError === "" ? "可用" : "不可用 - " + ftsError));
  if (ftsError === "") {
    const built = Date.now();
    raw.exec("insert into plugins_search(repo, haystack) select repo, haystack from plugins");
    console.log(`FTS5 建索引 ${Date.now() - built}ms（19,866 行）`);
  }

  const queries = ["上下文", "微信", "微信扫码", "dsh-purge", "jailbreak"];
  for (const q of queries) {
    const legacy = time(
      () =>
        db.db
          .prepare(
            "select count(*) as n from plugins where name like @p or display_name like @p or description like @p or features like @p or topics like @p",
          )
          .get({ p: `%${q}%` }).n,
    );
    const hay = time(
      () =>
        db.db
          .prepare("select count(*) as n from plugins where haystack like ?")
          .get(`%${q.toLowerCase()}%`).n,
    );
    let fts = "n/a";
    let hayHits = 0;
    if (ftsError === "") {
      hayHits = db.db
        .prepare("select count(*) as n from plugins where haystack like ?")
        .get(`%${q.toLowerCase()}%`).n;
      // trigram 需要 ≥3 个字符才可能命中
      if ([...q].length >= 3) {
        fts = time(() =>
          db.db
            .prepare("select count(*) as n from plugins_search where haystack match ?")
            .get(`"${q}"`).n,
        );
      }
    }
    console.log(
      `q=${q}：现状5列LIKE ${legacy.toFixed(1)}ms | haystack LIKE ${hay.toFixed(1)}ms | FTS5 ${typeof fts === "number" ? fts.toFixed(1) + "ms" : fts} | 命中 haystack=${hayHits}`,
    );
  }

  if (ftsError === "") {
    for (const q of ["上下文", "微信扫码", "jailbreak"]) {
      const ftsHits = db.db
        .prepare("select count(*) as n from plugins_search where haystack match ?")
        .get(`"${q}"`).n;
      const likeHits = db.db
        .prepare("select count(*) as n from plugins where haystack like ?")
        .get(`%${q.toLowerCase()}%`).n;
      console.log(`  语义比对 q=${q}：FTS5 ${ftsHits} 命中 / LIKE ${likeHits} 命中`);
    }
    // 两字查询在 trigram 下的表现（预期：无法命中）
    const two = db.db
      .prepare("select count(*) as n from plugins_search where haystack match ?")
      .get('"微信"').n;
    console.log(`  两字查询「微信」在 trigram 下命中 ${two} 条（预期 0，需回退 LIKE）`);
  }
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}