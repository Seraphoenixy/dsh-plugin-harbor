/**
 * 安装地址拼装回归。
 *
 * 核心回归（本轮线上故障）：profile 里记的 registry 取值是**版本范围**，把它当成
 * 安装地址交给 pnpm 会报 `ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER`
 * （实测：更新 dsh-cost-meter 时先卸载成功、后安装失败，插件从 profile 里消失）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { latestSpec, installSpecFor, redactSpec } from "../src/ops/spec.ts";

const registry = { name: "dsh-cost-meter", spec: "^1.9.28", kind: "registry" } as const;

test("registry 取值必须带上包名，范围本身不是安装地址", () => {
  assert.equal(installSpecFor({ ...registry }), "dsh-cost-meter@^1.9.28");
  // 核实过的目标版本优先于记录范围（更新要真的走到用户确认过的那个版本）
  assert.equal(installSpecFor({ ...registry }, undefined, "1.9.30"), "dsh-cost-meter@1.9.30");
  assert.equal(installSpecFor({ name: "x", spec: "~1.2", kind: "registry" }), "x@~1.2");
  assert.equal(installSpecFor({ name: "x", spec: "*", kind: "registry" }), "x@*");
  assert.equal(installSpecFor({ name: "x", spec: "latest", kind: "registry" }), "x@latest");
  // 空取值只能落到 @latest：不猜版本
  assert.equal(installSpecFor({ name: "x", spec: "", kind: "registry" }), "x@latest");
  // 别名（npm:）本身也是一种取值，仍挂在包名后面
  assert.equal(
    installSpecFor({ name: "alias", spec: "npm:real@1.2.3", kind: "registry" }),
    "alias@npm:real@1.2.3",
  );
});

test("git / https 地址原样透传，绝不拼 @latest", () => {
  for (const spec of [
    "github:o/r",
    "git+https://github.com/o/r.git#main",
    "git@github.com:o/r.git",
    "https://example.com/x.tgz",
  ])
    assert.equal(installSpecFor({ name: "x", spec, kind: "git" }), spec);
});

test("http(s) 地址里的凭据在拼装与展示时都被抹掉", () => {
  const spec = "git+https://user:tok3n@github.com/o/r.git";
  assert.equal(redactSpec(spec), "git+https://github.com/o/r.git");
  assert.equal(installSpecFor({ name: "x", spec, kind: "git" }), "git+https://github.com/o/r.git");
});

test("本地路径按 profile 解析成绝对路径；不知道 profile 目录时原样透传", () => {
  const dir = "D:\\profiles\\desktop";
  // 期望值用 `resolve` 现算：分隔符随平台，断言不该盯着 `/` 与 `\` 的差别
  assert.equal(
    installSpecFor({ name: "x", spec: "file:../local-plugin", kind: "path" }, dir),
    `file:${resolve(dir, "../local-plugin")}`,
  );
  assert.equal(
    installSpecFor({ name: "x", spec: "file:../local-plugin", kind: "path" }),
    "file:../local-plugin",
  );
  // link:（软链语义）必须保住协议，不能被改写成 file:
  assert.equal(
    installSpecFor({ name: "x", spec: "link:../local-plugin", kind: "path" }, dir),
    `link:${resolve(dir, "../local-plugin")}`,
  );
  // 没有协议的裸相对路径：知道 profile 目录时补成 file: 绝对路径
  assert.equal(
    installSpecFor({ name: "x", spec: "../local.tgz", kind: "tarball" }, dir),
    `file:${resolve(dir, "../local.tgz")}`,
  );
  assert.equal(
    installSpecFor({ name: "x", spec: "../local.tgz", kind: "tarball" }),
    "../local.tgz",
  );
});

test("依赖键与包名不同（别名安装）时前置依赖键", () => {
  assert.equal(
    installSpecFor({
      name: "mine",
      spec: "github:o/r-pkg",
      kind: "git",
      packageName: "real-pkg",
    }),
    "mine@github:o/r-pkg",
  );
});

test("latestSpec：只有 registry 口碑才拼 @latest，其余按形态走拼装", () => {
  assert.equal(latestSpec("registry", "^1.9.28", "dsh-x"), "dsh-x@latest");
  assert.equal(latestSpec(undefined, "^1.9.28", "dsh-x"), "dsh-x@latest");
  assert.equal(latestSpec(undefined, "", "dsh-x"), "dsh-x@latest");
  assert.equal(latestSpec("git", "github:o/r", "dsh-x"), "github:o/r");
  assert.equal(latestSpec("path", "file:../p", "dsh-x"), "file:../p");
  assert.equal(latestSpec("tarball", "./x.tgz", "dsh-x"), "./x.tgz");
  assert.equal(
    latestSpec("path", "file:../p", "dsh-x", "D:\\profiles\\desktop"),
    `file:${resolve("D:\\profiles\\desktop", "../p")}`,
  );
});