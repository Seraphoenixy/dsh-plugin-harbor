/**
 * 已装事实采集的夹具回归。
 *
 * profile 是测试里临时搭出来的（清单 + lockfile 夹具 + 假 node_modules），
 * 不读任何真实 profile。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifySpec,
  commitOfTarball,
  githubRepoOf,
  readInstalledPlugins,
} from "../src/core/installed.ts";

const lockfile = readFileSync(
  new URL("./fixtures/profile-lock.yaml", import.meta.url),
  "utf8",
);

/** 搭一个临时 profile：只写清单、lockfile 与假的 node_modules。 */
function withProfile(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pcenter-profile-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "dsh-profile-desktop",
        private: true,
        dsh: {
          profile: {
            bundles: ["dsh-channel-hub", "dsh-cost-meter", "dsh-local-plugin"],
          },
        },
        dependencies: {
          "@deepseek-ai/dsh-base": "0.2.1-rc.3",
          "dsh-channel-hub": "github:Seraphoenixy/dsh-channel-hub",
          "dsh-cost-meter": "^1.9.28",
          "dsh-local-plugin": "file:../local-plugin",
          "dsh-packed-plugin": "./vendor/dsh-packed-plugin-1.0.0.tgz",
        },
      }),
      "utf8",
    );
    writeFileSync(join(dir, "pnpm-lock.yaml"), lockfile, "utf8");
    const write = (name: string, pkg: unknown) => {
      const target = join(dir, "node_modules", name);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "package.json"), JSON.stringify(pkg), "utf8");
    };
    write("@deepseek-ai/dsh-base", { name: "@deepseek-ai/dsh-base", version: "0.2.1-rc.3" });
    write("dsh-channel-hub", {
      name: "dsh-channel-hub",
      version: "0.1.0-alpha.1",
      repository: "git+https://github.com/Seraphoenixy/dsh-channel-hub.git",
      dsh: { bundle: { patch: "./cordis.patch.yml" }, client: { platform: "web" } },
    });
    // repository 写成对象形态（npm 两种写法都要认）
    write("dsh-cost-meter", {
      name: "dsh-cost-meter",
      version: "1.9.28",
      repository: { type: "git", url: "git+https://github.com/Han-1413141/dsh-cost-meter.git" },
      dsh: { bundle: { patch: "./cordis.patch.yml" } },
    });
    // 本地路径包：没有 repository，版本也读不到 → 两个字段都留空
    write("dsh-local-plugin", { name: "dsh-local-plugin" });
    // dsh-packed-plugin 故意不落盘：present 应为 false，其余留空
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("spec 形态判定覆盖真实写法的四类", () => {
  assert.equal(classifySpec("github:Seraphoenixy/dsh-channel-hub"), "git");
  assert.equal(classifySpec("git+https://github.com/o/r.git"), "git");
  assert.equal(classifySpec("https://github.com/o/r.git#main"), "git");
  assert.equal(classifySpec("^1.9.28"), "registry");
  assert.equal(classifySpec("1.9.28"), "registry");
  assert.equal(classifySpec("latest"), "registry");
  assert.equal(classifySpec("file:../plugin"), "path");
  assert.equal(classifySpec("link:../plugin"), "path");
  assert.equal(classifySpec("../plugin"), "path");
  assert.equal(classifySpec("D:\\plugins\\x"), "path");
  assert.equal(classifySpec("./vendor/x-1.0.0.tgz"), "tarball");
  assert.equal(classifySpec("https://example.com/x.tgz"), "tarball");
  assert.equal(classifySpec(""), "unknown");
});

test("github 仓库身份从三种写法里取", () => {
  assert.equal(
    githubRepoOf("git+https://github.com/Seraphoenixy/dsh-channel-hub.git"),
    "Seraphoenixy/dsh-channel-hub",
  );
  assert.equal(githubRepoOf("https://github.com/o/r"), "o/r");
  assert.equal(githubRepoOf({ url: "git+https://github.com/Han-1413141/dsh-cost-meter.git" }), "Han-1413141/dsh-cost-meter");
  assert.equal(githubRepoOf("github:o/r"), "o/r");
  assert.equal(githubRepoOf("https://example.com/x"), undefined);
  assert.equal(githubRepoOf(undefined), undefined);
});

test("commit 只从 tar.gz 直链里取，不猜", () => {
  assert.equal(
    commitOfTarball(
      "https://codeload.github.com/Seraphoenixy/dsh-channel-hub/tar.gz/8B5F49914AA56C8C544A70ABE38E134B5148A261",
    ),
    "8b5f49914aa56c8c544a70abe38e134b5148a261",
  );
  assert.equal(commitOfTarball("https://registry.npmjs.org/x/-/x-1.0.0.tgz"), undefined);
  assert.equal(commitOfTarball(undefined), undefined);
});

test("读出一个 profile 的已装插件（宿主包被排除）", () => {
  withProfile((dir) => {
    const plugins = readInstalledPlugins(dir);
    assert.deepEqual(
      plugins.map((plugin) => plugin.name),
      [
        "dsh-channel-hub",
        "dsh-cost-meter",
        "dsh-local-plugin",
        "dsh-packed-plugin",
      ],
      "按名字排序，且不含 @deepseek-ai/*",
    );

    const git = plugins.find((p) => p.name === "dsh-channel-hub")!;
    assert.equal(git.kind, "git");
    assert.equal(git.spec, "github:Seraphoenixy/dsh-channel-hub");
    assert.equal(git.version, "0.1.0-alpha.1");
    assert.equal(git.repo, "Seraphoenixy/dsh-channel-hub");
    // commit 只能来自 lockfile（node_modules 副本里没有 git 元数据）
    assert.equal(git.commit, "8b5f49914aa56c8c544a70abe38e134b5148a261");
    assert.equal(git.selected, true);
    assert.equal(git.bundle, true);
    assert.equal(git.hasClient, true);
    assert.equal(git.present, true);

    const registry = plugins.find((p) => p.name === "dsh-cost-meter")!;
    assert.equal(registry.kind, "registry");
    assert.equal(registry.spec, "^1.9.28");
    assert.equal(registry.version, "1.9.28");
    assert.equal(registry.repo, "Han-1413141/dsh-cost-meter");
    assert.equal(registry.integrity, "sha512-aizlBxDGE0Q1ISvbGG25AlLMC");
    assert.equal(registry.commit, undefined, "registry 形态没有 commit");
    assert.equal(registry.hasClient, false);

    const local = plugins.find((p) => p.name === "dsh-local-plugin")!;
    assert.equal(local.kind, "path");
    assert.equal(local.version, undefined, "读不到版本不能填默认值");
    assert.equal(local.repo, undefined, "读不到仓库身份就留空");
    assert.equal(local.present, true);
    assert.equal(local.selected, true);

    const missing = plugins.find((p) => p.name === "dsh-packed-plugin")!;
    assert.equal(missing.kind, "tarball");
    assert.equal(missing.present, false);
    assert.equal(missing.version, undefined);
    assert.equal(missing.selected, false);
    // 本地 tgz 的 tarball 字段是文件路径，取不出 commit
    assert.equal(missing.commit, undefined);
  });
});

test("缺 lockfile / 缺清单时返回空表而不是抛错", () => {
  const dir = mkdtempSync(join(tmpdir(), "pcenter-nolock-"));
  try {
    assert.deepEqual(readInstalledPlugins(dir), []);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {} }), "utf8");
    assert.deepEqual(readInstalledPlugins(dir), []);
    writeFileSync(join(dir, "pnpm-lock.yaml"), "importers: {}\n", "utf8");
    assert.deepEqual(readInstalledPlugins(dir), []);
    // 坏 YAML 也不能抛
    writeFileSync(join(dir, "pnpm-lock.yaml"), "a: [unclosed\n", "utf8");
    assert.deepEqual(readInstalledPlugins(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});