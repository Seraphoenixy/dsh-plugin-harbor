/**
 * 操作编排回归：服务优先 / 子进程兜底的决策与结果归一。
 *
 * 全部离线：宿主服务是桩，子进程是假 CLI（见 `tests/helpers/fake-cli.ts`）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { executeTask, type ExecuteDeps } from "../src/ops/execute.ts";
import type { PluginManagerLike } from "../src/ops/manager.ts";
import type { OpControl, OpTask } from "../src/ops/types.ts";
import { fakeCli } from "./helpers/fake-cli.ts";

function makeTask(kind: OpTask["kind"], target: string, spec?: string): OpTask {
  return {
    id: "t1",
    kind,
    target,
    status: "running",
    log: [],
    queuedAt: 1,
    ...(spec !== undefined ? { spec } : {}),
  };
}

function makeControl(): OpControl & { lines: string[]; progressValues: (number | undefined)[] } {
  const lines: string[] = [];
  const progressValues: (number | undefined)[] = [];
  return {
    lines,
    progressValues,
    cancelled: false,
    onCancel: () => {},
    progress: (value, line) => {
      progressValues.push(value);
      if (line) lines.push(line);
    },
    log: (line) => lines.push(line),
  };
}

/** 宿主服务桩：按脚本返回结果，并记录调用。 */
function stubManager(script: {
  install?: any[];
  remove?: any[];
  setEnabled?: any[];
  setPluginEnabled?: any[];
}): { manager: PluginManagerLike; calls: string[] } {
  const calls: string[] = [];
  const next = (list: any[] | undefined, fallback: any) =>
    list && list.length > 0 ? list.shift() : fallback;
  const manager: PluginManagerLike = {
    async installBundle(spec) {
      calls.push(`install:${spec}`);
      return next(script.install, { changed: true, application: "applied", target: spec });
    },
    async removeBundle(name) {
      calls.push(`remove:${name}`);
      return next(script.remove, { changed: true, application: "applied", target: name });
    },
    async setBundleEnabled(name, enabled) {
      calls.push(`setEnabled:${name}:${enabled}`);
      return next(script.setEnabled, {
        changed: true,
        application: "applied",
        target: name,
        enabled,
      });
    },
    async setPluginEnabled(id, enabled) {
      calls.push(`setEntry:${id}:${enabled}`);
      return next(script.setPluginEnabled, {
        changed: true,
        application: "applied",
        target: id,
        enabled,
      });
    },
    async listBundles() {
      return [];
    },
    async listPlugins() {
      return [];
    },
  };
  return { manager, calls };
}

const deps = (over: Partial<ExecuteDeps> = {}): ExecuteDeps => ({
  profileName: "desktop",
  // 夹具里显式给出命令名：不写的话会走 `resolveDshCommand()`，在本机命中
  // PATH 上的 `dsh.cmd` → 变成「经 shell 拼一行命令串」，假 CLI 收到的参数
  // 形状就与断言不符（本轮实测：6 个子进程用例因为这条一起失败）。
  dshCommand: "dsh",
  ...over,
});

test("安装：有服务就走服务，不再碰子进程", async () => {
  const { manager, calls } = stubManager({});
  const cli = fakeCli({ code: 0 });
  const control = makeControl();
  const task = makeTask("install", "github:o/r", "github:o/r");
  const outcome = await executeTask(task, control, deps({ manager, spawn: cli.spawn }));
  assert.equal(outcome.status, "done");
  assert.equal(outcome.via, "manager");
  assert.deepEqual(calls, ["install:github:o/r"]);
  assert.equal(cli.calls.length, 0, "服务成功时不该启动子进程");
  assert.equal(task.requestId, "plugin-harbor:t1", "必须带 requestId 以便取消");
});

test("安装：宿主回 already-installed 时改用子进程原地覆盖", async () => {
  const { manager } = stubManager({
    install: [{ changed: false, application: "failed", target: "github:o/r", error: { code: "already-installed" } }],
  });
  const cli = fakeCli({ lines: ["Done in 1.2s using pnpm v11.28.5"], code: 0 });
  const control = makeControl();
  const outcome = await executeTask(
    makeTask("install", "github:o/r", "github:o/r"),
    control,
    deps({ manager, spawn: cli.spawn }),
  );
  assert.equal(outcome.via, "subprocess");
  assert.equal(outcome.status, "restart-required");
  assert.equal(outcome.needsRestart, true);
  assert.deepEqual(cli.calls[0]!.args, [
    "plugin",
    "--profile",
    "desktop",
    "add",
    "github:o/r",
  ]);
  assert.match(control.lines.join("\n"), /already-installed/);
});

test("安装：没有宿主服务时全程走子进程", async () => {
  const cli = fakeCli({ code: 0 });
  const outcome = await executeTask(
    makeTask("install", "dsh-x", "dsh-x@1.2.3"),
    makeControl(),
    deps({ spawn: cli.spawn }),
  );
  assert.equal(outcome.via, "subprocess");
  assert.equal(outcome.status, "restart-required");
  assert.deepEqual(cli.calls[0]!.args.slice(3), ["add", "dsh-x@1.2.3"]);
});

test("安装：子进程失败时把构建脚本被拦这类原因照原样带出来", async () => {
  const cli = fakeCli({
    stderr: ["ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED Ignored build scripts"],
    code: 1,
  });
  const outcome = await executeTask(
    makeTask("install", "github:o/r", "github:o/r"),
    makeControl(),
    deps({ spawn: cli.spawn }),
  );
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error!, /allowBuilds/);
});

test("安装：版本不兼容时把豁免命令交给用户，不回退子进程", async () => {
  const { manager } = stubManager({
    install: [
      {
        changed: false,
        application: "failed",
        target: "dsh-x@9.9.9",
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
    ],
  });
  const cli = fakeCli({ code: 0 });
  const outcome = await executeTask(
    makeTask("install", "dsh-x", "dsh-x@9.9.9"),
    makeControl(),
    deps({ manager, spawn: cli.spawn }),
  );
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error!, /allow-version dsh-x@9\.9\.9/);
  assert.equal(cli.calls.length, 0, "兼容性问题换子进程没有意义");
});

/**
 * 热重载口径：宿主的 `application` 是权威结论 —— 桌面宿主默认加载 `hmr`，它回
 * `applied` 就说明新代码已经原地生效；旧实现无条件把它改写成「需要重启」，
 * 用户看到的假重启提示就来自那里（本轮报障：改为支持热加载）。
 */
test("更新：宿主回 applied 时按「已热加载」收尾，不谎报需要重启", async () => {
  const { manager, calls } = stubManager({
    remove: [{ changed: true, application: "applied", target: "dsh-x" }],
    install: [
      { changed: true, application: "applied", target: "dsh-x", stage: "install" },
    ],
  });
  const control = makeControl();
  const outcome = await executeTask(
    makeTask("update", "dsh-x", "^1.9.28"),
    control,
    deps({ manager }),
  );
  assert.equal(outcome.status, "done");
  assert.notEqual(outcome.needsRestart, true);
  assert.match(outcome.note!, /已热加载/);
  assert.match(outcome.note!, /无需重启/);
  assert.doesNotMatch(outcome.note!, /请重启/);
  assert.deepEqual(calls, ["remove:dsh-x", "install:dsh-x@latest"]);
});

test("更新：宿主回 restart-required 时如实转述原因", async () => {
  const { manager } = stubManager({
    remove: [{ changed: true, application: "applied", target: "dsh-x" }],
    install: [
      {
        changed: true,
        application: "restart-required",
        target: "dsh-x",
        restartReason: "package-moved",
      },
    ],
  });
  const outcome = await executeTask(
    makeTask("update", "dsh-x", "^1.9.28"),
    makeControl(),
    deps({ manager }),
  );
  assert.equal(outcome.status, "restart-required");
  assert.equal(outcome.needsRestart, true);
  assert.match(outcome.note!, /重启/);
  assert.match(outcome.note!, /包位置发生了变化/);
});

/**
 * 本轮线上故障的回归点：profile 里记的 registry 取值是**版本范围**（`^1.9.28`），
 * 它不是安装地址。旧实现把它原样交给宿主，pnpm 报
 * `ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER`，而那时旧版本**已经卸载**，
 * 插件就此从 profile 里消失。这里钉死两件事：交给 pnpm 的必须带包名；服务端算好的
 * 地址（含核实过的目标版本）优先。
 */
test("更新：交给 pnpm 的地址必须带包名，绝不把版本范围当包名", async () => {
  const { manager, calls } = stubManager({
    remove: [{ changed: true, application: "applied", target: "dsh-x" }],
    install: [{ changed: true, application: "applied", target: "dsh-x" }],
  });
  const task = { ...makeTask("update", "dsh-x", "^1.9.28"), installSpec: "dsh-x@1.9.30" };
  const outcome = await executeTask(task, makeControl(), deps({ manager }));
  assert.equal(outcome.status, "done");
  assert.deepEqual(calls, ["remove:dsh-x", "install:dsh-x@1.9.30"]);
  for (const call of calls) assert.doesNotMatch(call, /install:\^/, "范围不能当包名交给 pnpm");
});

test("更新：安装失败时按原地址回滚，不让失败把插件弄丢", async () => {
  const { manager, calls } = stubManager({
    remove: [{ changed: true, application: "applied", target: "dsh-x" }],
    install: [
      {
        changed: false,
        application: "failed",
        target: "dsh-x@1.9.30",
        error: {
          code: "operation-error",
          diagnostic: '[ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER] "^1.9.28" isn\'t supported',
        },
        packageResult: { kind: "unknown" },
      },
      { changed: true, application: "applied", target: "dsh-x@^1.9.28" },
    ],
  });
  const task = {
    ...makeTask("update", "dsh-x", "^1.9.28"),
    installSpec: "dsh-x@1.9.30",
    restoreSpec: "dsh-x@^1.9.28",
  };
  const outcome = await executeTask(task, makeControl(), deps({ manager }));
  assert.equal(outcome.status, "failed");
  assert.deepEqual(calls, ["remove:dsh-x", "install:dsh-x@1.9.30", "install:dsh-x@^1.9.28"]);
  assert.match(outcome.error!, /已按原地址把 dsh-x 装回/);
  // 失败原因不能被折叠成一句「宿主的包操作失败」：诊断原文要带出来
  assert.match(outcome.error!, /ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER/);
});

test("更新：回滚也失败时如实说清「插件已不在依赖里，请重新安装」", async () => {
  const { manager } = stubManager({
    remove: [{ changed: true, application: "applied", target: "dsh-x" }],
    install: [
      { changed: false, application: "failed", target: "dsh-x", error: { code: "network" } },
      { changed: false, application: "failed", target: "dsh-x", error: { code: "network" } },
    ],
  });
  const task = {
    ...makeTask("update", "dsh-x", "^1.9.28"),
    installSpec: "dsh-x@1.9.30",
    restoreSpec: "dsh-x@^1.9.28",
  };
  const outcome = await executeTask(task, makeControl(), deps({ manager }));
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error!, /回滚也没成功/);
  assert.match(outcome.error!, /不在 profile 的依赖里，请重新安装/);
});

test("更新：安装阶段被取消时如实说明依赖已经卸掉了（不背着用户装回去）", async () => {
  const { manager, calls } = stubManager({
    remove: [{ changed: true, application: "applied", target: "dsh-x" }],
    install: [{ changed: false, application: "cancelled", target: "dsh-x" }],
  });
  const task = {
    ...makeTask("update", "dsh-x", "^1.9.28"),
    installSpec: "dsh-x@1.9.30",
    restoreSpec: "dsh-x@^1.9.28",
  };
  const outcome = await executeTask(task, makeControl(), deps({ manager }));
  assert.equal(outcome.status, "cancelled");
  assert.match(outcome.note!, /已经卸载/);
  assert.deepEqual(calls, ["remove:dsh-x", "install:dsh-x@1.9.30"], "取消不该再触发回滚安装");
});

test("启用失败且依赖已不在 profile 里时说清原因与下一步", async () => {
  const { manager } = stubManager({
    setEnabled: [
      {
        changed: false,
        application: "failed",
        target: "@liustack/modsearch",
        error: { code: "operation-error", diagnostic: "Cannot find module '@liustack/modsearch'" },
      },
    ],
  });
  const missing = await executeTask(
    makeTask("enable", "@liustack/modsearch"),
    makeControl(),
    deps({ manager, dependencyPresent: () => false }),
  );
  assert.equal(missing.status, "failed");
  assert.match(missing.error!, /已经不在 profile 的 dependencies 里/);
  assert.match(missing.error!, /重新安装/);
  // 宿主的诊断也要在：不能只说「宿主的包操作失败」
  assert.match(missing.error!, /找不到它的模块/);

  const { manager: present } = stubManager({
    setEnabled: [
      {
        changed: false,
        application: "failed",
        target: "dsh-x",
        error: { code: "incompatible-version" },
      },
    ],
  });
  const other = await executeTask(
    makeTask("enable", "dsh-x"),
    makeControl(),
    deps({ manager: present, dependencyPresent: () => true }),
  );
  assert.equal(other.status, "failed");
  assert.doesNotMatch(other.error!, /不在 profile 的 dependencies 里/);
});

test("更新：宿主不肯卸载时改用子进程原地覆盖 @latest", async () => {
  const { manager } = stubManager({
    remove: [
      { changed: false, application: "failed", target: "dsh-x", error: { code: "not-removable" } },
    ],
  });
  const cli = fakeCli({ code: 0 });
  const outcome = await executeTask(
    makeTask("update", "dsh-x", "^1.9.28"),
    makeControl(),
    deps({ manager, spawn: cli.spawn }),
  );
  assert.equal(outcome.via, "subprocess");
  assert.deepEqual(cli.calls[0]!.args.slice(3), ["add", "dsh-x@latest"]);
});

test("更新：git / 本地路径形态的 spec 原样重装，不拼 @latest", async () => {
  for (const [kind, spec] of [
    ["git", "github:o/r"],
    ["path", "file:../local-plugin"],
    ["tarball", "./vendor/x-1.0.0.tgz"],
  ] as const) {
    // 每次循环都要一个全新的桩：脚本化的 remove 结果只够用一次，
    // 复用同一个桩会让第二次走进「卸载成功」的分支（本轮实测踩到）。
    const { manager } = stubManager({
      remove: [
        { changed: false, application: "failed", target: "dsh-x", error: { code: "not-removable" } },
      ],
    });
    const cli = fakeCli({ code: 0 });
    const task = makeTask("update", "dsh-x", spec);
    task.specKind = kind;
    await executeTask(task, makeControl(), deps({ manager, spawn: cli.spawn }));
    assert.deepEqual(
      cli.calls[0]!.args.slice(3),
      ["add", spec],
      `${kind} 形态不该被拼上 @latest（github:o/r@latest 是无效地址）`,
    );
  }
});

test("更新：没有 spec 时用包名 @latest", async () => {
  const { manager } = stubManager({
    remove: [
      { changed: false, application: "failed", target: "dsh-x", error: { code: "bundle-in-use" } },
    ],
  });
  const cli = fakeCli({ code: 0 });
  await executeTask(makeTask("update", "dsh-x"), makeControl(), deps({ manager, spawn: cli.spawn }));
  assert.deepEqual(cli.calls[0]!.args.slice(3), ["add", "dsh-x@latest"]);
});

test("更新：卸载失败但不是「不许移除」时停在原地，不继续动 profile", async () => {
  const { manager, calls } = stubManager({
    remove: [
      { changed: false, application: "failed", target: "dsh-x", error: { code: "operation-error" } },
    ],
  });
  const cli = fakeCli({ code: 0 });
  const outcome = await executeTask(
    makeTask("update", "dsh-x", "^1.9.28"),
    makeControl(),
    deps({ manager, spawn: cli.spawn }),
  );
  assert.equal(outcome.status, "failed");
  assert.equal(cli.calls.length, 0);
  assert.deepEqual(calls, ["remove:dsh-x"], "失败的卸载之后不该再安装");
});

test("卸载：宿主说不是 bundle 时换子进程", async () => {
  const { manager } = stubManager({
    remove: [{ changed: false, application: "failed", target: "dsh-x", error: { code: "not-bundle" } }],
  });
  const cli = fakeCli({ code: 0 });
  const outcome = await executeTask(
    makeTask("remove", "dsh-x"),
    makeControl(),
    deps({ manager, spawn: cli.spawn }),
  );
  assert.equal(outcome.via, "subprocess");
  assert.deepEqual(cli.calls[0]!.args.slice(3), ["remove", "dsh-x"]);
});

test("启停：走服务；没有服务时如实报错而不是假装成功", async () => {
  const { manager, calls } = stubManager({
    setEnabled: [
      { changed: true, application: "restart-required", target: "dsh-x", enabled: false, restartReason: "no-hmr" },
    ],
  });
  const viaManager = await executeTask(
    makeTask("disable", "dsh-x"),
    makeControl(),
    deps({ manager }),
  );
  assert.equal(viaManager.status, "restart-required");
  assert.equal(viaManager.via, "manager");
  assert.deepEqual(calls, ["setEnabled:dsh-x:false"]);

  const cli = fakeCli({ code: 0 });
  const noManager = await executeTask(
    makeTask("enable", "dsh-x"),
    makeControl(),
    deps({ spawn: cli.spawn }),
  );
  assert.equal(noManager.status, "failed");
  assert.match(noManager.error!, /无法启停插件/);
  assert.equal(cli.calls.length, 0, "启停没有子进程兜底");
});

test("编排把每一步都写进日志，便于操作页回看", async () => {
  const { manager } = stubManager({
    remove: [
      { changed: false, application: "failed", target: "dsh-x", error: { code: "not-removable" } },
    ],
  });
  const cli = fakeCli({ lines: ["Progress: resolved 5, reused 5"], code: 0 });
  const control = makeControl();
  await executeTask(
    makeTask("update", "dsh-x", "^1.9.28"),
    control,
    deps({ manager, spawn: cli.spawn }),
  );
  const text = control.lines.join("\n");
  assert.match(text, /不允许先卸载/);
  assert.match(text, /Progress: resolved/);
});

/**
 * 热重载：宿主侧是 `setBundleEnabled(name, true)` —— 选中状态没变时它照样重新组合
 * profile，于是 HMR 会替换掉磁盘上已变化的插件代码（重建过 `dist/` 的已链接包靠
 * 这一步生效，不用重启 DSH）。
 */
test("热重载：走宿主重新组合，成功时说明无需重启", async () => {
  const { manager, calls } = stubManager({});
  const outcome = await executeTask(
    makeTask("reload", "dsh-x"),
    makeControl(),
    deps({ manager }),
  );
  assert.equal(outcome.status, "done");
  assert.equal(outcome.via, "manager");
  assert.notEqual(outcome.needsRestart, true);
  assert.match(outcome.note!, /重新组合并热加载/);
  assert.match(outcome.note!, /无需重启/);
  // 传入 enabled=true 只为了触发重新组合：选中状态由服务端在入队前校验过
  assert.deepEqual(calls, ["setEnabled:dsh-x:true"]);
});

test("热重载：宿主说这个 profile 没有热重载时如实转述，不假装成功", async () => {
  const { manager } = stubManager({
    setEnabled: [
      {
        changed: false,
        application: "restart-required",
        target: "dsh-x",
        enabled: true,
        restartReason: "no-hmr",
      },
    ],
  });
  const outcome = await executeTask(
    makeTask("reload", "dsh-x"),
    makeControl(),
    deps({ manager }),
  );
  assert.equal(outcome.status, "restart-required");
  assert.equal(outcome.needsRestart, true);
  assert.match(outcome.note!, /未开启热重载/);
});

test("热重载：没有宿主服务时如实报错，也不回退子进程", async () => {
  const cli = fakeCli({ code: 0 });
  const outcome = await executeTask(
    makeTask("reload", "dsh-x"),
    makeControl(),
    deps({ spawn: cli.spawn }),
  );
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error!, /无法热重载/);
  assert.equal(cli.calls.length, 0, "热重载没有子进程兜底");
});

/** 导入计划的一步（服务端算好后才会有；测试里直接给）。 */
const step = (over: any): any => ({ name: "dsh-x", action: "install", ...over });

test("导入：按计划逐步执行，只增不删，并把每一步写进日志", async () => {
  const { manager, calls } = stubManager({});
  const control = makeControl();
  const task: OpTask = {
    ...makeTask("import", "C:/tmp/export.json"),
    importSteps: [
      step({ name: "dsh-new", action: "install", spec: "dsh-new@1.0.0", enabled: true }),
      step({ name: "dsh-off", action: "disable" }),
      step({ name: "dsh-on", action: "enable" }),
      step({
        name: "dsh-entries",
        action: "entries",
        entries: [{ entryId: "include:a", enabled: false }],
      }),
      step({ name: "dsh-same", action: "skip", reason: "依赖、启用状态与条目开关都已一致" }),
      step({ name: "dsh-gone", action: "blocked", reason: "目标机器上没有这个路径" }),
    ],
    importCount: 6,
    importSnippetPath: "C:/tmp/exports/x-patch.yml",
  };
  const outcome = await executeTask(task, control, deps({ manager }));
  assert.equal(outcome.status, "done");
  assert.equal(outcome.via, "manager");
  assert.deepEqual(calls, [
    "install:dsh-new@1.0.0",
    "setEnabled:dsh-off:false",
    "setEnabled:dsh-on:true",
    "setEntry:include:a:false",
  ]);
  assert.match(outcome.note!, /1 项安装、3 项改状态、1 项已一致、1 项无法处理/);
  assert.match(outcome.note!, /共 6 项/);
  // 带 config 的片段只能是人工步骤：路径必须出现在结论里
  assert.match(outcome.note!, /x-patch\.yml/);
  assert.match(outcome.note!, /自行粘贴/);
  const text = control.lines.join("\n");
  assert.match(text, /1\/6 dsh-new：安装/);
  assert.match(text, /跳过 dsh-same/);
  assert.match(text, /无法处理 dsh-gone/);
  assert.match(text, /条目 include:a → 停用/);
  // 导入绝不卸载：整个流程里不该出现 remove
  assert.equal(calls.some((call) => call.startsWith("remove:")), false);
});

test("导入：宿主说 already-installed 时算「已装」而不是失败（重跑幂等）", async () => {
  const { manager } = stubManager({
    install: [
      {
        changed: false,
        application: "failed",
        target: "dsh-new@1.0.0",
        error: { code: "already-installed" },
      },
    ],
  });
  const outcome = await executeTask(
    {
      ...makeTask("import", "x.json"),
      importSteps: [step({ name: "dsh-new", action: "install", spec: "dsh-new@1.0.0" })],
    },
    makeControl(),
    deps({ manager }),
  );
  assert.equal(outcome.status, "done");
  assert.match(outcome.note!, /0 项安装、0 项改状态、1 项已一致/);
});

test("导入：单项失败不中断，结论里带首次失败原因", async () => {
  const { manager, calls } = stubManager({
    install: [
      {
        changed: false,
        application: "failed",
        target: "dsh-a@1.0.0",
        error: { code: "operation-error", diagnostic: "ERR_PNPM_FETCH_404" },
      },
    ],
  });
  const control = makeControl();
  const outcome = await executeTask(
    {
      ...makeTask("import", "x.json"),
      importSteps: [
        step({ name: "dsh-a", action: "install", spec: "dsh-a@1.0.0" }),
        step({ name: "dsh-b", action: "install", spec: "dsh-b@1.0.0" }),
      ],
    },
    control,
    deps({ manager }),
  );
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error!, /首个失败：dsh-a 安装失败/);
  assert.match(outcome.error!, /ERR_PNPM_FETCH_404/);
  assert.deepEqual(calls, ["install:dsh-a@1.0.0", "install:dsh-b@1.0.0"], "失败一个不能停");
  assert.match(control.lines.join("\n"), /安装失败 dsh-a/);
});

test("导入：宿主报告需要重启时整个任务就是「待重启」", async () => {
  const { manager } = stubManager({
    setEnabled: [
      {
        changed: true,
        application: "restart-required",
        target: "dsh-on",
        enabled: true,
        restartReason: "no-hmr",
      },
    ],
  });
  const outcome = await executeTask(
    {
      ...makeTask("import", "x.json"),
      importSteps: [step({ name: "dsh-on", action: "enable" })],
    },
    makeControl(),
    deps({ manager }),
  );
  assert.equal(outcome.status, "restart-required");
  assert.equal(outcome.needsRestart, true);
  assert.match(outcome.note!, /需要重启/);
});

test("导入：没有宿主服务时如实报错，不用子进程去改启用状态", async () => {
  const cli = fakeCli({ code: 0 });
  const outcome = await executeTask(
    {
      ...makeTask("import", "x.json"),
      importSteps: [step({ name: "dsh-new", action: "install", spec: "dsh-new" })],
    },
    makeControl(),
    deps({ spawn: cli.spawn }),
  );
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error!, /导入需要宿主 pluginManager 服务/);
  assert.equal(cli.calls.length, 0);
});

test("导入：空计划直接完成，不做任何事", async () => {
  const { manager, calls } = stubManager({});
  const outcome = await executeTask(
    { ...makeTask("import", "x.json"), importSteps: [] },
    makeControl(),
    deps({ manager }),
  );
  assert.equal(outcome.status, "done");
  assert.match(outcome.note!, /没有需要执行的步骤/);
  assert.deepEqual(calls, []);
});

test("导入：条目开关宿主不支持时如实记失败，不谎报成功", async () => {
  const { manager } = stubManager({});
  // 去掉 setPluginEnabled 模拟老宿主
  delete (manager as any).setPluginEnabled;
  const outcome = await executeTask(
    {
      ...makeTask("import", "x.json"),
      importSteps: [
        step({ name: "dsh-entries", action: "entries", entries: [{ entryId: "include:a", enabled: false }] }),
      ],
    },
    makeControl(),
    deps({ manager }),
  );
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error!, /宿主没有 setPluginEnabled 接口/);
});