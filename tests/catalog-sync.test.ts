/**
 * 目录同步编排回归（真实 SQLite + 桩 fetch，不联网、不起线程）。
 *
 * `store` 用 CatalogDb 直接实现，跳过 worker 消息层：这一层要验证的是**编排**
 * （增量计划、三桶口径、失败不致命、curated 复用），消息层由宿主契约测试覆盖。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { syncCatalog, type SyncDeps } from "../src/core/catalog.ts";
import { CatalogDb } from "../src/storage/catalog-db.ts";
import type { FetchResult } from "../src/upstream/fetch.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const shardBody = fixture("site-shard-agent-1.json");
const curatedBody = fixture("curated-zh.json");
const sitemapXml = fixture("sitemap-plugins-1.xml");

const SITE = "https://dsh-plugin.org";
const API = "https://api.dsh-plugin.org";

/** 第二个分片的正文：与夹具同形但换了 slug/repo，用来验证「两片各写各的」。 */
const otherBody = JSON.stringify(
  (JSON.parse(shardBody) as any[]).map((record) => ({
    ...record,
    slug: `b-${record.slug}`,
    source: { ...record.source, repo: `b-${record.source.repo}` },
  })),
);

/** 用 CatalogDb 实现 store 接口（与 worker 的消息语义一一对应）。 */
function storeOf(db: CatalogDb) {
  const calls: string[] = [];
  return {
    calls,
    async call<T = any>(method: string, payload: any = {}): Promise<T> {
      calls.push(method);
      switch (method) {
        case "catalog.knownChunks":
          return { chunks: [...db.knownChunks(payload.lang).entries()] } as T;
        case "catalog.removeChunks":
          return { removed: db.removeChunks(payload.urls ?? []) } as T;
        case "catalog.applyChunk":
          return { rows: db.applyChunk(payload.chunk, payload.body) } as T;
        case "catalog.applyCurated":
          return db.applyCurated(payload.body) as T;
        case "catalog.setSyncState":
          db.setSyncState(payload.state);
          return { ok: true } as T;
        case "catalog.counts":
          return db.counts(payload.lang) as T;
        default:
          throw Error("未知 store 方法：" + method);
      }
    },
  };
}

/** 与站点同形的索引页：push 片段 + JS 字符串转义。 */
function indexHtml(
  chunks: { category: string; page: number; hash: string }[],
  totalCount = 19866,
): string {
  const manifest: Record<string, string[]> = {};
  for (const chunk of chunks)
    (manifest[chunk.category] ??= []).push(
      `/directory/zh/${chunk.category}-${chunk.page}-${chunk.hash}.json`,
    );
  const payload =
    `1:"$Sreact.fragment"\n` +
    `2:{"sidebarStats":{"totalCount":${totalCount},"categoryCounts":{}},"shardManifest":${JSON.stringify(manifest)}}`;
  return `<html><body><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script></body></html>`;
}

const ok = (body: string): FetchResult => ({ ok: true, status: 200, body });
const fail = (error: string): FetchResult => ({ ok: false, status: 0, body: "", error });

interface Harness {
  deps: SyncDeps;
  counts: () => ReturnType<CatalogDb["counts"]>;
  fetched: string[];
}

function harness(routes: Map<string, () => FetchResult>): Harness {
  const db = new CatalogDb(":memory:");
  const store = storeOf(db);
  const fetched: string[] = [];
  const deps: SyncDeps = {
    fetch: async (url) => {
      fetched.push(url);
      const route = routes.get(url);
      return route ? route() : fail("HTTP 404（桩未登记该地址）");
    },
    store,
    log: () => {},
    now: () => 1_700_000_000_000,
    siteBase: SITE,
    apiBase: API,
    locale: "zh",
    concurrency: 2,
  };
  return { deps, counts: () => db.counts(), fetched };
}

const CHUNK_A = { category: "agent", page: 1, hash: "aaaaaaaa" };
const CHUNK_B = { category: "agent", page: 2, hash: "bbbbbbbb" };

test("冷启动：取全部变更分片并合并 curated", async () => {
  const routes = new Map<string, () => FetchResult>([
    [`${SITE}/zh/plugins`, () => ok(indexHtml([CHUNK_A, CHUNK_B]))],
    [`${SITE}/directory/zh/agent-1-aaaaaaaa.json`, () => ok(shardBody)],
    [`${SITE}/directory/zh/agent-2-bbbbbbbb.json`, () => ok(otherBody)],
    [`${API}/plugins.zh.json`, () => ok(curatedBody)],
  ]);
  const h = harness(routes);
  const report = await syncCatalog(h.deps);
  assert.equal(report.refreshed, 2);
  assert.equal(report.skipped, 0);
  assert.deepEqual(report.failures, []);
  assert.equal(report.source, "manifest");
  assert.equal(report.totalCount, 19866);
  assert.equal(report.rows, 24, "两个分片各写 12 行");
  assert.ok(report.curated, "首次同步应合并 curated");
  assert.equal(h.counts().rows, 24);
  assert.equal(h.counts().chunks, 2);
  assert.equal(h.counts().lastError, null);
});

test("再次同步：同哈希分片全部跳过，curated 不重复下载", async () => {
  const routes = new Map<string, () => FetchResult>([
    [`${SITE}/zh/plugins`, () => ok(indexHtml([CHUNK_A, CHUNK_B]))],
    [`${SITE}/directory/zh/agent-1-aaaaaaaa.json`, () => ok(shardBody)],
    [`${SITE}/directory/zh/agent-2-bbbbbbbb.json`, () => ok(otherBody)],
    [`${API}/plugins.zh.json`, () => ok(curatedBody)],
  ]);
  const h = harness(routes);
  await syncCatalog(h.deps);
  const secondFetched: string[] = [];
  const deps: SyncDeps = {
    ...h.deps,
    fetch: async (url) => {
      secondFetched.push(url);
      return (routes.get(url) ?? (() => fail("HTTP 404")))();
    },
  };
  const report = await syncCatalog(deps);
  assert.equal(report.refreshed, 0);
  assert.equal(report.skipped, 2);
  assert.deepEqual(report.failures, []);
  assert.equal(report.curated, undefined, "无变更且 curated 未过期时不该再拉 4.16MB");
  assert.ok(
    !secondFetched.includes(`${API}/plugins.zh.json`),
    "curated 地址不应被再次访问",
  );
  assert.equal(h.counts().rows, 24, "数据保持不变");
});

test("清单里消失的分片：其行被清理，且计入 remove 而不是 failures", async () => {
  const routes = new Map<string, () => FetchResult>([
    [`${SITE}/zh/plugins`, () => ok(indexHtml([CHUNK_A, CHUNK_B]))],
    [`${SITE}/directory/zh/agent-1-aaaaaaaa.json`, () => ok(shardBody)],
    [`${SITE}/directory/zh/agent-2-bbbbbbbb.json`, () => ok(otherBody)],
    [`${API}/plugins.zh.json`, () => ok(curatedBody)],
  ]);
  const h = harness(routes);
  await syncCatalog(h.deps);
  assert.equal(h.counts().rows, 24);
  // 站点删掉了第二片
  routes.set(`${SITE}/zh/plugins`, () => ok(indexHtml([CHUNK_A])));
  const report = await syncCatalog(h.deps);
  assert.equal(report.refreshed, 0);
  assert.equal(report.skipped, 1);
  assert.deepEqual(report.failures, []);
  assert.equal(h.counts().rows, 12, "消失分片的行必须一起消失");
  assert.equal(h.counts().chunks, 1);
});

test("索引页取数失败：不动数据，把原因写进状态", async () => {
  const routes = new Map<string, () => FetchResult>([
    [`${SITE}/zh/plugins`, () => ok(indexHtml([CHUNK_A]))],
    [`${SITE}/directory/zh/agent-1-aaaaaaaa.json`, () => ok(shardBody)],
    [`${API}/plugins.zh.json`, () => ok(curatedBody)],
  ]);
  const h = harness(routes);
  await syncCatalog(h.deps);
  assert.equal(h.counts().rows, 12);
  routes.set(`${SITE}/zh/plugins`, () => fail("超时（30000ms）"));
  const report = await syncCatalog(h.deps);
  assert.equal(report.refreshed, 0);
  assert.equal(report.failures.length, 1);
  assert.equal(report.rows, 0);
  assert.equal(h.counts().rows, 12, "失败不得清空已有目录");
  assert.match(h.counts().lastError!, /索引页取数失败：超时/);
});

test("单个分片失败：其余照常写入，失败项被点名", async () => {
  const routes = new Map<string, () => FetchResult>([
    [`${SITE}/zh/plugins`, () => ok(indexHtml([CHUNK_A, CHUNK_B]))],
    [`${SITE}/directory/zh/agent-1-aaaaaaaa.json`, () => ok(shardBody)],
    [`${SITE}/directory/zh/agent-2-bbbbbbbb.json`, () => fail("HTTP 500")],
    [`${API}/plugins.zh.json`, () => ok(curatedBody)],
  ]);
  const h = harness(routes);
  const report = await syncCatalog(h.deps);
  assert.equal(report.refreshed, 1);
  assert.equal(report.skipped, 0);
  assert.equal(report.failures.length, 1);
  assert.match(report.failures[0]!.url, /agent-2-bbbbbbbb/);
  assert.match(report.failures[0]!.reason, /HTTP 500/);
  assert.equal(h.counts().rows, 12, "成功分片的 12 行必须落库");
  // 分片失败要重试一次：同一地址应被访问两次
  const attempts = (await Promise.all(
    [1, 2].map(async () => {
      const inner = harness(routes);
      await syncCatalog(inner.deps);
      return inner.fetched.filter((url) => url.includes("agent-2")).length;
    }),
  ))[0];
  assert.equal(attempts, 2, "失败分片必须重试一次");
  assert.match(h.counts().lastError!, /失败 1 个/);
});

test("清单与 URL 扫描都解析不出分片：如实报降级，不伪装成空目录", async () => {
  const routes = new Map<string, () => FetchResult>([
    [`${SITE}/zh/plugins`, () => ok("<html><body>改版了</body></html>")],
    [`${SITE}/sitemaps/plugins/1.xml`, () => ok(sitemapXml)],
  ]);
  const h = harness(routes);
  const report = await syncCatalog(h.deps);
  assert.equal(report.refreshed, 0);
  assert.equal(report.failures.length, 1);
  assert.match(report.degraded!, /sitemap 可用/);
  assert.match(h.counts().lastError!, /降级|sitemap/);
});

test("sitemap 兜底通道不可用时的降级说明", async () => {
  const routes = new Map<string, () => FetchResult>([
    [`${SITE}/zh/plugins`, () => ok("<html></html>")],
    [`${SITE}/sitemaps/plugins/1.xml`, () => fail("HTTP 503")],
  ]);
  const h = harness(routes);
  const report = await syncCatalog(h.deps);
  assert.match(report.degraded!, /sitemap 不可用/);
});

test("curated 过期（超过 24h）时即使分片无变化也会重新合并", async () => {
  const routes = new Map<string, () => FetchResult>([
    [`${SITE}/zh/plugins`, () => ok(indexHtml([CHUNK_A]))],
    [`${SITE}/directory/zh/agent-1-aaaaaaaa.json`, () => ok(shardBody)],
    [`${API}/plugins.zh.json`, () => ok(curatedBody)],
  ]);
  const h = harness(routes);
  await syncCatalog(h.deps);
  const later = { ...h.deps, now: () => 1_700_000_000_000 + 25 * 3600 * 1000 };
  const report = await syncCatalog(later);
  assert.equal(report.refreshed, 0);
  assert.equal(report.skipped, 1);
  assert.ok(report.curated, "过期后应重新合并 curated");
});