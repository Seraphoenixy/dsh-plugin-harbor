// Development only: extract actual installed host libraries, never mocks. Does not touch the installed DSH profile.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const file =
  process.env.DSH_ASAR ??
  join(
    process.env.LOCALAPPDATA ?? "",
    "Programs",
    "DeepSeek Harness",
    "resources",
    "app.asar",
  );
if (!existsSync(file)) {
  console.error("缺少 DSH app.asar；设置 DSH_ASAR 后重试。");
  process.exit(2);
}
const raw = readFileSync(file);
const length = raw.readUInt32LE(12);
const start = 16;
let index;
try {
  index = JSON.parse(raw.subarray(start, start + length).toString("utf8"));
} catch {
  console.error("不支持的 ASAR 头部格式，未写入。");
  process.exit(2);
}
const base = start + length;
const files = new Map();
function walk(node, p = "") {
  if (node.files)
    for (const [k, v] of Object.entries(node.files)) walk(v, p ? p + "/" + k : k);
  else if (node.offset !== undefined) files.set(p, node);
}
walk(index);
const seen = new Set();
function extract(name) {
  if (seen.has(name) || name.startsWith("node:")) return;
  seen.add(name);
  const prefix = ["dsh/node_modules/", "node_modules/"]
    .map((p) => p + name + "/")
    .find((p) => files.has(p + "package.json"));
  if (!prefix) throw Error("ASAR 缺少依赖 " + name);
  const get = (p) => {
    const e = files.get(p);
    return raw.subarray(
      base + Number(e.offset),
      base + Number(e.offset) + e.size,
    );
  };
  const pkg = JSON.parse(get(prefix + "package.json"));
  for (const [path] of files)
    if (path.startsWith(prefix)) {
      const dest = join("node_modules", name, path.slice(prefix.length));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, get(path));
    }
  for (const dep of Object.keys(pkg.dependencies ?? {})) extract(dep);
  console.log(name + " " + pkg.version);
}
// 本插件在真实宿主契约测试里只需要 cordis 内核；需要服务端类型时再补。
for (const name of ["@deepseek-ai/cordis"]) extract(name);