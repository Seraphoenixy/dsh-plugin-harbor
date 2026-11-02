/**
 * git 远端只读查询。
 *
 * 一次 `git ls-remote --symref <url> HEAD` 同时拿到**默认分支**与**HEAD commit**：
 * 判断「按 commit 钉住的安装是否落后」只需要这两个值。
 *
 * ⚠️ 必须禁掉一切交互与凭据提示（`GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`）：
 * 插件在宿主进程里跑，绝不能因为一个私有仓库把宿主挂在凭据输入上。
 */
import { spawn } from "node:child_process";

export interface GitFacts {
  /** 远端 HEAD 指向的分支（`main` / `master` …）。 */
  defaultBranch?: string;
  /** 远端 HEAD 的 commit。 */
  commit?: string;
  error?: string;
}

export interface GitOptions {
  timeoutMs?: number;
  /** 覆盖 git 可执行文件（测试用假 git）。 */
  gitPath?: string;
}

const SHA = /^[0-9a-f]{7,40}$/i;

export function parseLsRemote(stdout: string): GitFacts {
  const facts: GitFacts = {};
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const symref = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(trimmed);
    if (symref) {
      facts.defaultBranch = symref[1];
      continue;
    }
    const head = /^([0-9a-f]{7,40})\s+HEAD$/i.exec(trimmed);
    if (head && SHA.test(head[1]!)) facts.commit = head[1]!.toLowerCase();
  }
  return facts;
}

/** 本机 git 可用性（诊断用）：`git --version`。 */
export async function readGitVersion(
  options: GitOptions = {},
): Promise<{ ok: boolean; detail: string }> {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value: { ok: boolean; detail: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(options.gitPath ?? "git", ["--version"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, detail: "git --version 超时" });
    }, options.timeoutMs ?? 5_000);
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", (error: any) =>
      finish({
        ok: false,
        detail:
          error?.code === "ENOENT"
            ? "本机没有 git 可执行文件（git 形态的更新判据会不可用）"
            : String(error?.message ?? error),
      }),
    );
    child.on("close", (code) =>
      finish(
        code === 0
          ? { ok: true, detail: stdout.trim() || "git 可用" }
          : { ok: false, detail: `git --version 退出码 ${code}` },
      ),
    );
  });
}

export async function readRemoteHead(
  repo: string,
  options: GitOptions = {},
): Promise<GitFacts> {
  const url = /^https?:|^git@/.test(repo)
    ? repo
    : `https://github.com/${repo.replace(/\.git$/, "")}.git`;
  return await new Promise<GitFacts>((resolve) => {
    let settled = false;
    const finish = (facts: GitFacts) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(facts);
    };
    const child = spawn(
      options.gitPath ?? "git",
      ["ls-remote", "--symref", url, "HEAD"],
      {
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never",
          GIT_ASKPASS: "",
        },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const timer = setTimeout(() => {
      child.kill();
      finish({ error: `git ls-remote 超时（${options.timeoutMs ?? 15_000}ms）` });
    }, options.timeoutMs ?? 15_000);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error: any) => {
      finish({
        error:
          error?.code === "ENOENT"
            ? "本机没有 git 可执行文件"
            : String(error?.message ?? error),
      });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        finish({
          error: stderr.trim().split("\n").slice(-1)[0] || `git 退出码 ${code}`,
        });
        return;
      }
      const facts = parseLsRemote(stdout);
      if (!facts.commit) {
        finish({ error: "git 没有返回 HEAD commit" });
        return;
      }
      finish(facts);
    });
  });
}