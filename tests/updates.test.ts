/**
 * 更新判据的夹具回归。
 *
 * 全部离线：registry / git / 详情页都是桩，不联网、不 spawn git。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { checkPlugin, checkPlugins, compareVersions } from "../src/core/updates.ts";
import type { InstalledPlugin } from "../src/core/types.ts";

const plugin = (over: Partial<InstalledPlugin>): InstalledPlugin => ({
  name: "dsh-x",
  spec: "^1.0.0",
  kind: "registry",
  selected: true,
  present: true,
  bundle: true,
  hasClient: false,
  ...over,
});

const REGISTRY_SHA = "8b5f49914aa56c8c544a70abe38e134b5148a261";
const OTHER_SHA = "393b4120bd7948a47571157c9f0208432924eb21";

test("版本比较覆盖 semver 常用形态", () => {
  assert.equal(compareVersions("1.9.47", "1.9.28"), 1);
  assert.equal(compareVersions("1.9.28", "1.9.28"), 0);
  assert.equal(compareVersions("1.9.28", "1.9.47"), -1);
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
  assert.equal(compareVersions("1.9", "1.9.0"), 0, "缺段按 0 处理");
  assert.equal(compareVersions("v1.1.85", "1.1.85"), 0, "前缀 v 不算差异");
  assert.equal(compareVersions("1.0.0-alpha.1", "1.0.0"), -1, "预发布低于正式版");
  assert.equal(compareVersions("1.0.0-alpha.2", "1.0.0-alpha.1"), 1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(compareVersions("1.0.0-beta", "1.0.0-alpha"), 1);
  assert.equal(compareVersions("1.0.0-1", "1.0.0-alpha"), -1, "数字标识符低于字母");
  assert.equal(compareVersions("1.0.0+build", "1.0.0"), 0, "build 元数据不参与比较");
  // 不可比的必须返回 undefined，而不是 0（否则「不知道」会变成「已最新」）
  assert.equal(compareVersions("latest", "1.0.0"), undefined);
  assert.equal(compareVersions("1.0.0", ""), undefined);
  assert.equal(compareVersions("1.0.0.0", "1.0.0"), undefined);
  assert.equal(compareVersions("1.x.0", "1.0.0"), undefined);
});

test("registry 形态：比 installedVersion 与 dist-tags.latest", async () => {
  const upToDate = await checkPlugin(plugin({ version: "1.9.47" }), {
    registry: async () => ({ latest: "1.9.47", integrity: "sha512-x" }),
    now: () => 1,
  });
  assert.equal(upToDate.updateAvailable, false);
  assert.equal(upToDate.latestVersion, "1.9.47");
  assert.equal(upToDate.latestSource, "registry");

  const behind = await checkPlugin(plugin({ version: "1.9.28" }), {
    registry: async () => ({ latest: "1.9.47" }),
    now: () => 1,
  });
  assert.equal(behind.updateAvailable, true);

  // registry 失败 → unknown + 原因，绝不猜
  const failed = await checkPlugin(plugin({ version: "1.9.28" }), {
    registry: async () => ({ error: "HTTP 500" }),
    now: () => 1,
  });
  assert.equal(failed.updateAvailable, null);
  assert.equal(failed.error, "HTTP 500");

  // 本地版本读不到 → unknown
  const noLocal = await checkPlugin(plugin({ version: undefined }), {
    registry: async () => ({ latest: "1.9.47" }),
    now: () => 1,
  });
  assert.equal(noLocal.updateAvailable, null);
  assert.match(noLocal.error!, /读不到本地版本/);

  // 版本口径不同 → unknown，而不是当成「落后」
  const incomparable = await checkPlugin(plugin({ version: undefined }), {
    registry: async () => ({ latest: "1.9.47" }),
    now: () => 1,
  });
  assert.equal(incomparable.updateAvailable, null);
});

test("git 形态：只比 lockfile commit 与远端 HEAD commit", async () => {
  const same = await checkPlugin(
    plugin({ kind: "git", repo: "o/r", spec: "github:o/r", commit: REGISTRY_SHA }),
    {
      git: async () => ({ defaultBranch: "main", commit: REGISTRY_SHA }),
      now: () => 1,
    },
  );
  assert.equal(same.updateAvailable, false);
  assert.equal(same.latestCommit, REGISTRY_SHA);
  assert.equal(same.latestSource, "git");

  const moved = await checkPlugin(
    plugin({ kind: "git", repo: "o/r", spec: "github:o/r", commit: REGISTRY_SHA }),
    { git: async () => ({ defaultBranch: "main", commit: OTHER_SHA }), now: () => 1 },
  );
  assert.equal(moved.updateAvailable, true);

  // 本地没有 commit（lockfile 缺记录）→ unknown，而不是「已最新」
  const noLocalCommit = await checkPlugin(
    plugin({ kind: "git", repo: "o/r", spec: "github:o/r", commit: undefined }),
    { git: async () => ({ commit: OTHER_SHA }), now: () => 1 },
  );
  assert.equal(noLocalCommit.updateAvailable, null);
  assert.match(noLocalCommit.error!, /lockfile/);

  // 远端不可达 → unknown + 原因
  const offline = await checkPlugin(
    plugin({ kind: "git", repo: "o/r", spec: "github:o/r", commit: REGISTRY_SHA }),
    { git: async () => ({ error: "git ls-remote 超时（15000ms）" }), now: () => 1 },
  );
  assert.equal(offline.updateAvailable, null);
  assert.match(offline.error!, /超时/);

  // 读不到仓库身份 → unknown
  const noRepo = await checkPlugin(
    plugin({ kind: "git", spec: "github:o/r", repo: undefined, commit: REGISTRY_SHA }),
    { git: async () => ({ commit: OTHER_SHA }), now: () => 1 },
  );
  assert.equal(noRepo.updateAvailable, null);
  assert.match(noRepo.error!, /仓库身份/);
});

test("本地路径 / 压缩包安装：没有远端可比，标未知并说明", async () => {
  for (const kind of ["path", "tarball", "unknown"] as const) {
    const check = await checkPlugin(
      plugin({ kind, spec: "file:../x", version: "0.0.1" }),
      {
        registry: async () => ({ latest: "9.9.9" }),
        git: async () => ({ commit: OTHER_SHA }),
        now: () => 1,
      },
    );
    assert.equal(check.updateAvailable, null, kind + " 不该给出结论");
    assert.equal(check.note, "本地路径 / 压缩包安装，没有远端可比");
    assert.equal(check.error, undefined);
    assert.equal(check.latestVersion, undefined, "不该去查 registry");
  }
});

test("批量判定带上限并发，单项抛错不影响其它项", async () => {
  const plugins = [
    plugin({ name: "a", version: "1.0.0" }),
    plugin({ name: "b", version: "1.0.0" }),
    plugin({ name: "c", version: "1.0.0" }),
    plugin({ name: "d", version: "1.0.0" }),
  ];
  let active = 0;
  let peak = 0;
  const checks = await checkPlugins(plugins, {
    concurrency: 2,
    now: () => 1,
    registry: async (name) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (name === "c") throw Error("registry 爆炸");
      return { latest: name === "a" ? "2.0.0" : "1.0.0" };
    },
  });
  assert.equal(checks.length, 4);
  assert.ok(peak <= 2, `并发上限失效：峰值 ${peak}`);
  assert.equal(checks[0]!.updateAvailable, true);
  assert.equal(checks[1]!.updateAvailable, false);
  assert.equal(checks[2]!.updateAvailable, null);
  assert.match(checks[2]!.error!, /registry 爆炸/);
  assert.equal(checks[3]!.updateAvailable, false);
});

test("未配置查询能力时如实报错而不是当作已最新", async () => {
  const git = await checkPlugin(
    plugin({ kind: "git", repo: "o/r", commit: REGISTRY_SHA }),
    { now: () => 1 },
  );
  assert.equal(git.updateAvailable, null);
  assert.match(git.error!, /未配置 git 查询/);
  const reg = await checkPlugin(plugin({ version: "1.0.0" }), { now: () => 1 });
  assert.equal(reg.updateAvailable, null);
  assert.match(reg.error!, /未配置 registry 查询/);
});