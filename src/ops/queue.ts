/**
 * FIFO 操作队列。
 *
 * 口径（与参考项目 dsh-plugin-hub 一致，理由也相同）：
 *  - **同一时刻只跑一个变更任务**：pnpm 会改 profile 的清单与 lockfile，
 *    并发跑两次会互相覆盖（channel-hub 的 2026-10-29 实测教训方向一致）；
 *  - 进度**只升不降**，且只有在拿到确定信息时才给百分比 —— 界面宁可显示
 *    「进行中」也不显示编出来的 42%；
 *  - 取消要落到实处：队列把取消请求转给运行器的 `onCancel` 回调
 *    （杀子进程 / 调宿主 `cancelInstall`），并等待运行器收尾。
 */
import type {
  OpControl,
  OpKind,
  OpRunResult,
  OpRunner,
  OpStatus,
  OpTask,
} from "./types.ts";

export interface OpQueueOptions {
  /** 每个任务保留的输出行数上限。 */
  maxLogLines?: number;
  now?: () => number;
  idFactory?: () => string;
  /** 任务终态回调（写操作记录用）。 */
  onFinish?: (task: OpTask) => void;
}

interface RunningEntry {
  control: OpControl;
  handlers: (() => void | Promise<void>)[];
  cancelled: boolean;
}

export class OpQueue {
  #tasks: OpTask[] = [];
  #running: RunningEntry | null = null;
  #active: OpTask | null = null;
  #idle: Promise<void> = Promise.resolve();
  #maxLogLines: number;
  #now: () => number;
  #idFactory: () => string;
  #onFinish?: (task: OpTask) => void;
  #seq = 0;

  constructor(
    private runner: OpRunner,
    options: OpQueueOptions = {},
  ) {
    this.#maxLogLines = options.maxLogLines ?? 200;
    this.#now = options.now ?? Date.now;
    this.#idFactory = options.idFactory ?? (() => `op-${++this.#seq}-${this.#now()}`);
    this.#onFinish = options.onFinish;
  }

  /** 入队并开始（若空闲）。返回任务对象供界面轮询。 */
  enqueue(input: {
    kind: OpKind;
    target: string;
    spec?: string;
    specKind?: string;
    /** 服务端按已装事实算好的可安装地址（见 `types.ts` 里 `OpTask.installSpec`）。 */
    installSpec?: string;
    restoreSpec?: string;
    /** 导入计划（服务端算好；客户端无权提供）。 */
    importSteps?: OpTask["importSteps"];
    importCount?: number;
    importConfigPlans?: OpTask["importConfigPlans"];
    importSnippetPath?: string;
    /** 入队时就写进任务的一句话（运行中界面可见；终态由运行器给的那句覆盖）。 */
    note?: string;
  }): OpTask {
    const task: OpTask = {
      id: this.#idFactory(),
      kind: input.kind,
      target: input.target,
      status: "queued",
      log: [],
      queuedAt: this.#now(),
      ...(input.spec !== undefined ? { spec: input.spec } : {}),
      ...(input.specKind !== undefined ? { specKind: input.specKind } : {}),
      ...(input.installSpec !== undefined ? { installSpec: input.installSpec } : {}),
      ...(input.restoreSpec !== undefined ? { restoreSpec: input.restoreSpec } : {}),
      ...(input.importSteps !== undefined ? { importSteps: input.importSteps } : {}),
      ...(input.importCount !== undefined ? { importCount: input.importCount } : {}),
      ...(input.importConfigPlans !== undefined ? { importConfigPlans: input.importConfigPlans } : {}),
      ...(input.importSnippetPath !== undefined ? { importSnippetPath: input.importSnippetPath } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    };
    this.#tasks.push(task);
    this.#pump();
    return task;
  }

  /** 全部任务（含历史），按入队顺序。 */
  list(): OpTask[] {
    return this.#tasks.map((task) => ({ ...task, log: [...task.log] }));
  }

  /** 当前运行中的任务 id（没有则 undefined）。 */
  activeId(): string | undefined {
    return this.#active?.id;
  }

  /** 队列是否为空且没有在跑的任务。 */
  isIdle(): boolean {
    return this.#active === null && this.#tasks.every((task) => task.status !== "queued");
  }

  /**
   * 等待队列排空（测试与关停用）。
   *
   * ⚠️ 不能只 `await this.#idle` 一次：`#idle` 是「当前那个任务」的 promise，
   * 它在任务结束、下一个任务已启动时就被替换了 —— 只等一次会在第 N 个任务
   * 完成时提前返回（本轮实测：三个任务的用例只看到前两个）。这里循环等到
   * **既没有运行中的任务、也没有排队中的任务**。
   */
  async drain(): Promise<void> {
    let guard = 0;
    while (!this.isIdle()) {
      await this.#idle;
      if (++guard > 10_000) break;
    }
  }

  /**
   * 取消一个任务。
   *
   * 排队中的直接标取消；运行中的把请求转给运行器并等待其收尾 —— 调用方拿到的
   * `true` 表示「取消已被接受」，不代表文件改动已经还原（那由运行器保证）。
   */
  async cancel(id: string): Promise<boolean> {
    const task = this.#tasks.find((entry) => entry.id === id);
    if (!task) return false;
    if (task.status === "queued") {
      task.status = "cancelled";
      task.endedAt = this.#now();
      task.note = "排队时被取消";
      this.#onFinish?.(task);
      this.#pump();
      return true;
    }
    const running = this.#running;
    if (task.status !== "running" || !running || this.#active?.id !== id) return false;
    running.cancelled = true;
    task.note = "取消请求已发出，等待收尾";
    for (const handler of running.handlers.splice(0)) {
      try {
        await handler();
      } catch {
        // 取消失败不改变结论：运行器会走到自己的终态
      }
    }
    return true;
  }

  #pump(): void {
    if (this.#active) return;
    const next = this.#tasks.find((task) => task.status === "queued");
    if (!next) return;
    this.#active = next;
    this.#idle = this.#run(next);
  }

  async #run(task: OpTask): Promise<void> {
    const running: RunningEntry = {
      cancelled: false,
      handlers: [],
      control: {
        onCancel: (handler) => {
          if (running.cancelled) void handler();
          else running.handlers.push(handler);
        },
        progress: (value, line) => {
          if (typeof value === "number") {
            const clamped = Math.max(0, Math.min(100, value));
            // 只升不降：pnpm 的进度行会来回跳
            task.progress =
              typeof task.progress === "number"
                ? Math.max(task.progress, clamped)
                : clamped;
          }
          if (typeof line === "string" && line !== "") this.#pushLog(task, line);
        },
        log: (line) => this.#pushLog(task, line),
        get cancelled() {
          return running.cancelled;
        },
      },
    };
    this.#running = running;
    task.status = "running";
    task.startedAt = this.#now();
    let result: OpRunResult;
    try {
      result = await this.runner(task, running.control);
    } catch (error) {
      result = {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (running.cancelled && result.status !== "done" && result.status !== "restart-required")
      result = { ...result, status: "cancelled", note: result.note ?? "已取消" };
    task.status = result.status;
    task.endedAt = this.#now();
    if (result.error) task.error = result.error;
    if (result.note) task.note = result.note;
    if (result.needsRestart) task.needsRestart = true;
    if (result.via) task.via = result.via;
    if (result.status === "done") task.progress = 100;
    this.#running = null;
    this.#active = null;
    this.#onFinish?.(task);
    this.#pump();
  }

  #pushLog(task: OpTask, line: string): void {
    for (const entry of line.split(/\r?\n/)) {
      const trimmed = entry.trim();
      if (trimmed === "") continue;
      task.log.push(trimmed);
    }
    if (task.log.length > this.#maxLogLines)
      task.log.splice(0, task.log.length - this.#maxLogLines);
  }
}

/** 状态 → 界面文案。 */
export const STATUS_LABELS: Record<OpStatus, string> = {
  queued: "排队中",
  running: "进行中",
  done: "已完成",
  "restart-required": "待重启",
  failed: "失败",
  cancelled: "已取消",
};