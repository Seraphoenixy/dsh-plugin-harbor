/**
 * 导出功能的真实验收（维护用，只读）。
 *
 * 用法：
 *   node --experimental-transform-types scripts/verify-export.mjs --profile desktop [--include-data] [--write]
 *
 * 口径：
 *  - **默认什么都不写**：只把导出对象在内存里组装出来并打印摘要（插件数、每条的配置行 /
 *    条目 / 设置文件数、未导出项及原因、警告、序列化体积）。加 `--write` 才真的落盘，
 *    而且落在 `<profile>/plugin-harbor/exports/` 下（本插件自己的数据目录）。
 *  - 全程不出网；只读 profile 的清单 / 补丁 / 各插件数据目录。
 *  - **不打印任何配置取值**：摘要只有计数与插件名，凭据不会出现在终端里。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readInstalledPlugins } from "../src/core/installed.ts";
import {
  buildExport,
  exportFileName,
  ownedDataDirNames,
  serializeExport,
  unownedProfileDirs,
} from "../src/core/transfer.ts";
import { readSettingsFile } from "../src/core/settings.ts";

const profileArg = process.argv.indexOf("--profile");
if (profileArg < 0 || process.argv[profileArg + 1] === undefined) {
  console.error("必须显式指定 --profile <名字>（本脚本会读该 profile，默认不写盘）。");
  process.exit(2);
}
const profileName = process.argv[profileArg + 1];
const includeData = process.argv.includes("--include-data");
const doWrite = process.argv.includes("--write");
const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const profileDir = join(home, "profiles", profileName);
if (!existsSync(profileDir)) {
  console.error("profile 不存在：" + profileDir);
  process.exit(2);
}

console.log(`DSH_HOME：${home}`);
console.log(`profile：${profileName}（${profileDir}）`);
console.log(`写盘：${doWrite ? "是（写入 plugin-harbor/exports/）" : "否（只读预演）"}`);

const plugins = readInstalledPlugins(profileDir);
const loaded = readSettingsFile(join(profileDir, "plugin-harbor"));
console.log(`已装第三方插件：${plugins.length} 个`);

const now = Date.now();
const started = performance.now();
const bundle = buildExport({
  profileName,
  profileDir,
  pluginVersion: "verify-export",
  plugins,
  settings: loaded.settings,
  includeData,
  selfDirName: "plugin-harbor",
  now,
});
const elapsed = performance.now() - started;
const text = serializeExport(bundle);

console.log(`\n导出对象：${(text.length / 1024).toFixed(1)} KB，组装耗时 ${elapsed.toFixed(0)}ms`);
for (const plugin of bundle.plugins) {
  console.log(
    `  · ${plugin.name}｜${plugin.kind}｜${plugin.version ?? "?"}｜${plugin.enabled ? "已启用" : "已停用"}` +
      `｜配置行 ${plugin.config?.length ?? 0}｜条目 ${plugin.entries?.length ?? 0}｜设置文件 ${plugin.files?.length ?? 0}`,
  );
}
console.log(
  `\n补丁归属：认领 ${bundle.profilePatch?.attributed.length ?? 0} 行，` +
    `认不出归属 ${bundle.profilePatch?.unattributed.length ?? 0} 行` +
    (bundle.profilePatch?.error === undefined ? "" : `，解析错误：${bundle.profilePatch.error}`),
);
const reasons = new Map();
for (const item of bundle.omissions) reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1);
console.log(`未导出项：${bundle.omissions.length} 项`);
for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1]))
  console.log(`  · ${count} × ${reason}`);
console.log("警告：");
for (const line of bundle.warnings) console.log("  · " + line);
if (includeData) {
  const owned = ownedDataDirNames(profileDir, plugins, [], "plugin-harbor");
  const unowned = unownedProfileDirs(profileDir, owned);
  if (unowned.length > 0) console.log(`\n认不出归属的顶层目录：${unowned.join("、")}`);
}

if (doWrite) {
  const dir = join(profileDir, "plugin-harbor", "exports");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, exportFileName(profileName, now));
  writeFileSync(path, text, "utf8");
  console.log(`\n已写入：${path}（${statSync(path).size} 字节）`);
  // 写完再读回来验一遍格式（不打印内容）
  const back = JSON.parse(readFileSync(path, "utf8"));
  console.log(`读回校验：format=${back.format} version=${back.version} plugins=${back.plugins.length}`);
} else {
  console.log("\n（未写盘；需要落盘时加 --write）");
}