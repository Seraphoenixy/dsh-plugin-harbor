/**
 * 诊断回归（全部桩，不联网、不 spawn）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  runDiagnostics,
  summarizeDiagnostics,
  type DiagnosticDeps,
} from "../src/core/diagnostics.ts";
import type { CenterSettingsFile } from "../src/core/settings.ts";

const settings: CenterSettingsFile = {
  version: 1,
  locale: "zh",
  syncTtlMs: 86_400_000,
  siteBase: "https://dsh-plugin.org",
  apiBase: "https://api.dsh-plugin.org",
  registry: "",
  proxy: "",
};

const okFetch = async (url: string) => {
  if (url.endsWith("/stats.json"))
    return { ok: true, status: 200, body: JSON.stringify({ total: 5809, verified: 5809 }) };
  if (url.includes("/-/ping")) return { ok: true, status: 200, body: "{}" };
  return { ok: true, status: 200, body: "x".repeat(253_455) };
};

const baseDeps = (over: Partial<DiagnosticDeps> = {}): DiagnosticDeps => ({
  fetch: okFetch,
  gitVersion: async () => ({ ok: true, detail: "git version 2.56.0.windows.2" }),
  storePing: async () => ({ path: "C:/tmp/catalog.sqlite", sqlite: "3.53.4", tables: 5 }),
  counts: async () => ({
    rows: 19_866,
    totalCount: 19_866,
    lastSyncAt: 1_700_000_000_000,
    lastError: null,
  }),
  settings,
  // 桌面宿主默认加载 hmr：默认按「有热重载」构造，专门的分支另有用例
  hot: () => true,
  now: (() => {
    let value = 0;
    return () => (value += 5);
  })(),
  ...over,
});

test("全部通过时七项都 ok 且带细节", async () => {
  const checks = await runDiagnostics(baseDeps());
  assert.deepEqual(
    checks.map((entry) => entry.id),
    ["catalog", "store", "site", "api", "registry", "git", "hmr"],
  );
  assert.ok(checks.every((entry) => entry.ok === true));
  assert.match(checks.find((c) => c.id === "catalog")!.detail, /19,866 条/);
  assert.match(checks.find((c) => c.id === "api")!.detail, /收录 5809/);
  assert.match(checks.find((c) => c.id === "store")!.detail, /SQLite 3\.53\.4/);
  assert.match(checks.find((c) => c.id === "site")!.detail, /253,455 字节/);
  assert.ok(checks.every((entry) => entry.ms >= 0));
  assert.equal(summarizeDiagnostics(checks), "全部 7 项通过");
});

/**
 * 热重载能力：「有 hmr」与「没 hmr」都要如实说清后果 —— 它决定装完/改完要不要重启。
 */
test("热重载：宿主有 hmr 服务时说明改动原地生效", async () => {
  const checks = await runDiagnostics(baseDeps({ hot: () => true }));
  const hmr = checks.find((entry) => entry.id === "hmr")!;
  assert.equal(hmr.ok, true);
  assert.match(hmr.detail, /无需重启/);
  assert.match(hmr.detail, /热重载/);
});

test("热重载：没有 hmr 服务时判失败并说明要重启", async () => {
  const checks = await runDiagnostics(baseDeps({ hot: () => false }));
  const hmr = checks.find((entry) => entry.id === "hmr")!;
  assert.equal(hmr.ok, false);
  assert.match(hmr.detail, /未提供 hmr 服务/);
  assert.match(hmr.detail, /下次启动 DSH/);
});

test("尚未同步目录：catalog 记「无结论」而不是失败，也不伪装成 0 条已同步", async () => {
  const checks = await runDiagnostics(
    baseDeps({
      counts: async () => ({ rows: 0, totalCount: null, lastSyncAt: null, lastError: null }),
    }),
  );
  const catalog = checks.find((entry) => entry.id === "catalog")!;
  assert.equal(catalog.ok, null);
  assert.equal(catalog.detail, "尚未同步目录");
  assert.match(summarizeDiagnostics(checks), /无结论 1 项：目录数据/);
});

test("上次同步失败：catalog 判失败并带上原因", async () => {
  const checks = await runDiagnostics(
    baseDeps({
      counts: async () => ({
        rows: 12,
        totalCount: 19866,
        lastSyncAt: 1,
        lastError: "索引页取数失败：超时（30000ms）",
      }),
    }),
  );
  const catalog = checks.find((entry) => entry.id === "catalog")!;
  assert.equal(catalog.ok, false);
  assert.match(catalog.detail, /上次失败：索引页取数失败/);
});

test("单项失败不影响其它项，且原因如实带上", async () => {
  const checks = await runDiagnostics(
    baseDeps({
      fetch: async (url) => {
        if (url.includes("dsh-plugin.org/zh/plugins"))
          return { ok: false, status: 0, body: "", error: "超时（20000ms）" };
        return await okFetch(url);
      },
      gitVersion: async () => ({ ok: false, detail: "本机没有 git 可执行文件（git 形态的更新判据会不可用）" }),
    }),
  );
  const site = checks.find((entry) => entry.id === "site")!;
  const git = checks.find((entry) => entry.id === "git")!;
  assert.equal(site.ok, false);
  assert.match(site.detail, /超时/);
  assert.equal(git.ok, false);
  assert.match(git.detail, /没有 git 可执行文件/);
  assert.equal(checks.find((entry) => entry.id === "api")!.ok, true, "其余项照常通过");
  const summary = summarizeDiagnostics(checks);
  assert.match(summary, /失败 2 项：官网目录/);
  assert.match(summary, /git 可用性/);
});

test("镜像不实现 /-/ping 时按「可达」处理并说明", async () => {
  const checks = await runDiagnostics(
    baseDeps({
      settings: { ...settings, registry: "https://registry.npmmirror.com" },
      fetch: async (url) =>
        url.includes("registry.npmmirror.com")
          ? { ok: false, status: 404, body: "", error: "HTTP 404" }
          : await okFetch(url),
    }),
  );
  const registry = checks.find((entry) => entry.id === "registry")!;
  assert.equal(registry.ok, true, "4xx 说明网络可达，不该判成失败");
  assert.match(registry.detail, /未实现 \/-\/ping/);
  assert.match(registry.detail, /registry\.npmmirror\.com/);
});

test("store / counts 抛错时收敛成失败项，绝不冒泡", async () => {
  const checks = await runDiagnostics(
    baseDeps({
      storePing: async () => {
        throw Error("catalog store is closed");
      },
      counts: async () => {
        throw Error("worker 崩了");
      },
    }),
  );
  assert.equal(checks.length, 7);
  assert.match(checks.find((entry) => entry.id === "store")!.detail, /closed/);
  assert.match(checks.find((entry) => entry.id === "catalog")!.detail, /worker 崩了/);
  assert.equal(checks.filter((entry) => entry.ok === true).length, 5);
});