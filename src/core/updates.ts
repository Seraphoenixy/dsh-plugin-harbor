/**
 * 更新判据。
 *
 * 三条硬判据（按安装形态选一条），拿不到就标 `unknown`：
 *   - **registry**：本地版本 vs registry `dist-tags.latest`（版本可比才判定）；
 *   - **git**：lockfile 里的 commit vs 远端 HEAD commit（`git ls-remote --symref`）；
 *   - **path / tarball**：没有远端可比，恒 `null` 并给出说明。
 *
 * ⚠️ 刻意**不用**「目录的 `repoUpdatedAt` 变新了」当判据：它只说明仓库有提交，
 * 不说明已装的那份落后（而且 git 安装本来就钉在 commit 上）。它只作为展示信号。
 *
 * ⚠️ 也刻意不把「详情页的 `version`」当 git 形态的判据：git 装的插件其
 * `package.json` 版本与站点 tag 常常是两套口径（实测 channel-hub 恒为
 * `0.1.0-alpha.1`，站点 tag 是 `v1.1.85` 之类），跨口径比较会造出假结论。
 */
import type { DetailRecord, InstalledPlugin, UpdateCheck } from "./types.ts";
import type { GitFacts } from "../upstream/git.ts";
import type { RegistryFacts } from "../upstream/registry.ts";
import { mapLimited } from "../upstream/fetch.ts";

export interface UpdateDeps {
  /** registry 查询（缺省不查）。 */
  registry?: (name: string) => Promise<RegistryFacts>;
  /** git 远端查询（缺省不查）。 */
  git?: (repo: string) => Promise<GitFacts>;
  /** 按需详情页（仅用于补充展示字段，不参与判定）。 */
  detail?: (repo: string) => Promise<DetailRecord | undefined>;
  now?: () => number;
  concurrency?: number;
}

/**
 * 版本比较（semver 的常用子集）。
 *
 * 返回负数/0/正数；**任一侧解析不了就返回 `undefined`**（调用方必须据此标
 * `unknown`，而不是当 0 处理 —— 那会把「不知道」渲染成「已最新」）。
 */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return undefined;
  for (let i = 0; i < 3; i++) {
    if (left.numbers[i]! !== right.numbers[i]!)
      return left.numbers[i]! < right.numbers[i]! ? -1 : 1;
  }
  // 有预发布 < 无预发布（1.0.0-alpha < 1.0.0）
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;
  const length = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < length; i++) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const lNum = /^\d+$/.test(l);
    const rNum = /^\d+$/.test(r);
    if (lNum && rNum) return Number(l) < Number(r) ? -1 : 1;
    if (lNum !== rNum) return lNum ? -1 : 1; // 数字标识符 < 字母标识符
    return l < r ? -1 : 1;
  }
  return 0;
}

interface ParsedVersion {
  numbers: [number, number, number];
  pre: string[];
}

function parseVersion(value: string): ParsedVersion | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/^[v=]+/i, "");
  if (text === "") return undefined;
  /**
   * ⚠️ 必须先剥掉 build 元数据再按 `-` 拆预发布：`1.0.0+build` 若直接 split('.')，
   * 第三段会变成 `0+build` 而被判成「不可比」（本轮实测踩到）。
   */
  const [core, ...rest] = text.split("+")[0]!.split("-");
  const parts = core!.split(".");
  if (parts.length === 0 || parts.length > 3) return undefined;
  const numbers: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < parts.length; i++) {
    if (!/^\d+$/.test(parts[i]!)) return undefined;
    numbers[i] = Number(parts[i]);
  }
  const pre = rest.length === 0 ? [] : rest.join("-").split(".").filter((item) => item !== "");
  return { numbers, pre };
}

/** 判定单个已装插件。 */
export async function checkPlugin(
  plugin: InstalledPlugin,
  deps: UpdateDeps,
): Promise<UpdateCheck> {
  const checkedAt = (deps.now ?? Date.now)();
  const base: UpdateCheck = {
    name: plugin.name,
    kind: plugin.kind,
    spec: plugin.spec,
    updateAvailable: null,
    checkedAt,
  };
  if (plugin.repo) base.repo = plugin.repo;
  if (plugin.version) base.installedVersion = plugin.version;
  if (plugin.commit) base.installedCommit = plugin.commit;

  if (plugin.kind === "path" || plugin.kind === "tarball" || plugin.kind === "unknown") {
    base.note = "本地路径 / 压缩包安装，没有远端可比";
    return base;
  }

  if (plugin.kind === "git") {
    if (!plugin.repo) {
      base.error = "读不到仓库身份（package.json 无 repository，spec 也不是仓库地址）";
      return base;
    }
    if (!deps.git) {
      base.error = "未配置 git 查询";
      return base;
    }
    const remote = await deps.git(plugin.repo);
    if (remote.error || !remote.commit) {
      base.error = remote.error ?? "远端没有返回 commit";
      return base;
    }
    base.latestCommit = remote.commit;
    base.latestSource = "git";
    if (!plugin.commit) {
      base.error = "lockfile 里没有这条依赖的 commit（无法与远端比较）";
      return base;
    }
    base.updateAvailable = remote.commit !== plugin.commit;
    return base;
  }

  // registry
  if (!deps.registry) {
    base.error = "未配置 registry 查询";
    return base;
  }
  const facts = await deps.registry(plugin.name);
  if (facts.error || !facts.latest) {
    base.error = facts.error ?? "registry 没有返回 latest";
    return base;
  }
  base.latestVersion = facts.latest;
  base.latestSource = "registry";
  if (!plugin.version) {
    base.error = "读不到本地版本（node_modules 里缺这个包？）";
    return base;
  }
  const order = compareVersions(facts.latest, plugin.version);
  if (order === undefined) {
    base.error = `版本不可比：${facts.latest} vs ${plugin.version}`;
    return base;
  }
  base.updateAvailable = order > 0;
  return base;
}

/** 批量判定；带上限并发，单项失败不影响其它项。 */
export async function checkPlugins(
  plugins: InstalledPlugin[],
  deps: UpdateDeps,
): Promise<UpdateCheck[]> {
  return await mapLimited(plugins, deps.concurrency ?? 4, async (plugin) => {
    try {
      return await checkPlugin(plugin, deps);
    } catch (error) {
      return {
        name: plugin.name,
        kind: plugin.kind,
        updateAvailable: null,
        error: error instanceof Error ? error.message : String(error),
        checkedAt: (deps.now ?? Date.now)(),
      } satisfies UpdateCheck;
    }
  });
}