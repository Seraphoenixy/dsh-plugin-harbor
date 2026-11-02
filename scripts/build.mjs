import { build } from "esbuild";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const sourcemap = process.env.PLUGIN_HARBOR_SOURCEMAPS === "1";
await mkdir("dist", { recursive: true });

/**
 * 构建标识（源码内容哈希，两次同样源码得到同一个值）。
 *
 * ⚠️ 为什么必须有：客户端的 `client.js` 是**页面加载时从磁盘现取**的，而宿主侧
 * `index.js` 是**进程启动/上次重新组合时载入**的。两者可能不同步 —— 实测症状是新面板
 * 调用新方法时收到 `Unknown method: export.run`（宿主还是旧构建）。把同一个构建标识
 * 打进两个 bundle，界面就能直接说「宿主运行的是旧构建，请重启或触发一次重新组合」，
 * 而不是抛一句看不出所以然的错。
 *
 * 用内容哈希而不是时间戳：`dist/` 是入库产物，时间戳会让每次构建都产生无谓 diff。
 */
async function buildId() {
  const hash = createHash("sha256");
  const walk = async (dir) => {
    for (const name of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const path = join(dir, name.name);
      if (name.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!/\.(ts|css)$/.test(name.name)) continue;
      hash.update(path.replaceAll("\\", "/"));
      hash.update("\0");
      hash.update(await readFile(path));
      hash.update("\0");
    }
  };
  await walk("src");
  return hash.digest("hex").slice(0, 12);
}

const ID = await buildId();
const define = { __HARBOR_BUILD__: JSON.stringify(ID) };
console.log(`构建标识：${ID}`);

// 服务端入口（宿主进程内运行）。
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap,
  define,
});

// 目录库工作线程：与主线程分开部署，解析与写库不占宿主主线程。
await build({
  entryPoints: ["src/storage/worker.ts"],
  outfile: "dist/catalog-worker.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap,
  define,
});

await build({
  entryPoints: ["src/client.ts"],
  outfile: "dist/client.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  // 样式以**字符串**内联：交给 esbuild 默认的 CSS 处理会被抽成独立资源、
  // 默认导出一个空对象，页面就变成无样式。`text` loader 保证拿到原文。
  loader: { ".css": "text" },
  sourcemap,
  define,
});

/**
 * 自检：两个 bundle 都要真的带上构建标识。
 *
 * 只注入不引用（或哪天引用被删掉）时 esbuild 的 define 是静默空操作，界面就再也发现不了
 * 「宿主是旧构建」—— 那种失效必须是构建期就炸，而不是等用户看到 `Unknown method`。
 */
for (const file of ["dist/index.js", "dist/client.js"]) {
  const text = await readFile(file, "utf8");
  if (!text.includes(`"${ID}"`)) {
    console.error(`${file} 没有带上构建标识 ${ID}：检查 __HARBOR_BUILD__ 的引用是否还在。`);
    process.exit(2);
  }
}