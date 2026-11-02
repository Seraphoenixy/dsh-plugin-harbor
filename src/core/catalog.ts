/**
 * 目录同步编排。
 *
 * 一次同步 = 索引页（分片清单）→ 内容寻址的增量计划 → 取变更分片（解析与写库
 * 都在 worker 线程）→ 清理消失分片 → curated 增强合并 → 落状态。
 *
 * ⚠️ 三桶互斥（refreshed / skipped / failures）与「部分失败不致命」是刻意的：
 * 参考项目 channel-hub 2026-10-29 的实测教训是「把有任一失败的整批计成失败，
 * 界面就会否认已经发生的事实」。这里只把**真的没取到**的分片记进 failures。
 */
import { extractFlightPayload } from "./flight.ts";
import {
  readDetailRecord,
  readShardManifest,
  readSitemapLocations,
} from "./site.ts";
import { describeRefresh, planSync, type RefreshOutcome } from "./sync.ts";
import type { ChunkRef, DetailRecord } from "./types.ts";
import type { FetchResult } from "../upstream/fetch.ts";
import { mapLimited } from "../upstream/fetch.ts";

export interface SyncDeps {
  fetch: (
    url: string,
    options?: { timeoutMs?: number; etag?: string },
  ) => Promise<FetchResult>;
  store: { call<T = any>(method: string, payload?: any): Promise<T> };
  log: (message: string) => void;
  now: () => number;
  siteBase: string;
  apiBase: string;
  locale: "zh" | "en";
  concurrency?: number;
}

export interface SyncReport extends RefreshOutcome {
  /** 清单来源：`manifest` 为站点自报，`url-scan` 为改版后的兜底。 */
  source: string;
  curated?: { merged: number; orphans: number };
}

/** 分片约 626KB，弱网/代理链路上 30s 不够，给 60s；索引页 253KB 给 30s。 */
const SHARD_TIMEOUT_MS = 60_000;
const INDEX_TIMEOUT_MS = 30_000;
const CURATED_TIMEOUT_MS = 120_000;
/** curated（4.16MB）不是每次都要重下：无分片变化且未过期就复用上一份。 */
const CURATED_TTL_MS = 24 * 3600 * 1000;

function indexPath(deps: SyncDeps): string {
  return `${deps.siteBase}/${deps.locale}/plugins`;
}

/** 取一个分片，失败重试一次；两次都失败才算 failures。 */
async function fetchChunk(
  deps: SyncDeps,
  chunk: ChunkRef,
): Promise<{ ok: boolean; body: string; error?: string }> {
  let last = "未知错误";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await deps.fetch(`${deps.siteBase}${chunk.url}`, {
      timeoutMs: SHARD_TIMEOUT_MS,
    });
    if (result.ok && result.body !== "") return { ok: true, body: result.body };
    last = result.error ?? "空响应";
    deps.log(`分片取数失败（第 ${attempt} 次）：${chunk.url}：${last}`);
  }
  return { ok: false, body: "", error: last };
}

/**
 * 按需抓取一个插件的详情页（站点精确版本 / 安装命令 / dshTarget）。
 *
 * ⚠️ 只有这一条路径能拿到列表页没有的精确事实，因此**只能按需**：19,866 条全量
 * 抓一遍是 19,866 × 152KB ≈ 2.9GB。已装清单通常只有个位数到几十个插件，代价可接受。
 */
export async function fetchDetail(
  deps: Pick<SyncDeps, "fetch" | "siteBase" | "locale">,
  repo: string,
): Promise<DetailRecord | undefined> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return undefined;
  const result = await deps.fetch(
    `${deps.siteBase}/${deps.locale}/plugins/${repo}`,
    { timeoutMs: 30_000 },
  );
  if (!result.ok || result.body === "") return undefined;
  return readDetailRecord(extractFlightPayload(result.body));
}

/**
 * 执行一次同步。
 *
 * 索引页拿不到时**不动任何数据**，直接把失败原因写进状态并返回 —— 让界面显示
 * 「上次同步失败 + 原因」，而不是清出一张空目录。
 */
export async function syncCatalog(deps: SyncDeps): Promise<SyncReport> {
  const now = deps.now();
  const index = await deps.fetch(indexPath(deps), {
    timeoutMs: INDEX_TIMEOUT_MS,
  });
  if (!index.ok || index.body === "") {
    const reason = index.error ?? "空响应";
    await deps.store.call("catalog.setSyncState", {
      state: { lang: deps.locale, lastError: `索引页取数失败：${reason}` },
    });
    return {
      refreshed: 0,
      skipped: 0,
      failures: [{ url: indexPath(deps), reason }],
      rows: 0,
      source: "none",
    };
  }

  const manifest = readShardManifest(
    extractFlightPayload(index.body),
    deps.locale,
  );
  if (manifest.chunks.length === 0) {
    /**
     * 站点改版：清单与 URL 扫描都没扫出分片。兜底通道是 sitemap（枚举器已就绪
     * 并有夹具），但它只有 slug、没有描述，且要拉 15 个分片（≈14MB）——
     * 完整接入排在 M4，这里如实报降级原因，不伪装成「目录为空」。
     */
    const sitemap = await deps.fetch(`${deps.siteBase}/sitemaps/plugins/1.xml`, {
      timeoutMs: INDEX_TIMEOUT_MS,
    });
    const degraded =
      sitemap.ok && readSitemapLocations(sitemap.body).length > 0
        ? "索引页解析不出分片清单，已确认 sitemap 可用；分片兜底枚举尚未接入"
        : "索引页解析不出分片清单，且 sitemap 不可用";
    await deps.store.call("catalog.setSyncState", {
      state: { lang: deps.locale, lastError: degraded },
    });
    return {
      refreshed: 0,
      skipped: 0,
      failures: [{ url: indexPath(deps), reason: "清单为空" }],
      rows: 0,
      source: "none",
      degraded,
    };
  }

  const known = await deps.store.call<{ chunks: [string, string][] }>(
    "catalog.knownChunks",
    { lang: deps.locale },
  );
  const plan = planSync(manifest, new Map(known?.chunks ?? []));
  deps.log(
    `同步计划：取 ${plan.fetch.length} 片、跳过 ${plan.skipped} 片、清理 ${plan.remove.length} 片`,
  );
  if (plan.remove.length > 0) {
    const removed = await deps.store.call<{ removed: number }>(
      "catalog.removeChunks",
      { urls: plan.remove },
    );
    deps.log(`清理陈旧分片 ${plan.remove.length} 个（${removed?.removed ?? 0} 行）`);
  }

  const fetchResults = await mapLimited(
    plan.fetch,
    deps.concurrency ?? 3,
    async (chunk) => ({ chunk, ...(await fetchChunk(deps, chunk)) }),
  );
  const failures: { url: string; reason: string }[] = [];
  let refreshed = 0;
  let rows = 0;
  for (const result of fetchResults) {
    if (!result.ok) {
      failures.push({ url: result.chunk.url, reason: result.error ?? "未知错误" });
      continue;
    }
    try {
      const applied = await deps.store.call<{ rows: number }>(
        "catalog.applyChunk",
        { chunk: result.chunk, body: result.body },
      );
      refreshed += 1;
      rows += applied?.rows ?? 0;
    } catch (error) {
      // 写库失败同样只算这一片失败：存储是旁路，不能让整次同步作废。
      failures.push({
        url: result.chunk.url,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let curated: { merged: number; orphans: number } | undefined;
  const curatedState = await deps.store.call<{ lastSyncAt: number | null }>(
    "catalog.counts",
    { lang: "curated" },
  );
  const curatedAge =
    curatedState?.lastSyncAt != null ? now - curatedState.lastSyncAt : Infinity;
  if (refreshed > 0 || curatedAge > CURATED_TTL_MS) {
    const body = await deps.fetch(`${deps.apiBase}/plugins.${deps.locale}.json`, {
      timeoutMs: CURATED_TIMEOUT_MS,
    });
    if (body.ok && body.body !== "") {
      curated = await deps.store.call("catalog.applyCurated", { body: body.body });
      await deps.store.call("catalog.setSyncState", {
        state: { lang: "curated", lastSyncAt: now },
      });
    } else {
      deps.log(`curated 增强取数失败：${body.error ?? "空响应"}`);
    }
  }

  const counts = await deps.store.call<{ rows: number }>("catalog.counts", {
    lang: deps.locale,
  });
  const outcome: RefreshOutcome = {
    refreshed,
    skipped: plan.skipped,
    failures,
    rows: counts?.rows ?? rows,
    totalCount: manifest.totalCount,
  };
  await deps.store.call("catalog.setSyncState", {
    state: {
      lang: deps.locale,
      totalCount: manifest.totalCount,
      lastSyncAt: now,
      lastError: failures.length > 0 ? describeRefresh(outcome) : null,
    },
  });
  return {
    ...outcome,
    source: manifest.source,
    ...(curated ? { curated } : {}),
  };
}