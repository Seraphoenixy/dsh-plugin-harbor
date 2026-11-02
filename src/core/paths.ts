import { homedir } from "node:os";
import { join } from "node:path";

/** 本插件在某 profile 下的路径集合。 */
export interface ProfileRef {
  /** profile 名，用于界面展示与 RPC 白名单校验。 */
  name: string;
  /** profile 根目录（`<home>/profiles/<name>`）。 */
  dir: string;
  /** 本插件的数据目录（`<profile>/plugin-harbor`）。 */
  dataDir: string;
  /** 目录库路径（`<dataDir>/catalog.sqlite`）。 */
  dbPath: string;
}

/**
 * profile 名的合法字符集。
 *
 * ⚠️ 刻意写成 ASCII 显式区间而不是 `\w`：它只描述一类字符，且 `\w` 在
 * Unicode 语义下会放进非 ASCII 字母（宿主实际只用 desktop / web / headless
 * 这类名字）。profile 名会被拼进文件路径，白名单必须窄。
 */
const PROFILE_NAME = /^[A-Za-z0-9_.-]+$/;

/** DSH 数据根：环境变量优先，其次 `~/.dsh`。 */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

/**
 * profile 名白名单校验。
 *
 * profile 名会被拼进文件路径，且 `catalog.sqlite` 直接落在
 * `<profile>/plugin-harbor/` 下，因此这里必须挡住路径穿越与空值。
 */
export function assertProfileName(name: string): string {
  /**
   * `.` 与 `..` 也满足上面的字符类，但它们不是「一层目录名」：
   * `<home>/profiles/..` 会指到 profiles 的上一级，正是白名单要挡的东西
   * （本仓库 `tests/paths.test.ts` 钉住这两个值）。
   */
  if (name === "." || name === ".." || !PROFILE_NAME.test(name))
    throw Error("Invalid DSH profile name");
  return name;
}

/** 解析本次运行所属的 profile（宿主下发的 `profileContext` 优先）。 */
export function resolveProfile(ctx: any): ProfileRef {
  const context = ctx?.get?.("profileContext") ?? {};
  const name = assertProfileName(
    context.name ?? process.env.DSH_PROFILE ?? "desktop",
  );
  const dir = join(dshHome(), "profiles", name);
  const dataDir = join(dir, "plugin-harbor");
  return { name, dir, dataDir, dbPath: join(dataDir, "catalog.sqlite") };
}