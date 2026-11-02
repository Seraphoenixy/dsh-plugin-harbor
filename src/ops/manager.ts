/**
 * 宿主 `pluginManager` 服务适配。
 *
 * 本插件不直接调 pnpm：宿主已经有完整的安装流水线（profile 写锁、registry 回退、
 * 失败还原 manifest+lockfile、构建脚本审批、兼容性闸门）。这里只做两件事：
 *  1. 把宿主返回的 `application` / `error.code` / `packageResult` **归一化**成
 *     我们能展示与决策的状态；
 *  2. 把「这个错误码该怎么办」写成一句人能照做的话。
 *
 * ⚠️ 归一化不允许把「不知道」当成功：宿主的 `application` 缺失时一律判 `failed`，
 * 并在消息里说明「宿主没有返回结果」，而不是报告安装成功。
 */
import type { HostService } from "./types.ts";

/** 宿主返回的 `application`。 */
export type OpApplication =
  | "cancelled"
  | "failed"
  | "applied"
  | "restart-required"
  | "overridden";

/** 归一化后的状态；`restart` 表示改动已落盘但要重启才生效。 */
export type OpStatus = "done" | "restart" | "failed" | "cancelled";

/** 宿主 `error.code` 的取值（来自其类型声明，共 13 个）。 */
export type ManagerErrorCode =
  | "management-required"
  | "unaddressable"
  | "unknown-plugin"
  | "invalid-spec"
  | "already-installed"
  | "ambiguous-install"
  | "not-bundle"
  | "not-removable"
  | "stop-profile"
  | "bundle-in-use"
  | "stale-approval"
  | "incompatible-version"
  | "operation-error";

/** 宿主 `packageResult.kind` 的取值。 */
export type PackageFailureKind =
  | "network"
  | "unknown"
  | "timeout"
  | "integrity"
  | "pnpm-missing"
  | "not-found"
  | "no-matching-version"
  | "disk-full"
  | "permission"
  | "build-blocked";

export interface ManagerOutcome {
  status: OpStatus;
  /** 宿主的原始 application；缺失表示宿主没给出结论。 */
  application?: OpApplication;
  changed: boolean;
  stage?: string;
  target: string;
  enabled?: boolean;
  restartReason?: string;
  errorCode?: string;
  /** 面向用户的一句话（失败原因 / 下一步动作）。 */
  message: string;
  warnings: string[];
  logPath?: string;
  /** `incompatible-version` 时宿主要求的版本豁免信息。 */
  incompatible?: {
    name: string;
    version: string;
    runtimeVersion: string;
    requirements: Record<string, string>;
  }[];
  /** 需要用户批准构建脚本时给出的包名（本插件不代批准）。 */
  pendingBuilds?: string[];
}

export interface InstallOptions {
  enabled?: boolean;
  requestId?: string;
  registry?: string | null;
}

/** 归一化结果。`target` 缺失时用调用方传入的 spec。 */
export function normalizeOutcome(raw: any, fallbackTarget: string): ManagerOutcome {
  const application =
    raw?.application === "applied" ||
    raw?.application === "restart-required" ||
    raw?.application === "cancelled" ||
    raw?.application === "failed" ||
    raw?.application === "overridden"
      ? (raw.application as OpApplication)
      : undefined;
  const errorCode = typeof raw?.error?.code === "string" ? raw.error.code : undefined;
  const kind = typeof raw?.packageResult?.kind === "string" ? raw.packageResult.kind : undefined;
  const status: OpStatus =
    application === "applied" || application === "overridden"
      ? "done"
      : application === "restart-required"
        ? "restart"
        : application === "cancelled"
          ? "cancelled"
          : "failed";

  const outcome: ManagerOutcome = {
    status,
    changed: raw?.changed === true,
    target: typeof raw?.target === "string" && raw.target !== "" ? raw.target : fallbackTarget,
    message: "",
    warnings: Array.isArray(raw?.warnings)
      ? raw.warnings.filter((item: unknown): item is string => typeof item === "string")
      : [],
  };
  if (application) outcome.application = application;
  if (typeof raw?.stage === "string") outcome.stage = raw.stage;
  if (typeof raw?.enabled === "boolean") outcome.enabled = raw.enabled;
  if (typeof raw?.restartReason === "string") outcome.restartReason = raw.restartReason;
  if (errorCode) outcome.errorCode = errorCode;
  if (typeof raw?.packageResult?.logPath === "string")
    outcome.logPath = raw.packageResult.logPath;
  if (Array.isArray(raw?.error?.incompatible)) outcome.incompatible = raw.error.incompatible;
  if (Array.isArray(raw?.pendingBuilds))
    outcome.pendingBuilds = raw.pendingBuilds.filter(
      (item: unknown): item is string => typeof item === "string",
    );

  outcome.message = describeOutcome(outcome, {
    diagnostic: typeof raw?.error?.diagnostic === "string" ? raw.error.diagnostic : undefined,
    kind,
  });
  return outcome;
}

/** 把状态与错误码翻成一句能照做的话。 */
export function describeOutcome(
  outcome: ManagerOutcome,
  extra: { diagnostic?: string; kind?: string } = {},
): string {
  if (outcome.status === "done")
    return outcome.application === "overridden"
      ? "已生效（覆盖了同 id 的既有条目）"
      : "已完成";
  if (outcome.status === "restart") {
    const why: Record<string, string> = {
      "no-hmr": "该 profile 未开启热重载",
      "package-moved": "包位置发生了变化",
      "host-module": "涉及宿主自带模块",
      "unmanaged-plugin": "该插件不由插件管理器装载",
      "module-comparison": "模块解析结果发生变化",
    };
    return (
      "改动已落盘，需要重启 DSH 才生效" +
      (outcome.restartReason ? `（${why[outcome.restartReason] ?? outcome.restartReason}）` : "")
    );
  }
  if (outcome.status === "cancelled") return "已取消（宿主的文件改动已还原）";

  const byCode: Record<string, string> = {
    "already-installed":
      "这个包已经装过：热重载下宿主不能原地覆盖，需要先卸载再安装",
    "incompatible-version": describeIncompatible(outcome),
    "not-removable": "宿主不允许移除这个包（它可能在启动时就被占用）",
    "not-bundle": "这个包不是 DSH 插件（没有 bundle patch）",
    "unknown-plugin": "宿主不认识这个名字（可能不在当前 profile 的依赖或 bundle 列表里）",
    "invalid-spec": "安装地址不合法",
    "ambiguous-install": "这个名字对应多个可安装目标，需要更具体的地址",
    "management-required": "需要管理权限（或该操作不在当前允许范围内）",
    "unaddressable": "无法唯一定位这个条目",
    "stop-profile": "需要先停止当前 profile",
    "bundle-in-use": "该 bundle 正在使用中",
    "stale-approval": "批准已过期，请重新确认",
    "operation-error": "宿主的包操作失败",
  };
  const byKind: Record<string, string> = {
    network: "网络不可达（registry 或仓库取不到）",
    timeout: "拉取超时",
    integrity: "下载内容校验失败",
    "pnpm-missing": "找不到 pnpm",
    "not-found": "registry / 仓库里没有这个包",
    "no-matching-version": "没有匹配的版本",
    "disk-full": "磁盘空间不足",
    permission: "没有写入权限",
    "build-blocked":
      "pnpm 拦下了构建脚本：需要在 profile 的 pnpm-workspace.yaml 的 allowBuilds 里放行该包后重试",
  };
  const diagnostic = extra.diagnostic;
  if (outcome.errorCode) {
    /**
     * ⚠️ `operation-error` 是宿主的「兜底错误码」：pnpm 失败、模块解析失败、重载失败
     * 全都是它，真正的信息只在 `error.diagnostic` 里。旧实现先命中错误码就返回
     * 「宿主的包操作失败」，把诊断整个丢掉 —— 用户拿到一句无法照做的话，只能自己去
     * 翻 pnpm.log（本轮线上实测就是这个坑）。所以这里：先看 `packageResult.kind`，
     * 再用诊断原文（或其特征）说话，一条都不丢。
     */
    if (outcome.errorCode === "operation-error") {
      const kindText = extra.kind ? byKind[extra.kind] : undefined;
      if (diagnostic !== undefined && diagnostic.trim() !== "")
        return describeDiagnostic(diagnostic, kindText ?? "宿主的包操作失败");
      return kindText !== undefined
        ? `${kindText}（宿主没有给出诊断，请查看操作日志）`
        : "宿主的包操作失败（宿主没有给出诊断，请查看操作日志）";
    }
    const canned = byCode[outcome.errorCode];
    if (canned)
      return diagnostic !== undefined && diagnostic.trim() !== ""
        ? `${canned}（${describeDiagnostic(diagnostic, "")}）`
        : canned;
  }

  if (extra.kind && byKind[extra.kind]) {
    const tail = diagnostic ? `（${truncate(diagnostic)}）` : "";
    return byKind[extra.kind]! + tail;
  }
  if (!outcome.application && diagnostic === undefined)
    return "宿主没有返回结果（未知状态），请查看操作日志";
  // 没有错误码时诊断原文本身就是宿主的说明：原样给出（已知特征仍会补一句下一步）
  return diagnostic ? describeDiagnostic(diagnostic, "") : "操作失败";
}

/**
 * pnpm / Node 的失败特征 → 一句能照做的话。
 *
 * 诊断原文照附在后面（截断而非替换）：映射是给「下一步」用的，原文是证据。
 */
const DIAGNOSTIC_SIGNATURES: [RegExp, string][] = [
  [
    /ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER|isn't supported by any available resolver/i,
    "交给 pnpm 的安装地址被当成包名了（缺 `<包名>@` 前缀）",
  ],
  [/ERR_PNPM_NO_MATCHING_VERSION|No matching version found/i, "没有匹配的版本"],
  [
    /ERR_PNPM_FETCH_404|ERR_PNPM_FETCH_401|404 Not Found|not in this registry/i,
    "registry / 仓库里没有这个包或版本（或没有权限）",
  ],
  [/ERR_PNPM_TARBALL_INTEGRITY/, "下载内容校验失败"],
  [
    /ERR_PNPM_TARBALL_URL_MISMATCH/,
    "lockfile 里的 tarball 地址与当前 registry 不一致（换过 registry 的包要先卸载再装）",
  ],
  [
    /ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED|ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/i,
    "pnpm 拦下了构建脚本：需要在 profile 的 pnpm-workspace.yaml 的 allowBuilds 里放行该包后重试",
  ],
  [
    /Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/,
    "加载这个插件时找不到它的模块：它依赖的包多半已经不在了（先重新安装，再启用）",
  ],
  [
    /ERR_PNPM_OUTDATED_LOCKFILE|frozen-lockfile/i,
    "lockfile 与 package.json 不一致（`--frozen-lockfile` 拒绝了这次改动）",
  ],
  [
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|network failure/i,
    "网络不可达（registry 或仓库取不到）",
  ],
  [/ENOSPC|no space left/i, "磁盘空间不足"],
  [/EACCES|EPERM|permission denied/i, "没有写入权限"],
];

/** 诊断原文 + 已知特征给出的那一句。`fallback` 为空时只给原文。 */
export function describeDiagnostic(diagnostic: string, fallback: string): string {
  const hit = DIAGNOSTIC_SIGNATURES.find(([pattern]) => pattern.test(diagnostic));
  const raw = truncate(diagnostic);
  if (hit) return `${hit[1]}：${raw}`;
  return fallback === "" ? raw : `${fallback}：${raw}`;
}

function describeIncompatible(outcome: ManagerOutcome): string {
  const first = outcome.incompatible?.[0];
  if (!first) return "版本不兼容（宿主拒绝了这次安装）";
  const unmet = Object.entries(first.requirements ?? {})
    .map(([key, value]) => `${key} ${value}`)
    .join("、");
  return (
    `${first.name}@${first.version} 与当前 DSH ${first.runtimeVersion} 不兼容` +
    (unmet ? `（要求 ${unmet}）` : "") +
    `；如确认要装，可执行 dsh plugin allow-version ${first.name}@${first.version} --dsh-version ${first.runtimeVersion} --accept-risk`
  );
}

function truncate(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

/** 宿主 `pluginManager.listPlugins()` 里我们用得到的字段。 */
export interface HostEntry {
  entryId: string;
  moduleName: string;
  enabled: boolean;
  /** 宿主不允许我们改这个条目时给的原因（`management-required` / `unaddressable`）。 */
  readOnlyReason?: string;
}

/** 宿主服务的方法面（只列本插件用到的）。 */
export interface PluginManagerLike extends HostService {
  installBundle(spec: string, options?: InstallOptions): Promise<any>;
  removeBundle(name: string): Promise<any>;
  setBundleEnabled(name: string, enabled: boolean): Promise<any>;
  cancelInstall?(requestId: string): Promise<any>;
  waitForInstall?(requestId: string): Promise<any>;
  listBundles(): Promise<any[]>;
  listPlugins?(): Promise<any[]>;
  /** 改单个条目的启用状态（宿主会把它写进 profile 补丁的 `disabled`）。 */
  setPluginEnabled?(id: string, enabled: boolean): Promise<any>;
}

/**
 * 读宿主条目（导出的条目级信息、导入的条目开关比对都靠它）。
 *
 * 方法缺失（老宿主）或读失败时返回 `undefined` —— 调用方据此**如实说明**「条目级信息
 * 不可用」，而不是编一份空的条目表出来。
 */
export async function readHostEntries(
  manager: PluginManagerLike,
): Promise<HostEntry[] | undefined> {
  if (typeof manager.listPlugins !== "function") return undefined;
  try {
    const rows = await manager.listPlugins();
    if (!Array.isArray(rows)) return undefined;
    const out: HostEntry[] = [];
    for (const row of rows) {
      if (
        !row ||
        typeof row.entryId !== "string" ||
        typeof row.moduleName !== "string" ||
        typeof row.enabled !== "boolean"
      )
        continue;
      out.push({
        entryId: row.entryId,
        moduleName: row.moduleName,
        enabled: row.enabled,
        ...(typeof row.readOnlyReason === "string" ? { readOnlyReason: row.readOnlyReason } : {}),
      });
    }
    return out;
  } catch {
    return undefined;
  }
}

/** 改一个条目的启用状态；宿主不支持就返回 unsupported（调用方如实报告）。 */
export async function setEntryEnabledWithManager(
  manager: PluginManagerLike,
  entryId: string,
  enabled: boolean,
): Promise<ManagerOutcome | "unsupported"> {
  if (typeof manager.setPluginEnabled !== "function") return "unsupported";
  try {
    return normalizeOutcome(await manager.setPluginEnabled(entryId, enabled), entryId);
  } catch (error) {
    return failure(entryId, error);
  }
}

/** 调宿主安装；任何抛错都收敛成 failed 结果（附原因）。 */
export async function installWithManager(
  manager: PluginManagerLike,
  spec: string,
  options: InstallOptions = {},
): Promise<ManagerOutcome> {
  try {
    const raw = await manager.installBundle(spec, options);
    return normalizeOutcome(raw, spec);
  } catch (error) {
    return failure(spec, error);
  }
}

export async function removeWithManager(
  manager: PluginManagerLike,
  name: string,
): Promise<ManagerOutcome> {
  try {
    return normalizeOutcome(await manager.removeBundle(name), name);
  } catch (error) {
    return failure(name, error);
  }
}

export async function setEnabledWithManager(
  manager: PluginManagerLike,
  name: string,
  enabled: boolean,
): Promise<ManagerOutcome> {
  try {
    return normalizeOutcome(await manager.setBundleEnabled(name, enabled), name);
  } catch (error) {
    return failure(name, error);
  }
}

/** 取消一次安装；返回宿主的口径（cancelled / not-running / too-late）。 */
export async function cancelWithManager(
  manager: PluginManagerLike,
  requestId: string,
): Promise<"cancelled" | "not-running" | "too-late" | "unsupported"> {
  if (typeof manager.cancelInstall !== "function") return "unsupported";
  try {
    const raw = await manager.cancelInstall(requestId);
    const status = raw?.status;
    return status === "cancelled" || status === "not-running" || status === "too-late"
      ? status
      : "not-running";
  } catch {
    return "unsupported";
  }
}

function failure(target: string, error: unknown): ManagerOutcome {
  const text = error instanceof Error ? error.message : String(error);
  return {
    status: "failed",
    changed: false,
    target,
    message: truncate(text),
    warnings: [],
  };
}

/** 是否因为「已装」被拒（调用方据此改走 remove → install 或子进程覆盖）。 */
export function isAlreadyInstalled(outcome: ManagerOutcome): boolean {
  return outcome.errorCode === "already-installed";
}

/** 是否因为版本不兼容被拒（调用方据此把豁免命令交给用户）。 */
export function isIncompatible(outcome: ManagerOutcome): boolean {
  return outcome.errorCode === "incompatible-version";
}