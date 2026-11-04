import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ExportBundle } from "../core/transfer.ts";
import { isLocalExport } from "../core/transfer.ts";

export interface ConfigEntry {
  options: { id: string; name: string; config?: unknown };
  fiber?: { state: number };
}
export interface ConfigEditorLike {
  entries(): ConfigEntry[];
  edit(
    entry: ConfigEntry,
    change: (current: any, inherited: any) => any,
  ): Promise<void>;
}
export interface ConfigPlan {
  plugin: string;
  id: string;
  action: "apply" | "skip" | "manual";
  paths: string[];
  skipped: string[];
  reason?: string;
  patch?: Record<string, unknown>;
  expected?: string;
}
const secretKey =
  /token|secret|password|passwd|apikey|accesskey|privatekey|credential|cookie|authorization|sessionid/i;
const machineKey =
  /(?:path|directory|datadir|cachedir|logdir|workdir|workspace|cwd|homedir|socket|proxy|registry)/i;
const unsafeKey = /^(?:__proto__|prototype|constructor|__jsExpr)$/;
const unsafeValue =
  /\[已脱敏\]|\[REDACTED\]|\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{16,}|\bnpm_[A-Za-z0-9]{16,}|\bBearer\s+\S+|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.|https?:\/\/[^/]*@/i;
const localValue = /^(?:[A-Za-z]:[\\/]|\/|\\\\|\.\.?[\\/]|~[\\/]|file:|link:)/;
const record = (v: any): v is Record<string, unknown> =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const fingerprint = (v: any): string =>
  createHash("sha256")
    .update(JSON.stringify(v ?? {}))
    .digest("hex");
const sensitive = (value: any): boolean =>
  typeof value === "string"
    ? unsafeValue.test(value) || localValue.test(value)
    : Array.isArray(value)
      ? value.some(sensitive)
      : record(value)
        ? Object.entries(value).some(
            ([k, v]) =>
              secretKey.test(k.replace(/[-_]/g, "")) ||
              machineKey.test(k) ||
              unsafeKey.test(k) ||
              sensitive(v),
          )
        : false;

/** 只合并可迁移的普通 JSON 字段；不删除本机字段，不用占位符替换秘密，不执行表达式。 */
export function safeConfigPatch(incoming: unknown): {
  patch: Record<string, unknown>;
  skipped: string[];
} {
  const skipped: string[] = [];
  const walk = (
    value: Record<string, unknown>,
    prefix = "",
    depth = 0,
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (
        depth > 20 ||
        unsafeKey.test(key) ||
        secretKey.test(key.replace(/[-_]/g, "")) ||
        machineKey.test(key)
      ) {
        skipped.push(path);
        continue;
      }
      if (record(child)) {
        if (Object.hasOwn(child, "__jsExpr")) {
          skipped.push(path);
          continue;
        }
        const nested = walk(child, path, depth + 1);
        if (Object.keys(nested).length) out[key] = nested;
      } else if (
        sensitive(child) ||
        child === null ||
        (typeof child === "number" && !Number.isFinite(child))
      ) {
        skipped.push(path);
      } else if (
        Array.isArray(child) ||
        ["string", "number", "boolean"].includes(typeof child)
      )
        out[key] = structuredClone(child);
      else skipped.push(path);
    }
    return out;
  };
  return {
    patch: record(incoming) ? walk(incoming) : {},
    skipped: record(incoming) ? skipped : ["(配置不是普通对象)"],
  };
}
export function mergeConfig(
  current: any,
  patch: Record<string, unknown>,
): { next: Record<string, unknown>; paths: string[] } {
  if (!record(current)) throw Error("本机配置不是普通对象");
  const next = structuredClone(current);
  const paths: string[] = [];
  const merge = (target: any, source: Record<string, unknown>, prefix = "") => {
    for (const [key, value] of Object.entries(source)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (record(value)) {
        if (target[key] !== undefined && !record(target[key]))
          throw Error("配置结构不同，需要人工处理");
        if (target[key] === undefined) target[key] = {};
        merge(target[key], value, path);
      } else {
        if (sensitive(target[key]))
          throw Error("配置替换会影响本机敏感字段，需要人工处理");
        if (!isDeepStrictEqual(target[key], value)) {
          target[key] = structuredClone(value);
          paths.push(path);
        }
      }
    }
  };
  merge(next, patch);
  return { next, paths };
}
const owns = (entry: ConfigEntry, plugin: string) =>
  entry.options.name === plugin || entry.options.name.startsWith(plugin + "/");
export function planConfigs(
  bundle: ExportBundle,
  editor: ConfigEditorLike | undefined,
): ConfigPlan[] {
  const entries = editor?.entries() ?? [];
  const plans: ConfigPlan[] = [];
  for (const plugin of bundle.plugins) {
    if (isLocalExport(plugin)) continue;
    for (const row of plugin.config ?? []) {
      if (row.config === undefined) continue;
      const safe = safeConfigPatch(row.config);
      const base: ConfigPlan = {
        plugin: plugin.name,
        id: row.id ?? "",
        action: "manual",
        paths: [],
        skipped: safe.skipped,
      };
      const candidates = entries.filter(
        (e) =>
          e.options.id === row.id &&
          owns(e, plugin.name) &&
          (!row.name || e.options.name === row.name),
      );
      if (!record(row.config)) base.reason = "配置不是普通对象，无法安全合并";
      else if (!Object.keys(safe.patch).length) {
        base.action = "skip";
        base.reason = "只有凭据、路径、表达式或空配置，保留本机值，无需恢复";
      } else if (!editor) base.reason = "宿主没有 configEditor 配置服务";
      else if (
        !row.id ||
        candidates.length !== 1 ||
        candidates[0]!.fiber?.state !== 2
      )
        base.reason =
          "插件尚未激活或配置条目无法唯一匹配；安装/启用后请重新预检";
      else {
        try {
          const entry = candidates[0]!;
          const merged = mergeConfig(entry.options.config ?? {}, safe.patch);
          base.paths = merged.paths;
          base.action = merged.paths.length ? "apply" : "skip";
          if (base.action === "apply") {
            base.patch = safe.patch;
            base.expected = fingerprint(entry.options.config);
          } else base.reason = "可迁移配置已一致";
        } catch {
          base.reason = "配置结构或本机敏感字段冲突，需要人工处理";
        }
      }
      plans.push(base);
    }
  }
  return plans;
}
export async function applyConfig(
  plan: ConfigPlan,
  editor: ConfigEditorLike | undefined,
): Promise<void> {
  if (plan.action !== "apply" || !plan.patch || !editor)
    throw Error("配置没有可执行的宿主计划");
  const entries = editor
    .entries()
    .filter((e) => e.options.id === plan.id && owns(e, plan.plugin));
  if (entries.length !== 1) throw Error("配置条目已变化，请重新预检");
  // 再过滤一次，不接受历史记录或其他调用方带入的不安全字段。
  const safe = safeConfigPatch(plan.patch);
  if (safe.skipped.length) throw Error("配置计划含受保护字段");
  await editor.edit(entries[0]!, (current) => {
    if (fingerprint(current) !== plan.expected)
      throw Error("本机配置已变化，请重新预检");
    return mergeConfig(current, safe.patch).next;
  });
}
