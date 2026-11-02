/**
 * 执行通道的真实验收（隔离环境，维护用，必须显式联网）。
 *
 * 用法：
 *   node --experimental-transform-types scripts/verify-ops.mjs --network [--keep]
 *
 * 口径：
 *  - `DSH_HOME` 指向**系统临时目录**，profile 名为 `plugin-harbor-selftest`：
 *    全程不读也不写你正在用的 profile（默认 desktop）；
 *  - 跑的是**真实** `dsh plugin` CLI + **真实 pnpm** + 真实 registry / GitHub；
 *  - 走的是本插件自己的兜底通道 `runDshPlugin()`（宿主内会优先走 pluginManager
 *    服务，这条是服务不可用时的路径）；
 *  - 默认跑完就删临时目录（`--keep` 保留以便排查）。
 *
 * ⚠️ Windows 上的关键事实：`dsh` 是 `.cmd`，`spawn(..., shell:false)` 直接 ENOENT；
 * 因此这里显式用「安装目录里的 Electron 可执行文件 + 宿主的 desktop-cli.js」调用，
 * 与打包 shim 内部的做法一致。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDshPlugin } from "../src/ops/subprocess.ts";
import { readInstalledPlugins } from "../src/core/installed.ts";
import { installSpecFor } from "../src/ops/spec.ts";

if (!process.argv.includes("--network")) {
  console.error("本脚本会调用真实 CLI 安装真实插件，必须显式传 --network。");
  process.exit(2);
}

const PROFILE = "plugin-harbor-selftest";
const installRoot =
  process.env.DSH_INSTALL_ROOT ??
  join(
    process.env.LOCALAPPDATA ?? "",
    "Programs",
    "DeepSeek Harness",
  );
const exePath = join(installRoot, "DeepSeek Harness.exe");
const cliPath = join(
  installRoot,
  "resources",
  "app.asar",
  "dsh",
  "node_modules",
  "@deepseek-ai",
  "dsh-desktop-host",
  "lib",
  "cli.js",
);
if (!existsSync(exePath)) {
  console.error("找不到宿主可执行文件：" + exePath + "（可用 DSH_INSTALL_ROOT 指定）");
  process.exit(2);
}

const home = mkdtempSync(join(tmpdir(), "pcenter-ops-"));
const profileDir = join(home, "profiles", PROFILE);
mkdirSync(profileDir, { recursive: true });
/**
 * 先写好 profile 清单：非 desktop profile 若不预先存在清单，CLI 会按模板初始化
 * （那是整套宿主 bundle，既慢又与本验收无关）。这里给一份**最小**清单，
 * 让 CLI 直接在我们的目录里跑真实 pnpm。
 */
writeFileSync(
  join(profileDir, "package.json"),
  JSON.stringify(
    {
      name: "dsh-profile-" + PROFILE,
      private: true,
      dsh: { profile: { bundles: [] } },
      dependencies: {},
    },
    null,
    2,
  ) + "\n",
  "utf8",
);
writeFileSync(
  join(profileDir, "pnpm-workspace.yaml"),
  "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n",
  "utf8",
);

console.log(`隔离 DSH_HOME：${home}`);
console.log(`自建 profile：${PROFILE}（与你正在用的 profile 无关）`);
console.log(`CLI：${exePath} + ${cliPath.replace(installRoot, "…")}`);

const run = async (action, spec, label) => {
  const lines = [];
  let lastProgress = 0;
  const started = Date.now();
  const result = await runDshPlugin(
    {
      profile: PROFILE,
      action,
      spec,
      dshCommand: exePath,
      dshPrefixArgs: ["--expose-internals", cliPath],
      env: { ELECTRON_RUN_AS_NODE: "1", DSH_HOME: home },
      timeoutMs: 8 * 60 * 1000,
    },
    {
      log: (line) => {
        lines.push(line);
        // 只留少量关键行，避免把 pnpm 全文刷屏
        if (/added|removed|Done in|ERR_|error|dsh:/.test(line) && lines.length < 400)
          process.stdout.write("    · " + line.slice(0, 160) + "\n");
      },
      progress: (value) => {
        if (value - lastProgress >= 25) {
          lastProgress = value;
          process.stdout.write(`    进度 ${value}%\n`);
        }
      },
    },
  );
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `  ${label}：退出码 ${result.code ?? "null"}${result.timedOut ? "（超时）" : ""}，${seconds}s` +
      (result.failure ? `，失败归类 ${result.failure.kind}：${result.failure.message}` : ""),
  );
  return result;
};

const readProfile = () => {
  const manifest = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
  return {
    dependencies: Object.keys(manifest.dependencies ?? {}),
    bundles: manifest.dsh?.profile?.bundles ?? [],
  };
};

const cases = [
  { action: "add", spec: "github:Seraphoenixy/dsh-channel-hub", name: "dsh-channel-hub", kind: "git" },
  { action: "add", spec: "dsh-cost-meter", name: "dsh-cost-meter", kind: "registry" },
];

let failures = 0;
try {
  console.log("\n1) 用真实 CLI 确认 profile 可寻址（DSH 自有命令，不经我们的兜底通道）");
  const probe = spawnSync(
    exePath,
    ["--expose-internals", cliPath, "plugin", "--profile", PROFILE, "version-exemptions"],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", DSH_HOME: home },
    },
  );
  console.log(
    `  version-exemptions：退出码 ${probe.status}，输出 ${(probe.stdout ?? "").trim().slice(0, 120) || "(空)"}` +
      (probe.error ? `，错误 ${probe.error.code ?? probe.error.message}` : ""),
  );
  if (probe.status !== 0) failures += 1;

  console.log("\n2) 真实安装（我们的 runDshPlugin → 真实 dsh CLI → 真实 pnpm）");
  for (const item of cases) {
    const result = await run(item.action, item.spec, `安装 ${item.kind} 形态：${item.spec}`);
    const state = readProfile();
    const installed = state.dependencies.includes(item.name);
    const onDisk = existsSync(join(profileDir, "node_modules", item.name, "package.json"));
    const inBundles = state.bundles.includes(item.name);
    console.log(
      `    落点：依赖 ${installed ? "有" : "无"}｜node_modules ${onDisk ? "有" : "无"}｜bundle 选中 ${inBundles ? "有" : "无"}`,
    );
    if (result.code !== 0 || !installed || !onDisk) failures += 1;
  }

  console.log("\n3) 更新流程：profile 里记的是版本范围，装之前必须先拼成安装地址");
  {
    const facts = readInstalledPlugins(profileDir).find(
      (plugin) => plugin.name === "dsh-cost-meter",
    );
    if (!facts) {
      console.log("  读不到 dsh-cost-meter 的已装事实，跳过这一步");
      failures += 1;
    } else {
      const assembled = installSpecFor(facts, profileDir);
      console.log(`  已装事实：spec=${facts.spec} kind=${facts.kind}`);
      console.log(`  拼出的安装地址：${assembled}`);
      /**
       * 历史缺陷的写法：把范围当包名交给 pnpm。真实 pnpm 必须拒绝它（实测是
       * `ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER`，而那时旧版本已经卸载 ——
       * 这就是插件从 profile 里消失的那条链）。
       */
      const bare = String(facts.spec ?? "");
      if (/^[\^~]|^\d|^\*$/.test(bare)) {
        const bareResult = await run("add", bare, `历史缺陷写法（范围当包名）：${bare}`);
        if (bareResult.code === 0) {
          console.log("  ⚠️ 范围竟然装成功了：本用例的前提已变，需要重新评估");
          failures += 1;
        }
      } else {
        console.log(`  记录值 ${bare} 不是范围形态，跳过「范围当包名」的对照`);
      }
      // 修复后的写法：先卸载，再按拼出的地址安装（与 doUpdate 同序）
      const removed = await run("remove", "dsh-cost-meter", "更新第 1 步：卸载旧版本");
      const added = await run("add", assembled, "更新第 2 步：按拼出的地址安装");
      const after = readInstalledPlugins(profileDir).find(
        (plugin) => plugin.name === "dsh-cost-meter",
      );
      const onDisk = existsSync(
        join(profileDir, "node_modules", "dsh-cost-meter", "package.json"),
      );
      console.log(
        `  落点：依赖 ${after ? "有" : "无"}｜node_modules ${onDisk ? "有" : "无"}｜版本 ${after?.version ?? "?"}｜记录值 ${after?.spec ?? "?"}`,
      );
      if (removed.code !== 0 || added.code !== 0 || !after || !onDisk) failures += 1;
    }
  }

  console.log("\n4) 真实卸载");
  for (const item of cases) {
    const result = await run("remove", item.name, `卸载 ${item.name}`);
    const state = readProfile();
    const stillThere = state.dependencies.includes(item.name);
    const onDisk = existsSync(join(profileDir, "node_modules", item.name, "package.json"));
    console.log(
      `    落点：依赖 ${stillThere ? "仍在（异常）" : "已移除"}｜node_modules ${onDisk ? "仍在" : "已移除"}`,
    );
    if (result.code !== 0 || stillThere) failures += 1;
  }

  console.log("\n5) 收尾");
  const final = readProfile();
  console.log(`  最终依赖：${JSON.stringify(final.dependencies)}`);
  console.log(`  最终 bundle：${JSON.stringify(final.bundles)}`);
} finally {
  if (process.argv.includes("--keep")) console.log("临时目录保留：" + home);
  else rmSync(home, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n真实执行验收：全部通过" : `\n真实执行验收：${failures} 项未达预期`);
process.exit(failures === 0 ? 0 : 1);