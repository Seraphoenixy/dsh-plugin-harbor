/**
 * 设置持久化。
 *
 * 位置：`<profile>/plugin-harbor/settings.json` —— 本插件**自己的数据目录**，
 * 与目录库同级。这里只写自己的文件，绝不碰 profile 的 `package.json` /
 * `cordis.patch.yml`（AGENTS.md 的硬约束）。
 *
 * 口径：
 *  - 读取**容错**：文件缺失、JSON 坏、字段类型不对，一律退回该字段的默认值，
 *    并把原因记进 `notes` 让界面如实显示，不静默吞掉；
 *  - 写入**原子**：先写 `.tmp` 再 `rename`，避免半截文件；
 *  - 校验**拒绝而非纠正**：非法值直接报错，不替用户改写意图。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CenterSettingsFile {
  version: 1;
  /** 目录语言：`zh` / `en`（决定抓哪一套分片）。 */
  locale: "zh" | "en";
  /** 目录自动刷新间隔（毫秒）。 */
  syncTtlMs: number;
  /** 官网基址（可指向镜像）。 */
  siteBase: string;
  /** API 中心基址。 */
  apiBase: string;
  /** registry 基址；空串表示用 npm 官方源。 */
  registry: string;
  /** 出网代理；空串表示交给宿主/系统。 */
  proxy: string;
}

/** 同步间隔的允许区间：15 分钟 ~ 30 天。 */
export const MIN_TTL_MS = 15 * 60 * 1000;
export const MAX_TTL_MS = 30 * 24 * 3600 * 1000;

/** 由环境变量给出的默认值（自建镜像与离线验收用）。 */
export function defaultSettings(): CenterSettingsFile {
  return {
    version: 1,
    locale: "zh",
    syncTtlMs: 24 * 3600 * 1000,
    siteBase: process.env.PLUGIN_HARBOR_SITE ?? "https://dsh-plugin.org",
    apiBase: process.env.PLUGIN_HARBOR_API ?? "https://api.dsh-plugin.org",
    registry: process.env.PLUGIN_HARBOR_REGISTRY ?? "",
    proxy: "",
  };
}

export function settingsPath(dataDir: string): string {
  return join(dataDir, "settings.json");
}

const isHttpUrl = (value: string) => /^https?:\/\/[^\s]+$/i.test(value);
const clean = (value: string) => value.trim();

/**
 * 把任意输入规范成合法设置；每个字段独立校验，坏的退回默认值并记 note。
 *
 * ⚠️ 逐字段独立处理很关键：一个坏字段不该让整份设置作废（用户会丢掉其余设置），
 * 也不该把坏值放行。
 */
export function normalizeSettings(
  raw: unknown,
  defaults: CenterSettingsFile = defaultSettings(),
): { settings: CenterSettingsFile; notes: string[] } {
  const notes: string[] = [];
  // ⚠️ 数组的 `typeof` 也是 "object"：必须显式排除，否则 `[1,2,3]` 会被当成
  // 一份「没有任何已知字段」的设置而静默通过（本轮实测踩到）。
  const isRecord =
    raw !== null && typeof raw === "object" && !Array.isArray(raw);
  const record = (isRecord ? raw : {}) as Record<string, unknown>;
  if (raw !== undefined && !isRecord)
    notes.push("设置文件不是对象，已全部退回默认值");

  const locale = record.locale === "en" || record.locale === "zh" ? record.locale : defaults.locale;
  if (record.locale !== undefined && record.locale !== locale)
    notes.push(`locale 取值非法（${String(record.locale)}），已退回 ${locale}`);

  let syncTtlMs = defaults.syncTtlMs;
  if (typeof record.syncTtlMs === "number" && Number.isFinite(record.syncTtlMs)) {
    if (record.syncTtlMs >= MIN_TTL_MS && record.syncTtlMs <= MAX_TTL_MS)
      syncTtlMs = Math.round(record.syncTtlMs);
    else
      notes.push(
        `syncTtlMs 超出允许区间（${MIN_TTL_MS}–${MAX_TTL_MS}），已退回 ${defaults.syncTtlMs}`,
      );
  } else if (record.syncTtlMs !== undefined) {
    notes.push("syncTtlMs 不是数字，已退回默认值");
  }

  const url = (key: "siteBase" | "apiBase"): string => {
    const value = record[key];
    if (typeof value !== "string" || clean(value) === "") {
      if (value !== undefined) notes.push(`${key} 不是合法地址，已退回默认值`);
      return defaults[key];
    }
    if (!isHttpUrl(clean(value))) {
      notes.push(`${key} 不是 http(s) 地址（${clean(value)}），已退回默认值`);
      return defaults[key];
    }
    return clean(value).replace(/\/$/, "");
  };

  let registry = defaults.registry;
  const registryRaw = record.registry;
  if (typeof registryRaw === "string") {
    if (clean(registryRaw) === "") registry = "";
    else if (isHttpUrl(clean(registryRaw))) registry = clean(registryRaw).replace(/\/$/, "");
    else notes.push("registry 不是 http(s) 地址，已退回默认值");
  } else if (registryRaw !== undefined) {
    notes.push("registry 不是字符串，已退回默认值");
  }

  let proxy = defaults.proxy;
  const proxyRaw = record.proxy;
  if (typeof proxyRaw === "string") {
    if (clean(proxyRaw).length > 200) notes.push("proxy 过长（>200），已退回默认值");
    else proxy = clean(proxyRaw);
  } else if (proxyRaw !== undefined) {
    notes.push("proxy 不是字符串，已退回默认值");
  }

  return {
    settings: {
      version: 1,
      locale,
      syncTtlMs,
      siteBase: url("siteBase"),
      apiBase: url("apiBase"),
      registry,
      proxy,
    },
    notes,
  };
}

/** 读设置文件；缺失/损坏都退回默认值并给出 notes。 */
export function readSettingsFile(
  dataDir: string,
  defaults: CenterSettingsFile = defaultSettings(),
): { settings: CenterSettingsFile; notes: string[] } {
  const path = settingsPath(dataDir);
  if (!existsSync(path)) return { settings: defaults, notes: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return normalizeSettings(parsed, defaults);
  } catch (error) {
    return {
      settings: defaults,
      notes: [
        "设置文件无法解析，已退回默认值：" +
          (error instanceof Error ? error.message : String(error)),
      ],
    };
  }
}

/** 原子写设置文件（先写 .tmp 再 rename）。 */
export function writeSettingsFile(
  dataDir: string,
  settings: CenterSettingsFile,
): void {
  const path = settingsPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export interface SettingsPatch {
  locale?: unknown;
  syncTtlMs?: unknown;
  siteBase?: unknown;
  apiBase?: unknown;
  registry?: unknown;
  proxy?: unknown;
}

/** 把补丁合并进当前设置；非法值**报错**（与读取时的「退回默认」不同）。 */
export function applySettingsPatch(
  current: CenterSettingsFile,
  patch: SettingsPatch,
): { settings: CenterSettingsFile; problems: string[] } {
  const merged: Record<string, unknown> = { ...current };
  for (const key of [
    "locale",
    "syncTtlMs",
    "siteBase",
    "apiBase",
    "registry",
    "proxy",
  ] as const) {
    if (patch[key] !== undefined) merged[key] = patch[key];
  }
  // 用「默认值＝当前值」来归一化：非法项会被写成当前值，据此就能识别出问题字段。
  const { settings } = normalizeSettings(merged, current);
  const problems: string[] = [];
  if (patch.locale !== undefined && settings.locale !== patch.locale)
    problems.push("locale 只能是 zh 或 en");
  if (patch.syncTtlMs !== undefined && settings.syncTtlMs !== patch.syncTtlMs)
    problems.push(`syncTtlMs 必须是 ${MIN_TTL_MS}–${MAX_TTL_MS} 之间的毫秒数`);
  for (const key of ["siteBase", "apiBase"] as const)
    if (patch[key] !== undefined && settings[key] !== clean(String(patch[key])).replace(/\/$/, ""))
      problems.push(`${key} 必须是 http(s) 地址`);
  if (patch.registry !== undefined && settings.registry !== clean(String(patch.registry)).replace(/\/$/, ""))
    problems.push("registry 必须是 http(s) 地址或空串");
  if (patch.proxy !== undefined && settings.proxy !== clean(String(patch.proxy)))
    problems.push("proxy 必须是 ≤200 字符的字符串");
  return { settings, problems };
}