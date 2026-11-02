/**
 * 操作入参校验回归。
 *
 * 重点：挡掉会被 CLI 当成选项的参数与带空白/控制字符的输入。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  requireConfirm,
  validateName,
  validateSpec,
  validateTaskId,
} from "../src/ops/validate.ts";

test("包名：接受常见形态，拒绝会变成选项或含空白的输入", () => {
  for (const name of [
    "dsh-channel-hub",
    "@liustack/modsearch",
    "dsh-ops",
    "dsh.context",
    "a",
  ])
    assert.equal(validateName(name).ok, true, name + " 应被接受");

  for (const bad of [
    "-g",
    "--global",
    "has space",
    "line\nbreak",
    "tab\there",
    "",
    "   ",
    "../escape",
    "a".repeat(215),
  ]) {
    const result = validateName(bad);
    assert.equal(result.ok, false, JSON.stringify(bad) + " 应被拒绝");
    assert.ok(result.reason !== "");
  }
  assert.equal(validateName(123).ok, false);
});

test("安装地址：git / 路径 / 压缩包 / 版本范围都放行", () => {
  for (const spec of [
    "dsh-cost-meter",
    "dsh-cost-meter@1.9.47",
    "@scope/name@^1.0.0",
    "github:Seraphoenixy/dsh-channel-hub",
    "git+https://github.com/o/r.git#main",
    "https://github.com/o/r.git",
    "file:../local-plugin",
    "../local-plugin",
    "D:/plugins/x",
    // Windows 绝对路径就是反斜杠：本地路径形态的更新会拼出这种地址
    "file:D:\\plugins\\local-plugin",
    "./vendor/x-1.0.0.tgz",
    "latest",
  ])
    assert.equal(validateSpec(spec).ok, true, spec + " 应被接受");

  // 版本范围没有包名，不是可安装目标：早点拒绝比让 pnpm 报 404 更清楚
  const range = validateSpec("^1.9.28");
  assert.equal(range.ok, false);
  assert.match(range.reason, /缺少包名/);
});

test("安装地址：拒绝前导减号、空白与控制字符、超长", () => {
  for (const bad of [
    "-g",
    "--registry=http://evil",
    "dsh-x --global",
    "dsh-x\nrm -rf /",
    "\u0000dsh-x",
    "",
    "a".repeat(301),
  ]) {
    const result = validateSpec(bad);
    assert.equal(result.ok, false, JSON.stringify(bad) + " 应被拒绝");
  }
  assert.equal(validateSpec(undefined).ok, false);
});

test("确认与任务 id", () => {
  assert.equal(requireConfirm(true).ok, true);
  for (const value of [false, undefined, "true", 1, {}])
    assert.equal(requireConfirm(value).ok, false, JSON.stringify(value) + " 不算确认");

  assert.equal(validateTaskId("op-1-1700000000000").ok, true);
  for (const bad of ["", "  ", "a".repeat(121), "bad\u0001id"])
    assert.equal(validateTaskId(bad).ok, false);
});