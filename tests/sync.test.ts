/**
 * 同步计划与结果口径的夹具回归。
 *
 * 关键口径：分片 URL 内容寻址（文件名 8 位哈希即内容指纹），因此
 * 「本地同 URL 同哈希」＝必然跳过；「本地有、清单没有」＝陈旧分片要清理。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { describeRefresh, planSync, type RefreshOutcome } from "../src/core/sync.ts";
import type { ChunkRef, ShardManifest } from "../src/core/types.ts";

const chunk = (category: string, page: number, hash: string): ChunkRef => ({
  url: `/directory/zh/${category}-${page}-${hash}.json`,
  lang: "zh",
  category,
  page,
  hash,
});

const manifest = (chunks: ChunkRef[]): ShardManifest => ({
  lang: "zh",
  chunks,
  source: "manifest",
});

test("cold start fetches every shard and skips none", () => {
  const plan = planSync(manifest([chunk("tools", 1, "aaaaaaaa"), chunk("tools", 2, "bbbbbbbb")]), new Map());
  assert.equal(plan.fetch.length, 2);
  assert.equal(plan.skipped, 0);
  assert.deepEqual(plan.remove, []);
});

test("unchanged shards are skipped, changed content arrives as a new url", () => {
  const known = new Map([
    ["/directory/zh/tools-1-aaaaaaaa.json", "aaaaaaaa"],
    ["/directory/zh/tools-2-bbbbbbbb.json", "bbbbbbbb"],
  ]);
  // tools-2 内容变了：站点发的是新哈希文件名，旧 URL 随之消失。
  const plan = planSync(
    manifest([
      chunk("tools", 1, "aaaaaaaa"),
      chunk("tools", 2, "cccccccc"),
    ]),
    known,
  );
  assert.equal(plan.skipped, 1, "同 URL 同哈希必然跳过");
  assert.deepEqual(
    plan.fetch.map((entry) => entry.url),
    ["/directory/zh/tools-2-cccccccc.json"],
  );
  assert.deepEqual(plan.remove, ["/directory/zh/tools-2-bbbbbbbb.json"]);
});

test("vanished shards are reported for cleanup, not silently kept", () => {
  const known = new Map([
    ["/directory/zh/fun-1-b9ffc203.json", "b9ffc203"],
    ["/directory/zh/tools-1-aaaaaaaa.json", "aaaaaaaa"],
  ]);
  const plan = planSync(manifest([chunk("tools", 1, "aaaaaaaa")]), known);
  assert.deepEqual(plan.remove, ["/directory/zh/fun-1-b9ffc203.json"]);
  assert.equal(plan.fetch.length, 0);
  assert.equal(plan.skipped, 1);
});

test("duplicated urls in the manifest are counted once", () => {
  const plan = planSync(
    manifest([chunk("tools", 1, "aaaaaaaa"), chunk("tools", 1, "aaaaaaaa")]),
    new Map(),
  );
  assert.equal(plan.fetch.length, 1);
  assert.equal(plan.skipped, 0);
});

test("a shard whose url kept its page but changed hash is refetched", () => {
  // 内容寻址下同 URL 不同哈希不该出现；真出现时必须重取，
  // 且因为清单里没有旧 URL，旧分片同时进入待清理列表。
  const known = new Map([["/directory/zh/tools-1-aaaaaaaa.json", "aaaaaaaa"]]);
  const plan = planSync(manifest([chunk("tools", 1, "dddddddd")]), known);
  assert.equal(plan.fetch.length, 1);
  assert.equal(plan.skipped, 0);
  assert.deepEqual(plan.remove, ["/directory/zh/tools-1-aaaaaaaa.json"]);
});

test("refresh outcome keeps three mutually exclusive buckets and names failures", () => {
  const outcome: RefreshOutcome = {
    refreshed: 3,
    skipped: 34,
    failures: [{ url: "/directory/zh/tools-9-ffffffff.json", reason: "HTTP 500" }],
    rows: 19866,
    totalCount: 19866,
    degraded: "清单来自 URL 扫描兜底",
  };
  const line = describeRefresh(outcome);
  assert.match(line, /已更新 3\/37 个分片/);
  assert.match(line, /跳过 34 个（内容未变）/);
  assert.match(line, /失败 1 个：.*HTTP 500/);
  assert.match(line, /降级/);
  const quiet = describeRefresh({ refreshed: 2, skipped: 0, failures: [], rows: 20 });
  assert.equal(quiet, "已更新 2/2 个分片。");
});