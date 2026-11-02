/**
 * 夹具抓取（维护用，**必须显式联网**）。
 *
 * 用法：`node --experimental-transform-types scripts/capture-fixtures.mjs --network`
 *
 * 为什么不是简单的「把响应存下来」：
 *  - 索引页 253KB、单分片 626KB、详情页 152KB、sitemap 单分片 971KB，整份入库
 *    会把仓库撑大；这里只保留**解析器真正需要**的部分（分片留前 N 条、
 *    详情页只留该插件的那一个记录对象、sitemap 只留前几条 URL）。
 *  - 抓取时顺手跑一遍真实的解析器（`src/core/flight.ts` / `site.ts`），
 *    因此「夹具是真实的」和「解析器对真实载荷有效」在同一处得到验证。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractFlightPayload } from "../src/core/flight.ts";
import {
  extractPluginRecord,
  normalizeCuratedBody,
  normalizeShardBody,
  readDetailRecord,
  readShardManifest,
} from "../src/core/site.ts";

const NETWORK = process.argv.includes("--network");
if (!NETWORK) {
  console.error(
    "夹具抓取会访问 dsh-plugin.org，必须显式传 --network；常规 npm run check 不联网。",
  );
  process.exit(2);
}

const SITE = process.env.PLUGIN_HARBOR_SITE ?? "https://dsh-plugin.org";
const API = process.env.PLUGIN_HARBOR_API ?? "https://api.dsh-plugin.org";
const OUT = "tests/fixtures";
/** 分片夹具保留的条数：够覆盖字段缺失分支，又不至于把仓库撑大。 */
const SHARD_ROWS = 12;
/** sitemap 夹具保留的 URL 条数。 */
const SITEMAP_URLS = 8;

async function get(url) {
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw Error(`${url} -> HTTP ${response.status}`);
  return response.text();
}

/** 段落式 HTML：把载荷按 Next 的真实形态（JS 字符串转义）包进 push 片段。 */
function wrapPayload(payload, segments = 1) {
  const size = Math.ceil(payload.length / segments);
  const parts = [];
  for (let i = 0; i < segments; i++) {
    const slice = payload.slice(i * size, (i + 1) * size);
    if (slice === "") continue;
    parts.push(`<script>self.__next_f.push([1,${JSON.stringify(slice)}])</script>`);
  }
  return `<!doctype html><html><head><title>fixture</title></head><body>\n${parts.join("\n")}\n</body></html>\n`;
}

/** 从载荷里切出含某键的第一个完整 JSON 对象（花括号配平，忽略字符串内的括号）。 */
function sliceObject(payload, needle) {
  const at = payload.indexOf(needle);
  if (at === -1) throw Error("载荷里找不到 " + needle);
  const start = payload.lastIndexOf("{", at);
  let depth = 0;
  let inString = false;
  for (let i = start; i < payload.length; i++) {
    const ch = payload[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return payload.slice(start, i + 1);
    }
  }
  throw Error("对象未闭合：" + needle);
}

const provenance = { fetchedAt: new Date().toISOString(), site: SITE, api: API, sources: {} };
mkdirSync(OUT, { recursive: true });

// --- 1. 索引页：清单 + 计数 -------------------------------------------------
const indexHtml = await get(`${SITE}/zh/plugins`);
const indexPayload = extractFlightPayload(indexHtml);
const manifest = readShardManifest(indexPayload, "zh");
if (manifest.chunks.length === 0) throw Error("索引页载荷没有解析出任何分片");
console.log(
  `index: payload=${indexPayload.length} chunks=${manifest.chunks.length} source=${manifest.source} total=${manifest.totalCount}`,
);
writeFileSync(
  join(OUT, "site-index-zh.html"),
  wrapPayload(indexPayload, 3),
  "utf8",
);
provenance.sources["site-index-zh.html"] = {
  url: `${SITE}/zh/plugins`,
  bytes: indexHtml.length,
  kept: `${indexPayload.length} 字符 Flight 载荷（3 段）`,
  parsed: { chunks: manifest.chunks.length, totalCount: manifest.totalCount ?? null },
};

// --- 2. 分片：留前 N 条 ------------------------------------------------------
const firstChunk = manifest.chunks[0];
const shardBody = await get(`${SITE}${firstChunk.url}`);
const shardRows = normalizeShardBody(shardBody);
console.log(`shard ${firstChunk.url}: rows=${shardRows.length}`);
/**
 * ⚠️ 必须写**站点原始记录**，不是归一化后的行：夹具的职责是让解析器对真实
 * 输入格式做回归。本轮实测踩到过 —— 早先写入的是 `normalizeShardBody()` 的
 * 产物（键名已变成 `repo`/`stars`），测试再把夹具喂回解析器时 12 条全被丢弃，
 * 而夹具本身"看起来是对的"。
 */
const shardRaw = JSON.parse(shardBody);
if (!Array.isArray(shardRaw)) throw Error("分片原文不是 JSON 数组");
writeFileSync(
  join(OUT, `site-shard-${firstChunk.category}-${firstChunk.page}.json`),
  JSON.stringify(shardRaw.slice(0, SHARD_ROWS)),
  "utf8",
);
provenance.sources[`site-shard-${firstChunk.category}-${firstChunk.page}.json`] = {
  url: `${SITE}${firstChunk.url}`,
  bytes: shardBody.length,
  kept: `站点原始记录前 ${SHARD_ROWS} 条（共 ${shardRows.length} 条；保留原文键名）`,
  hash: firstChunk.hash,
};

// --- 3. curated API：只留与分片相交（另加 1 条不相交用于验证合并） -----------
const curatedBody = await get(`${API}/plugins.zh.json`);
const curated = normalizeCuratedBody(curatedBody);
const slugs = new Set(shardRows.slice(0, SHARD_ROWS).map((row) => row.slug));
const curatedSlice = curated.filter((record) => slugs.has(record.slug));
const stranger = curated.find((record) => !slugs.has(record.slug) && record.versionTag);
if (stranger) curatedSlice.push(stranger);
console.log(`curated: rows=${curated.length} kept=${curatedSlice.length}`);
if (curatedSlice.length === 0) throw Error("curated 夹具与分片夹具没有交集");
// 夹具保留短键原文：调用方理应通过 normalizeCuratedBody 读它。
const curatedRaw = JSON.parse(curatedBody);
const rawBySlug = new Map(curatedRaw.map((record) => [record.s, record]));
writeFileSync(
  join(OUT, "curated-zh.json"),
  JSON.stringify(
    curatedSlice.map((record) => rawBySlug.get(record.slug)),
    null,
    0,
  ),
  "utf8",
);
provenance.sources["curated-zh.json"] = {
  url: `${API}/plugins.zh.json`,
  bytes: curatedBody.length,
  kept: `${curatedSlice.length} 条（含 1 条不在分片夹具里的对照项）`,
};

// --- 4. 详情页：只留目标插件的那一个记录对象 --------------------------------
const detailSlug = "yujunzhixue/dsh-purge";
const detailHtml = await get(`${SITE}/zh/plugins/${detailSlug}`);
const detailPayload = extractFlightPayload(detailHtml);
const detailRecord = readDetailRecord(detailPayload);
if (!detailRecord?.installCommand) throw Error("详情页载荷里没有安装命令");
// 夹具只留这一个插件记录对象（其余相邻插件、样式与脚本都不进仓库）。
const extracted = extractPluginRecord(detailPayload);
if (!extracted) throw Error("详情页载荷里定位不到插件记录对象");
const detailSlice = extracted.text;
writeFileSync(
  join(OUT, "detail-dsh-purge.html"),
  wrapPayload(detailSlice, 2),
  "utf8",
);
console.log(
  `detail: ${detailRecord.slug} version=${detailRecord.version} install=${detailRecord.installType} target=${detailRecord.dshTarget === "" ? "(空)" : detailRecord.dshTarget}`,
);
provenance.sources["detail-dsh-purge.html"] = {
  url: `${SITE}/zh/plugins/${detailSlug}`,
  bytes: detailHtml.length,
  kept: `该插件的记录对象 ${detailSlice.length} 字符（2 段）`,
  parsed: {
    version: detailRecord.version ?? null,
    installType: detailRecord.installType ?? null,
    dshTarget: detailRecord.dshTarget ?? null,
    webInstallable: detailRecord.webInstallable ?? null,
  },
};

// --- 5. sitemap 兜底通道：留前若干条 URL -------------------------------------
const sitemapBody = await get(`${SITE}/sitemaps/plugins/1.xml`);
const locations = [...sitemapBody.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
if (locations.length === 0) throw Error("sitemap 分片里没有 <loc>");
writeFileSync(
  join(OUT, "sitemap-plugins-1.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locations
    .slice(0, SITEMAP_URLS)
    .map((loc) => `  <url><loc>${loc}</loc></url>`)
    .join("\n")}\n</urlset>\n`,
  "utf8",
);
console.log(`sitemap: locs=${locations.length} kept=${SITEMAP_URLS}`);
provenance.sources["sitemap-plugins-1.xml"] = {
  url: `${SITE}/sitemaps/plugins/1.xml`,
  bytes: sitemapBody.length,
  kept: `前 ${SITEMAP_URLS} 条 URL（共 ${locations.length} 条）`,
};

writeFileSync(
  join(OUT, "provenance.json"),
  JSON.stringify(provenance, null, 2) + "\n",
  "utf8",
);
console.log("夹具已写入 " + OUT + "（来源与裁剪口径见 provenance.json）");