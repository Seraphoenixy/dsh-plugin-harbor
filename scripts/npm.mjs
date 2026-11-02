import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

/** 直接用当前 Node 跑 npm CLI：避免依赖 PATH 上的 npm 与 shell 差异。 */
export function npm(args, options = {}) {
  const cli =
    process.env.npm_execpath ??
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return spawnSync(process.execPath, [cli, ...args], options);
}