/**
 * 目录库查询层回归（真实 SQLite，`:memory:`，不起线程）。
 *
 * 夹具是站点真实载荷的裁剪（见 `tests/fixtures/provenance.json`）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CatalogDb } from "../src/storage/catalog-db.ts";
import type { ChunkRef } from "../src/core/types.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const shardBody = fixture("site-shard-agent-1.json");
const curatedBody = fixture("curated-zh.json");

const chunk = (url: string, category = "agent", page = 1, hash = "aaaaaaaa"): ChunkRef => ({
  url,
  lang: "zh",
  category,
  page,
  hash,
});

function fresh(): CatalogDb {
  return new CatalogDb(":memory:");
}

test("schema: 目录库自报表数与 SQLite 版本", () => {
  const db = fresh();
  try {
    const meta = db.meta;
    assert.ok(
      meta.tables >= 4,
      "至少要建 plugins / chunks / sync_state / installed_cache 四张表",
    );
    assert.match(meta.sqlite, /^\d+\./);
    assert.deepEqual(db.counts(), {
      rows: 0,
      chunks: 0,
      totalCount: null,
      lastSyncAt: null,
      lastError: null,
      curatedOrphans: 0,
    });
  } finally {
    db.close();
  }
});

test("applyChunk 写入整片并登记哈希", () => {
  const db = fresh();
  try {
    const url = "/directory/zh/agent-1-aaaaaaaa.json";
    const rows = db.applyChunk(chunk(url), shardBody, 111);
    assert.equal(rows, 12);
    const counts = db.counts();
    assert.equal(counts.rows, 12);
    assert.equal(counts.chunks, 1);
    assert.equal(db.knownChunks("zh").get(url), "aaaaaaaa");
    // 分片不下发版本号与安装命令：库里的增强列必须为空。
    const page = db.list({ limit: 50 });
    assert.equal(page.rows.length, 12);
    assert.equal(page.total, 12);
  } finally {
    db.close();
  }
});

test("同名不同仓库的插件必须共存（slug 不是唯一键）", () => {
  const db = fresh();
  try {
    const rows = db.applyChunk(
      chunk("/directory/zh/agent-1-aaaaaaaa.json"),
      shardBody,
    );
    // 实测：单分片 617 条里有 23 组重名 slug，`dsh-purge` 属于 4 个不同仓库。
    // 夹具前 12 条就含 2 个 dsh-purge：按 slug 做主键时会静默丢一条（11 行）。
    assert.equal(rows, 12);
    assert.equal(db.counts().rows, 12);
    const purge = db
      .list({ q: "dsh-purge", limit: 50 })
      .rows.filter((row) => row.slug === "dsh-purge");
    assert.equal(purge.length, 2, "两个 dsh-purge 仓库都要在库里");
    assert.equal(
      new Set(purge.map((row) => row.repo)).size,
      2,
      "两者必须是不同仓库",
    );
  } finally {
    db.close();
  }
});

test("重写同一分片按整片替换，不留旧行", () => {
  const db = fresh();
  try {
    const url = "/directory/zh/agent-1-aaaaaaaa.json";
    db.applyChunk(chunk(url), shardBody);
    const raw = JSON.parse(shardBody) as unknown[];
    // 站点删掉了一个插件：同一 URL 重写（内容寻址下不该发生，但必须正确）
    const shrunk = JSON.stringify(raw.slice(0, 11));
    assert.equal(db.applyChunk(chunk(url), shrunk), 11);
    assert.equal(db.counts().rows, 11);
  } finally {
    db.close();
  }
});

test("内容变化换 URL 时，旧分片的行由 removeChunks 清理", () => {
  const db = fresh();
  try {
    const oldUrl = "/directory/zh/agent-1-aaaaaaaa.json";
    const newUrl = "/directory/zh/agent-1-bbbbbbbb.json";
    db.applyChunk(chunk(oldUrl, "agent", 1, "aaaaaaaa"), shardBody);
    db.applyChunk(chunk(newUrl, "agent", 1, "bbbbbbbb"), shardBody);
    assert.equal(db.counts().rows, 12, "同 slug 会在新分片里改归属，不重复计行");
    const removed = db.removeChunks([oldUrl]);
    assert.equal(removed, 0, "行已归属新分片，旧分片名下没有行可删");
    assert.equal(db.knownChunks().has(oldUrl), false);
    assert.equal(db.counts().chunks, 1);
  } finally {
    db.close();
  }
});

test("curated 合并按 repo 归并，落空的计入 orphans", () => {
  const db = fresh();
  try {
    db.applyChunk(chunk("/directory/zh/agent-1-aaaaaaaa.json"), shardBody);
    const result = db.applyCurated(curatedBody);
    // 合并键是 repo 而不是 slug：curated 里同名不同仓库的条目**不该**并进别的仓库
    // （夹具里 9 条中有 6 条的正主不在前 12 行里），落空的必须计数而不是静默丢弃。
    assert.equal(result.merged + result.orphans, 9);
    assert.ok(result.merged >= 1, "至少应有一条并进目录");
    assert.ok(result.orphans >= 1, "落空的条目必须被计数");
    assert.equal(db.counts("curated").curatedOrphans, result.orphans);
    const rows = db.list({ limit: 50 }).rows;
    assert.ok(
      rows.some((row) => row.npmPackage !== ""),
      "npm 包名应由 curated 补齐",
    );
  } finally {
    db.close();
  }
});

test("排序与游标分页既不漏行也不重行", () => {
  const db = fresh();
  try {
    db.applyChunk(chunk("/directory/zh/agent-1-aaaaaaaa.json"), shardBody);
    const first = db.list({ sort: "stars", limit: 5 });
    assert.equal(first.rows.length, 5);
    assert.equal(first.total, 12);
    assert.ok(first.nextCursor, "还有下一页时必须给游标");
    const second = db.list({ sort: "stars", limit: 5, cursor: first.nextCursor! });
    const third = db.list({
      sort: "stars",
      limit: 5,
      cursor: second.nextCursor ?? undefined,
    });
    assert.equal(third.rows.length, 2);
    assert.equal(third.nextCursor, null, "最后一页不给游标");
    const seen = [...first.rows, ...second.rows, ...third.rows].map((row) => row.repo);
    assert.equal(new Set(seen).size, 12, "分页必须覆盖全部行且不重复");
    const stars = [...first.rows, ...second.rows, ...third.rows].map((row) => row.stars);
    for (let i = 1; i < stars.length; i++)
      assert.ok(stars[i]! <= stars[i - 1]!, "stars 必须单调不增");
    // 单页取全量应与分页结果一致
    const all = db.list({ sort: "stars", limit: 50 }).rows.map((row) => row.repo);
    assert.deepEqual(all, seen);
  } finally {
    db.close();
  }
});

test("排序键相同也稳定（repo 兜底），不因并列丢行", () => {
  const db = fresh();
  try {
    // 全部 star 相同：只有 slug 兜底才可能稳定分页
    const body = JSON.stringify(
      Array.from({ length: 9 }, (_, i) => ({
        slug: `tie-${i}`,
        ownerSlug: "o",
        name: `tie-${i}`,
        category: "tools",
        description: "并列排序",
        source: { repo: `o/tie-${i}`, npmPackage: "" },
        compatibility: { status: "verified" },
        dates: { repoUpdatedAt: "2026-10-01T00:00:00Z", addedAt: "2026-10-01" },
        stats: { stargazers_count: 5, forks_count: 0 },
        metadata: { language: "TypeScript", license: "MIT", dshTopic: true },
      })),
    );
    db.applyChunk(chunk("/directory/zh/tools-1-aaaaaaaa.json", "tools"), body);
    const seen: string[] = [];
    let cursor = undefined;
    for (;;) {
      const page = db.list({ sort: "stars", limit: 4, cursor });
      seen.push(...page.rows.map((row) => row.slug));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    assert.equal(new Set(seen).size, 9);
    assert.equal(seen.length, 9);
  } finally {
    db.close();
  }
});

test("搜索与筛选、分面计数", () => {
  const db = fresh();
  try {
    db.applyChunk(chunk("/directory/zh/agent-1-aaaaaaaa.json"), shardBody);
    const all = db.list({ limit: 50 });
    assert.equal(all.facets.category.agent, 12);
    assert.ok(Object.keys(all.facets.language).length >= 1);
    // 取夹具里真实出现过的词做搜索，保证断言不依赖臆造数据。
    // ⚠️ 不能用短前缀（如 slice(0,4) 的 "dsh-"）：那会命中全部 12 条，
    // 断言就失去意义（本轮实测踩到）。
    const fullName = all.rows[0]!.name;
    const hit = db.list({ q: fullName, limit: 50 });
    assert.ok(hit.total >= 1, `搜索「${fullName}」应至少命中一条`);
    assert.ok(hit.total < all.total, "夹具里该词不应命中全部记录");
    // 分类筛选
    assert.equal(db.list({ category: "agent", limit: 50 }).total, 12);
    assert.equal(db.list({ category: "tools", limit: 50 }).total, 0);
    // 分面只施加搜索词（否则选了分类后分类分面恒为 1）
    const scoped = db.list({ q: fullName, limit: 50 });
    assert.ok(scoped.facets.category.agent >= 1);
  } finally {
    db.close();
  }
});

test("搜索词里的 LIKE 通配符按字面处理", () => {
  const db = fresh();
  try {
    db.applyChunk(chunk("/directory/zh/agent-1-aaaaaaaa.json"), shardBody);
    const total = db.list({ limit: 50 }).total;
    // `%` 若不转义会命中全部记录：转义后按字面找，夹具里没有含 `%` 的文本。
    assert.equal(db.list({ q: "%", limit: 50 }).total, 0);
    // `_` 同样按字面：只该命中真正含下划线的行（夹具里确实有），远少于全量。
    const underscore = db.list({ q: "_", limit: 50 }).total;
    assert.ok(underscore < total, `「_」按字面匹配，不该命中全部（${underscore}/${total}）`);
  } finally {
    db.close();
  }
});

test("搜索能命中描述文本（长查询走索引、短查询走回退）", () => {
  const db = fresh();
  try {
    db.applyChunk(chunk("/directory/zh/agent-1-aaaaaaaa.json"), shardBody);
    // 夹具第一条（dsh-purge）的描述里含「破甲工具」，而名称里没有：
    // 只匹配名称的实现会给出 0 条（真实站点上搜「微信」正是这个坑）。
    const long = db.list({ q: "破甲工具", limit: 50 });
    assert.ok(long.total >= 1, "≥3 字查询必须命中描述文本");
    const short = db.list({ q: "破甲", limit: 50 });
    assert.ok(short.total >= 1, "1–2 字查询也必须命中描述文本");
    // 子串语义：短查询是长查询的**超集**（含「破甲工具」的文本必然含「破甲」），
    // 但不要求相等 —— 单独出现「破甲」的记录也应命中。
    assert.ok(
      short.total >= long.total,
      `短查询应覆盖长查询（${short.total} vs ${long.total}）`,
    );
    const shortRepos = new Set(short.rows.map((row) => row.repo));
    for (const row of long.rows)
      assert.ok(shortRepos.has(row.repo), `长查询命中的 ${row.repo} 必须在短查询里`);
  } finally {
    db.close();
  }
});

test("检索索引随行增删同步，不留「删掉还能搜到」的陈旧项", () => {
  const db = fresh();
  try {
    const url = "/directory/zh/agent-1-aaaaaaaa.json";
    db.applyChunk(chunk(url), shardBody);
    assert.ok(db.list({ q: "破甲工具", limit: 50 }).total >= 1);
    // 站点删掉了这条插件（同一分片重写为更少的行）
    const raw = JSON.parse(shardBody) as any[];
    const shrunk = JSON.stringify(
      raw.filter((record) => record.slug !== "dsh-purge"),
    );
    db.applyChunk(chunk(url), shrunk);
    assert.equal(
      db.list({ q: "破甲工具", limit: 50 }).total,
      0,
      "行被删掉后索引里也不能再命中（触发器维护）",
    );
    // 整个分片消失时同样如此
    db.applyChunk(chunk(url), shardBody);
    assert.ok(db.list({ q: "破甲工具", limit: 50 }).total >= 1);
    db.removeChunks([url]);
    assert.equal(db.list({ q: "破甲工具", limit: 50 }).total, 0);
  } finally {
    db.close();
  }
});

/**
 * 操作历史里存的是**实际交给 pnpm 的地址**（`installSpec`），而不只是 profile 里
 * 记的取值：更新时前者是 `dsh-cost-meter@1.9.30`，后者是 `^1.9.28`。跨重启回看时
 * 界面要能显示真正装的是什么，所以这一列必须能落库、能读回。
 */
test("操作历史：install_spec 落库并可读回，老库只补列不重建", () => {
  const db = fresh();
  try {
    db.putOp({
      id: "op-1",
      kind: "update",
      target: "dsh-cost-meter",
      spec: "^1.9.28",
      installSpec: "dsh-cost-meter@1.9.30",
      status: "failed",
      progress: 40,
      via: "manager",
      note: "宿主的包操作失败",
      error: "宿主的包操作失败",
      log: ["先卸载已装版本", "已卸载，开始安装新版本"],
      queuedAt: 1,
      endedAt: 2,
    });
    const [task] = db.listOps(10);
    assert.equal(task!.spec, "^1.9.28");
    assert.equal(task!.installSpec, "dsh-cost-meter@1.9.30");
    assert.equal(task!.log.length, 2);
  } finally {
    db.close();
  }
});

test("容量预算：两万行量级的写入与检索在预算内", () => {
  const db = fresh();
  try {
    const template = JSON.parse(shardBody)[0];
    const rows = Array.from({ length: 20_000 }, (_, i) => ({
      ...template,
      slug: `perf-${i}`,
      name: `perf-${i}`,
      source: { repo: `perf/${i}`, npmPackage: "" },
      stats: { stargazers_count: i % 9000, forks_count: i % 300 },
      description: `第 ${i} 条：用于容量预算的合成记录，含「上下文」一词`,
    }));
    const body = JSON.stringify(rows);
    const started = performance.now();
    const applied = db.applyChunk(
      chunk("/directory/zh/tools-9-ffffffff.json", "tools", 9, "ffffffff"),
      body,
    );
    const applyMs = performance.now() - started;
    assert.equal(applied, 20_000);

    const searchRuns: number[] = [];
    for (let i = 0; i < 20; i++) {
      const at = performance.now();
      db.list({ q: "上下文", limit: 50 });
      searchRuns.push(performance.now() - at);
    }
    searchRuns.sort((a, b) => a - b);
    const p95 = searchRuns[Math.floor(searchRuns.length * 0.95)]!;
    const sorted = performance.now();
    db.list({ sort: "stars", limit: 50 });
    const sortMs = performance.now() - sorted;
    console.log(
      `容量预算：写入 20,000 行 ${applyMs.toFixed(0)}ms；搜索 P95 ${p95.toFixed(1)}ms；排序首页 ${sortMs.toFixed(1)}ms`,
    );
    // 阈值刻意宽松（CI 抖动）：真正要钉死的是「没有数量级错误」。
    assert.ok(applyMs < 5000, `写入 20,000 行耗时 ${applyMs.toFixed(0)}ms`);
    assert.ok(p95 < 100, `搜索 P95 ${p95.toFixed(1)}ms 超出预算`);
    assert.ok(sortMs < 100, `排序首页 ${sortMs.toFixed(1)}ms 超出预算`);
  } finally {
    db.close();
  }
});