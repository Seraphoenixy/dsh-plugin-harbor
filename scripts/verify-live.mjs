/**
 * 真实站点只读验收（维护用，**必须显式联网**）。
 *
 * 用法：`node --experimental-transform-types scripts/verify-live.mjs --network`
 *
 * 口径：
 *  - 只读站点数据；**不读也不写任何 profile**（目录库建在系统临时目录里）；
 *  - 不做任何安装/卸载/启停；
 *  - 冷同步一次、热同步一次，把行数、耗时、跳过数与查询指标打出来，
 *    供 `docs/ACCEPTANCE.md` 的「真实验收」段如实记载。
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncCatalog } from "../src/core/catalog.ts";
import { runDiagnostics, summarizeDiagnostics } from "../src/core/diagnostics.ts";
import { defaultSettings } from "../src/core/settings.ts";
import { CatalogDb } from "../src/storage/catalog-db.ts";
import { fetchText } from "../src/upstream/fetch.ts";
import { readGitVersion } from "../src/upstream/git.ts";

if (!process.argv.includes("--network")) {
  console.error("本脚本会访问 dsh-plugin.org，必须显式传 --network。");
  process.exit(2);
}

const SITE = process.env.PLUGIN_HARBOR_SITE ?? "https://dsh-plugin.org";
const API = process.env.PLUGIN_HARBOR_API ?? "https://api.dsh-plugin.org";
const dir = mkdtempSync(join(tmpdir(), "pcenter-live-"));
const dbPath = join(dir, "catalog.sqlite");
const db = new CatalogDb(dbPath);
const requests = [];
const counters = { shards: 0, bytes: 0 };

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
        throw Error("未知 store 方法：" + method);
    }
  },
};

const deps = {
  fetch: async (url, options) => {
    requests.push(url);
    if (url.includes("/directory/")) counters.shards += 1;
    const result = await fetchText(url, options);
    counters.bytes += result.body.length;
    return result;
  },
  store,
  log: (message) => console.log("  ·", message),
  now: () => Date.now(),
  siteBase: SITE,
  apiBase: API,
  locale: "zh",
};

console.log("临时目录：" + dir);
try {
  for (const phase of ["冷同步", "热同步"]) {
    requests.length = 0;
    counters.shards = 0;
    counters.bytes = 0;
    const started = Date.now();
    const report = await syncCatalog(deps);
    const seconds = (Date.now() - started) / 1000;
    console.log(
      `${phase}：${seconds.toFixed(1)}s，取 ${report.refreshed} 片 / 跳过 ${report.skipped} 片 / 清理 ${report.failures.length} 失败项；` +
        `请求 ${requests.length} 次、分片 ${counters.shards} 个、正文 ${(counters.bytes / 1048576).toFixed(1)}MB；` +
        `来源 ${report.source}${report.degraded ? "（降级：" + report.degraded + "）" : ""}` +
        `${report.curated ? `；curated 合并 ${report.curated.merged} 条 / 落空 ${report.curated.orphans} 条` : "；curated 未重下"}`,
    );
  }

  const counts = db.counts();
  const stats = statSync(dbPath);
  console.log(
    `目录库：${counts.rows} 行 / ${counts.chunks} 分片 / 站点自报 ${counts.totalCount} / curated 落空 ${counts.curatedOrphans}；` +
      `文件 ${(stats.size / 1048576).toFixed(1)}MB；最近同步错误：${counts.lastError ?? "无"}`,
  );

  const facets = db.list({ limit: 1 }).facets;
  console.log("分类分面：" + JSON.stringify(facets.category));
  console.log("语言分面（前 5）：" + JSON.stringify(Object.entries(facets.language).sort((a, b) => b[1] - a[1]).slice(0, 5)));

  for (const query of ["上下文", "微信", "dsh-purge"]) {
    const at = performance.now();
    const page = db.list({ q: query, limit: 50 });
    console.log(
      `搜索「${query}」：${page.total} 条命中，首页 ${page.rows.length} 条，${(performance.now() - at).toFixed(1)}ms`,
    );
  }

  const paging = [];
  let cursor = undefined;
  let pages = 0;
  const started = performance.now();
  for (;;) {
    const page = db.list({ sort: "stars", limit: 50, cursor });
    paging.push(...page.rows.map((row) => row.repo));
    pages += 1;
    if (!page.nextCursor || pages > 500) break;
    cursor = page.nextCursor;
  }
  console.log(
    `全量翻页：${pages} 页 / ${paging.length} 行 / 去重后 ${new Set(paging).size} 行 / ${((performance.now() - started) / 1000).toFixed(1)}s`,
  );

  // 诊断（真实端点，只读）：验证「站点 / API / registry / git / 目录库」五项连通性
  console.log("\n诊断（真实端点，只读）：");
  const checks = await runDiagnostics({
    fetch: fetchText,
    gitVersion: () => readGitVersion(),
    storePing: async () => ({ path: dbPath, ...db.meta }),
    counts: async () => db.counts(),
    settings: defaultSettings(),
    now: () => Date.now(),
  });
  for (const check of checks)
    console.log(
      `  ${check.ok === true ? "通过" : check.ok === false ? "失败" : "无结论"}｜${check.label}｜${check.detail}（${check.ms}ms）`,
    );
  console.log("  → " + summarizeDiagnostics(checks));
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}