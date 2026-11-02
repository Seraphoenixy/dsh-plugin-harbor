/**
 * 真实 profile 只读验收：已装事实 + 更新判据（维护用，必须显式联网）。
 *
 * 用法：
 *   node --experimental-transform-types scripts/verify-installed.mjs --profile desktop --network
 *
 * 口径：
 *  - **只读**：读 profile 的 `package.json` / `pnpm-lock.yaml` /
 *    `node_modules/<name>/package.json`；
 *  - 只发出只读网络请求：npm registry 的元数据、`git ls-remote`；不安装、不改文件；
 *  - 打印每个已装插件的形态、当前版本/commit、最新值、结论，供 `docs/ACCEPTANCE.md`
 *    的「真实验收」段如实记载。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readInstalledPlugins } from "../src/core/installed.ts";
import { checkPlugins } from "../src/core/updates.ts";
import { fetchRegistryFacts } from "../src/upstream/registry.ts";
import { readRemoteHead } from "../src/upstream/git.ts";

const profileArg = process.argv.indexOf("--profile");
const profile = profileArg >= 0 ? process.argv[profileArg + 1] : undefined;
if (!process.argv.includes("--network") || !profile) {
  console.error(
    "用法：node --experimental-transform-types scripts/verify-installed.mjs --profile <name> --network",
  );
  process.exit(2);
}

const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const profileDir = join(home, "profiles", profile);
console.log(`profile 目录：${profileDir}（只读）`);

const plugins = readInstalledPlugins(profileDir);
console.log(`已装第三方插件：${plugins.length} 个`);
for (const plugin of plugins)
  console.log(
    `  · ${plugin.name}｜${plugin.kind}｜spec=${plugin.spec}｜version=${plugin.version ?? "—"}｜commit=${plugin.commit ? plugin.commit.slice(0, 7) : "—"}｜repo=${plugin.repo ?? "—"}｜selected=${plugin.selected}｜client=${plugin.hasClient}`,
  );

const started = Date.now();
const checks = await checkPlugins(plugins, {
  now: () => Date.now(),
  concurrency: 4,
  registry: (name) => fetchRegistryFacts(name),
  git: (repo) => readRemoteHead(repo),
});
console.log(`\n更新检查用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);

const verdict = (check) =>
  check.updateAvailable === true
    ? "可更新"
    : check.updateAvailable === false
      ? "已最新"
      : "未判定";
for (const check of checks) {
  const latest = check.latestVersion ?? (check.latestCommit ? check.latestCommit.slice(0, 7) : "—");
  const local = check.installedVersion ?? (check.installedCommit ? check.installedCommit.slice(0, 7) : "—");
  console.log(
    `  ${verdict(check)}｜${check.name}（${check.kind}）｜当前 ${local} → 最新 ${latest}（${check.latestSource ?? "无来源"}）${check.error ? "｜原因：" + check.error : ""}${check.note ? "｜说明：" + check.note : ""}`,
  );
}
const tally = checks.reduce(
  (acc, check) => {
    if (check.updateAvailable === true) acc.update += 1;
    else if (check.updateAvailable === false) acc.latest += 1;
    else acc.unknown += 1;
    return acc;
  },
  { update: 0, latest: 0, unknown: 0 },
);
console.log(`\n汇总：可更新 ${tally.update}｜已最新 ${tally.latest}｜未判定 ${tally.unknown}`);