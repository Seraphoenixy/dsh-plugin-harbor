/**
 * 开发用自动重载：`dist/` 一变，就让宿主用磁盘上的新代码替换运行中的本插件。
 *
 * ⚠️ 为什么不是「监视 src/ 然后自己构建」：构建是 `npm run build` 的事，插件不该在
 * 运行时去跑编译器。这里只盯**产物**，谁构建的（手动 `npm run build`、`npm run dev`、
 * 编辑器任务）都无所谓。
 *
 * ⚠️ 为什么只对「检出目录安装」生效：`package.json` 的 `files` 里不含 `src/`，
 * 所以从 tarball / registry 装进来的副本只有 `dist/`。用「有没有 `src/index.ts`」
 * 当开关，正好把开发形态（`link:` 指向检出目录）与正式形态（独立副本）分开 ——
 * 正式安装里这段代码是惰性的，不会有任何文件监视。
 *
 * 重载动作本身复用 `pluginManager.setBundleEnabled(name, true)`（宿主 HMR 会按磁盘上
 * 当前的代码重新组合），**不自己去清 Node 的模块缓存**：那要依赖内核内部结构
 * （`loader.internal.loadCache`），内核一改就碎，且失败时容易把插件留在半死状态。
 */
import { existsSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

export interface WatchLogger {
  info?(message: string): void;
  warn?(message: string): void;
}

export interface WatchDistOptions {
  /** 要监视的目录（通常是 `<packageDir>/dist`）。 */
  dir: string;
  /** 防抖后调用一次（一次构建会触发多个 change 事件）。 */
  onChange: () => void;
  /** 只关心哪些文件名（相对 `dir`，分隔符已归一成 `/`）。 */
  filter?: (file: string) => boolean;
  logger?: WatchLogger;
  /** 防抖窗口：构建通常连续写几个文件，等它们写完再动。 */
  debounceMs?: number;
}

/**
 * 是否启用自动重载。
 *
 * 三个条件都满足才启用：
 *  1. 没被 `PLUGIN_HARBOR_HOT_RELOAD=0` 显式关掉；
 *  2. 包里**有 `src/index.ts`** —— 只有检出目录才有（`files` 不含 `src/`），
 *     正式安装的副本里没有，于是这段逻辑在生产环境完全惰性；
 *  3. `dist/` 真的存在（否则没什么可监视的）。
 */
export function shouldWatch(
  packageDir: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): boolean {
  if (env.PLUGIN_HARBOR_HOT_RELOAD === "0") return false;
  if (!exists(join(packageDir, "src", "index.ts"))) return false;
  return exists(join(packageDir, "dist"));
}

/**
 * 监视目录并把连续变更合并成一次回调。
 *
 * 返回的停止函数可重复调用；watcher 与定时器都 `unref()`，空闲的桌面进程仍能正常退出，
 * 测试也不会因为挂着一个监视器而不结束。
 */
export function watchDist(options: WatchDistOptions): () => void {
  const { dir, onChange, filter, logger = console } = options;
  const debounceMs = options.debounceMs ?? 700;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let watcher: FSWatcher;

  /**
   * `link:` 安装时 profile 里那条是 junction，直接监视它收不到「从另一条路径写入」
   * 的事件 —— 必须先解析到真实目录。
   */
  let target = dir;
  try {
    target = realpathSync(dir);
  } catch {
    /* 解析不了就用原路径（目录可能刚被删） */
  }

  try {
    watcher = watch(target, { recursive: true });
  } catch (error: any) {
    logger.warn?.(`plugin-harbor: 无法监视 ${target}（${error?.message ?? error}）`);
    return () => {};
  }

  const schedule = (_event: string, filename: string | null) => {
    if (stopped) return;
    if (filename !== null && filter !== undefined) {
      // Windows 上事件里的分隔符可能是 `\`，统一成 `/` 再交给 filter
      if (!filter(String(filename).replaceAll("\\", "/"))) return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!stopped) onChange();
    }, debounceMs);
    timer.unref?.();
  };

  watcher.on("change", schedule);
  watcher.on("rename", schedule);
  watcher.on("error", (error: any) =>
    logger.warn?.(`plugin-harbor: 监视器错误（${error?.message ?? error}）`),
  );
  watcher.unref?.();

  return () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    timer = undefined;
    try {
      watcher.close();
    } catch {
      /* 已经关了 */
    }
  };
}
