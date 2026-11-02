import type { ProfileRef } from "./paths.ts";

/**
 * RPC 信封与分发。
 *
 * 与参考项目 channel-hub 使用同一套版本化信封：客户端经宿主 connection 服务
 * 调 `ctx.connection.rpc.call("/api", "plugin-harbor", {version, method, payload})`，
 * 服务端用 `connection.fetch.register({path: "/api/plugin-harbor"})` 接住。
 *
 * ⚠️ 信封校验必须**先于**任何业务处理：`version` 不是 1、`method` 不是本插件
 * 时一律按无效信封拒绝，避免把外来的报文当成本插件的方法调用。
 */

/** 本插件在 connection 通道上的方法名与路径。 */
export const RPC_METHOD = "plugin-harbor";
export const RPC_PATH = "/api/plugin-harbor";
export const RPC_VERSION = 1;

/** 已校验的业务信封。 */
export interface Envelope {
  rpcId: string;
  method: string;
  payload: any;
}

/** 一个方法可用的运行时依赖（由 apply 注入，便于离线测试替换）。 */
export interface RpcContext {
  profile: ProfileRef;
  store: { call<T = any>(method: string, payload?: any): Promise<T> };
  log: (message: string) => void;
  /** 是否已有一次目录同步在跑（界面据此显示进度并避免重复触发）。 */
  syncing: () => boolean;
  /** 触发/复用一次目录同步。 */
  refresh: () => Promise<unknown>;
  /**
   * 宿主是否提供热重载服务（`hmr`）。
   *
   * 桌面宿主默认加载 `@deepseek-ai/dsh-hmr`（`dsh-base` 的 `hmr` 条目），此时变更由
   * 宿主原地生效、无需重启；没有它时宿主一律回 `restart-required`。界面据此选择
   * 文案，**结论仍以宿主返回的 `application` 为准**（这里只回答「有没有这个能力」）。
   */
  hot: () => boolean;
}

/** 只读类方法：不依赖 apply 内的运行时对象，便于单独测试。 */
export type RpcHandlers = Record<
  string,
  (payload: any, ctx: RpcContext) => unknown | Promise<unknown>
>;

export type RpcHandler = (
  payload: any,
  ctx: RpcContext,
) => unknown | Promise<unknown>;

export interface RpcOutcome {
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string };
}

/**
 * 校验并拆出业务信封。
 *
 * 非法信封返回 `reason` 与**能读到的** rpcId（读不到时固定 `"invalid"`），
 * 由调用方原样回一个 `server-response`，让客户端不会悬挂等待。
 */
export function readEnvelope(
  message: any,
): { ok: true; envelope: Envelope } | { ok: false; reason: string; rpcId: string } {
  const rpcId = typeof message?.rpcId === "string" ? message.rpcId : "invalid";
  if (message?.type !== "client-request")
    return { ok: false, reason: "Invalid versioned RPC envelope", rpcId };
  if (message?.method !== RPC_METHOD)
    return { ok: false, reason: "Invalid versioned RPC envelope", rpcId };
  if (message?.payload?.version !== RPC_VERSION)
    return { ok: false, reason: "Invalid versioned RPC envelope", rpcId };
  if (typeof message?.payload?.method !== "string")
    return { ok: false, reason: "Invalid versioned RPC envelope", rpcId };
  return {
    ok: true,
    envelope: {
      rpcId,
      method: message.payload.method,
      payload: message.payload.payload ?? {},
    },
  };
}

/**
 * 错误脱敏：只保留一句人类可读的说明。
 *
 * 目录数据与安装输出都会经过这里，任何形如 `token=…` 的片段都不该出现在界面
 * 或日志里（AGENTS.md 的硬约束）。
 */
export function redact(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(
      /(token|secret|password|cookie|authorization)([=:]\s*)\S+/gi,
      "$1$2[redacted]",
    )
    .slice(0, 200);
}

/** 由方法表构造分发器：未知方法、抛错都收敛成 `{ok:false, error}`。 */
export function createDispatcher(
  handlers: Record<string, RpcHandler>,
): (method: string, payload: any, ctx: RpcContext) => Promise<RpcOutcome> {
  return async function dispatch(method, payload, ctx) {
    const handler = handlers[method];
    if (!handler)
      return {
        ok: false,
        error: {
          code: "plugin-harbor/unknown-method",
          message: "Unknown method: " + method,
        },
      };
    try {
      return { ok: true, value: (await handler(payload ?? {}, ctx)) ?? null };
    } catch (error) {
      return {
        ok: false,
        error: { code: "plugin-harbor/error", message: redact(error) },
      };
    }
  };
}