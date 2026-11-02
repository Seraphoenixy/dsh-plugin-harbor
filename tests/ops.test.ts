/**
 * 操作层回归：服务适配归一化、子进程兜底与失败归类、FIFO 队列。
 *
 * 全部离线：spawn 是假 CLI（脚本化的 stdout/stderr/exit），不真跑 pnpm。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import {
  cancelWithManager,
  describeOutcome,
  installWithManager,
  isAlreadyInstalled,
  isIncompatible,
  normalizeOutcome,
  removeWithManager,
  setEnabledWithManager,
  type PluginManagerLike,
} from "../src/ops/manager.ts";
import {
  classifyDshFailure,
  estimateProgress,
  hostCliCandidates,
  needsShell,
  resolveDshCommand,
  runDshPlugin,
  type SpawnLike,
  type SpawnedChild,
} from "../src/ops/subprocess.ts";
import { OpQueue } from "../src/ops/queue.ts";
import type { OpRunner } from "../src/ops/types.ts";

test("宿主结果归一化：application 决定状态，缺失一律判失败", () => {
  const applied = normalizeOutcome(
    { changed: true, application: "applied", stage: "install", target: "dsh-x@1.2.3" },
    "dsh-x",
  );
  assert.equal(applied.status, "done");
  assert.equal(applied.changed, true);
  assert.equal(applied.target, "dsh-x@1.2.3");
  assert.equal(applied.message, "已完成");

  const restart = normalizeOutcome(
    { changed: true, application: "restart-required", restartReason: "no-hmr", target: "dsh-x" },
    "dsh-x",
  );
  assert.equal(restart.status, "restart");
  assert.match(restart.message, /需要重启 DSH/);
  assert.match(restart.message, /未开启热重载/);

  const cancelled = normalizeOutcome({ application: "cancelled", target: "dsh-x" }, "dsh-x");
  assert.equal(cancelled.status, "cancelled");
  assert.match(cancelled.message, /已取消/);

  const failed = normalizeOutcome(
    { application: "failed", error: { code: "not-bundle" }, target: "dsh-x" },
    "dsh-x",
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "not-bundle");
  assert.match(failed.message, /不是 DSH 插件/);

  // ⚠️ 宿主没有返回 application：绝不能当成功
  const unknown = normalizeOutcome({}, "dsh-y");
  assert.equal(unknown.status, "failed");
  assert.match(unknown.message, /没有返回结果/);

  const overridden = normalizeOutcome({ application: "overridden", target: "dsh-x" }, "dsh-x");
  assert.equal(overridden.status, "done");
  assert.match(overridden.message, /覆盖/);
});

test("错误码 → 下一步动作：已装 / 不兼容 / 不可移除", () => {
  const already = normalizeOutcome(
    { application: "failed", error: { code: "already-installed" }, target: "dsh-x" },
    "dsh-x",
  );
  assert.equal(isAlreadyInstalled(already), true);
  assert.match(already.message, /先卸载再安装/);

  const incompatible = normalizeOutcome(
    {
      application: "failed",
      target: "dsh-x",
      error: {
        code: "incompatible-version",
        incompatible: [
          {
            name: "dsh-x",
            version: "9.9.9",
            runtimeVersion: "0.2.1-rc.3",
            requirements: { "engines.dsh": ">=0.3.0" },
          },
        ],
      },
    },
    "dsh-x",
  );
  assert.equal(isIncompatible(incompatible), true);
  assert.match(incompatible.message, /allow-version dsh-x@9\.9\.9/);
  assert.match(incompatible.message, /engines\.dsh/);

  const blocked = normalizeOutcome(
    {
      application: "failed",
      target: "dsh-x",
      packageResult: { exitCode: 1, kind: "build-blocked", output: "", truncated: false, logPath: "/tmp/log" },
    },
    "dsh-x",
  );
  assert.equal(blocked.logPath, "/tmp/log");
  assert.match(blocked.message, /allowBuilds/);
});

test("适配层把抛错收敛成失败结果，不把异常漏给队列", async () => {
  const manager: PluginManagerLike = {
    async installBundle() {
      throw Error("boom");
    },
    async removeBundle() {
      throw Error("remove boom");
    },
    async setBundleEnabled() {
      throw Error("enable boom");
    },
    async listBundles() {
      return [];
    },
  };
  const installed = await installWithManager(manager, "dsh-x");
  assert.equal(installed.status, "failed");
  assert.match(installed.message, /boom/);
  const removed = await removeWithManager(manager, "dsh-x");
  assert.equal(removed.status, "failed");
  assert.match(removed.message, /remove boom/);
  const enabled = await setEnabledWithManager(manager, "dsh-x", true);
  assert.equal(enabled.status, "failed");
  // 没有 cancelInstall ⇒ unsupported（调用方据此退回子进程）
  assert.equal(await cancelWithManager(manager, "r1"), "unsupported");
});

test("describeOutcome 对未知组合也给出一句话", () => {
  const outcome = normalizeOutcome(
    { application: "failed", target: "t", error: { diagnostic: "  something  went\nwrong " } },
    "t",
  );
  assert.equal(outcome.message, "something went wrong");
});

/**
 * 本轮线上故障的回归点：宿主的 `operation-error` 是兜底错误码（pnpm 失败、模块
 * 加载失败、重载失败都用它），真正的原因只写在 `error.diagnostic` 里。旧实现命中
 * 错误码就返回「宿主的包操作失败」，把诊断整个丢掉 —— 用户拿到一句无法照做的话，
 * 只能自己去翻 pnpm.log。
 */
test("operation-error 必须带出宿主的诊断原文，并按已知特征给出下一步", () => {
  const unsupported = normalizeOutcome(
    {
      application: "failed",
      target: "dsh-cost-meter@^1.9.28",
      stage: "package",
      error: {
        code: "operation-error",
        diagnostic:
          '[ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER] "^1.9.28" isn\'t supported by any available resolver.',
      },
      packageResult: { kind: "unknown", exitCode: 1 },
    },
    "dsh-cost-meter",
  );
  assert.match(unsupported.message, /被当成包名/);
  assert.match(unsupported.message, /ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER/);

  const offline = normalizeOutcome(
    {
      application: "failed",
      target: "dsh-x",
      error: {
        code: "operation-error",
        diagnostic: "request to https://registry.npmjs.org/dsh-x failed",
      },
      packageResult: { kind: "network" },
    },
    "dsh-x",
  );
  // 诊断里没有已知特征时，用 packageResult.kind 的口径打头，原文照附
  assert.match(offline.message, /网络不可达/);
  assert.match(offline.message, /registry\.npmjs\.org/);

  const notFound = normalizeOutcome(
    {
      application: "failed",
      target: "dsh-x",
      error: { code: "operation-error", diagnostic: "ERR_PNPM_FETCH_404 GET ...: Not Found" },
      packageResult: { kind: "unknown" },
    },
    "dsh-x",
  );
  // 有已知特征时，特征给出的说明比 kind 更准（404 是「没有这个包」，不是「网络不通」）
  assert.match(notFound.message, /没有这个包或版本/);
  assert.match(notFound.message, /ERR_PNPM_FETCH_404/);

  const moduleGone = normalizeOutcome(
    {
      application: "failed",
      target: "@liustack/modsearch",
      error: { code: "operation-error", diagnostic: "Cannot find module '@liustack/modsearch'" },
    },
    "@liustack/modsearch",
  );
  assert.match(moduleGone.message, /找不到它的模块/);
  assert.match(moduleGone.message, /重新安装/);
});

test("有错误码但没有诊断时，如实说明「宿主没给原因」而不是留空", () => {
  const outcome = normalizeOutcome(
    { application: "failed", target: "dsh-x", error: { code: "operation-error" } },
    "dsh-x",
  );
  assert.match(outcome.message, /宿主的包操作失败/);
  assert.match(outcome.message, /没有给出诊断/);
});

test("已知错误码的固定文案不会被诊断顶掉，但诊断仍要附上", () => {
  const outcome = normalizeOutcome(
    {
      application: "failed",
      target: "dsh-x",
      error: { code: "not-bundle", diagnostic: "no dsh.bundle.patch in dsh-x" },
    },
    "dsh-x",
  );
  assert.match(outcome.message, /不是 DSH 插件/);
  assert.match(outcome.message, /no dsh\.bundle\.patch/);
});

// ---------- 子进程兜底 ----------

/** 假 CLI：按脚本吐出 stdout 后以给定退出码结束。 */
function fakeSpawn(script: {
  lines?: string[];
  stderr?: string[];
  code?: number | null;
  emitError?: string;
  delayMs?: number;
}): { spawn: SpawnLike; calls: { command: string; args: string[] }[]; killed: boolean[] } {
  const calls: { command: string; args: string[] }[] = [];
  const killed: boolean[] = [];
  const spawn: SpawnLike = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter() as EventEmitter & SpawnedChild;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    child.pid = 4242;
    child.stdout = stdout as any;
    child.stderr = stderr as any;
    child.kill = () => {
      killed.push(true);
      setTimeout(() => child.emit("close", 143), 0);
      return true;
    };
    setTimeout(() => {
      if (script.emitError) {
        const error: any = new Error(script.emitError);
        error.code = script.emitError.includes("ENOENT") ? "ENOENT" : undefined;
        child.emit("error", error);
        return;
      }
      for (const line of script.lines ?? []) stdout.emit("data", line + "\n");
      for (const line of script.stderr ?? []) stderr.emit("data", line + "\n");
      child.emit("close", script.code ?? 0);
    }, script.delayMs ?? 0);
    return child;
  };
  return { spawn, calls, killed };
}

test("子进程兜底：正常结束记进度，参数正确", async () => {
  const fake = fakeSpawn({
    lines: [
      "Progress: resolved 10, reused 8, downloaded 2, added 0",
      "Packages: +3",
      "dependencies:",
      "+ dsh-x 1.2.3",
      "Done in 4.9s using pnpm v11.28.5",
    ],
    code: 0,
  });
  const progress: number[] = [];
  const logs: string[] = [];
  const result = await runDshPlugin(
    {
      profile: "desktop",
      action: "add",
      spec: "github:o/r",
      dshCommand: "dsh",
      spawn: fake.spawn,
    },
    { progress: (value) => progress.push(value), log: (line) => logs.push(line) },
  );
  assert.deepEqual(fake.calls, [
    {
      command: "dsh",
      args: ["plugin", "--profile", "desktop", "add", "github:o/r"],
    },
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.failure, undefined, "退出码 0 不该给失败归类");
  assert.ok(logs.some((line) => line.includes("dsh-x")));
  assert.ok(progress.length > 0);
  assert.ok(
    progress.every((value, index) => index === 0 || value >= progress[index - 1]!),
    "进度只升不降",
  );
  // 真实 `dsh plugin` 的输出结尾是 pnpm 的 `Done in …`（96）；100 由队列在 done 时给。
  assert.equal(progress[progress.length - 1], 96);
});

test("子进程兜底：构建脚本被拦、404、权限各有可照做的说明", () => {
  assert.equal(
    classifyDshFailure(1, "ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED Ignored build scripts").kind,
    "build-blocked",
  );
  assert.match(
    classifyDshFailure(1, "ERR_PNPM_IGNORED_BUILDS").message,
    /allowBuilds/,
  );
  assert.equal(classifyDshFailure(1, "ERR_PNPM_FETCH_404 not in this registry").kind, "not-found");
  assert.equal(classifyDshFailure(1, "EACCES permission denied").kind, "permission");
  assert.equal(classifyDshFailure(1, "ENOSPC no space left on device").kind, "disk-full");
  assert.equal(classifyDshFailure(1, "", true).kind, "timeout");
  const unknown = classifyDshFailure(2, "line one\nboom happened");
  assert.equal(unknown.kind, "unknown");
  assert.match(unknown.message, /boom happened/);
});

test("子进程兜底：找不到 dsh 时给出明确指引", async () => {
  const fake = fakeSpawn({ emitError: "spawn dsh ENOENT" });
  const result = await runDshPlugin(
    {
      profile: "desktop",
      action: "add",
      spec: "dsh-x",
      dshCommand: "dsh",
      spawn: fake.spawn,
    },
    {},
  );
  assert.equal(result.failure?.kind, "dsh-missing");
  assert.match(result.failure!.message, /PLUGIN_HARBOR_DSH/);
});

// ---------- 「怎么调 dsh」的解析（Windows 上的真实缺陷） ----------

test("解析 dsh：PLUGIN_HARBOR_DSH 优先", () => {
  const resolved = resolveDshCommand({
    env: { PLUGIN_HARBOR_DSH: "C:/tools/dsh.cmd", PATH: "" } as any,
    exists: () => false,
  });
  assert.equal(resolved?.source, "override");
  assert.equal(resolved?.command, "C:/tools/dsh.cmd");
  assert.equal(resolved?.useShell, needsShell("C:/tools/dsh.cmd"), "`.cmd` 必须经 shell");
});

test("解析 dsh：宿主自带 CLI 优先于 PATH，且不需要 shell", () => {
  const candidates = hostCliCandidates("C:/app/DeepSeek Harness.exe");
  assert.ok(
    candidates[0]!.endsWith(
      join("resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js"),
    ),
  );
  const resolved = resolveDshCommand({
    env: { PATH: "C:/somewhere", PATHEXT: ".CMD" } as any,
    execPath: "C:/app/DeepSeek Harness.exe",
    exists: (path) => path === candidates[0],
    probePath: () => "C:/somewhere/dsh.cmd",
  });
  assert.equal(resolved?.source, "host-cli");
  assert.equal(resolved?.command, "C:/app/DeepSeek Harness.exe");
  assert.deepEqual(resolved?.prefixArgs, ["--expose-internals", candidates[0]]);
  assert.deepEqual(resolved?.env, { ELECTRON_RUN_AS_NODE: "1" });
  assert.equal(resolved?.useShell, false, "直接跑宿主 CLI，不经过 cmd.exe");
});

test("解析 dsh：宿主 CLI 不在时退回 PATH，PATH 也没有则返回 undefined", () => {
  const viaPath = resolveDshCommand({
    env: { PATH: "C:/bin" } as any,
    exists: () => false,
    probePath: () => "C:/bin/dsh.cmd",
  });
  assert.equal(viaPath?.source, "path");
  assert.equal(viaPath?.command, "C:/bin/dsh.cmd");

  const nothing = resolveDshCommand({
    env: { PATH: "C:/bin" } as any,
    exists: () => false,
    probePath: () => undefined,
  });
  assert.equal(nothing, undefined);
});

test("runDshPlugin：`.cmd` 经 shell 时拼一行命令串（避开 DEP0190）", async () => {
  const fake = fakeSpawn({ code: 0 });
  await runDshPlugin(
    {
      profile: "selftest",
      action: "add",
      spec: "github:o/r",
      dshCommand: "C:/bin/dsh.cmd",
      spawn: fake.spawn,
    },
    {},
  );
  const call = fake.calls[0]!;
  assert.equal(call.args.length, 0, "经 shell 时参数已拼进命令串");
  assert.equal(
    call.command,
    '"C:/bin/dsh.cmd" "plugin" "--profile" "selftest" "add" "github:o/r"',
  );
});

test("runDshPlugin：宿主 CLI 路径带上前缀参数与环境变量", async () => {
  const fake = fakeSpawn({ code: 0 });
  const spawned: any[] = [];
  const spawn: SpawnLike = (command, args, options) => {
    spawned.push({ command, args, options });
    return fake.spawn(command, args, options);
  };
  await runDshPlugin(
    {
      profile: "selftest",
      action: "remove",
      spec: "dsh-x",
      dshCommand: "C:/app/DeepSeek Harness.exe",
      dshPrefixArgs: ["--expose-internals", "C:/app/resources/app.asar/cli.js"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      spawn,
    },
    {},
  );
  assert.deepEqual(spawned[0]!.args, [
    "--expose-internals",
    "C:/app/resources/app.asar/cli.js",
    "plugin",
    "--profile",
    "selftest",
    "remove",
    "dsh-x",
  ]);
  assert.equal(spawned[0]!.options.env.ELECTRON_RUN_AS_NODE, "1");
  assert.notEqual(spawned[0]!.options.shell, true);
});

test("runDshPlugin：完全找不到 dsh 时如实报错，不抛", async () => {
  const fake = fakeSpawn({ code: 0 });
  const result = await runDshPlugin(
    {
      profile: "selftest",
      action: "add",
      spec: "dsh-x",
      spawn: fake.spawn,
      resolve: () => undefined,
    },
    {},
  );
  assert.equal(fake.calls.length, 0, "解析失败时不得启动任何进程");
  assert.equal(result.failure?.kind, "dsh-missing");
  assert.match(result.failure!.message, /PLUGIN_HARBOR_DSH/);
});

test("进度估算：resolved 比例压在低区间，脚本阶段中段，Done 收尾", () => {
  const early = estimateProgress("Progress: resolved 100, reused 0, downloaded 0, added 0");
  assert.ok(early >= 8 && early <= 30, `早期进度应压在 8–30，实际 ${early}`);
  const mid = estimateProgress("Progress: resolved 100, downloaded 100, added 100");
  assert.ok(mid >= 8 && mid <= 30);
  assert.equal(estimateProgress("Packages: +3"), 85);
  assert.equal(estimateProgress("Running prepare scripts"), 60);
  assert.equal(estimateProgress("Done in 4.9s using pnpm"), 96);
  assert.equal(estimateProgress("\n[exit 0]"), 100);
});

// ---------- 队列 ----------

const okRunner: OpRunner = async (task, control) => {
  control.progress(30, "step 1");
  control.progress(20, "step 2（倒退应被忽略）");
  control.log("done");
  return { status: "done", via: "manager" };
};

test("队列：FIFO、同一时刻只跑一个、进度只升不降", async () => {
  const order: string[] = [];
  let concurrent = 0;
  let peak = 0;
  const runner: OpRunner = async (task, control) => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    order.push(task.target);
    await new Promise((resolve) => setTimeout(resolve, 5));
    control.progress(50);
    concurrent -= 1;
    return { status: "done" };
  };
  const queue = new OpQueue(runner);
  const first = queue.enqueue({ kind: "install", target: "a" });
  const second = queue.enqueue({ kind: "install", target: "b" });
  const third = queue.enqueue({ kind: "remove", target: "c" });
  assert.equal(first.status, "running", "入队即启动（队列空闲时）");
  assert.equal(second.status, "queued");
  assert.equal(third.status, "queued");
  await queue.drain();
  assert.equal(peak, 1, "同一时刻只能跑一个变更任务");
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.deepEqual(
    queue.list().map((task) => task.status),
    ["done", "done", "done"],
  );
  assert.equal(first.progress, 100);
  assert.ok(second.endedAt !== undefined);
  assert.equal(third.startedAt !== undefined, true);
});

test("队列：进度单调、日志上限、终态回调", async () => {
  const finished: string[] = [];
  const queue = new OpQueue(
    async (task, control) => {
      control.progress(40);
      control.progress(10);
      for (let i = 0; i < 10; i++) control.log("line " + i);
      return { status: "restart-required", needsRestart: true, note: "需要重启" };
    },
    { maxLogLines: 4, onFinish: (task) => finished.push(`${task.target}:${task.status}`) },
  );
  const task = queue.enqueue({ kind: "install", target: "x" });
  await queue.drain();
  assert.equal(task.progress, 40, "倒退的进度必须被忽略");
  assert.deepEqual(task.log, ["line 6", "line 7", "line 8", "line 9"]);
  assert.equal(task.status, "restart-required");
  assert.equal(task.needsRestart, true);
  assert.equal(task.note, "需要重启");
  assert.deepEqual(finished, ["x:restart-required"]);
});

test("队列：取消运行中的任务会调用取消回调并把状态改成 cancelled", async () => {
  const cancelled: boolean[] = [];
  const queue = new OpQueue(async (task, control) => {
    control.onCancel(() => {
      cancelled.push(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { status: control.cancelled ? "cancelled" : "done" };
  });
  const task = queue.enqueue({ kind: "install", target: "x" });
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(task.status, "running");
  assert.equal(await queue.cancel(task.id), true);
  await queue.drain();
  assert.deepEqual(cancelled, [true], "必须把取消转给运行器");
  assert.equal(task.status, "cancelled");
  assert.equal(await queue.cancel("不存在"), false);
});

test("队列：取消排队中的任务不会启动它", async () => {
  const ran: string[] = [];
  const queue = new OpQueue(async (task) => {
    ran.push(task.target);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { status: "done" };
  });
  const first = queue.enqueue({ kind: "install", target: "a" });
  const second = queue.enqueue({ kind: "install", target: "b" });
  assert.equal(await queue.cancel(second.id), true);
  assert.equal(second.status, "cancelled");
  assert.equal(second.note, "排队时被取消");
  await queue.drain();
  assert.deepEqual(ran, ["a"]);
  assert.equal(first.status, "done");
});

test("队列：运行器抛错转成 failed，不让异常逃出队列", async () => {
  const queue = new OpQueue(async () => {
    throw Error("runner exploded");
  });
  const task = queue.enqueue({ kind: "install", target: "x" });
  await queue.drain();
  assert.equal(task.status, "failed");
  assert.match(task.error!, /runner exploded/);
});