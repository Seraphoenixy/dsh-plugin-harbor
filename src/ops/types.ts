/**
 * 操作层的公共类型。
 *
 * `HostService` 只描述我们真正会用到的那一小块（`on` / `off`），避免把宿主的
 * 类型定义复制进本仓库。
 */
export interface HostService {
  /** 订阅宿主事件（cordis 的 `ctx.on` 同形）。 */
  on?(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
}

/**
 * 一次操作的种类。
 *
 * `update` 是「卸载 + 安装」的编排，不是宿主的一个动作；`reload` 是「按磁盘上当前
 * 的代码重新组合并加载」（宿主 `setBundleEnabled(name, true)`：选中状态没变化时
 * 它仍会重新组合 profile，从而替换掉磁盘上已变化的插件代码）—— 桌面宿主的 HMR
 * 默认开启，所以这条路**不需要重启**就能让重建后的插件生效。
 */
export type OpKind =
  | "install"
  | "update"
  | "remove"
  | "enable"
  | "disable"
  | "reload"
  | "import";

/**
 * 导入计划里队列要执行的一步。
 *
 * ⚠️ 计划由**服务端**在入队前算好（读导出文件 + 当前 profile 事实）；客户端永远不提供
 * 步骤，和更新地址同口径。`skip` / `blocked` 也留在计划里：这样界面能解释「为什么没动它」。
 */
export interface ImportTaskStep {
  name: string;
  action: "install" | "enable" | "disable" | "entries" | "skip" | "blocked";
  /** 交给宿主的安装地址（`install` 时才有，已过 `validateSpec`）。 */
  spec?: string;
  enabled?: boolean;
  entries?: { entryId: string; enabled: boolean }[];
  /** 跳过 / 阻塞的原因。 */
  reason?: string;
}

export type OpStatus =
  | "queued"
  | "running"
  | "done"
  | "restart-required"
  | "failed"
  | "cancelled";

/** 队列里的一个任务（也是「操作页」显示的一行）。 */
export interface OpTask {
  id: string;
  kind: OpKind;
  /** 目标：包名（安装前是 spec）。 */
  target: string;
  /** 安装/更新用的地址。 */
  spec?: string;
  /**
   * **服务端**按已装事实算好的可安装地址（更新时用）。
   *
   * ⚠️ 与 `spec` 分开：`spec` 是 profile 里记的取值（registry 形态是版本范围
   * `^1.9.28`），范围本身不是安装地址，直接交给 pnpm 会被当成包名而失败。
   */
  installSpec?: string;
  /** 更新失败回滚时按原样装回的地址（不带目标版本）。 */
  restoreSpec?: string;
  /** spec 的形态（registry / git / path / tarball），决定原地覆盖时怎么拼地址。 */
  specKind?: string;
  /** 导入计划（服务端算好；见 `ImportTaskStep`）。 */
  importSteps?: ImportTaskStep[];
  /** 导入文件里带的插件数（进度与结论用）。 */
  importCount?: number;
  /**
   * 导入时生成的「需要人工粘贴的配置片段」文件路径。
   *
   * 宿主 `pluginManager` 只提供 `setPluginEnabled`（写 `disabled`），没有写任意 `config`
   * 的接口，本项目也不允许手工改 profile 的 `cordis.patch.yml` —— 所以这部分只能是人工步骤，
   * 由服务端把片段写好后把路径交给用户。
   */
  importSnippetPath?: string;
  status: OpStatus;
  /** 0–100；不确定时为 undefined（界面显示「进行中」而不是假进度）。 */
  progress?: number;
  /** 最近若干行输出（上限见 `OpQueueOptions.maxLogLines`）。 */
  log: string[];
  error?: string;
  note?: string;
  needsRestart?: boolean;
  requestId?: string;
  /** 走的是宿主服务还是子进程兜底。 */
  via?: "manager" | "subprocess";
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
}

/** 运行器给队列的回调：进度、日志、取消登记。 */
export interface OpControl {
  /** 登记取消时要做的事（杀子进程 / 取消宿主安装）。 */
  onCancel(handler: () => void | Promise<void>): void;
  progress(value: number | undefined, line?: string): void;
  log(line: string): void;
  readonly cancelled: boolean;
}

export interface OpRunResult {
  status: OpStatus;
  error?: string;
  note?: string;
  needsRestart?: boolean;
  via?: "manager" | "subprocess";
}

export type OpRunner = (task: OpTask, control: OpControl) => Promise<OpRunResult>;