/**
 * 已装插件与其配置的导出 / 导入。
 *
 * 口径（与 AGENTS.md 的纪律一致）：
 *  - **只读导出**：插件清单来自已装事实，配置行来自 profile 的 `cordis.patch.yml`，
 *    插件自己的设置文件是**可选项**且必须脱敏；数据库 / 缓存 / 日志 / 二进制一律不导出，
 *    并且每一项未导出的东西都要出现在 `omissions` 里 —— 不能静默少东西。
 *  - **导入只增不删**：安装缺失的插件、按导出恢复启用状态与条目开关；**从不卸载**，
 *    也不动 `package.json` / `cordis.patch.yml` / `pnpm-lock.yaml`（那是宿主的事）。
 *  - **配置行给人工**：宿主的 `pluginManager` 只提供 `setPluginEnabled`（写 `disabled`），
 *    **没有写任意 `config` 的接口**，本项目也不允许手工改 profile 的补丁文件。因此配置行
 *    导出后由导入方生成一份可粘贴的 YAML 片段，并如实说明这一步必须人工完成。
 *  - **归属规则明确**：profile 补丁行按「条目 id（宿主/插件自己声明的行 id）」或
 *    「行里的 `name` 指向该包」归属到插件；归属不到的行走 `profilePatch.unattributed`，
 *    数据目录同理（认不出属于谁的目录进 `omissions`，不硬塞给某个插件）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { installSpecFor } from "../ops/spec.ts";
import type { CenterSettingsFile } from "./settings.ts";
import type { InstalledPlugin } from "./types.ts";

export const EXPORT_FORMAT = "dsh-plugin-harbor/export";
export const EXPORT_VERSION = 1;
/** 单个插件设置文件的上限；超过就只记省略，不截断（截断的配置没法用）。 */
const MAX_FILE_BYTES = 256 * 1024;
/** 全部插件设置文件的总上限。 */
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
/** 数据目录递归深度上限。 */
const MAX_DEPTH = 3;
/** 只导出这些扩展名的文本文件；其余进省略清单。 */
const TEXT_EXTENSIONS = new Set([
  ".json",
  ".jsonc",
  ".yml",
  ".yaml",
  ".txt",
  ".md",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
]);
/** 绝不进入导出的目录名（缓存/依赖/日志/本插件自己的导出目录）。 */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  "cache",
  "caches",
  ".git",
  "exports",
  "logs",
  "log",
  "tmp",
  "temp",
]);
/** 绝不进入导出的文件名形态：数据库、日志、锁、压缩包。 */
const EXCLUDED_FILE = /\.(sqlite3?|db|db3|log|lock|tgz|tar|gz|zip|bin|node|dll|exe|so|dylib)(-wal|-shm)?$/i;
/** 归一化后的键名里出现这些词就按凭据处理。 */
const SECRET_KEY =
  /(token|secret|passwd|password|apikey|accesskey|privatekey|credential|cookie|authorization|sessionid|clientsecret)/;
/** 值里出现这些形态也按凭据处理（明文 key / JWT / Bearer / URL 里的用户信息）。 */
const SECRET_VALUE = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/,
  /\bnpm_[A-Za-z0-9]{16,}/,
  /\bBearer\s+\S+/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,
  /:\/\/[^/\s:@]+:[^/\s:@]+@/,
];
export const REDACTED = "[已脱敏]";

export interface ExportedFile {
  /** 相对 profile 目录的路径（`<entryId>/settings.json`）。 */
  path: string;
  bytes: number;
  content: string;
}

export interface ExportedEntry {
  entryId: string;
  moduleName: string;
  enabled: boolean;
}

export interface ExportedConfigRow {
  id?: string;
  name?: string;
  config?: unknown;
  /** `!!js` 表达式按**字符串**原样保留，不能强行转成布尔。 */
  disabled?: boolean | string;
}

export interface ExportedPlugin {
  name: string;
  /** profile 里记录的取值（registry 形态是版本范围）。 */
  spec: string;
  kind: InstalledPlugin["kind"];
  version?: string;
  /** 导出时是否已启用（= 在 `dsh.profile.bundles` 里）。 */
  enabled: boolean;
  repo?: string;
  packageName?: string;
  /** 该插件在宿主里的条目（需要宿主服务；缺服务时整个字段缺席）。 */
  entries?: ExportedEntry[];
  /** 归属到该插件的 profile 补丁行（含用户配置）。 */
  config?: ExportedConfigRow[];
  /** 该插件自己的设置文件（仅 `includeData`，且已脱敏）。 */
  files?: ExportedFile[];
}

export interface ExportBundle {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: number;
  profile: string;
  by: { plugin: string; version: string };
  settings?: CenterSettingsFile;
  plugins: ExportedPlugin[];
  profilePatch?: {
    /** 被各插件认领的行 id。 */
    attributed: string[];
    /** 认不出属于谁的补丁行：原样带出，绝不丢。 */
    unattributed: ExportedConfigRow[];
    error?: string;
  };
  /** 没进导出的东西及原因（数据库 / 二进制 / 过大 / 认不出归属 / 疑似凭据）。 */
  omissions: { path: string; reason: string }[];
  warnings: string[];
}

/** 宿主的条目（`pluginManager.listPlugins()` 的子集）。 */
export interface HostEntry {
  entryId: string;
  moduleName: string;
  enabled: boolean;
  readOnlyReason?: string;
}

export interface ExportInput {
  profileName: string;
  profileDir: string;
  pluginVersion: string;
  plugins: InstalledPlugin[];
  settings: CenterSettingsFile;
  /** 宿主条目；服务不可用时整个字段缺席（条目级信息就不导出）。 */
  entries?: HostEntry[];
  includeData?: boolean;
  now?: number;
  /** 本插件的数据目录名，避免把自己的导出目录扫进去。 */
  selfDirName?: string;
}

/** 组装导出对象（纯读取；脱敏在拼装时完成）。 */
export function buildExport(input: ExportInput): ExportBundle {
  const now = input.now ?? Date.now();
  const warnings: string[] = [];
  const omissions: { path: string; reason: string }[] = [];
  const patch = readProfilePatch(input.profileDir);
  if (patch.error !== undefined) warnings.push(`profile 补丁未能解析：${patch.error}`);
  const unattributed: ExportedConfigRow[] = [];
  const attributed: string[] = [];
  let redactions = 0;

  const plugins: ExportedPlugin[] = input.plugins.map((plugin) => {
    const rowIds = declaredRowIds(input.profileDir, plugin.name);
    const myEntries = (input.entries ?? []).filter((entry) => isEntryOf(entry.moduleName, plugin.name));
    const mine: ExportedConfigRow[] = [];
    for (const row of patch.rows) {
      if (!belongsTo(row, plugin.name, rowIds)) continue;
      if (row.id !== undefined) attributed.push(row.id);
      const safe = redactRow(row);
      redactions += safe.count;
      mine.push(safe.row);
    }
    const exported: ExportedPlugin = {
      name: plugin.name,
      spec: plugin.spec,
      kind: plugin.kind,
      enabled: plugin.selected,
    };
    if (plugin.version !== undefined) exported.version = plugin.version;
    if (plugin.repo !== undefined) exported.repo = plugin.repo;
    if (plugin.packageName !== undefined) exported.packageName = plugin.packageName;
    if (input.entries !== undefined)
      exported.entries = myEntries.map((entry) => ({
        entryId: entry.entryId,
        moduleName: entry.moduleName,
        enabled: entry.enabled,
      }));
    if (mine.length > 0) exported.config = mine;
    if (input.includeData === true) {
      const scan = collectDataFiles(input.profileDir, plugin, myEntries, input.selfDirName);
      omissions.push(...scan.omissions);
      redactions += scan.redactions;
      if (scan.files.length > 0) exported.files = scan.files;
    }
    return exported;
  });

  // 归属不到的补丁行也要带出去：用户可能配置了导出范围之外的插件/宿主条目
  for (const row of patch.rows) {
    if (row.id !== undefined && attributed.includes(row.id)) continue;
    if (row.config === undefined && row.disabled === undefined) continue;
    const safe = redactRow(row);
    redactions += safe.count;
    unattributed.push(safe.row);
  }
  if (patch.rows.length > 0 && unattributed.length > 0)
    warnings.push(
      `有 ${unattributed.length} 行补丁没归到导出范围内的已装插件（多半配置的是宿主自带条目或其他包），已原样放在 profilePatch.unattributed 里`,
    );
  if (input.includeData === true) {
    if (redactions > 0)
      warnings.push(`插件设置里有 ${redactions} 处疑似凭据的字段/取值，已替换为 ${REDACTED}`);
    warnings.push("插件自己的设置文件只导出、不自动导入：那是各插件自己的数据，本项目不代写");
    /**
     * 认不出归属的顶层目录也要列出来：否则用户会以为「导出的就是全部」。
     * 只列名字与原因，不猜它属于哪个插件。
     */
    const owned = ownedDataDirNames(
      input.profileDir,
      input.plugins,
      input.entries ?? [],
      input.selfDirName,
    );
    for (const dir of unownedProfileDirs(input.profileDir, owned))
      omissions.push({ path: dir, reason: "认不出属于哪个已装插件，未导出其内容" });
  }
  if (input.entries === undefined)
    warnings.push("宿主 pluginManager 服务不可用：未包含条目级信息（条目开关无法导出/导入）");

  const bundle: ExportBundle = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now,
    profile: input.profileName,
    by: { plugin: "plugin-harbor", version: input.pluginVersion },
    plugins,
    profilePatch: {
      attributed: [...new Set(attributed)],
      unattributed,
      ...(patch.error === undefined ? {} : { error: patch.error }),
    },
    omissions,
    warnings,
  };
  bundle.settings = redactSettings(input.settings);
  return bundle;
}

/** 导出对象 → 可写盘的 JSON 文本（末尾带换行）。 */
export function serializeExport(bundle: ExportBundle): string {
  return JSON.stringify(bundle, null, 2) + "\n";
}

/** 导出文件名（可排序、带 profile 名）。 */
export function exportFileName(profileName: string, now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  return `${stamp}-${profileName}.json`;
}

/**
 * 读回一个导出文件并做**格式校验**。
 *
 * 校验失败一律报错而不是「当作空导出」：把别的 JSON 当清单导入比报错危险得多。
 */
export function readExport(text: string): { bundle?: ExportBundle; error?: string } {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { error: "不是合法 JSON：" + (error instanceof Error ? error.message : String(error)) };
  }
  if (!parsed || typeof parsed !== "object") return { error: "内容不是对象" };
  if (parsed.format !== EXPORT_FORMAT)
    return { error: `不是插件港湾的导出文件（format=${String(parsed.format)}）` };
  if (parsed.version !== EXPORT_VERSION)
    return { error: `导出格式版本不支持：${String(parsed.version)}（本插件支持 ${EXPORT_VERSION}）` };
  if (!Array.isArray(parsed.plugins)) return { error: "缺少 plugins 数组" };
  for (const plugin of parsed.plugins) {
    if (!plugin || typeof plugin.name !== "string" || plugin.name === "")
      return { error: "plugins 里有条目缺少 name" };
    if (typeof plugin.spec !== "string") return { error: `插件 ${plugin.name} 缺少 spec` };
    if (typeof plugin.kind !== "string") return { error: `插件 ${plugin.name} 缺少 kind` };
  }
  return { bundle: parsed as ExportBundle };
}

export type ImportAction = "install" | "enable" | "disable" | "entries" | "skip" | "blocked";

export interface ImportStep {
  name: string;
  action: ImportAction;
  /** 真正交给宿主的安装地址（install 时才有）。 */
  spec?: string;
  enabled?: boolean;
  entries?: { entryId: string; enabled: boolean }[];
  /** 为什么跳过 / 阻塞。 */
  reason?: string;
  /** 导出里记录的形态，供界面显示。 */
  kind?: string;
}

export interface ImportPlan {
  source: string;
  exportProfile?: string;
  exportedAt?: number;
  steps: ImportStep[];
  /** 本插件自己的设置里，与当前不同的字段。 */
  settings: { changed: string[] };
  /** 需要人工粘贴的配置行数。 */
  configRows: number;
  unattributedRows: number;
  omissions: { path: string; reason: string }[];
  warnings: string[];
}

export interface PlanInput {
  source: string;
  bundle: ExportBundle;
  profileName: string;
  profileDir: string;
  installed: InstalledPlugin[];
  settings: CenterSettingsFile;
  entries?: HostEntry[];
  /** 该路径在本机是否存在（本地路径/压缩包形态的可安装性判断）。 */
  exists?: (path: string) => boolean;
}

/** 预检：算出「将安装 / 将启用 / 将停用 / 条目开关 / 已一致 / 无法处理」。 */
export function planImport(input: PlanInput): ImportPlan {
  const exists = input.exists ?? existsSyncSafe;
  const byName = new Map(input.installed.map((plugin) => [plugin.name, plugin]));
  const entryByName = new Map<string, HostEntry[]>();
  for (const entry of input.entries ?? []) {
    const owner = [...byName.keys()].find((name) => isEntryOf(entry.moduleName, name));
    if (owner === undefined) continue;
    const list = entryByName.get(owner) ?? [];
    list.push(entry);
    entryByName.set(owner, list);
  }
  const steps: ImportStep[] = [];
  for (const exported of input.bundle.plugins) {
    const current = byName.get(exported.name);
    const kind = exported.kind;
    if (current === undefined) {
      const address = installAddressFor(exported, input.profileDir, exists);
      if (address.blocked !== undefined) {
        steps.push({ name: exported.name, action: "blocked", kind, reason: address.blocked });
        continue;
      }
      steps.push({
        name: exported.name,
        action: "install",
        spec: address.spec!,
        enabled: exported.enabled !== false,
        kind,
      });
      continue;
    }
    const wantEnabled = exported.enabled !== false;
    if (wantEnabled !== current.selected) {
      steps.push({ name: exported.name, action: wantEnabled ? "enable" : "disable", kind });
      continue;
    }
    const wanted = (exported.entries ?? []).filter((entry) => entry.enabled !== undefined);
    const live = entryByName.get(exported.name) ?? [];
    const changes =
      input.entries === undefined
        ? []
        : wanted
            .map((entry) => {
              const actual = live.find((row) => row.entryId === entry.entryId);
              if (actual === undefined || actual.readOnlyReason !== undefined) return undefined;
              return actual.enabled === entry.enabled
                ? undefined
                : { entryId: entry.entryId, enabled: entry.enabled };
            })
            .filter((row): row is { entryId: string; enabled: boolean } => row !== undefined);
    if (changes.length > 0) {
      steps.push({ name: exported.name, action: "entries", entries: changes, kind });
      continue;
    }
    steps.push({
      name: exported.name,
      action: "skip",
      kind,
      reason:
        input.entries === undefined
          ? "依赖与启用状态已一致（宿主服务不可用，未比对条目开关）"
          : "依赖、启用状态与条目开关都已一致",
    });
  }
  const changed: string[] = [];
  const exportedSettings = input.bundle.settings;
  if (exportedSettings !== undefined)
    for (const [key, value] of Object.entries(exportedSettings))
      if (JSON.stringify(input.settings?.[key as keyof CenterSettingsFile]) !== JSON.stringify(value))
        changed.push(key);
  const warnings = [...(input.bundle.warnings ?? [])];
  if (input.bundle.profile !== undefined && input.bundle.profile !== input.profileName)
    warnings.push(
      `导出文件来自 profile「${input.bundle.profile}」，本机是「${input.profileName}」：本地路径形态可能对不上`,
    );
  return {
    source: input.source,
    ...(input.bundle.profile === undefined ? {} : { exportProfile: input.bundle.profile }),
    ...(input.bundle.exportedAt === undefined ? {} : { exportedAt: input.bundle.exportedAt }),
    steps,
    settings: { changed },
    configRows: input.bundle.plugins.reduce((sum, plugin) => sum + (plugin.config?.length ?? 0), 0),
    unattributedRows: input.bundle.profilePatch?.unattributed?.length ?? 0,
    omissions: input.bundle.omissions ?? [],
    warnings,
  };
}

/**
 * 需要人工粘贴的补丁片段（YAML）。
 *
 * 宿主只提供 `setPluginEnabled`（写 `disabled`），没有写任意 `config` 的接口，本项目也
 * 不允许手工改 profile 的补丁文件 —— 所以带 `config` 的行只能给用户自己粘。
 */
export function patchSnippet(bundle: ExportBundle, profileName: string): string | undefined {
  const rows: ExportedConfigRow[] = [];
  for (const plugin of bundle.plugins)
    for (const row of plugin.config ?? [])
      if (row.config !== undefined || row.disabled !== undefined) rows.push(row);
  if (rows.length === 0) return undefined;
  const header = [
    `# 插件港湾导出（${bundle.exportedAt ? new Date(bundle.exportedAt).toLocaleString("zh-CN", { hour12: false }) : "未知时间"} · profile ${bundle.profile ?? "?"}）`,
    `# 这些行带 config，宿主的 pluginManager 没有写 config 的接口，需要你确认后自行粘贴到`,
    `# ~/.dsh/profiles/${profileName}/cordis.patch.yml（profile 补丁是 YAML 序列，字段按 id 生效）`,
    "# 粘贴前请核对：本机插件版本/路径可能不同，config 里的地址、密钥等需要按本机环境调整。",
    "",
  ].join("\n");
  return header + rows.map((row) => serializeRow(row)).join("\n") + "\n";
}

/** 补丁行脱敏：`config` 里的凭据同样要替换（导出文件可能被分享/带出机器）。 */
function redactRow(row: PatchRow): { row: ExportedConfigRow; count: number } {
  const config = row.config === undefined ? undefined : redactValue(row.config);
  const count = config?.count ?? 0;
  const out: ExportedConfigRow = {};
  if (row.id !== undefined) out.id = row.id;
  if (row.name !== undefined) out.name = row.name;
  if (row.disabled !== undefined) out.disabled = row.disabled;
  if (config !== undefined) out.config = config.value;
  return { row: out, count };
}

function serializeRow(row: ExportedConfigRow): string {
  const lines: string[] = ["- id: " + JSON.stringify(row.id ?? "")];
  if (row.name !== undefined) lines.push("  name: " + JSON.stringify(row.name));
  if (typeof row.disabled === "boolean") lines.push("  disabled: " + String(row.disabled));
  else if (typeof row.disabled === "string")
    // 原来是 `!!js` 表达式：照原样写成 js 标签，别退化成普通字符串/布尔
    lines.push("  disabled: !!js " + JSON.stringify(row.disabled));
  if (row.config !== undefined)
    lines.push(
      "  config:",
      ...JSON.stringify(row.config, null, 2)
        .split("\n")
        .map((line) => "    " + line),
    );
  return lines.join("\n");
}

// ---------- 内部：安装地址 ----------

/**
 * 导入时要装的地址。
 *
 *  - registry：优先按导出的**确切版本**装（导出的意义就是还原那一套），拿不到才退回记录的取值；
 *  - git / https 压缩包：原样（git 会解析到分支头，和本项目的更新口径一致）；
 *  - 本地路径 / link：**必须在目标机器上真实存在**，否则报阻塞 —— 让 pnpm 去猜一个别的
 *    机器上的路径只会得到一句看不懂的报错。
 */
export function installAddressFor(
  exported: ExportedPlugin,
  profileDir: string,
  exists: (path: string) => boolean = existsSyncSafe,
): { spec?: string; blocked?: string } {
  const source = {
    name: exported.name,
    spec: exported.spec,
    kind: exported.kind,
    ...(exported.packageName === undefined ? {} : { packageName: exported.packageName }),
  };
  if (exported.kind === "registry") {
    const version = exported.version;
    return {
      spec: installSpecFor(
        source,
        profileDir,
        version === undefined || version === "" ? undefined : version,
      ),
    };
  }
  if (exported.kind === "git") return { spec: installSpecFor(source, profileDir) };
  if (exported.kind === "tarball") {
    const spec = installSpecFor(source, profileDir);
    if (/^https?:\/\//i.test(spec)) return { spec };
    const path = localPathOf(spec);
    if (path === undefined) return { spec };
    return exists(path)
      ? { spec }
      : {
          blocked: `导出记录的是本机压缩包（${path}），目标机器上没有这个文件：先把包放过去，或改用 registry / git 地址`,
        };
  }
  const spec = installSpecFor(source, profileDir);
  const path = localPathOf(spec);
  if (path === undefined) return { spec };
  return exists(path)
    ? { spec }
    : {
        blocked: `导出记录的是本机路径形态（${path}），目标机器上没有这个路径：先把包放到该位置，或改用 registry / git 地址`,
      };
}

function localPathOf(spec: string): string | undefined {
  const local = /^(?:file|link):(.+)$/s.exec(spec);
  if (local) return local[1]!.replace(/^~(?=$|[\\/])/, () => homedir());
  if (/^[A-Za-z]:[\\/]/.test(spec) || spec.startsWith("/") || spec.startsWith("./") || spec.startsWith("../"))
    return spec;
  return undefined;
}

function existsSyncSafe(path: string): boolean {
  try {
    return statSync(path).isDirectory() || statSync(path).isFile();
  } catch {
    return false;
  }
}

// ---------- 内部：补丁行与归属 ----------

interface PatchRow extends ExportedConfigRow {
  insert?: unknown;
}

/** 读 profile 补丁里的行（只读；`!!js` 标签按字符串收下，不求值）。 */
function readProfilePatch(profileDir: string): { rows: PatchRow[]; error?: string } {
  let text: string;
  try {
    text = readFileSync(join(profileDir, "cordis.patch.yml"), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { rows: [] };
    return { rows: [], error: error instanceof Error ? error.message : String(error) };
  }
  let document: unknown;
  try {
    document = parseYaml(text, {
      customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value: string) => value }],
    });
  } catch (error) {
    return { rows: [], error: error instanceof Error ? error.message : String(error) };
  }
  if (!Array.isArray(document)) return { rows: [], error: "profile 补丁不是 YAML 序列" };
  const rows: PatchRow[] = [];
  for (const item of document) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (Array.isArray(row.insert)) {
      for (const inner of row.insert) {
        if (!inner || typeof inner !== "object") continue;
        rows.push(normalizeRow(inner as Record<string, unknown>));
      }
      continue;
    }
    rows.push(normalizeRow(row));
  }
  return { rows };
}

function normalizeRow(row: Record<string, unknown>): PatchRow {
  const out: PatchRow = {};
  if (typeof row.id === "string") out.id = row.id;
  if (typeof row.name === "string") out.name = row.name;
  if (typeof row.disabled === "boolean") out.disabled = row.disabled;
  // `!!js` 之类的表达式按字符串收下：转成布尔会改变语义（`!!js "ctx.get(...)"` 是求值时机问题）
  else if (typeof row.disabled === "string") out.disabled = row.disabled;
  if (row.config !== undefined) out.config = row.config;
  if (row.insert !== undefined) out.insert = row.insert;
  return out;
}

/** 插件自己声明的条目 id（读它自己的补丁文件；读不到就返回空集）。 */
export function declaredRowIds(profileDir: string, name: string): string[] {
  const dir = pluginDirOf(profileDir, name);
  if (dir === undefined) return [];
  let patchPath: string | undefined;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const declared = pkg?.dsh?.bundle?.patch;
    if (typeof declared === "string") patchPath = resolve(dir, declared);
  } catch {
    return [];
  }
  if (patchPath === undefined) return [];
  let text: string;
  try {
    text = readFileSync(patchPath, "utf8");
  } catch {
    return [];
  }
  const ids: string[] = [];
  try {
    const document = parseYaml(text, {
      customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value: string) => value }],
    });
    if (Array.isArray(document))
      for (const item of document) {
        if (!item || typeof item !== "object") continue;
        const row = item as Record<string, unknown>;
        const list = Array.isArray(row.insert) ? row.insert : [row];
        for (const inner of list)
          if (inner && typeof inner === "object" && typeof (inner as any).id === "string")
            ids.push((inner as any).id);
      }
  } catch {
    return [];
  }
  return [...new Set(ids)];
}

function pluginDirOf(profileDir: string, name: string): string | undefined {
  const dir = join(profileDir, "node_modules", name);
  try {
    statSync(dir);
    return dir;
  } catch {
    return undefined;
  }
}

/** 一行补丁是否属于这个插件：按声明的行 id，或按行里的 `name` 指向该包。 */
function belongsTo(row: PatchRow, name: string, rowIds: string[]): boolean {
  if (row.id !== undefined && rowIds.includes(row.id)) return true;
  if (row.name === name) return true;
  if (row.name !== undefined && row.name.startsWith(name + "/")) return true;
  return false;
}

/** 宿主条目是否属于这个插件（模块名就是包名，或是它的子路径）。 */
export function isEntryOf(moduleName: string, name: string): boolean {
  if (moduleName === name) return true;
  return moduleName.startsWith(name + "/");
}

// ---------- 内部：插件自己的设置文件 ----------

interface ScanResult {
  files: ExportedFile[];
  omissions: { path: string; reason: string }[];
  redactions: number;
}

/**
 * 一个插件的数据目录候选名。
 *
 * ⚠️ 真实 profile 上踩到的坑：`dsh-channel-hub` 的数据目录叫 `channel-hub`（= 它的**条目 id**），
 * 既不是包名也不是包名的尾段。条目 id 在宿主可用时来自 `listPlugins()`，宿主不可用时可以从
 * 插件**自己**的补丁文件里读出来（`declaredRowIds`）—— 所以这里两个来源都要用，否则离线导出
 * （例如本插件的维护脚本）会把真实数据目录误判成「认不出归属」而全部略过。
 */
function dataDirCandidates(
  profileDir: string,
  plugin: InstalledPlugin,
  entries: HostEntry[],
): string[] {
  return [
    ...new Set([
      plugin.name,
      plugin.name.split("/").pop() ?? plugin.name,
      ...declaredRowIds(profileDir, plugin.name),
      ...entries.map((entry) => entry.entryId.replace(/^include:/, "")),
    ]),
  ];
}

function collectDataFiles(
  profileDir: string,
  plugin: InstalledPlugin,
  entries: HostEntry[],
  selfDirName?: string,
): ScanResult {
  const result: ScanResult = { files: [], omissions: [], redactions: 0 };
  for (const candidate of dataDirCandidates(profileDir, plugin, entries)) {
    const dir = join(profileDir, candidate);
    if (selfDirName !== undefined && candidate === selfDirName) {
      result.omissions.push({ path: candidate, reason: "本插件自己的数据目录（设置已单独导出）" });
      continue;
    }
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    let total = 0;
    walk(dir, candidate, 0, (rel, absolute, size) => {
      const name = basename(absolute);
      if (EXCLUDED_FILE.test(name)) {
        result.omissions.push({ path: rel, reason: "数据库/日志/锁/压缩包，不导出" });
        return;
      }
      if (!TEXT_EXTENSIONS.has(extname(name).toLowerCase())) {
        result.omissions.push({ path: rel, reason: "非文本扩展名，不导出" });
        return;
      }
      if (size > MAX_FILE_BYTES) {
        result.omissions.push({ path: rel, reason: `超过 ${Math.round(MAX_FILE_BYTES / 1024)}KB，不导出` });
        return;
      }
      if (total + size > MAX_TOTAL_BYTES) {
        result.omissions.push({ path: rel, reason: "超出本次导出的总体积上限，不导出" });
        return;
      }
      let text: string;
      try {
        const raw = readFileSync(absolute);
        if (raw.includes(0)) {
          result.omissions.push({ path: rel, reason: "二进制内容，不导出" });
          return;
        }
        text = raw.toString("utf8");
      } catch (error) {
        result.omissions.push({
          path: rel,
          reason: "读取失败：" + (error instanceof Error ? error.message : String(error)),
        });
        return;
      }
      const redacted = redactText(text);
      if (redacted.count > 0) result.redactions += redacted.count;
      total += size;
      result.files.push({ path: rel, bytes: size, content: redacted.text });
    });
  }
  return result;
}

function walk(
  dir: string,
  prefix: string,
  depth: number,
  visit: (rel: string, absolute: string, size: number) => void,
): void {
  if (depth > MAX_DEPTH) return;
  let items: string[];
  try {
    items = readdirSync(dir);
  } catch {
    return;
  }
  for (const item of items.sort()) {
    const absolute = join(dir, item);
    const rel = prefix + "/" + item;
    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      if (EXCLUDED_DIRS.has(item.toLowerCase())) continue;
      walk(absolute, rel, depth + 1, visit);
      continue;
    }
    if (!stats.isFile()) continue;
    visit(rel, absolute, stats.size);
  }
}

// ---------- 内部：脱敏 ----------

/** 递归脱敏：键名像凭据就整值替换，取值像凭据就替换那一段。 */
export function redactValue(value: unknown, key = ""): { value: unknown; count: number } {
  if (typeof value === "string") {
    const redacted = redactText(value);
    if (normalizeKey(key) !== "" && SECRET_KEY.test(normalizeKey(key)))
      return { value: REDACTED, count: Math.max(1, redacted.count) };
    return { value: redacted.text, count: redacted.count };
  }
  if (Array.isArray(value)) {
    let count = 0;
    const out = value.map((item) => {
      const nested = redactValue(item, key);
      count += nested.count;
      return nested.value;
    });
    return { value: out, count };
  }
  if (value && typeof value === "object") {
    let count = 0;
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      const nested = redactValue(childValue, childKey);
      count += nested.count;
      out[childKey] = nested.value;
    }
    return { value: out, count };
  }
  return { value, count: 0 };
}

/** 文本里的凭据形态替换。 */
export function redactText(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const pattern of SECRET_VALUE) {
    out = out.replace(new RegExp(pattern.source, "gi"), () => {
      count += 1;
      return REDACTED;
    });
  }
  return { text: out, count };
}

function redactSettings(settings: CenterSettingsFile): CenterSettingsFile {
  const { value } = redactValue(settings);
  return value as CenterSettingsFile;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * 认得出归属的 profile 顶层目录名（导出用它判断「哪些目录没被导出」）。
 *
 * 与 `collectDataFiles` 共用同一套候选名：两处各写一套的话迟早会漂（本轮实测：
 * 维护脚本少算了「插件自己声明的行 id」，于是把已经导出的 `channel-hub` 又列成
 * 「认不出归属」）。
 */
export function ownedDataDirNames(
  profileDir: string,
  plugins: InstalledPlugin[],
  entries: HostEntry[] = [],
  selfDirName?: string,
): Set<string> {
  const owned = new Set<string>();
  for (const plugin of plugins)
    for (const name of dataDirCandidates(profileDir, plugin, entries)) owned.add(name);
  if (selfDirName !== undefined) owned.add(selfDirName);
  return owned;
}

/** profile 下那些认不出归属的顶层目录（如实列出，不硬塞给某个插件）。 */
export function unownedProfileDirs(profileDir: string, owned: Set<string>): string[] {
  let items: string[];
  try {
    items = readdirSync(profileDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const item of items.sort()) {
    if (owned.has(item)) continue;
    if (item.startsWith(".")) continue;
    if (["node_modules", "cache", "logs"].includes(item.toLowerCase())) continue;
    try {
      if (!statSync(join(profileDir, item)).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push(item);
  }
  return out;
}