/**
 * 数据面解析的夹具回归。
 *
 * 夹具是**真实载荷的裁剪**（见 `scripts/capture-fixtures.mjs` 与
 * `tests/fixtures/provenance.json`），不是手写的玩具样本：这里钉住的正是
 * 「站点真的这么发、我们真的这么读」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  extractFlightPayload,
  findObjectEnd,
  findObjectStart,
  findOutsideString,
  readJsonObjectAfter,
  stringMask,
} from "../src/core/flight.ts";
import {
  extractPluginRecord,
  normalizeCuratedBody,
  normalizeShardBody,
  normalizeShardRecord,
  parseChunkUrl,
  readDetailRecord,
  readDetailRecordFromHtml,
  readShardManifest,
  readShardManifestFromHtml,
  readSitemapLocations,
} from "../src/core/site.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const indexHtml = fixture("site-index-zh.html");
const shardBody = fixture("site-shard-agent-1.json");
const curatedBody = fixture("curated-zh.json");
const detailHtml = fixture("detail-dsh-purge.html");
const sitemapXml = fixture("sitemap-plugins-1.xml");

test("flight: joins every push segment and undoes JS escapes", () => {
  const html =
    '<script>self.__next_f.push([0])</script>' +
    '<script>self.__next_f.push([1,"a\\"b"])</script>' +
    '<script>self.__next_f.push([1,"\\u4e2d\\x41\\n"])</script>';
  assert.equal(extractFlightPayload(html), 'a"b中A\n');
});

test("flight: reads an object only outside string literals", () => {
  // 键名先出现在字符串里、后出现在真实对象里：必须取后者。
  const payload = '{"note":"see \\"target\\":{}\\n here" ,"target":{"a":1}}';
  assert.deepEqual(readJsonObjectAfter(payload, "target"), { a: 1 });
  const mask = stringMask(payload);
  const inside = findOutsideString(payload, '"a":1', mask);
  assert.equal(typeof inside, "number");
  const start = findObjectStart(payload, inside!, mask);
  assert.equal(payload.slice(start!, start! + 7), '{"a":1}');
  assert.equal(findObjectEnd(payload, start!, mask), payload.length - 2);
});

test("flight: rejects a malformed or absent payload", () => {
  assert.equal(extractFlightPayload("<html>no flight here</html>"), "");
  assert.equal(readJsonObjectAfter("{}", "missing"), undefined);
  assert.equal(
    readJsonObjectAfter('{"target": [1,2]}', "target"),
    undefined,
    "非对象必须返回 undefined，而不是抛错",
  );
});

test("index page fixture yields the full shard manifest and site counts", () => {
  const manifest = readShardManifestFromHtml(indexHtml, "zh");
  assert.equal(manifest.source, "manifest");
  // 实测：zh 侧 37 个分片、站点自报 19,866 条收录。
  assert.equal(manifest.chunks.length, 37);
  assert.equal(manifest.totalCount, 19866);
  assert.equal(manifest.categoryCounts?.tools, 7908);
  const tools = manifest.chunks.filter((chunk) => chunk.category === "tools");
  assert.equal(tools.length, 13, "tools 是页数最多的分类");
  assert.ok(
    manifest.chunks.every(
      (chunk) => chunk.hash.length === 8 && chunk.page >= 1 && chunk.lang === "zh",
    ),
  );
  const urls = new Set(manifest.chunks.map((chunk) => chunk.url));
  assert.equal(urls.size, manifest.chunks.length, "清单里不应有重复分片");
});

test("index page parser degrades to URL scanning when the field is renamed", () => {
  // 站点改版：清单字段改名 → 仍能从载荷里扫出分片，但分类由文件名推出。
  const payload = extractFlightPayload(indexHtml).replaceAll(
    "shardManifest",
    "shardsRenamed",
  );
  const manifest = readShardManifest(payload, "zh");
  assert.equal(manifest.source, "url-scan");
  assert.equal(manifest.chunks.length, 37);
  assert.equal(manifest.totalCount, 19866, "计数仍应读到");
});

test("index page parser returns an empty manifest instead of inventing one", () => {
  const manifest = readShardManifest("nothing to see", "zh");
  assert.deepEqual(manifest.chunks, []);
  assert.equal(manifest.source, "url-scan");
  assert.equal(manifest.totalCount, undefined);
});

test("chunk url parsing rejects shapes it does not own", () => {
  assert.deepEqual(parseChunkUrl("/directory/zh/tools-13-5ec2fc05.json"), {
    url: "/directory/zh/tools-13-5ec2fc05.json",
    lang: "zh",
    category: "tools",
    page: 13,
    hash: "5ec2fc05",
  });
  for (const bad of [
    "/directory/zh/tools-13.json",
    "/directory/zh/tools-13-5EC2FC05.json",
    "/directory/zh/tools-0-5ec2fc05.json",
    "https://example.com/directory/zh/tools-1-aaaaaaaa.json?x=1",
  ])
    assert.equal(parseChunkUrl(bad), undefined, "must reject " + bad);
});

test("shard fixture keeps the site's raw record shape", () => {
  // 夹具必须是站点原文：早先误存了归一化产物，解析器把 12 条全丢了，
  // 而夹具本身「看起来是对的」。这条断言钉住输入格式。
  const raw = JSON.parse(shardBody);
  assert.equal(raw.length, 12);
  assert.ok(raw.every((record: any) => record.source?.repo));
  assert.ok(raw.every((record: any) => !("stars" in record)));
});

test("shard fixture normalizes to catalog rows", () => {
  const rows = normalizeShardBody(shardBody);
  assert.equal(rows.length, 12);
  const first = rows[0]!;
  assert.ok(first.slug !== "" && first.repo.includes("/"));
  assert.ok(first.description.length > 0);
  assert.equal(typeof first.stars, "number");
  assert.ok(first.repoUpdatedAt.length > 0, "更新判据依赖 repoUpdatedAt");
  // 站点在分片里**不下发**版本号与安装命令：这里必须留空，不能补默认值。
  assert.ok(!("version" in first));
  assert.ok(!("installCommand" in first));
});

test("shard normalization drops rows without a key or a source", () => {
  assert.equal(normalizeShardRecord({ name: "no-slug" }), undefined);
  assert.equal(
    normalizeShardRecord({ slug: "x", source: { repo: "" } }),
    undefined,
  );
  assert.equal(normalizeShardRecord("not an object"), undefined);
  // 其余字段缺失只留空，不报错。
  const bare = normalizeShardRecord({ slug: "x", source: { repo: "o/r" } });
  assert.equal(bare?.displayName, "x");
  assert.equal(bare?.repoUpdatedAt, "");
  assert.equal(bare?.dshTopic, false);
  assert.deepEqual(bare?.topics, []);
  assert.equal(bare?.stars, 0);
});

test("curated api uses short keys and must not share the shard normalizer", () => {
  const records = normalizeCuratedBody(curatedBody);
  assert.equal(records.length, 9);
  assert.ok(records.every((record) => record.slug !== "" && record.repo !== ""));
  const withVersion = records.filter((record) => record.versionTag);
  // curated 的价值就在于它有版本 tag；夹具里刻意留了 1 条不在分片夹具里的对照项。
  assert.ok(withVersion.length >= 1, "curated 夹具必须含版本 tag 样本");
  assert.ok(
    records.some((record) => record.installNpm?.startsWith("dsh plugin")),
  );
  // 分片归一化器读全名键；喂 curated 短键记录时应当丢弃而不是产出空行。
  assert.equal(normalizeShardRecord(JSON.parse(curatedBody)[0]), undefined);
});

test("detail page fixture yields version and the exact install command", () => {
  const detail = readDetailRecordFromHtml(detailHtml);
  assert.ok(detail, "detail record must parse");
  assert.equal(detail!.slug, "dsh-purge");
  assert.equal(detail!.repo, "yujunzhixue/dsh-purge");
  assert.equal(detail!.version, "v1.1.85");
  assert.equal(detail!.installType, "github");
  assert.match(detail!.installCommand!, /^dsh plugin --profile web add /);
  assert.equal(detail!.npmPackage, "");
  assert.equal(detail!.status, "verified");
  assert.deepEqual(detail!.platforms, ["dsh-plugin"]);
});

test("detail parser ignores unrelated keys that appear earlier in the page", () => {
  // 真实踩到过：页面里 JSON-LD 的 `"type":"application/ld+json"` 抢先命中，
  // 于是 install.type 读成了 MIME 类型。锚点必须锁定插件记录对象。
  const payload =
    '<script type="application/ld+json">{"@type":"SoftwareApplication","type":"application/ld+json","slug":"other","source":{"repo":"a/b"}}</script>' +
    '<script>self.__next_f.push([1,"{\\"slug\\":\\"real\\",\\"source\\":{\\"repo\\":\\"o/r\\",\\"npmPackage\\":\\"\\"},\\"install\\":{\\"type\\":\\"npm\\",\\"command\\":\\"dsh plugin --profile web add pkg\\"},\\"compatibility\\":{\\"dshTarget\\":\\"rc.6\\",\\"status\\":\\"verified\\",\\"platforms\\":[\\"dsh-plugin\\"]}}"])</script>';
  const record = readDetailRecord(extractFlightPayload(payload));
  assert.equal(record?.slug, "real");
  assert.equal(record?.installType, "npm");
  assert.equal(record?.dshTarget, "rc.6");
});

test("detail parser returns undefined rather than a half record", () => {
  assert.equal(readDetailRecord("no payload"), undefined);
  assert.equal(
    readDetailRecord('{"slug":"x"}'),
    undefined,
    "缺 source.repo 的记录必须整体丢弃",
  );
});

test("extractPluginRecord returns the exact source text it parsed", () => {
  const extracted = extractPluginRecord(extractFlightPayload(detailHtml));
  assert.ok(extracted);
  assert.equal(JSON.parse(extracted!.text).slug, "dsh-purge");
  assert.ok(extracted!.text.startsWith("{") && extracted!.text.endsWith("}"));
});

test("sitemap fallback enumerates detail urls", () => {
  const locations = readSitemapLocations(sitemapXml);
  assert.equal(locations.length, 8);
  assert.ok(locations.every((url) => url.startsWith("https://dsh-plugin.org/")));
  assert.equal(readSitemapLocations("<urlset></urlset>").length, 0);
});