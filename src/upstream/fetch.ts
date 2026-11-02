/**
 * 只读上游客户端。
 *
 * 全部出网都经过这里，便于三件事：统一的超时、统一的条件请求（ETag），以及
 * 「一次出网访问了哪些地址」这件事在代码里可审计（README 与
 * `docs/DATA-SOURCES.md` 的域名清单与这里一一对应）。
 *
 * 不做代理协商：宿主的 `fetch` 已在进程级应用系统/环境代理，这里再加一层只会
 * 造成两套口径。
 */

export interface FetchResult {
  ok: boolean;
  status: number;
  body: string;
  etag?: string;
  /** 失败原因（网络错误或 HTTP 状态），成功时为 undefined。 */
  error?: string;
}

export interface FetchOptions {
  timeoutMs?: number;
  /** 本地缓存到的 ETag；命中 304 时 `body` 为空、`status` 为 304。 */
  etag?: string;
  /** 覆盖 Accept 头（registry 用精简元数据）。 */
  accept?: string;
}

/** 单次 GET。任何异常都收敛成 `{ok:false}`，不抛。 */
export async function fetchText(
  url: string,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 30_000,
  );
  try {
    const headers: Record<string, string> = {
      accept:
        options.accept ??
        "text/html,application/json,application/xml;q=0.9,*/*;q=0.5",
      "user-agent": "dsh-plugin-harbor (DeepSeek Harness plugin)",
    };
    if (options.etag) headers["if-none-match"] = options.etag;
    const response = await fetch(url, { headers, signal: controller.signal });
    const etag = response.headers.get("etag") ?? undefined;
    if (response.status === 304)
      return { ok: true, status: 304, body: "", ...(etag ? { etag } : {}) };
    const body = await response.text();
    if (!response.ok)
      return {
        ok: false,
        status: response.status,
        body: "",
        error: `HTTP ${response.status}`,
        ...(etag ? { etag } : {}),
      };
    return { ok: true, status: response.status, body, ...(etag ? { etag } : {}) };
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "AbortError"
        ? `超时（${options.timeoutMs ?? 30_000}ms）`
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, status: 0, body: "", error: reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 带上限并发的批量取数。
 *
 * 同步一个 37 片的目录时，串行会把冷启动拖到分钟级，全并发又可能被站点限流；
 * 3 路是参考项目 dsh-plugin-hub 的目录拉取量级下的保守取法。
 */
export async function mapLimited<T, R>(
  items: T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(limit, 1), items.length) },
    async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await run(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}