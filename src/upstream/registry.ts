/**
 * npm registry 只读查询。
 *
 * 用 npm 的**精简元数据**（`application/vnd.npm.install-v1+json`）：返回体只有
 * dist-tags 与各版本的 `dist`，几 KB 而不是整份 packument（真实包可达数 MB）。
 */
import { fetchText } from "./fetch.ts";

export interface RegistryFacts {
  /** `dist-tags.latest`。 */
  latest?: string;
  /** 该版本声明的 `dist.integrity`（可与 lockfile 里的值逐字比对）。 */
  integrity?: string;
  error?: string;
}

export interface RegistryOptions {
  /** registry 基址；缺省用 npm 官方源。 */
  registry?: string;
  timeoutMs?: number;
}

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/** 包名 → registry 路径：只有 `/` 需要编码成 `%2f`（scope 的 `@` 保持原样）。 */
export function packagePath(name: string): string {
  return name.replace("/", "%2f");
}

export async function fetchRegistryFacts(
  name: string,
  options: RegistryOptions = {},
): Promise<RegistryFacts> {
  const base = (options.registry ?? DEFAULT_REGISTRY).replace(/\/$/, "");
  const url = `${base}/${packagePath(name)}`;
  const result = await fetchText(url, {
    timeoutMs: options.timeoutMs ?? 15_000,
    accept: "application/vnd.npm.install-v1+json",
  });
  if (!result.ok) return { error: result.error ?? `HTTP ${result.status}` };
  let parsed: any;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    return { error: "registry 返回的不是 JSON" };
  }
  const latest = parsed?.["dist-tags"]?.latest;
  if (typeof latest !== "string" || latest === "")
    return { error: "registry 没有 dist-tags.latest" };
  const integrity = parsed?.versions?.[latest]?.dist?.integrity;
  return {
    latest,
    ...(typeof integrity === "string" && integrity !== "" ? { integrity } : {}),
  };
}