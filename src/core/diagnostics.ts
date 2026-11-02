/**
 * 连通性与状态诊断。
 *
 * 口径：
 *  - **全部只读**：只发 GET 与 `git --version`，不安装、不改文件；
 *  - **只有用户点「运行诊断」时才跑**（服务端不自动触发），因为其中几项要出网；
 *  - 单项失败**不影响**其它项：每项独立 try/catch，失败记 `ok:false` + 原因，
 *    绝不抛给界面；拿不到结论的项记 `ok:null`（例如尚未同步过目录）。
 */
import type { FetchResult } from "../upstream/fetch.ts";
import { DEFAULT_REGISTRY } from "../upstream/registry.ts";
import type { CenterSettingsFile } from "./settings.ts";

export interface DiagnosticCheck {
  id: "catalog" | "store" | "site" | "api" | "registry" | "git" | "hmr";
  label: string;
  /** null 表示「没有结论」（未同步过 / 未运行），与 false 严格区分。 */
  ok: boolean | null;
  detail: string;
  ms: number;
}

export interface DiagnosticDeps {
  fetch: (
    url: string,
    options?: { timeoutMs?: number; etag?: string; accept?: string },
  ) => Promise<FetchResult>;
  gitVersion: () => Promise<{ ok: boolean; detail: string }>;
  storePing: () => Promise<{ path: string; sqlite: string; tables: number }>;
  counts: () => Promise<{
    rows: number;
    totalCount: number | null;
    lastSyncAt: number | null;
    lastError: string | null;
  }>;
  settings: CenterSettingsFile;
  /** 宿主是否提供热重载服务（`hmr`）：决定变更能否原地生效。**只读探测，不出网**。 */
  hot: () => boolean;
  now?: () => number;
}

const INDEX_TIMEOUT_MS = 20_000;
const SMALL_TIMEOUT_MS = 10_000;

/** 跑一遍全部诊断项。 */
export async function runDiagnostics(
  deps: DiagnosticDeps,
): Promise<DiagnosticCheck[]> {
  const now = deps.now ?? Date.now;
  const results: DiagnosticCheck[] = [];
  const check = async (
    id: DiagnosticCheck["id"],
    label: string,
    run: () => Promise<{ ok: boolean | null; detail: string }>,
  ): Promise<void> => {
    const started = now();
    try {
      const outcome = await run();
      results.push({ id, label, ok: outcome.ok, detail: outcome.detail, ms: now() - started });
    } catch (error) {
      results.push({
        id,
        label,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        ms: now() - started,
      });
    }
  };

  await check("catalog", "目录数据", async () => {
    const counts = await deps.counts();
    if (counts.rows === 0)
      return {
        ok: null,
        detail: counts.lastError ? `尚未同步（上次失败：${counts.lastError}）` : "尚未同步目录",
      };
    const when = counts.lastSyncAt
      ? new Date(counts.lastSyncAt).toLocaleString("zh-CN", { hour12: false })
      : "未知时间";
    return {
      ok: counts.lastError === null,
      detail:
        `${counts.rows.toLocaleString("zh-CN")} 条，站点自报 ` +
        `${counts.totalCount === null ? "未知" : counts.totalCount.toLocaleString("zh-CN")}；` +
        `同步于 ${when}` +
        (counts.lastError ? `；上次失败：${counts.lastError}` : ""),
    };
  });

  await check("store", "目录库", async () => {
    const ping = await deps.storePing();
    return {
      ok: ping.sqlite !== "",
      detail: `SQLite ${ping.sqlite}，${ping.tables} 张表；${ping.path}`,
    };
  });

  await check("site", "官网目录（dsh-plugin.org）", async () => {
    const url = `${deps.settings.siteBase}/${deps.settings.locale}/plugins`;
    const result = await deps.fetch(url, { timeoutMs: INDEX_TIMEOUT_MS });
    if (!result.ok) return { ok: false, detail: `${url}：${result.error ?? "取数失败"}` };
    return {
      ok: result.body.length > 0,
      detail: `${url}：HTTP ${result.status}，${result.body.length.toLocaleString("zh-CN")} 字节`,
    };
  });

  await check("api", "API 中心（stats.json）", async () => {
    const url = `${deps.settings.apiBase}/stats.json`;
    const result = await deps.fetch(url, {
      timeoutMs: SMALL_TIMEOUT_MS,
      accept: "application/json",
    });
    if (!result.ok) return { ok: false, detail: `${url}：${result.error ?? "取数失败"}` };
    try {
      const parsed = JSON.parse(result.body) as { total?: number; verified?: number };
      return {
        ok: true,
        detail: `${url}：收录 ${parsed.total ?? "?"}，已验证 ${parsed.verified ?? "?"}`,
      };
    } catch {
      return { ok: true, detail: `${url}：HTTP ${result.status}（响应不是 JSON）` };
    }
  });

  await check("registry", "npm registry", async () => {
    const base = deps.settings.registry === "" ? DEFAULT_REGISTRY : deps.settings.registry;
    const url = `${base}/-/ping`;
    const result = await deps.fetch(url, {
      timeoutMs: SMALL_TIMEOUT_MS,
      accept: "application/json",
    });
    if (!result.ok && result.status === 0)
      return { ok: false, detail: `${base}：${result.error ?? "不可达"}` };
    // 4xx 也算「可达」：镜像不一定实现 /-/ping，但能应答就说明网络通
    return {
      ok: true,
      detail: `${base}：HTTP ${result.status}${result.ok ? "" : "（该镜像未实现 /-/ping，但可达）"}`,
    };
  });

  await check("git", "git 可用性", async () => {
    const version = await deps.gitVersion();
    return { ok: version.ok, detail: version.detail };
  });

  /**
   * 热重载：只探测宿主有没有 `hmr` 服务，不触发任何重载。
   * 它决定「装完/改完要不要重启」：有它则宿主原地生效，没它则一律 `restart-required`。
   */
  await check("hmr", "热重载（hmr）", async () => {
    const hot = deps.hot();
    return hot
      ? {
          ok: true,
          detail:
            "宿主提供 hmr 服务：安装/更新/启停/热重载由宿主原地生效，无需重启 DSH（重建后的已链接插件按「热重载」即可生效）",
        }
      : {
          ok: false,
          detail:
            "宿主未提供 hmr 服务：变更要等下次启动 DSH 才生效（桌面启动器提供 profileContext 时 dsh-base 会启用 hmr 条目）",
        };
  });

  return results;
}

/** 诊断结果 → 一句话汇总（界面顶部用）。 */
export function summarizeDiagnostics(checks: DiagnosticCheck[]): string {
  const failed = checks.filter((entry) => entry.ok === false).length;
  const unknown = checks.filter((entry) => entry.ok === null).length;
  if (failed === 0 && unknown === 0) return `全部 ${checks.length} 项通过`;
  const parts: string[] = [];
  if (failed > 0)
    parts.push(
      `失败 ${failed} 项：` +
        checks
          .filter((entry) => entry.ok === false)
          .map((entry) => entry.label)
          .join("、"),
    );
  if (unknown > 0)
    parts.push(
      `无结论 ${unknown} 项：` +
        checks
          .filter((entry) => entry.ok === null)
          .map((entry) => entry.label)
          .join("、"),
    );
  return parts.join("；");
}