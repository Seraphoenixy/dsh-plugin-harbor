/**
 * 操作编排：决定每个动作走宿主服务还是子进程兜底，并把它接到队列上。
 *
 * 决策表（与已批准计划一致）：
 *
 * | 动作 | 首选 | 回退条件 | 回退方式 |
 * |---|---|---|---|
 * | 安装 | `manager.installBundle(spec)` | 无服务 / 服务拒绝且子进程能做得更好 | `dsh plugin add <spec>` |
 * | 更新 | `manager.removeBundle` → `installBundle(installSpec)` | 移除被拒（不可移除、占用中） | `dsh plugin add <installSpec>`（原地覆盖） |
 * | 卸载 | `manager.removeBundle` | 无服务 | `dsh plugin remove <name>` |
 * | 启停 | `manager.setBundleEnabled` | —— | **不回退**：子进程改不了启用状态 |
 * | 热重载 | `manager.setBundleEnabled(name, true)`（重新组合） | —— | **不回退**：子进程改不了运行中的宿主 |
 * | 导入 | 逐步 `installBundle` / `setBundleEnabled` / `setPluginEnabled` | —— | **不回退且不卸载**：计划由服务端算好，只增不删 |
 *
 * ⚠️ 为什么更新要「先卸后装」：热重载下宿主对已装包直接回 `already-installed`
 * （它不能原地覆盖正在运行的模块）。移除被拒时改用子进程 `add <spec>` 原地覆盖
 * —— 这条路要重启，必须如实告诉用户。
 *
 * ⚠️ **是否要重启由宿主的 `application` 决定，不由我们猜**：桌面宿主默认加载
 * `@deepseek-ai/dsh-hmr`（`dsh-base` 的 `hmr` 条目，`disabled: !ctx.get('profileContext')`），
 * 此时宿主把改动**原地生效**并回 `applied`；只有在真的需要重启时（`no-hmr` /
 * `package-moved` / `host-module` / `unmanaged-plugin` / `module-comparison`）才回
 * `restart-required`。旧实现在更新路径上无条件覆盖成「需要重启」，把已经热加载好
 * 的结果说成要重启（本轮用户报障「改为支持热加载」）。
 *
 * ⚠️ 为什么「先卸后装」必须配两件事（2026-11-01 的真实故障）：
 *  1. **地址要拼好再动手**：profile 里记的是取值（registry 形态是版本范围
 *     `^1.9.28`），不是安装地址；`pnpm add ^1.9.28` 会被当成包名而失败，结果是
 *     「旧版本卸了、新版本没装上、插件从 profile 里消失」。地址由服务端在入队前
 *     算好并用 `validateSpec` 验过（`ops/spec.ts`），装不成的地址**绝不会先卸载**；
 *  2. **失败要回滚**：卸载已经生效，所以安装失败时必须按原地址装回去，并如实说明
 *     回滚成功还是失败；取消同理（取消不回滚，但结论里必须写明依赖已被移除）。
 */
import {
  cancelWithManager,
  installWithManager,
  isAlreadyInstalled,
  isIncompatible,
  removeWithManager,
  setEnabledWithManager,
  setEntryEnabledWithManager,
  type ManagerOutcome,
  type PluginManagerLike,
} from "./manager.ts";
import { latestSpec } from "./spec.ts";
import { runDshPlugin, type DshRunResult, type SpawnLike } from "./subprocess.ts";
import type {
  ImportTaskStep,
  OpControl,
  OpKind,
  OpRunResult,
  OpTask,
} from "./types.ts";

export interface ExecuteDeps {
  profileName: string;
  /** profile 目录；解析本地路径形态的安装地址时要用。 */
  profileDir?: string;
  /** 宿主服务；缺失即全程走子进程（启停除外）。 */
  manager?: PluginManagerLike;
  /** 子进程兜底实现（测试注入假 CLI）。 */
  runDsh?: typeof runDshPlugin;
  spawn?: SpawnLike;
  dshCommand?: string;
  registry?: string | null;
  timeoutMs?: number;
  log?: (message: string) => void;
  now?: () => number;
  /** 生成宿主安装用的 requestId（便于取消）。 */
  requestIdFor?: (task: OpTask) => string;
  /**
   * 这个依赖是否还在 profile 的 `dependencies` 里。
   *
   * 只用于**失败之后的解释**：宿主「启停」的语义是「保留已装依赖，只改 bundle 选中
   * 状态」，所以依赖一旦不在了，启用永远不可能成功 —— 这时必须告诉用户去重新安装，
   * 而不是丢一句「宿主的包操作失败」。
   */
  dependencyPresent?: (name: string) => boolean;
}

/** 「已经装过」等只影响首次安装的错误：值得换子进程再试一次。 */
const SUBPROCESS_RETRY_CODES = new Set(["already-installed", "not-bundle"]);

/** 移除被拒的错误码：更新时改用子进程原地覆盖。 */
const REMOVE_REFUSED_CODES = new Set([
  "not-removable",
  "stop-profile",
  "bundle-in-use",
  "unaddressable",
  "unknown-plugin",
]);

export interface OpOutcome extends OpRunResult {
  /** 宿主侧的原始结论（走服务时才有）。 */
  managerOutcome?: ManagerOutcome;
}

/**
 * 执行一个任务。
 *
 * 队列保证同一时刻只有一个任务在跑，这里不需要再加锁；取消通过 `control.onCancel`
 * 登记（宿主取消 requestId / 杀子进程树）。
 */
export async function executeTask(
  task: OpTask,
  control: OpControl,
  deps: ExecuteDeps,
): Promise<OpOutcome> {
  const log = deps.log
    ? (message: string) => {
        // 编排层的每一步都要同时进「操作页」的任务日志与宿主日志，否则用户
        // 在界面上看不到「为什么回退到子进程」这类关键决策。
        control.log(message);
        deps.log?.(message);
      }
    : (message: string) => control.log(message);
  switch (task.kind) {
    case "install":
      return await doInstall(task, control, deps, log);
    case "update":
      return await doUpdate(task, control, deps, log);
    case "remove":
      return await doRemove(task, control, deps, log);
    case "enable":
    case "disable":
      return await doSetEnabled(task, control, deps, log);
    case "reload":
      return await doReload(task, control, deps, log);
    case "import":
      return await doImport(task, control, deps, log);
  }
}

async function doInstall(
  task: OpTask,
  control: OpControl,
  deps: ExecuteDeps,
  log: (message: string) => void,
): Promise<OpOutcome> {
  const spec = task.spec ?? task.target;
  if (deps.manager) {
    const requestId = requestIdOf(task, deps);
    const outcome = await installWithManager(deps.manager, spec, {
      enabled: true,
      requestId,
      ...(deps.registry ? { registry: deps.registry } : {}),
    });
    control.progress(outcome.status === "done" ? 100 : undefined, outcome.message);
    if (outcome.status === "done" || outcome.status === "restart")
      return fromManager(outcome);
    if (outcome.errorCode && SUBPROCESS_RETRY_CODES.has(outcome.errorCode)) {
      log(`宿主拒绝了这次安装（${outcome.errorCode}），改用子进程 dsh plugin add`);
      return await viaSubprocess(task, control, deps, "add", spec);
    }
    if (isIncompatible(outcome))
      return { ...fromManager(outcome), error: outcome.message };
    return { ...fromManager(outcome), error: outcome.message };
  }
  log("宿主未提供 pluginManager 服务，改用子进程 dsh plugin add");
  return await viaSubprocess(task, control, deps, "add", spec);
}

async function doUpdate(
  task: OpTask,
  control: OpControl,
  deps: ExecuteDeps,
  log: (message: string) => void,
): Promise<OpOutcome> {
  const name = task.target;
  const recorded = task.spec ?? "";
  /**
   * ⚠️ 这里必须是**可安装地址**，不能是 profile 里记的版本范围：`pnpm add ^1.9.28`
   * 会被当成包名解析而失败（本轮线上踩到，见 `spec.ts` 顶部说明）。地址优先用服务端
   * 按已装事实算好的 `installSpec`（它还带上核实过的目标版本）；没有时才按形态兜底。
   */
  const spec = installSpecOf(task, deps);
  const restoreSpec = task.restoreSpec ?? latestSpec(task.specKind, recorded, name, deps.profileDir);
  if (!deps.manager) {
    log("宿主未提供 pluginManager 服务，改用子进程原地覆盖安装");
    return await viaSubprocess(task, control, deps, "add", spec);
  }
  control.progress(5, "先卸载已装版本");
  const removed = await removeWithManager(deps.manager, name);
  if (removed.status === "failed" && !REMOVE_REFUSED_CODES.has(removed.errorCode ?? "")) {
    // 卸载失败但不是「不许移除」：交回用户，别继续动 profile
    return { ...fromManager(removed), error: removed.message };
  }
  if (removed.status === "failed") {
    log(`宿主不允许先卸载（${removed.errorCode}），改用子进程原地覆盖`);
    return await viaSubprocess(task, control, deps, "add", spec);
  }
  control.progress(40, "已卸载，开始安装新版本");
  const installed = await installWithManager(deps.manager, spec, {
    enabled: true,
    requestId: requestIdOf(task, deps),
    ...(deps.registry ? { registry: deps.registry } : {}),
  });
  const mapped = fromManager(installed);
  /**
   * ⚠️ **不覆盖宿主的结论**：宿主回 `applied` 就说明它已经把新代码原地装好并热加载
   * （桌面宿主默认有 `hmr` 服务），此时说「需要重启」是假的；只有宿主回
   * `restart-required`（附 `restartReason`）才需要重启。旧实现无条件改成需要重启，
   * 用户看到的「重启」提示就来自这里（本轮报障：改为支持热加载）。
   */
  if (mapped.status === "done")
    return {
      ...mapped,
      note: `已卸载旧版本并安装新版本：${spec}（宿主已热加载，无需重启）`,
    };
  if (mapped.status === "restart-required")
    return {
      ...mapped,
      // 宿主给的 restartReason 要说出来（包位置变化 / 涉及宿主模块 / 未开热重载…）
      note: `已卸载旧版本并安装新版本；${mapped.note ?? "需要重启 DSH 才生效"}`,
    };
  if (mapped.status === "cancelled")
    return {
      ...mapped,
      // 取消发生在「已卸载」之后：不能假装 profile 没事，也不能背着用户装回去。
      note: `已取消：旧版本已经卸载，新版本没有装上，${name} 现在不在 profile 的依赖里；请重新安装`,
      error: `已取消：旧版本已经卸载，新版本没有装上，${name} 现在不在 profile 的依赖里；请重新安装`,
    };
  /**
   * 安装失败时 profile 已经少了这个依赖（这是「先卸后装」的固有代价）。尽力按
   * **原地址**装回去，让失败不至于把用户的插件弄丢；回滚结果如实写进结论。
   */
  const rolled = await rollbackUpdate(task, control, deps, log, restoreSpec);
  return { ...mapped, error: `${mapped.error ?? "更新失败"}${rolled}` };
}

/**
 * 更新失败后的回滚：把刚被卸载的依赖按原地址装回来。
 *
 * 只做一次、只装原地址、结果照实说 —— 不回滚成「换个版本」，也不把回滚失败吞掉。
 */
async function rollbackUpdate(
  task: OpTask,
  control: OpControl,
  deps: ExecuteDeps,
  log: (message: string) => void,
  restoreSpec: string,
): Promise<string> {
  const name = task.target;
  if (!deps.manager) return "；依赖已从 profile 移除，请重新安装";
  log(`新版本没装上，按原地址装回 ${restoreSpec}`);
  control.progress(45, "回滚：装回原版本");
  const back = await installWithManager(deps.manager, restoreSpec, {
    enabled: true,
    requestId: requestIdOf(task, deps, ":rollback"),
    ...(deps.registry ? { registry: deps.registry } : {}),
  });
  if (back.status === "done" || back.status === "restart")
    return `；已按原地址把 ${name} 装回（profile 恢复原状），重启后仍是原来的版本`;
  return `；回滚也没成功（${back.message}）：${name} 现在不在 profile 的依赖里，请重新安装`;
}

/** 执行用的安装地址：优先服务端算好的 `installSpec`，否则按已装形态兜底。 */
function installSpecOf(task: OpTask, deps: ExecuteDeps): string {
  const prepared = task.installSpec?.trim();
  if (prepared !== undefined && prepared !== "") return prepared;
  return latestSpec(task.specKind, task.spec ?? "", task.target, deps.profileDir);
}

/**
 * 导入：按服务端算好的计划逐步执行。
 *
 * 口径：
 *  - **只增不删**：只装缺失的、按导出恢复启用状态与条目开关，**从不卸载**、不动 profile 文件；
 *  - **一步一步来**（队列本来就是一次一个变更），每步都写进任务日志，界面能看清做到哪了；
 *  - **单项失败不中断**：继续做剩下的，最后给一份「N 项成功 / M 项失败 / K 项已一致」的结论，
 *    并把第一次失败的原因写进 `error`；
 *  - 宿主回 `already-installed` 视为「已装」而不是失败：重跑同一个导入应当是幂等的；
 *  - 任一步骤要求重启，整个任务就是「待重启」（结论一律以宿主为准）。
 */
async function doImport(
  task: OpTask,
  control: OpControl,
  deps: ExecuteDeps,
  log: (message: string) => void,
): Promise<OpOutcome> {
  const steps = task.importSteps ?? [];
  if (steps.length === 0)
    return { status: "done", via: "manager", note: "这次导入没有需要执行的步骤" };
  if (!deps.manager)
    return {
      status: "failed",
      error: "导入需要宿主 pluginManager 服务（子进程改不了启用状态与条目开关）；请重启 DSH 后重试",
    };
  const outcome = await runImportSteps(task, control, deps, log, steps);
  control.progress(100, outcome.note);
  log(outcome.note ?? outcome.error ?? "导入结束");
  return outcome;
}

interface ImportTally {
  installed: number;
  changed: number;
  same: number;
  blocked: number;
  failed: string[];
  needsRestart: boolean;
  cancelled: boolean;
}

async function runImportSteps(
  task: OpTask,
  control: OpControl,
  deps: ExecuteDeps,
  log: (message: string) => void,
  steps: ImportTaskStep[],
): Promise<OpOutcome> {
  const manager = deps.manager!;
  const tally: ImportTally = {
    installed: 0,
    changed: 0,
    same: 0,
    blocked: 0,
    failed: [],
    needsRestart: false,
    cancelled: false,
  };
  for (const [index, step] of steps.entries()) {
    if (control.cancelled) {
      tally.cancelled = true;
      log(`已取消：第 ${index + 1}/${steps.length} 步之后没有再动 profile`);
      break;
    }
    const at = Math.round((index / steps.length) * 95);
    control.progress(at, `${index + 1}/${steps.length} ${step.name}：${stepLabel(step.action)}`);
    if (step.action === "skip") {
      tally.same += 1;
      log(`跳过 ${step.name}：${step.reason ?? "已一致"}`);
      continue;
    }
    if (step.action === "blocked") {
      tally.blocked += 1;
      log(`无法处理 ${step.name}：${step.reason ?? "本机环境不满足"}`);
      continue;
    }
    const requestId = requestIdOf(task, deps, `:${index}`);
    if (step.action === "install") {
      const result = await installWithManager(manager, step.spec ?? step.name, {
        enabled: step.enabled !== false,
        requestId,
        ...(deps.registry ? { registry: deps.registry } : {}),
      });
      if (result.status === "done") {
        tally.installed += 1;
        log(`已安装 ${step.name}（${step.spec ?? step.name}）`);
        continue;
      }
      if (result.status === "restart") {
        tally.installed += 1;
        tally.needsRestart = true;
        log(`已安装 ${step.name}（${step.spec ?? step.name}）：${result.message}`);
        continue;
      }
      if (isAlreadyInstalled(result)) {
        tally.same += 1;
        log(`${step.name} 已经装过，跳过`);
        continue;
      }
      tally.failed.push(`${step.name} 安装失败：${result.message}`);
      log(`安装失败 ${step.name}：${result.message}`);
      continue;
    }
    if (step.action === "entries") {
      let changed = 0;
      for (const entry of step.entries ?? []) {
        const result = await setEntryEnabledWithManager(manager, entry.entryId, entry.enabled);
        if (result === "unsupported") {
          tally.failed.push(`${step.name} 的条目开关：宿主没有 setPluginEnabled 接口`);
          log(`条目开关失败 ${entry.entryId}：宿主没有 setPluginEnabled 接口`);
          continue;
        }
        if (result.status === "done" || result.status === "restart") {
          changed += 1;
          if (result.status === "restart") tally.needsRestart = true;
          log(`条目 ${entry.entryId} → ${entry.enabled ? "启用" : "停用"}：${result.message}`);
          continue;
        }
        tally.failed.push(`${step.name} 的条目 ${entry.entryId}：${result.message}`);
        log(`条目开关失败 ${entry.entryId}：${result.message}`);
      }
      if (changed > 0) tally.changed += 1;
      else tally.same += 1;
      continue;
    }
    // enable / disable
    const wanted = step.action === "enable";
    const result = await setEnabledWithManager(manager, step.name, wanted);
    if (result.status === "done" || result.status === "restart") {
      tally.changed += 1;
      if (result.status === "restart") tally.needsRestart = true;
      log(`${wanted ? "已启用" : "已停用"} ${step.name}：${result.message}`);
      continue;
    }
    tally.failed.push(`${step.name} ${wanted ? "启用" : "停用"}失败：${result.message}`);
    log(`${wanted ? "启用" : "停用"}失败 ${step.name}：${result.message}`);
  }
  const total = steps.length;
  /** 带 config 的补丁片段只能人工粘贴：把路径写进结论，别让用户自己去找。 */
  const manual =
    task.importSnippetPath === undefined
      ? ""
      : `；带 config 的补丁片段已写到 ${task.importSnippetPath}，需要你确认后自行粘贴到 profile 的 cordis.patch.yml（宿主没有写 config 的接口）`;
  const summary =
    `导入完成：${tally.installed} 项安装、${tally.changed} 项改状态、${tally.same} 项已一致` +
    (tally.blocked > 0 ? `、${tally.blocked} 项无法处理` : "") +
    (tally.failed.length > 0 ? `、${tally.failed.length} 项失败` : "") +
    `（共 ${total} 项）` +
    manual;
  if (tally.failed.length > 0)
    return {
      status: "failed",
      via: "manager",
      note: summary,
      error: `${summary}；首个失败：${tally.failed[0]}`,
    };
  if (tally.cancelled)
    return {
      status: "cancelled",
      via: "manager",
      note: `已取消：${summary}`,
      error: `已取消：${summary}`,
    };
  if (tally.needsRestart)
    return {
      status: "restart-required",
      via: "manager",
      needsRestart: true,
      note: summary + "；其中一步宿主报告需要重启 DSH",
    };
  return {
    status: "done",
    via: "manager",
    note:
      summary +
      (tally.blocked > 0
        ? "；无法处理的项已按原样保留，请按提示补齐后再导入一次"
        : "（都是宿主原地生效，无需重启）"),
  };
}

function stepLabel(action: ImportTaskStep["action"]): string {
  switch (action) {
    case "install":
      return "安装";
    case "enable":
      return "启用";
    case "disable":
      return "停用";
    case "entries":
      return "恢复条目开关";
    case "skip":
      return "已一致";
    case "blocked":
      return "无法处理";
  }
}

/**
 * 热重载：让宿主按**磁盘上当前的代码**重新组合并加载这个插件。
 *
 * 宿主侧等价动作是 `setBundleEnabled(name, true)` —— 选中状态没变时
 * `selectBundle()` 直接返回，但 `publishAndReload()` 照样跑，于是 HMR 会替换掉
 * profile 目录下（含已链接包的目标、`node_modules` 下已变化的包）已加载的插件代码。
 * 这正是「重建了 dist/ 但不想重启 DSH」要的那一步。
 *
 * 与启停一样**没有子进程兜底**：子进程改不了运行中的宿主。宿主没开热重载时它会如实
 * 回 `restart-required`（`restartReason: no-hmr`），我们照原样转述。
 */
async function doReload(
  task: OpTask,
  control: OpControl,
  deps: ExecuteDeps,
  log: (message: string) => void,
): Promise<OpOutcome> {
  if (!deps.manager) {
    return {
      status: "failed",
      error:
        "宿主未提供 pluginManager 服务，无法热重载（子进程改不了运行中的宿主）；请重启 DSH 后重试",
    };
  }
  const outcome = await setEnabledWithManager(deps.manager, task.target, true);
  control.progress(outcome.status === "done" ? 100 : undefined, outcome.message);
  log(outcome.message);
  if (outcome.status === "done")
    return {
      ...fromManager(outcome),
      note: "已按磁盘上的当前代码重新组合并热加载（无需重启 DSH）",
    };
  if (outcome.status === "restart") return fromManager(outcome);
  return { ...fromManager(outcome), error: outcome.message };
}

async function doRemove(
  task: OpTask,
  control: OpControl,
  deps: ExecuteDeps,
  log: (message: string) => void,
): Promise<OpOutcome> {
  if (deps.manager) {
    const outcome = await removeWithManager(deps.manager, task.target);
    control.progress(outcome.status === "done" ? 100 : undefined, outcome.message);
    if (outcome.status === "done" || outcome.status === "restart")
      return fromManager(outcome);
    // 只有「宿主不可能做到」的错误才换子进程（例如它不认为这是 bundle）
    if (outcome.errorCode === "not-bundle" || outcome.errorCode === "unknown-plugin") {
      log(`宿主无法处理（${outcome.errorCode}），改用子进程 dsh plugin remove`);
      return await viaSubprocess(task, control, deps, "remove", task.target);
    }
    return { ...fromManager(outcome), error: outcome.message };
  }
  log("宿主未提供 pluginManager 服务，改用子进程 dsh plugin remove");
  return await viaSubprocess(task, control, deps, "remove", task.target);
}

async function doSetEnabled(
  task: OpTask,
  control: OpControl,
  deps: ExecuteDeps,
  log: (message: string) => void,
): Promise<OpOutcome> {
  const enabled = task.kind === "enable";
  if (!deps.manager) {
    return {
      status: "failed",
      error:
        "宿主未提供 pluginManager 服务，无法启停插件（子进程改不了启用状态）；请重启 DSH 让服务就绪后重试",
    };
  }
  const outcome = await setEnabledWithManager(deps.manager, task.target, enabled);
  control.progress(outcome.status === "done" ? 100 : undefined, outcome.message);
  log(outcome.message);
  if (outcome.status === "done" || outcome.status === "restart") return fromManager(outcome);
  /**
   * 宿主「启用」只切 bundle 选中状态、**不动依赖**。依赖若已被上一次失败的更新删掉
   * （或从来就没装成），启用永远不可能成功 —— 这种情况必须说清「去重新安装」，
   * 否则用户只能看到一句宿主的原始报错（本轮线上就是这样卡住的）。
   */
  const missing =
    enabled && deps.dependencyPresent !== undefined && !deps.dependencyPresent(task.target);
  const message = missing
    ? `${outcome.message}；${task.target} 已经不在 profile 的 dependencies 里（多半是上一次失败的更新把它删掉了），宿主无法在缺依赖时启用它 —— 请在市场页重新安装`
    : outcome.message;
  return { ...fromManager(outcome), error: message, note: message };
}

/** 子进程路径：跑 `dsh plugin <action> <spec>`，把输出接到进度与日志。 */
async function viaSubprocess(
  task: OpTask,
  control: OpControl,
  deps: ExecuteDeps,
  action: "add" | "remove",
  spec: string,
): Promise<OpOutcome> {
  const run = deps.runDsh ?? runDshPlugin;
  const result: DshRunResult = await run(
    {
      profile: deps.profileName,
      action,
      spec,
      ...(deps.spawn ? { spawn: deps.spawn } : {}),
      ...(deps.dshCommand ? { dshCommand: deps.dshCommand } : {}),
      ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
    },
    {
      log: (line) => control.log(line),
      progress: (value, line) => control.progress(value, line),
      onCancel: (handler) => control.onCancel(handler),
    },
  );
  if (result.code === 0 && !result.timedOut) {
    return {
      status: "restart-required",
      needsRestart: true,
      via: "subprocess",
      note:
        "已通过 dsh plugin 完成；改动在下次启动 DSH 时生效（若插件未出现在已启用列表，请在宿主插件页启用）",
    };
  }
  if (control.cancelled)
    return { status: "cancelled", via: "subprocess", note: "已取消（子进程已终止）" };
  const failure = result.failure;
  return {
    status: "failed",
    via: "subprocess",
    error:
      failure?.message ??
      result.error ??
      `dsh plugin ${action} 失败（退出码 ${result.code ?? "未知"}）`,
  };
}

function requestIdOf(task: OpTask, deps: ExecuteDeps, suffix = ""): string {
  const base = deps.requestIdFor ? deps.requestIdFor(task) : `plugin-harbor:${task.id}`;
  if (suffix !== "") return `${base}${suffix}`;
  task.requestId = base;
  return base;
}

function fromManager(outcome: ManagerOutcome): OpOutcome {
  type Status = OpRunResult["status"];
  const status: Status =
    outcome.status === "done"
      ? "done"
      : outcome.status === "restart"
        ? "restart-required"
        : outcome.status === "cancelled"
          ? "cancelled"
          : "failed";
  const result: OpOutcome = {
    status,
    via: "manager",
    ...(outcome.status === "restart" ? { needsRestart: true } : {}),
    note: outcome.message,
    managerOutcome: outcome,
  };
  if (outcome.logPath) result.note = `${outcome.message}（日志：${outcome.logPath}）`;
  /**
   * 失败必须把原因同时放进 `error`：界面上的失败行显示的是 `error`，而 `note` 会被
   * 日志路径占满。旧实现只写 `note`，导致「失败了但看不出为什么」（本轮线上）。
   */
  if (status === "failed") result.error = result.note;
  return result;
}

/** 队列任务 → 运行器（把 deps 闭包进去，便于 RPC 层直接 new OpQueue）。 */
export function makeRunner(deps: ExecuteDeps) {
  return async (task: OpTask, control: OpControl): Promise<OpRunResult> =>
    await executeTask(task, control, deps);
}

/** 任务状态 → 界面徽标文案（操作页用）。 */
export function describeTask(task: OpTask): string {
  if (task.status === "queued") return "排队中";
  if (task.status === "running")
    return typeof task.progress === "number" ? `进行中 ${task.progress}%` : "进行中";
  if (task.status === "done") return "已完成";
  if (task.status === "restart-required") return "待重启";
  if (task.status === "cancelled") return "已取消";
  return task.error ? `失败：${task.error}` : "失败";
}

/** 供 RPC 层复用的取消分发：优先宿主，其次子进程。 */
export async function cancelTask(
  task: OpTask,
  deps: ExecuteDeps,
): Promise<"manager" | "subprocess" | "unsupported"> {
  if (deps.manager && task.via !== "subprocess" && task.requestId) {
    const status = await cancelWithManager(deps.manager, task.requestId);
    if (status !== "unsupported") return "manager";
  }
  return "subprocess";
}

/** 安装形态判断：目标是否已经是当前 profile 的依赖（决定 install vs update）。 */
export function isInstalledName(name: string, installedNames: Set<string>): boolean {
  return installedNames.has(name);
}

/** 把一个 kind 归一成大小写稳定的字符串（存库与展示用）。 */
export function normalizeKind(kind: OpKind): OpKind {
  return kind;
}