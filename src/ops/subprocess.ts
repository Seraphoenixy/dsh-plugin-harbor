/**
 * `dsh plugin` 子进程兜底通道。
 *
 * 只在宿主 `pluginManager` 服务不可用、或被宿主拒绝（例如 HMR 下不能原地覆盖
 * 已装包）时使用。它自己跑 `dsh plugin --profile <p> add|remove <spec>`，
 * 因此要自己负责：输出捕获与进度估算、超时、取消（含进程树）、失败归类。
 *
 * ⚠️ 取消必须**杀进程树**：pnpm 会派生构建脚本子进程，只杀 `dsh` 本身会在后台
 * 留下 pnpm 树继续改 profile（宿主自己的实现也为同一原因做了进程树终止）。
 */
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 解析「怎么调 dsh」。
 *
 * ⚠️ Windows 上的真实缺陷（本轮实测）：`dsh` 是 **`.cmd` 批处理**，
 * `spawn("dsh", args, { shell: false })` 直接 **ENOENT**（Node 不能直接执行
 * `.cmd`）；而用户级 shim 在某些机器上还会报 "Harness CLI not found"。
 * 宿主自己就装了 CLI，最稳的做法是**绕过 shell 解析**，用安装目录里的
 * Electron 可执行文件直接跑宿主的 `desktop-cli.js`（打包 shim 正是这么做的）。
 *
 * 解析顺序：
 *  1. `PLUGIN_HARBOR_DSH` 显式指定；
 *  2. 宿主自带 CLI（`<安装根>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`
 *     + `ELECTRON_RUN_AS_NODE=1`）—— 只在真的存在时采用（插件运行在 Electron 里时存在）；
 *  3. PATH 上的 `dsh`（Windows 下 `.cmd`/`.bat` 需要经 shell）。
 */
export interface DshCommand {
  command: string;
  prefixArgs: string[];
  env?: Record<string, string>;
  /** 是否必须经 shell（Windows 的 `.cmd`）。 */
  useShell: boolean;
  source: "override" | "host-cli" | "path";
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  /** 注入的「路径是否存在」判断（测试用；宿主里走 fs.existsSync，asar 可读）。 */
  exists?: (path: string) => boolean;
  /** 注入的 PATH 探测（测试用）。 */
  probePath?: (name: string) => string | undefined;
  execPath?: string;
}

const HOST_CLI_RELATIVE = [
  "resources",
  "app.asar",
  "dsh",
  "node_modules",
  "@deepseek-ai",
  "dsh-desktop-host",
  "lib",
  "cli.js",
];

/** 宿主 CLI 的候选路径：从可执行文件所在目录向上找若干层。 */
export function hostCliCandidates(execPath: string): string[] {
  const out: string[] = [];
  let dir = dirname(execPath);
  for (let depth = 0; depth < 4; depth++) {
    out.push(join(dir, ...HOST_CLI_RELATIVE));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

/** Windows 的 `.cmd` / `.bat` 必须经 shell。 */
export function needsShell(command: string, platform = process.platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

export function resolveDshCommand(options: ResolveOptions = {}): DshCommand | undefined {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const execPath = options.execPath ?? process.execPath;

  const override = env.PLUGIN_HARBOR_DSH;
  if (typeof override === "string" && override.trim() !== "") {
    const command = override.trim();
    return {
      command,
      prefixArgs: [],
      useShell: needsShell(command),
      source: "override",
    };
  }

  for (const candidate of hostCliCandidates(execPath)) {
    if (!exists(candidate)) continue;
    return {
      command: execPath,
      prefixArgs: ["--expose-internals", candidate],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      useShell: false,
      source: "host-cli",
    };
  }

  const probe =
    options.probePath ??
    ((name: string) => {
      // 与 shell 的查找顺序一致：先看 PATH 里可直接执行的形式
      const pathValue = env.PATH ?? env.Path ?? "";
      const extensions =
        process.platform === "win32"
          ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
          : [""];
      for (const dir of pathValue.split(process.platform === "win32" ? ";" : ":")) {
        if (dir.trim() === "") continue;
        for (const extension of extensions) {
          const candidate = join(dir.trim(), name + extension.toLowerCase());
          if (exists(candidate)) return candidate;
        }
      }
      return undefined;
    });
  const found = probe("dsh");
  if (found) {
    return { command: found, prefixArgs: [], useShell: needsShell(found), source: "path" };
  }
  return undefined;
}

export interface SpawnedChild {
  pid?: number;
  stdout?: { on(event: string, listener: (chunk: any) => void): unknown } | null;
  stderr?: { on(event: string, listener: (chunk: any) => void): unknown } | null;
  on(event: string, listener: (...args: any[]) => void): unknown;
  kill(signal?: string): boolean;
}

export type SpawnLike = (
  command: string,
  args: string[],
  options: any,
) => SpawnedChild;

export interface DshRunOptions {
  profile: string;
  action: "add" | "remove";
  spec: string;
  /** 覆盖 `dsh` 可执行文件（测试用假 CLI）。 */
  dshCommand?: string;
  /** 命令前缀参数（宿主 CLI 需要 `--expose-internals <cli.js>`）。 */
  dshPrefixArgs?: string[];
  /** 显式要求经 shell（`dshCommand` 是 `.cmd` 时自动打开）。 */
  useShell?: boolean;
  /** 注入的命令解析（测试用；默认走 `resolveDshCommand()`）。 */
  resolve?: () => DshCommand | undefined;
  spawn?: SpawnLike;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface DshRunHooks {
  log?(line: string): void;
  /** 原始输出片段（含回车刷新的进度行）。 */
  chunk?(text: string): void;
  progress?(value: number, line: string): void;
  /** 登记取消动作（子进程起来之前也会先登记一次）。 */
  onCancel?(handler: () => void | Promise<void>): void;
}

export interface DshFailure {
  kind:
    | "dsh-missing"
    | "build-blocked"
    | "not-found"
    | "tarball-mismatch"
    | "permission"
    | "disk-full"
    | "timeout"
    | "unknown";
  message: string;
}

export interface DshRunResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  /** 进程级错误（例如 ENOENT）。 */
  error?: string;
  failure?: DshFailure;
}

/**
 * 默认 spawn（把 node 的类型收敛到上面的窄接口）。
 *
 * ⚠️ `shell: true` 时我们把整行命令串当 `command` 传入、`args` 留空，
 * 因此这里原样透传。
 */
const defaultSpawn: SpawnLike = (command, args, options) =>
  nodeSpawn(command, args, options) as unknown as SpawnedChild;

/** 估算进度：只升不降由调用方（队列）保证，这里给原始估计。 */
export function estimateProgress(text: string, current = 0): number {
  const line = text.replace(/\r/g, "\n");
  let value = current;
  const resolved = /Progress: resolved (\d+)/.exec(line);
  const handled = /(?:reused|downloaded|added) (\d+)/.exec(line);
  if (resolved) {
    const total = Number(resolved[1]);
    const done = handled ? Number(handled[1]) : 0;
    if (total > 0) {
      const ratio = done <= total ? done / total : 1;
      value = Math.max(value, 8 + Math.round(ratio * 22)); // 8–30
    }
  }
  if (/(^|\n)(dependencies|devDependencies|optionalDependencies):/.test(line))
    value = Math.max(value, 85);
  if (/Packages:\s*\+/.test(line)) value = Math.max(value, 85);
  if (/Running (prepare|build|install) scripts|node-pre-gyp|building/i.test(line))
    value = Math.max(value, 60);
  if (/Done in [\d.]+s/.test(line)) value = Math.max(value, 96);
  if (/\[exit \d+\]/.test(line)) value = Math.max(value, 100);
  return value;
}

/** 失败归类：把 pnpm / git 的典型输出翻成一句能照做的中文。 */
export function classifyDshFailure(
  code: number | null,
  output: string,
  timedOut = false,
): DshFailure {
  const text = output;
  if (timedOut) return { kind: "timeout", message: "命令超时，已终止" };
  if (/ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED|ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/i.test(text))
    return {
      kind: "build-blocked",
      message:
        "pnpm 拦下了依赖的构建脚本：需要在 profile 的 pnpm-workspace.yaml 里把该包加入 allowBuilds 后重试",
    };
  if (/ERR_PNPM_TARBALL_URL_MISMATCH/.test(text))
    return {
      kind: "tarball-mismatch",
      message:
        "lockfile 里的 tarball 地址与当前 registry 不一致（换过 registry 的包需要先卸载再装）",
    };
  if (/ERR_PNPM_FETCH_404|404 Not Found|not in this registry|No matching version/i.test(text))
    return { kind: "not-found", message: "registry / 仓库里没有这个包或版本" };
  if (/EACCES|EPERM|permission denied/i.test(text))
    return { kind: "permission", message: "没有写入权限" };
  if (/ENOSPC|no space left/i.test(text))
    return { kind: "disk-full", message: "磁盘空间不足" };
  const lastLine =
    text
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter((item) => item !== "")
      .slice(-1)[0] ?? "";
  return {
    kind: "unknown",
    message: lastLine === "" ? `命令失败（退出码 ${code ?? "未知"}）` : lastLine.slice(0, 200),
  };
}

/** 用给定命令跑一次 `dsh plugin`。任何异常都收敛成结果对象，不抛。 */
export async function runDshPlugin(
  options: DshRunOptions,
  hooks: DshRunHooks = {},
): Promise<DshRunResult> {
  const resolved = options.resolve
    ? options.resolve()
    : options.dshCommand
    ? {
        command: options.dshCommand,
        prefixArgs: options.dshPrefixArgs ?? [],
        ...(options.env ? { env: options.env } : {}),
        useShell: options.useShell ?? needsShell(options.dshCommand),
        source: "override" as const,
      }
    : resolveDshCommand();
  if (!resolved) {
    return {
      code: null,
      output: "",
      timedOut: false,
      error: "找不到 dsh 命令",
      failure: {
        kind: "dsh-missing",
        message:
          "找不到可用的 dsh 命令：宿主 CLI 不在预期位置，PATH 上也没有 dsh。" +
          "可以用 PLUGIN_HARBOR_DSH 指定可执行文件路径。",
      },
    };
  }
  const command = resolved.command;
  const shellArgs = [
    ...(options.dshPrefixArgs ?? resolved.prefixArgs),
    "plugin",
    "--profile",
    options.profile,
    options.action,
    options.spec,
  ];
  const childEnv = { ...(resolved.env ?? {}), ...(options.env ?? {}) };
  const spawnImpl = options.spawn ?? defaultSpawn;
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;

  return await new Promise<DshRunResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let output = "";
    let progress = 0;
    let child: SpawnedChild | null = null;

    const killTree = () => {
      if (!child) return;
      const pid = child.pid;
      try {
        if (process.platform === "win32" && typeof pid === "number") {
          // 只杀 dsh 会留下 pnpm 子树继续改 profile，必须整棵树一起终止。
          nodeSpawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          }).on("error", () => child?.kill());
        } else {
          child.kill();
        }
      } catch {
        try {
          child.kill();
        } catch {
          // 已经退出
        }
      }
    };
    hooks.onCancel?.(killTree);

    const finish = (result: DshRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let timer: NodeJS.Timeout;
    try {
      /**
       * ⚠️ `.cmd` / `.bat` 必须经 shell，而 `shell: true` + 参数数组会触发 Node 的
       * DEP0190（参数未转义地拼接）。这里的参数全部来自白名单校验
       * （`ops/validate.ts`：无空白、无控制字符、不以 `-` 开头），因此自己拼成
       * 一行命令串、并把每个参数加引号，既避开弃用告警也不引入注入面。
       */
      child = resolved.useShell
        ? spawnImpl(
            [command, ...shellArgs]
              .map((part) => `"${part.replace(/"/g, '""')}"`)
              .join(" "),
            [],
            {
              windowsHide: true,
              shell: true,
              stdio: ["ignore", "pipe", "pipe"],
              env: { ...process.env, ...childEnv },
            },
          )
        : spawnImpl(command, shellArgs, {
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, ...childEnv },
          });
    } catch (error) {
      finish({
        code: null,
        output: "",
        timedOut: false,
        error: error instanceof Error ? error.message : String(error),
        failure: {
          kind:
            (error as any)?.code === "ENOENT" ? "dsh-missing" : "unknown",
          message:
            (error as any)?.code === "ENOENT"
              ? "找不到 dsh 命令：请确认它在 PATH 上，或用 PLUGIN_HARBOR_DSH 指定路径"
              : String(error),
        },
      });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    const absorb = (chunk: any) => {
      const text = String(chunk);
      output += text;
      if (output.length > 200_000) output = output.slice(-100_000);
      hooks.chunk?.(text);
      const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
      for (const line of lines) hooks.log?.(line.trim());
      progress = estimateProgress(text, progress);
      hooks.progress?.(progress, lines.slice(-1)[0] ?? "");
    };
    child.stdout?.on("data", absorb);
    child.stderr?.on("data", absorb);
    child.on("error", (error: any) => {
      finish({
        code: null,
        output,
        timedOut: false,
        error: String(error?.message ?? error),
        failure: {
          kind: error?.code === "ENOENT" ? "dsh-missing" : "unknown",
          message:
            error?.code === "ENOENT"
              ? "找不到 dsh 命令：请确认它在 PATH 上，或用 PLUGIN_HARBOR_DSH 指定路径"
              : String(error?.message ?? error),
        },
      });
    });
    child.on("close", (code: number | null) => {
      const failure =
        code === 0 && !timedOut ? undefined : classifyDshFailure(code, output, timedOut);
      finish({
        code,
        output,
        timedOut,
        ...(failure ? { failure } : {}),
      });
    });
  });
}