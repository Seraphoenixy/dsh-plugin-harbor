/**
 * 开发用自动重载（`src/ops/watch.ts`）：开关判据 + 监视器的防抖与过滤。
 *
 * 全部离线：只用临时目录里造出来的假 dist，不碰真实 profile，也不碰本仓库的 dist。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldWatch, watchDist } from "../src/ops/watch.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "harbor-watch-"));

test("shouldWatch：只有检出目录才启用（正式安装的副本里没有 src/）", () => {
  const root = tempDir();
  try {
    const checkout = join(root, "checkout");
    mkdirSync(join(checkout, "src"), { recursive: true });
    mkdirSync(join(checkout, "dist"), { recursive: true });
    writeFileSync(join(checkout, "src", "index.ts"), "export {}");

    // 检出目录：有 src/index.ts + dist → 启用
    assert.equal(shouldWatch(checkout, {}), true);

    // 显式关闭
    assert.equal(shouldWatch(checkout, { PLUGIN_HARBOR_HOT_RELOAD: "0" }), false);
    // 其它值不关闭（只认字面 "0"）
    assert.equal(shouldWatch(checkout, { PLUGIN_HARBOR_HOT_RELOAD: "1" }), true);

    /**
     * 正式安装的副本：`package.json` 的 files 不含 src/，所以只有 dist/。
     * 这是「以后正式使用与源码项目没关系」的那条判据 —— 必须返回 false。
     */
    const installed = join(root, "installed");
    mkdirSync(join(installed, "dist"), { recursive: true });
    writeFileSync(join(installed, "dist", "index.js"), "export {}");
    assert.equal(shouldWatch(installed, {}), false, "没有 src/index.ts 就不该监视");

    // dist 不存在也不启用（没什么可盯的）
    const noDist = join(root, "no-dist");
    mkdirSync(join(noDist, "src"), { recursive: true });
    writeFileSync(join(noDist, "src", "index.ts"), "export {}");
    assert.equal(shouldWatch(noDist, {}), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("watchDist：连续写入合并成一次回调，且只认过滤后的产物", async () => {
  const root = tempDir();
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.js"), "// v1");

  let calls = 0;
  const stop = watchDist({
    dir: dist,
    debounceMs: 60,
    filter: (file) => file === "index.js",
    onChange: () => {
      calls += 1;
    },
    logger: {},
  });
  try {
    // 过滤掉的产物：不该触发
    writeFileSync(join(dist, "client.js"), "// client");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(calls, 0, "client.js 不在过滤名单里，不该触发重载");

    // 连续三次写 index.js：防抖后只触发一次
    for (const value of ["v2", "v3", "v4"]) {
      writeFileSync(join(dist, "index.js"), `// ${value}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(calls, 1, "一次构建连写多个文件只该重载一次");
  } finally {
    stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("watchDist：停止之后不再回调（可重复调用停止函数）", async () => {
  const root = tempDir();
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.js"), "// v1");

  let calls = 0;
  const stop = watchDist({
    dir: dist,
    debounceMs: 50,
    onChange: () => {
      calls += 1;
    },
    logger: {},
  });
  try {
    stop();
    stop(); // 重复调用必须安全
    writeFileSync(join(dist, "index.js"), "// v2");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(calls, 0, "停止后不得再触发");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("watchDist：目录不存在时返回可用的空停止函数，而不是抛错", () => {
  const stop = watchDist({
    dir: join(tmpdir(), "harbor-watch-does-not-exist-" + Date.now()),
    onChange: () => {},
    logger: {},
  });
  assert.equal(typeof stop, "function");
  stop();
  stop();
});
