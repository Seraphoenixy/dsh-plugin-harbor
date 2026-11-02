/**
 * 假 CLI 夹具：按脚本吐 stdout/stderr 并以给定退出码结束。
 *
 * 用途：验证子进程兜底通道的参数、进度与失败归类，不真跑 pnpm、不联网。
 * （放在 `tests/helpers/` 下，不被 `tests/*.test.ts` 的 glob 收集。）
 */
import { EventEmitter } from "node:events";
import type { SpawnLike, SpawnedChild } from "../../src/ops/subprocess.ts";

export interface FakeScript {
  lines?: string[];
  stderr?: string[];
  code?: number | null;
  emitError?: string;
  delayMs?: number;
}

export interface FakeCli {
  spawn: SpawnLike;
  calls: { command: string; args: string[] }[];
  killed: number;
}

export function fakeCli(script: FakeScript): FakeCli {
  const calls: { command: string; args: string[] }[] = [];
  const state = { killed: 0 };
  const spawn: SpawnLike = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter() as EventEmitter & SpawnedChild;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    child.pid = 4242;
    child.stdout = stdout as any;
    child.stderr = stderr as any;
    child.kill = () => {
      state.killed += 1;
      setTimeout(() => child.emit("close", 143), 0);
      return true;
    };
    setTimeout(() => {
      if (script.emitError) {
        const error: any = new Error(script.emitError);
        if (script.emitError.includes("ENOENT")) error.code = "ENOENT";
        child.emit("error", error);
        return;
      }
      for (const line of script.lines ?? []) stdout.emit("data", line + "\n");
      for (const line of script.stderr ?? []) stderr.emit("data", line + "\n");
      child.emit("close", script.code ?? 0);
    }, script.delayMs ?? 0);
    return child;
  };
  return {
    spawn,
    calls,
    get killed() {
      return state.killed;
    },
  };
}