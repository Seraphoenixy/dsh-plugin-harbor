import { spawnSync } from "node:child_process";

// 真实宿主契约测试：缺少本机宿主包时以退出码 2 结束（核心测试不需要宿主）。
for (const name of ["@deepseek-ai/cordis"]) {
  try {
    await import(name);
  } catch {
    console.error(
      "缺少真实宿主依赖 " + name + "；运行 node scripts/extract-host.mjs 后重试。",
    );
    process.exit(2);
  }
}
const result = spawnSync(process.execPath, ["--test", "tests/host.test.mjs"], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);