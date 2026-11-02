import { npm } from "./npm.mjs";
import assert from "node:assert/strict";

const result = npm(["pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
});
if (result.status !== 0) {
  console.error(result.stderr);
  process.exit(1);
}
const pack = JSON.parse(result.stdout)[0];
const files = new Set(pack.files.map((f) => f.path));
for (const required of [
  "dist/index.js",
  "dist/client.js",
  "dist/catalog-worker.js",
  "cordis.patch.yml",
  "LICENSE",
])
  assert.ok(files.has(required), "Missing " + required);
// 安装包不得含源码、依赖、运行时数据与日志。
// ⚠️ 不要用裸 `catalog-` 前缀做黑名单：本插件自己的产物就叫
// `dist/catalog-worker.js`，那样会把正常产物判成私有文件（本轮实测踩到）。
for (const file of files)
  assert.ok(
    !/^src\/|(^|\/)node_modules\/|\.sqlite|\.log$|catalog-.*\.json$/.test(file),
    "Unexpected private/runtime file " + file,
  );
console.log(
  "Package verified: " +
    pack.files.length +
    " files, " +
    pack.size +
    " compressed bytes",
);