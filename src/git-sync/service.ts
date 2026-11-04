import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, isAbsolute } from "node:path";
import {
  readExport,
  installAddressFor,
  isLocalExport,
  type ExportBundle,
} from "../core/transfer.ts";
import { validateSpec } from "../ops/validate.ts";

export const BRANCH = "harbor-sync";
const LIMIT = 8 * 1024 * 1024;
export interface SyncConfig {
  remote: string;
  environment: string;
}
export const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export function validateConfig(raw: any): SyncConfig {
  const { remote, environment } = raw ?? {};
  if (
    typeof remote !== "string" ||
    remote.length > 2048 ||
    /[\s\x00-\x1f\x7f]/.test(remote)
  )
    throw Error("仓库地址不合法");
  let allowed = isAbsolute(remote);
  if (/^(https|ssh):\/\//.test(remote)) {
    try {
      const u = new URL(remote);
      allowed =
        !u.password &&
        !u.search &&
        !u.hash &&
        !!u.hostname &&
        (u.protocol === "ssh:" || !u.username);
    } catch {
      allowed = false;
    }
  } else if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:[a-zA-Z0-9/_.-]+$/.test(remote))
    allowed = true;
  if (!allowed || remote.startsWith("-"))
    throw Error(
      "仅支持无凭据的 HTTPS、SSH 或本机绝对路径；请使用系统 Git 认证",
    );
  if (
    typeof environment !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(environment)
  )
    throw Error(
      "环境名须为 1–64 位字母、数字、下划线或连字符，首位为字母或数字",
    );
  return { remote, environment };
}
/** Git 同步忽略源机器路径，也保护目标机器同名开发插件；不生成其配置片段。 */
export function portableBundle(
  bundle: ExportBundle,
  installed: { name: string; kind: string; spec: string }[] = [],
): ExportBundle {
  const copy = structuredClone(bundle);
  const protectedNames = new Set(
    installed.filter((p) => isLocalExport(p as any)).map((p) => p.name),
  );
  const excluded = copy.plugins.filter(
    (p) => isLocalExport(p) || protectedNames.has(p.name),
  );
  const names = new Set(excluded.map((p) => p.name));
  const ids = new Set(
    excluded.flatMap((p) => [
      ...(p.config ?? []).flatMap((r) => (r.id ? [r.id] : [])),
      ...(p.entries ?? []).map((e) => e.entryId),
    ]),
  );
  const rows = new Set(
    excluded.flatMap((p) => (p.config ?? []).map((r) => JSON.stringify(r))),
  );
  copy.plugins = copy.plugins.filter((p) => !names.has(p.name));
  for (const p of excluded)
    copy.omissions.push({
      path: `plugins/${p.name}`,
      reason: protectedNames.has(p.name)
        ? "目标机器同名插件为本地开发版本：忽略远端安装、启停及配置，保留本机路径"
        : "本地路径/本地压缩包不参与 Git 同步：忽略安装、启停和配置，不发布源码或路径",
    });
  if (copy.profilePatch) {
    copy.profilePatch.attributed = copy.profilePatch.attributed.filter(
      (id) => !ids.has(id),
    );
    copy.profilePatch.unattributed = copy.profilePatch.unattributed.filter(
      (r) =>
        !ids.has(r.id ?? "") &&
        !rows.has(JSON.stringify(r)) &&
        ![...names].some(
          (name) => r.name === name || r.name?.startsWith(name + "/"),
        ),
    );
  }
  delete copy.settings;
  return copy;
}

/** 开发机发布时，保留共享快照中同名的远端安装记录，不以本地路径替换或删除。 */
export function publicationBundle(
  local: ExportBundle,
  remote: ExportBundle | undefined,
  installed: { name: string; kind: string; spec: string }[],
): ExportBundle {
  const copy = portableBundle(local);
  if (!remote) return copy;
  const protectedNames = new Set(
    installed.filter((p) => isLocalExport(p as any)).map((p) => p.name),
  );
  for (const plugin of portableBundle(remote).plugins) {
    if (!protectedNames.has(plugin.name)) continue;
    copy.plugins = copy.plugins.filter((p) => p.name !== plugin.name);
    copy.plugins.push(plugin);
    copy.omissions.push({
      path: `plugins/${plugin.name}/local`,
      reason: "本机本地开发版本已忽略；发布时保留远端原有的安装与配置记录",
    });
  }
  return copy;
}

export function snapshot(bundle: ExportBundle): string {
  const copy = structuredClone(bundle);
  copy.exportedAt = 0;
  copy.plugins.sort((a, b) => a.name.localeCompare(b.name, "en"));
  const order = (v: any): any =>
    Array.isArray(v)
      ? v.map(order)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, order(v[k])]),
          )
        : v;
  return JSON.stringify(order(copy), null, 2) + "\n";
}
export function parseSnapshot(text: string): ExportBundle {
  if (Buffer.byteLength(text) > LIMIT) throw Error("快照超过 8MB");
  const parsed = readExport(text);
  if (!parsed.bundle) throw Error(`快照格式错误：${parsed.error}`);
  const b = parsed.bundle;
  if (
    !Array.isArray(b.omissions) ||
    !b.omissions.every(
      (x) => x && typeof x.path === "string" && typeof x.reason === "string",
    ) ||
    !Array.isArray(b.warnings) ||
    !b.warnings.every((x) => typeof x === "string")
  )
    throw Error("快照字段不合法");
  const names = new Set<string>();
  for (const p of b.plugins) {
    if (
      names.has(p.name) ||
      typeof p.enabled !== "boolean" ||
      !["registry", "git", "tarball", "path", "unknown"].includes(p.kind)
    )
      throw Error("快照插件字段不合法或重复");
    names.add(p.name);
    for (const value of [p.spec, p.repo, p.packageName]) {
      if (
        value !== undefined &&
        (typeof value !== "string" ||
          /(?:https?:\/\/)[^/]*@|[?&](?:token|key|secret|password)=/i.test(
            value,
          ))
      )
        throw Error("安装来源含凭据或字段不合法，请先改为无凭据地址");
    }
    if (p.version !== undefined && typeof p.version !== "string")
      throw Error("版本字段不合法");
    const address = installAddressFor(p, "", () => false);
    if (address.spec && !validateSpec(address.spec).ok)
      throw Error("快照包含不合法的安装地址");
    if (
      p.entries !== undefined &&
      (!Array.isArray(p.entries) ||
        !p.entries.every(
          (e) =>
            e &&
            typeof e.entryId === "string" &&
            typeof e.moduleName === "string" &&
            typeof e.enabled === "boolean",
        ))
    )
      throw Error("快照条目不合法");
    if (
      p.config !== undefined &&
      (!Array.isArray(p.config) ||
        !p.config.every((x) => x && typeof x === "object"))
    )
      throw Error("快照配置不合法");
  }
  if (
    b.profilePatch !== undefined &&
    (!b.profilePatch || !Array.isArray(b.profilePatch.unattributed))
  )
    throw Error("快照补丁不合法");
  return b;
}

/** 独立 bare mirror，无 checkout，无仓库脚本/钩子；错误不返回 Git 原始认证输出。 */
export class GitSync {
  private busy = false;
  private abort?: AbortController;
  constructor(private root: string) {}
  config(): SyncConfig | null {
    try {
      return validateConfig(
        JSON.parse(readFileSync(join(this.root, "config.json"), "utf8")),
      );
    } catch (e: any) {
      if (e.code === "ENOENT") return null;
      throw Error("Git 同步设置损坏，请重新保存");
    }
  }
  configure(raw: unknown) {
    if (this.busy) throw Error("同步操作正在运行");
    const config = validateConfig(raw);
    mkdirSync(this.root, { recursive: true });
    writeFileSync(join(this.root, "config.tmp"), JSON.stringify(config));
    renameSync(join(this.root, "config.tmp"), join(this.root, "config.json"));
    return config;
  }
  cancel() {
    this.abort?.abort();
    return { cancelled: !!this.abort };
  }
  async locked<T>(run: () => Promise<T>): Promise<T> {
    if (this.busy) throw Error("同步操作正在运行");
    this.busy = true;
    this.abort = new AbortController();
    try {
      return await run();
    } finally {
      this.busy = false;
      this.abort = undefined;
    }
  }
  private async git(
    args: string[],
    cwd: string,
    input?: string,
    env: NodeJS.ProcessEnv = {},
  ): Promise<string> {
    return await new Promise((resolve, reject) => {
      const inherited = { ...process.env };
      for (const key of Object.keys(inherited))
        if (
          /^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*)$/i.test(
            key,
          )
        )
          delete inherited[key];
      const child = spawn(
        "git",
        ["-c", "core.hooksPath=", "-c", "protocol.ext.allow=never", ...args],
        {
          cwd,
          shell: false,
          windowsHide: true,
          env: {
            ...inherited,
            GIT_TERMINAL_PROMPT: "0",
            GCM_INTERACTIVE: "never",
            ...env,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let output = "";
      let bytes = 0;
      let failure = "";
      const stop = () => {
        failure = "Git 操作已取消";
        child.kill();
      };
      const timer = setTimeout(() => {
        failure = "Git 操作超时";
        child.kill();
      }, 30_000);
      this.abort?.signal.addEventListener("abort", stop, { once: true });
      if (this.abort?.signal.aborted) stop();
      const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > LIMIT) {
          failure = "Git 输出超过限制";
          child.kill();
        } else chunks.push(chunk);
      });
      child.stderr.resume();
      const cleanup = () => {
        clearTimeout(timer);
        this.abort?.signal.removeEventListener("abort", stop);
      };
      child.on("error", () => {
        cleanup();
        reject(Error("无法运行 Git，请检查 Git 安装"));
      });
      child.on("close", (code) => {
        cleanup();
        output = Buffer.concat(chunks).toString("utf8");
        code === 0 && !failure
          ? resolve(output.trimEnd())
          : reject(
              Error(
                failure ||
                  "Git 操作失败：请检查权限、系统认证、网络或远端是否已变化",
              ),
            );
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
  }
  private async repo(config: SyncConfig) {
    const dir = join(this.root, digest(config.remote));
    mkdirSync(dir, { recursive: true });
    await this.git(["init", "--bare", "."], dir);
    return dir;
  }
  private async head(config: SyncConfig, dir: string): Promise<string | null> {
    const out = await this.git(
      ["ls-remote", "--refs", config.remote, `refs/heads/${BRANCH}`],
      dir,
    );
    if (!out) return null;
    if (!/^[a-f0-9]{40,64}\s/.test(out)) throw Error("远端 commit 不合法");
    await this.git(
      ["fetch", "--no-tags", config.remote, `refs/heads/${BRANCH}`],
      dir,
    );
    return await this.git(["rev-parse", "FETCH_HEAD"], dir);
  }
  private path(c: SyncConfig) {
    return `harbor/environments/${c.environment}/snapshot.json`;
  }
  async inspect() {
    const c = this.config();
    if (!c) throw Error("请先保存同步仓库");
    const dir = await this.repo(c);
    const commit = await this.head(c, dir);
    if (!commit) return { commit: null, text: null, history: [] as string[] };
    const path = this.path(c);
    const entry = await this.git(["ls-tree", commit, "--", path], dir);
    let text: string | null = null;
    if (entry) {
      if (!entry.startsWith("100644 blob "))
        throw Error("远端快照必须是普通文件");
      text = await this.git(["show", `${commit}:${path}`], dir);
      parseSnapshot(text);
    }
    const history = (
      await this.git(["log", "-10", "--format=%h %aI", commit, "--", path], dir)
    )
      .split("\n")
      .filter(Boolean);
    return { commit, text, history };
  }
  async publish(text: string, expected: string | null) {
    parseSnapshot(text);
    const c = this.config();
    if (!c) throw Error("请先保存同步仓库");
    const dir = await this.repo(c);
    const head = await this.head(c, dir);
    if (head !== expected) throw Error("远端已变化，请重新检查并确认发布");
    const index = join(dir, `index-${randomUUID()}`);
    const env = {
      GIT_INDEX_FILE: index,
      GIT_AUTHOR_NAME: "Plugin Harbor",
      GIT_AUTHOR_EMAIL: "harbor@localhost",
      GIT_COMMITTER_NAME: "Plugin Harbor",
      GIT_COMMITTER_EMAIL: "harbor@localhost",
    };
    try {
      await this.git(
        head ? ["read-tree", head] : ["read-tree", "--empty"],
        dir,
        undefined,
        env,
      );
      const blob = await this.git(["hash-object", "-w", "--stdin"], dir, text);
      await this.git(
        [
          "update-index",
          "--add",
          "--cacheinfo",
          `100644,${blob},${this.path(c)}`,
        ],
        dir,
        undefined,
        env,
      );
      const tree = await this.git(["write-tree"], dir, undefined, env);
      if (
        head &&
        tree === (await this.git(["rev-parse", `${head}^{tree}`], dir))
      )
        return { commit: head, unchanged: true };
      const commit = await this.git(
        [
          "commit-tree",
          tree,
          ...(head ? ["-p", head] : []),
          "-m",
          `Harbor snapshot: ${c.environment}`,
        ],
        dir,
        undefined,
        env,
      );
      await this.git(["push", c.remote, `${commit}:refs/heads/${BRANCH}`], dir);
      return { commit, unchanged: false };
    } finally {
      rmSync(index, { force: true });
    }
  }
}
