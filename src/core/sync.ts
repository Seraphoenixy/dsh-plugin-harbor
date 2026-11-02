import type { ChunkRef, ShardManifest, SyncPlan } from "./types.ts";

/** 本地已入库的分片：`url → 文件名哈希`。 */
export type KnownChunks = Map<string, string>;

/**
 * 计算本次同步要取哪些分片。
 *
 * 分片 URL 是**内容寻址**的：文件名里的 8 位哈希就是内容指纹，站点对同一
 * 路径给一年 `immutable` 缓存。于是：
 *   - 本地已有同 URL 同哈希 → 不可能变内容，直接跳过（实测条件 GET 也是 304）；
 *   - 站点改版内容后文件名哈希会变 → 出现的是**新 URL**，老的随之消失；
 *   - 因此「本地有、清单里没有」的 URL 就是需要清理的陈旧分片。
 *
 * ⚠️ 不能只看数量或页码：页码不变而内容变化时，只有哈希能分辨。
 */
export function planSync(manifest: ShardManifest, known: KnownChunks): SyncPlan {
  const fetch: ChunkRef[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const chunk of manifest.chunks) {
    if (seen.has(chunk.url)) continue;
    seen.add(chunk.url);
    if (known.get(chunk.url) === chunk.hash) {
      skipped += 1;
      continue;
    }
    fetch.push(chunk);
  }
  const remove = [...known.keys()].filter((url) => !seen.has(url));
  return { fetch, skipped, remove };
}

/** 一次刷新的结果口径（三个桶互斥，避免把「跳过」和「失败」混成一句）。 */
export interface RefreshOutcome {
  refreshed: number;
  skipped: number;
  failures: { url: string; reason: string }[];
  rows: number;
  totalCount?: number;
  /** 清单来源异常时的说明（例如走了 URL 扫描兜底）。 */
  degraded?: string;
}

/** 把计划与结果整理成一句可展示的话；不吞掉任何失败项。 */
export function describeRefresh(outcome: RefreshOutcome): string {
  const parts = [`已更新 ${outcome.refreshed}/${outcome.refreshed + outcome.skipped} 个分片`];
  if (outcome.skipped > 0) parts.push(`跳过 ${outcome.skipped} 个（内容未变）`);
  if (outcome.failures.length > 0)
    parts.push(
      `失败 ${outcome.failures.length} 个：` +
        outcome.failures
          .slice(0, 3)
          .map((failure) => `${failure.url}：${failure.reason}`)
          .join("；"),
    );
  if (outcome.degraded) parts.push("降级：" + outcome.degraded);
  return parts.join("；") + "。";
}