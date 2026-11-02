/**
 * 已装插件的事实采集（只读）。
 *
 * 三个来源交叉验证，任何一个读不到都只留空、不猜：
 *  1. profile 的 `package.json` —— 依赖名与声明的 spec（含 bundle 选中列表）；
 *  2. `node_modules/<name>/package.json` —— 真实版本与 `repository` 反查的仓库身份；
 *  3. `pnpm-lock.yaml` —— git 形态的**解析后 commit**（`resolution.tarball` 里的
 *     `/tar.gz/<sha>`）与 registry 形态的 integrity。
 *
 * ⚠️ 为什么必须读 lockfile：`node_modules` 里的 git 安装副本**不含任何 git 元数据**
 * （pnpm 对 git 依赖按 package.json 的 `files` 做 pack，实测 9 个文件里没有
 * `.git`、也没有 `gitHead`），commit 只存在于 lockfile 与 `.modules.yaml`。
 *
 * ⚠️ 这里只读文件，绝不写；也绝不触发安装。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { InstalledPlugin } from "./types.ts";

/** 宿主自带的包不是「第三方插件」，界面上也不该出现。 */
const HOST_SCOPE = "@deepseek-ai/";

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** 从各种仓库写法里取 `owner/repo`：`git+https://…`、`github:o/r`、`…/r.git`。 */
export function githubRepoOf(url: unknown): string | undefined {
  if (typeof url === "string") {
    const text = url.trim();
    const long = /github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i.exec(text);
    if (long) return `${long[1]}/${long[2]!.replace(/\.git$/, "")}`;
    const short = /^github:([^/\s]+)\/([^/\s#?]+)$/i.exec(text);
    if (short) return `${short[1]}/${short[2]!.replace(/\.git$/, "")}`;
  }
  if (url && typeof url === "object") {
    const record = url as Record<string, unknown>;
    return githubRepoOf(record.url ?? record.directory ?? undefined);
  }
  return undefined;
}

/** 声明 spec 的形态；判定依据是 spec 本身，不看安装结果。 */
export function classifySpec(spec: string): InstalledPlugin["kind"] {
  const text = spec.trim();
  if (text === "") return "unknown";
  if (/^(github:|git\+|git:)/i.test(text)) return "git";
  if (/^https?:\/\//i.test(text)) return /\.git(#|$)/i.test(text) ? "git" : "tarball";
  if (/\.git(#|$)/i.test(text)) return "git";
  if (/^(file:|link:|\.{1,2}[\\/]|[A-Za-z]:[\\/])/i.test(text)) {
    return /\.tgz$/i.test(text) ? "tarball" : "path";
  }
  if (/\.tgz$/i.test(text)) return "tarball";
  return "registry";
}

interface LockfileEntry {
  specifier?: string;
  version?: string;
}

interface LockfilePackage {
  resolution?: { integrity?: string; tarball?: string; gitHosted?: boolean };
  version?: string;
}

interface Lockfile {
  importers?: Record<
    string,
    { dependencies?: Record<string, LockfileEntry> } | undefined
  >;
  packages?: Record<string, LockfilePackage>;
}

function readLockfile(profileDir: string): Lockfile | undefined {
  const path = join(profileDir, "pnpm-lock.yaml");
  if (!existsSync(path)) return undefined;
  try {
    return parseYaml(readFileSync(path, "utf8")) as Lockfile;
  } catch {
    return undefined;
  }
}

/**
 * 在 `packages:` 里找一条记录。
 *
 * ⚠️ 键与 importer 的 `version` **不一定逐字相同**：pnpm 会在 importer 的值上带
 * peer 后缀（实测 `1.9.28(@deepseek-ai/schemastery@3.18.5)`），而 `packages:` 的键
 * 不带。这里先剥掉尾部 `(…)` 再逐字匹配，最后才退化到前缀匹配。
 */
function findPackage(
  lockfile: Lockfile | undefined,
  name: string,
  resolved: string | undefined,
): LockfilePackage | undefined {
  if (!lockfile?.packages || resolved === undefined) return undefined;
  const exact = lockfile.packages[`${name}@${resolved}`];
  if (exact) return exact;
  const core = resolved.replace(/\([^()]*\)\s*$/, "");
  const stripped = lockfile.packages[`${name}@${core}`];
  if (stripped) return stripped;
  const prefix = `${name}@`;
  for (const [key, value] of Object.entries(lockfile.packages))
    if (key.startsWith(prefix) && (key.includes(core) || core.includes(key.slice(prefix.length))))
      return value;
  return undefined;
}

/** git 解析结果的 commit：`…/tar.gz/<sha>` 里的 sha。 */
export function commitOfTarball(tarball: unknown): string | undefined {
  if (typeof tarball !== "string") return undefined;
  const match = /\/tar\.gz\/([0-9a-f]{7,40})/i.exec(tarball);
  return match ? match[1]!.toLowerCase() : undefined;
}

/**
 * 读出一个 profile 里已装的第三方插件。
 *
 * 口径：`dependencies` 里非 `@deepseek-ai/*` 的项就是候选；`version` 缺失、
 * `repository` 读不到、lockfile 没有对应记录，都只是留空（`undefined`），
 * 由更新判据标成 `unknown`，**不补默认值**。
 */
export function readInstalledPlugins(profileDir: string): InstalledPlugin[] {
  const manifest = readJson(join(profileDir, "package.json"));
  if (!manifest || typeof manifest !== "object") return [];
  const dependencies: Record<string, unknown> =
    manifest.dependencies && typeof manifest.dependencies === "object"
      ? manifest.dependencies
      : {};
  const bundles: string[] = Array.isArray(manifest.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles.filter(
        (item: unknown): item is string => typeof item === "string",
      )
    : [];
  const lockfile = readLockfile(profileDir);
  const importer = lockfile?.importers?.["."]?.dependencies ?? {};

  const plugins: InstalledPlugin[] = [];
  for (const [name, rawSpec] of Object.entries(dependencies)) {
    if (name.startsWith(HOST_SCOPE)) continue;
    const declared = typeof rawSpec === "string" ? rawSpec : "";
    const entry = importer[name];
    const spec =
      typeof entry?.specifier === "string" && entry.specifier !== ""
        ? entry.specifier
        : declared;
    const resolved =
      typeof entry?.version === "string" && entry.version !== ""
        ? entry.version
        : undefined;
    const kind = classifySpec(spec);
    const pkgDir = join(profileDir, "node_modules", name);
    const pkg = readJson(join(pkgDir, "package.json"));
    const pkgEntry = findPackage(lockfile, name, resolved);
    const tarball =
      pkgEntry?.resolution?.tarball ??
      (kind === "git" ? resolved : undefined);
    const plugin: InstalledPlugin = {
      name,
      spec,
      kind,
      selected: bundles.includes(name),
      present: pkg !== undefined,
      bundle: typeof pkg?.dsh?.bundle?.patch === "string",
      hasClient: pkg?.dsh?.client !== undefined,
    };
    const version = typeof pkg?.version === "string" ? pkg.version : undefined;
    if (version !== undefined) plugin.version = version;
    // 依赖键可能与包自己声明的名字不同（`npm:` 别名）；拼安装地址时需要真实包名。
    if (typeof pkg?.name === "string" && pkg.name !== "") plugin.packageName = pkg.name;
    const repo = githubRepoOf(pkg?.repository) ?? githubRepoOf(spec);
    if (repo !== undefined) plugin.repo = repo;
    const commit = commitOfTarball(tarball);
    if (commit !== undefined) plugin.commit = commit;
    const integrity = pkgEntry?.resolution?.integrity;
    if (typeof integrity === "string" && integrity !== "")
      plugin.integrity = integrity;
    plugins.push(plugin);
  }
  return plugins.sort((a, b) => a.name.localeCompare(b.name));
}