/**
 * 插件港湾宿主入口。
 *
 * 职责：解析 profile 路径、装配目录库 worker、挂载版本化 RPC 路由、把目录同步
 * 编排接上，并把 `dispatch` 暴露给契约测试。已装清单与插件操作在 M2–M3 接入。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDispatcher,
  readEnvelope,
  redact,
  RPC_METHOD,
  RPC_PATH,
  RPC_VERSION,
  type RpcContext,
  type RpcOutcome,
} from "./core/dispatch.ts";
import { resolveProfile } from "./core/paths.ts";
import { fetchDetail, syncCatalog, type SyncReport } from "./core/catalog.ts";
import { readInstalledPlugins } from "./core/installed.ts";
import {
  buildExport,
  exportFileName,
  patchSnippet,
  planImport,
  readExport,
  serializeExport,
  type ExportBundle,
} from "./core/transfer.ts";
import { checkPlugins } from "./core/updates.ts";
import { runDiagnostics, type DiagnosticCheck } from "./core/diagnostics.ts";
import {
  applySettingsPatch,
  readSettingsFile,
  writeSettingsFile,
} from "./core/settings.ts";
import type {
  CatalogPage,
  CatalogQuery,
  CatalogRow,
  CatalogStatus,
  CenterSettings,
  DetailRecord,
  InstalledRow,
  PluginStatus,
  UpdateCheck,
} from "./core/types.ts";
import { CatalogStore } from "./storage/client.ts";
import { fetchText } from "./upstream/fetch.ts";
import { fetchRegistryFacts } from "./upstream/registry.ts";
import { readGitVersion, readRemoteHead } from "./upstream/git.ts";
import { OpQueue } from "./ops/queue.ts";
import { executeTask } from "./ops/execute.ts";
import { installSpecFor, redactSpec } from "./ops/spec.ts";
import { runDshPlugin } from "./ops/subprocess.ts";
import { shouldWatch, watchDist } from "./ops/watch.ts";
import { setEnabledWithManager, readHostEntries, type PluginManagerLike } from "./ops/manager.ts";
import type { OpTask } from "./ops/types.ts";
import {
  requireConfirm,
  validateName,
  validateSpec,
  validateTaskId,
} from "./ops/validate.ts";

export const name = "plugin-harbor";
export const VERSION = "0.1.0-alpha.1";

/**
 * 构建标识（由 `scripts/build.mjs` 按源码内容哈希注入；见那里的说明）。
 *
 * 客户端与宿主各自打进同一个值：面板拿它和 `/status` 返回的 `build` 比对，就能发现
 * 「界面已是新构建、宿主里跑的还是旧的」这种错配，并直接说清怎么修。
 */
declare const __HARBOR_BUILD__: string;
export const BUILD: string = typeof __HARBOR_BUILD__ === "string" ? __HARBOR_BUILD__ : "dev";

/** 数据来源基址：允许用环境变量指向镜像（测试与自建镜像用）。 */
const SITE_BASE = process.env.PLUGIN_HARBOR_SITE ?? "https://dsh-plugin.org";
const API_BASE = process.env.PLUGIN_HARBOR_API ?? "https://api.dsh-plugin.org";
/** 默认 registry：可用环境变量指向镜像（自建镜像与离线验收用）。 */
const DEFAULT_REGISTRY = process.env.PLUGIN_HARBOR_REGISTRY ?? "";
/** 详情页缓存 TTL：站点的精确版本一天内不会变。 */
const DETAIL_TTL_MS = 24 * 3600 * 1000;
/** 更新结论缓存 TTL：界面打开时只用缓存，不自动出网。 */
const CHECK_TTL_MS = 10 * 60 * 1000;
/**
 * 自热重载的延迟：先把 RPC 回执与「操作历史」送出去，再请宿主替换我们自己 ——
 * 否则响应会随着本插件被换掉而消失（客户端只看到一次失败的调用）。
 */
const SELF_RELOAD_DELAY_MS = 600;

function realpathOf(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * 判断某个已装依赖是不是**本插件自己**（自热重载要单独处理：先回执、后动手）。
 *
 * 不用硬编码包名，而是拿本文件的真实路径去比对每个依赖的落点：
 *  - `file:` / `link:` 依赖 → 解析到 profile 之外的目录（已链接包的目标）；
 *  - 其余依赖 → `<profile>/node_modules/<依赖名>`。
 * 两边都取 realpath，兼容 pnpm 的符号链接布局（`.pnpm/...` 虚拟store）。
 */
export function selfPackageName(
  profileDir: string,
  entries: { name: string; spec: string }[],
  moduleDir: string = dirname(dirname(fileURLToPath(import.meta.url))),
): string | undefined {
  const here = realpathOf(moduleDir);
  if (here === undefined) return undefined;
  for (const entry of entries) {
    const local = /^(file|link):(.*)$/s.exec(entry.spec.trim());
    const candidates: string[] = [];
    if (local) {
      const target = local[2]!.replace(/^~(?=$|[\\/])/, () => homedir());
      candidates.push(resolve(profileDir, target));
    }
    candidates.push(join(profileDir, "node_modules", entry.name));
    for (const candidate of candidates)
      if (realpathOf(candidate) === here) return entry.name;
  }
  return undefined;
}

/** 本插件对外暴露的方法表：这里只放**不依赖本 profile 设置**的只读方法。 */
const handlers = {
  status: async (_payload: any, rpc: RpcContext): Promise<PluginStatus> => ({
    plugin: name,
    version: VERSION,
    build: BUILD,
    profile: rpc.profile.name,
    dataDir: rpc.profile.dataDir,
    dbPath: rpc.profile.dbPath,
    store: await rpc.store.call("ping"),
    hot: rpc.hot(),
  }),
  /**
   * 目录状态。读不到就说读不到：`totalCount` 为 null 时不填 0，
   * `error` 透传上次同步的失败原因（AGENTS.md：不用默认值填充）。
   */
  "catalog.status": async (_payload: any, rpc: RpcContext): Promise<CatalogStatus> => {
    const counts = await rpc.store.call("catalog.counts", { lang: "zh" });
    return {
      rows: counts?.rows ?? 0,
      chunks: counts?.chunks ?? 0,
      totalCount: counts?.totalCount ?? null,
      lastSyncAt: counts?.lastSyncAt ?? null,
      error: counts?.lastError ?? null,
      syncing: rpc.syncing(),
      curatedOrphans: counts?.curatedOrphans ?? 0,
      milestone: "M1",
    };
  },
  "catalog.list": async (payload: any, rpc: RpcContext): Promise<CatalogPage> =>
    rpc.store.call("catalog.list", { query: (payload ?? {}) as CatalogQuery }),
  /**
   * 已装清单：profile 事实（清单/lockfile/node_modules）+ 目录信息 + 缓存的更新结论。
   *
   * ⚠️ 这里**不出网**：更新结论来自 `updates.check` 写下的缓存；缓存缺失时
   * `update` 为 undefined（界面显示「未检查」），而不是当场去查。
   */
  "installed.list": async (_payload: any, rpc: RpcContext): Promise<InstalledRow[]> => {
    const plugins = readInstalledPlugins(rpc.profile.dir);
    if (plugins.length === 0) return [];
    const repos = plugins
      .map((plugin) => plugin.repo)
      .filter((repo): repo is string => typeof repo === "string");
    const [catalog, details, checks] = await Promise.all([
      rpc.store.call<{ rows: CatalogRow[] }>("catalog.rowsByRepo", { repos }),
      rpc.store.call<{ details: [string, { record: any; at: number }][] }>(
        "catalog.getDetails",
        { repos },
      ),
      rpc.store.call<{ checks: UpdateCheck[] }>("installed.getChecks"),
    ]);
    const byRepo = new Map((catalog?.rows ?? []).map((row) => [row.repo, row]));
    const detailByRepo = new Map(details?.details ?? []);
    const checkByName = new Map((checks?.checks ?? []).map((check) => [check.name, check]));
    return plugins.map((plugin) => {
      const row: InstalledRow = { ...plugin };
      const catalogRow = plugin.repo ? byRepo.get(plugin.repo) : undefined;
      if (catalogRow) {
        row.displayName = catalogRow.displayName;
        row.category = catalogRow.category;
        row.stars = catalogRow.stars;
        // 站点详情页地址要 owner + slug（不能拿 repo 切，slug 会重名）
        if (typeof catalogRow.slug === "string") row.slug = catalogRow.slug;
        if (typeof catalogRow.owner === "string") row.owner = catalogRow.owner;
      }
      const detail = plugin.repo ? detailByRepo.get(plugin.repo)?.record : undefined;
      if (detail) {
        if (typeof detail.version === "string") row.detailVersion = detail.version;
        if (typeof detail.installCommand === "string")
          row.installCommand = detail.installCommand;
        if (typeof detail.dshTarget === "string") row.dshTarget = detail.dshTarget;
      }
      const check = checkByName.get(plugin.name);
      if (check) row.update = check;
      return row;
    });
  },
  /**
   * 更新与详情页都要按本 profile 的设置（registry / siteBase / locale）出网，
   * 因此它们与 `settings.*`、`catalog.refresh`、`diagnostics.run` 一起放在
   * apply 作用域里（见下面的 runtimeHandlers）。
   */
};

export async function apply(ctx: any) {
  const profile = resolveProfile(ctx);
  const store = new CatalogStore({
    workerPath: fileURLToPath(new URL("./catalog-worker.js", import.meta.url)),
    dbPath: profile.dbPath,
  });
  const log = (message: string) => ctx?.logger?.info?.(`plugin-harbor: ${message}`);
  /**
   * 本 profile 的设置：从 `<dataDir>/settings.json` 读，坏字段逐项退回默认值
   * 并把原因记进 `notes`（界面上如实显示，不静默吞掉）。
   */
  const loaded = readSettingsFile(profile.dataDir);
  let settings = loaded.settings;
  const settingNotes = [...loaded.notes];
  for (const note of settingNotes) log("设置：" + note);
  /**
   * 宿主服务是**晚绑定**的：`ctx.inject(['pluginManager'], …)` 的回调可能晚于
   * `apply` 返回，因此这里保留一个引用，由编排层在**每次执行时**读取。
   */
  let manager: PluginManagerLike | undefined;
  /**
   * 跑一次更新检查并把结论落库。
   *
   * `only` 给包名时只查这几个（更新完成后只复查被更新的那个，不必把整张表重查一遍）。
   * 判据全部来自 `core/updates.ts`：拿不到就 `updateAvailable: null` + 原因，绝不当成
   * 「已最新」。
   */
  const checkUpdates = async (
    target: { call<T = any>(method: string, payload?: any): Promise<T> },
    only?: string[],
  ): Promise<UpdateCheck[]> => {
    const plugins = readInstalledPlugins(profile.dir);
    const selected =
      only === undefined ? plugins : plugins.filter((plugin) => only.includes(plugin.name));
    if (selected.length === 0) return [];
    const checks = await checkPlugins(selected, {
      now: () => Date.now(),
      concurrency: 4,
      registry: (packageName) =>
        fetchRegistryFacts(packageName, {
          ...(settings.registry !== "" ? { registry: settings.registry } : {}),
        }),
      git: (repo) => readRemoteHead(repo),
    });
    await target.call("installed.putChecks", { checks });
    return checks;
  };

  /** 把一句话追加进任务结论（已有的分号结尾不重复加）。 */
  const appendNote = (note: string | undefined, extra: string): string =>
    note === undefined || note === "" ? extra : `${note}${/[；;]\s*$/.test(note) ? "" : "；"}${extra}`;

  /** 一句能直接读的复查结论（写进操作结论与日志）。 */
  const describeCheck = (check: UpdateCheck | undefined): string => {
    if (!check) return "没有拿到复查结论";
    if (check.updateAvailable === true) {
      const latest = check.latestVersion ?? check.latestCommit?.slice(0, 7) ?? "未知";
      return `仍可更新（最新 ${latest}）`;
    }
    if (check.updateAvailable === false) {
      const current = check.installedVersion ?? check.installedCommit?.slice(0, 7) ?? "当前版本";
      return `已是最新（${current}）`;
    }
    const why = check.error ?? check.note ?? "没有可比对的远端";
    return `未判定（${why}）`;
  };

  const queue = new OpQueue(
    async (task, control) => {
      const result = await executeTask(task, control, {
        profileName: profile.name,
        profileDir: profile.dir,
        ...(manager ? { manager } : {}),
        runDsh: runDshPlugin,
        log,
        // 只在失败解释时调用：读一次当前依赖列表，判断「启用」是不是根本没依赖可启用。
        dependencyPresent: (name) =>
          readInstalledPlugins(profile.dir).some((plugin) => plugin.name === name),
        ...(settings.registry !== "" ? { registry: settings.registry } : {}),
      });
      /**
       * 更新完成后**自动复查被更新的那个插件**：不复查的话，已装页会一直显示更新前
       * 那次检查的结论（「可更新」），刚更新完的插件看起来还是旧的 —— 界面在骗人。
       *
       * 复查发生在任务进入终态**之前**：客户端看到「已完成」时，库里已经是新结论，
       * 紧接着重读已装清单就能拿到正确的徽标（否则会出现一次可见的竞态）。
       *
       * 复查失败不能把一次成功的更新改判成失败：只把原因追加进结论与日志。
       */
      if (task.kind !== "update") return result;
      const present = readInstalledPlugins(profile.dir).some(
        (plugin) => plugin.name === task.target,
      );
      if (!present) {
        // 更新失败且没能装回来：没有可复查的对象，如实说，不编一个结论
        control.log("更新后复查：插件已不在 profile 的依赖里，跳过");
        return result;
      }
      try {
        control.progress(100, "复查更新状态");
        const [check] = await checkUpdates(store, [task.target]);
        const sentence = describeCheck(check);
        control.log(`更新后复查 ${task.target}：${sentence}`);
        return { ...result, note: appendNote(result.note, `更新后已复查：${sentence}`) };
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        control.log(`更新后复查失败：${why}`);
        return { ...result, note: appendNote(result.note, `更新后复查失败：${why}`) };
      }
    },
    {
      onFinish: (task) => {
        // 操作历史是旁路：写库失败不影响操作结果本身
        void store.call("op.putOp", { task }).catch(() => {});
      },
    },
  );

  /**
   * 变更类操作。共同口径：
   *  - 入参先过白名单校验（挡前导 `-`、空白、控制字符与超长）；
   *  - 一律要求 `confirm: true`（对应界面上的确认弹窗）；
   *  - 更新的地址与形态**由服务端从已装事实里取**，不接受客户端传来的 spec。
   */
  /**
   * 导出 / 导入共用的文件位置与读取闸门。
   *
   * 导出文件放在本插件的数据目录下（`<dataDir>/exports/`）：既在 profile 里便于随 profile
   * 一起备份，也不会被导出流程自己扫进去（`transfer.ts` 把 `exports` 目录排除在外）。
   */
  const uploadsDir = () => join(profile.dataDir, "exports");
  const MAX_EXPORT_BYTES = 8 * 1024 * 1024;

  /** 导入源路径：给名字就按导出目录解析，给绝对路径就用它（用户可能放在别处）。 */
  const resolveExportPath = (input: unknown): string => {
    if (typeof input !== "string") throw Error("导入文件路径必须是字符串");
    const raw = input.trim();
    if (raw === "") throw Error("导入文件路径不能为空");
    if (raw.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw))
      throw Error("导入文件路径不合法（含控制字符或过长）");
    return isAbsolute(raw) ? raw : join(uploadsDir(), raw);
  };

  /**
   * 把浏览器里选中的文件**落到导出目录**，返回可以直接给 `import.preview` / `op.import`
   * 用的绝对路径。
   *
   * ⚠️ 为什么要有这一步：界面上的「选择文件…」拿到的是 `File` 对象，它的内容只存在于
   * 浏览器内存里，而预检与导入都只接受**服务端读得到的路径**。宿主也没有给插件用的原生
   * 文件对话框，所以只能由客户端读出文本、经 RPC 交给服务端落盘。
   *
   * 落点固定在本插件自己的 `exports/` 目录（不是用户选的任意目录）：那是本插件唯一
   * 拥有写权限的位置，也不会把文件写到 profile 的补丁或清单里去。
   *
   * 文件名只取用户那份文件的名字做后缀，前缀仍用本插件的导出命名规则 —— 避免
   * `..\\..\\` 之类的名字把文件写到目录外，也避免覆盖已有导出。
   */
  const saveUploaded = (payload: any): { name: string; path: string; bytes: number } => {
    const raw = payload?.content;
    if (typeof raw !== "string") throw Error("上传内容必须是字符串");
    const text = raw;
    if (text.trim() === "") throw Error("这个文件是空的");
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_EXPORT_BYTES)
      throw Error(`文件有 ${bytes} 字节，超过 ${MAX_EXPORT_BYTES} 上限：不是插件港湾的导出文件？`);
    /**
     * 先按导出文件的格式校验一遍再落盘：选错文件（比如随手点的别的 JSON）应该当场
     * 报错，而不是先写进目录、等预检时才炸，把 `exports/` 留一堆垃圾。
     */
    const parsed = readExport(text);
    if (parsed.bundle === undefined) throw Error(`这个文件不能作为导入源：${parsed.error}`);
    const base = typeof payload?.name === "string" ? payload.name : "";
    const suffix = base
      .replace(/^.*[\\/]/, "")
      .replace(/\.json$/i, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[.-]+/, "")
      .slice(0, 80);
    const stamp = exportFileName(profile.name, Date.now()).replace(/\.json$/, "");
    const name = suffix === "" ? `${stamp}.json` : `${stamp}-${suffix}.json`;
    const path = join(uploadsDir(), name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, "utf8");
    log(`导入文件已存入 ${path}（${bytes} 字节）`);
    return { name, path, bytes };
  };

  const loadExport = (path: string): { bundle: ExportBundle; source: string } => {
    let stats;
    try {
      stats = statSync(path);
    } catch {
      throw Error("读不到这个文件：" + path);
    }
    if (!stats.isFile()) throw Error("这不是一个文件：" + path);
    if (stats.size > MAX_EXPORT_BYTES)
      throw Error(`文件有 ${stats.size} 字节，超过 ${MAX_EXPORT_BYTES} 上限：不是插件港湾的导出文件？`);
    const parsed = readExport(readFileSync(path, "utf8"));
    if (parsed.bundle === undefined)
      throw Error(`这个文件不能作为导入源：${parsed.error}`);
    return { bundle: parsed.bundle, source: path };
  };

  const countSteps = (steps: OpTask["importSteps"]) => {
    const counts = { install: 0, enable: 0, disable: 0, entries: 0, skip: 0, blocked: 0 };
    for (const step of steps ?? []) counts[step.action] += 1;
    return counts;
  };

  const describePlanCounts = (counts: ReturnType<typeof countSteps>): string =>
    `计划：安装 ${counts.install}、启用 ${counts.enable}、停用 ${counts.disable}、恢复条目开关 ${counts.entries}` +
    `、已一致 ${counts.skip}、无法处理 ${counts.blocked}`;

  const opHandlers = {
    /** 当前设置 + 读取时的修正说明（界面要能看见「哪一项被退回了默认值」）。 */
    "settings.get": async (): Promise<CenterSettings> => ({
      ...settings,
      notes: settingNotes,
    }),
    /**
     * 修改设置。非法值**报错**（不替用户改写意图）；合法则原子写盘并即刻生效。
     */
    "settings.set": async (payload: any): Promise<CenterSettings> => {
      const { settings: next, problems } = applySettingsPatch(settings, payload ?? {});
      if (problems.length > 0) throw Error(problems.join("；"));
      writeSettingsFile(profile.dataDir, next);
      settings = next;
      settingNotes.length = 0;
      log(
        `设置已更新：locale=${next.locale} syncTtlMs=${next.syncTtlMs} ` +
          `siteBase=${next.siteBase} registry=${next.registry === "" ? "(默认)" : next.registry}`,
      );
      return { ...next, notes: [] };
    },
    /** 强制同步：同一时刻只允许一次，重复请求复用同一次运行的结果。 */
    "catalog.refresh": async (): Promise<SyncReport> => (await rpc.refresh()) as SyncReport,
    /**
     * 检查更新：registry（`dist-tags.latest`）/ git（lockfile commit vs 远端 HEAD）。
     *
     * 判不了的一律 `updateAvailable: null` + 原因，绝不当成「已最新」。
     */
    "updates.check": async (_payload: any, rpcContext: RpcContext): Promise<UpdateCheck[]> => {
      const checks = await checkUpdates(rpcContext.store);
      const fresh = checks.filter((check) => check.updateAvailable === true).length;
      log(`更新检查完成：${checks.length} 个已装插件，其中 ${fresh} 个有新版本`);
      return checks;
    },
    /**
     * 按需拉一个插件的详情页（站点精确版本 / 安装命令 / dshTarget），带 24h 缓存。
     * 目录列表里没有这些字段，只有详情页有。
     */
    "plugin.detail": async (payload: any, rpcContext: RpcContext): Promise<DetailRecord | null> => {
      const repo = String(payload?.repo ?? "");
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw Error("Invalid repo: " + repo);
      const cached = await rpcContext.store.call<{
        details: [string, { record: any; at: number }][];
      }>("catalog.getDetails", { repos: [repo] });
      const hit = cached?.details?.find(([key]) => key === repo)?.[1];
      if (hit && Date.now() - hit.at < DETAIL_TTL_MS)
        return hit.record as DetailRecord;
      const record = await fetchDetail(
        { fetch: fetchText, siteBase: settings.siteBase, locale: settings.locale },
        repo,
      );
      if (!record) return null;
      await rpcContext.store.call("catalog.putDetail", { repo, record });
      return record;
    },
    /**
     * 连通性诊断：**只读**，且只在用户点「运行诊断」时跑（其中几项要出网）。
     */
    "diagnostics.run": async (_payload: any, rpcContext: RpcContext): Promise<DiagnosticCheck[]> =>
      await runDiagnostics({
        fetch: fetchText,
        gitVersion: () => readGitVersion(),
        storePing: () => rpcContext.store.call("ping"),
        counts: () => rpcContext.store.call("catalog.counts", { lang: settings.locale }),
        settings,
        hot: () => rpcContext.hot(),
        now: () => Date.now(),
      }),
    "op.install": async (payload: any): Promise<OpTask> => {
      const spec = validateSpec(payload?.spec);
      if (!spec.ok) throw Error(spec.reason);
      const confirmed = requireConfirm(payload?.confirm);
      if (!confirmed.ok) throw Error(confirmed.reason);
      return queue.enqueue({ kind: "install", target: spec.value, spec: spec.value });
    },
    "op.update": async (payload: any, rpcContext: RpcContext): Promise<OpTask> => {
      const name = validateName(payload?.name);
      if (!name.ok) throw Error(name.reason);
      const confirmed = requireConfirm(payload?.confirm);
      if (!confirmed.ok) throw Error(confirmed.reason);
      const installed = readInstalledPlugins(profile.dir).find(
        (plugin) => plugin.name === name.value,
      );
      if (!installed)
        throw Error("这个插件不在当前 profile 的已装列表里：" + name.value);
      /**
       * profile 里记的是**取值**（registry 形态是版本范围 `^1.9.28`），不是安装地址；
       * 直接把它交给 pnpm 会被当成包名而失败（本轮线上踩到）。这里按已装事实拼出
       * 可安装地址，并且**在动手卸载之前**就用 `validateSpec` 校验 —— 装不成的地址
       * 绝不能先卸载再失败，那会把用户的插件弄丢。
       */
      const checks = await rpcContext.store.call<{ checks: UpdateCheck[] }>(
        "installed.getChecks",
      );
      const check = (checks?.checks ?? []).find((item) => item.name === installed.name);
      const target = check?.latestVersion;
      const installSpec = installSpecFor(
        installed,
        profile.dir,
        typeof target === "string" && target !== "" ? target : undefined,
      );
      const verified = validateSpec(installSpec);
      if (!verified.ok)
        throw Error(`无法从已装事实组装安装地址：${verified.reason}（记录值 ${redactSpec(installed.spec)}）`);
      return queue.enqueue({
        kind: "update",
        target: installed.name,
        // 记录值只作展示与回滚依据；凭据不进操作历史。
        spec: redactSpec(installed.spec),
        installSpec: verified.value,
        restoreSpec: installSpecFor(installed, profile.dir),
        specKind: installed.kind,
      });
    },
    "op.remove": async (payload: any): Promise<OpTask> => {
      const name = validateName(payload?.name);
      if (!name.ok) throw Error(name.reason);
      const confirmed = requireConfirm(payload?.confirm);
      if (!confirmed.ok) throw Error(confirmed.reason);
      return queue.enqueue({ kind: "remove", target: name.value });
    },
    "op.setEnabled": async (payload: any): Promise<OpTask> => {
      const name = validateName(payload?.name);
      if (!name.ok) throw Error(name.reason);
      if (typeof payload?.enabled !== "boolean")
        throw Error("enabled 必须是布尔值");
      const confirmed = requireConfirm(payload?.confirm);
      if (!confirmed.ok) throw Error(confirmed.reason);
      return queue.enqueue({
        kind: payload.enabled ? "enable" : "disable",
        target: name.value,
      });
    },
    /**
     * 热重载：让宿主按**磁盘上当前的代码**重新组合并加载这个插件，无需重启。
     *
     * 典型用途：本插件或任何 `link:` 包重建了 `dist/` 之后，把新代码换进运行中的宿主。
     * 只对**当前已启用**的插件开放 —— 重载不改启用状态（要改请用启停）。
     */
    "op.reload": async (payload: any, rpcContext: RpcContext): Promise<OpTask> => {
      const name = validateName(payload?.name);
      if (!name.ok) throw Error(name.reason);
      const confirmed = requireConfirm(payload?.confirm);
      if (!confirmed.ok) throw Error(confirmed.reason);
      const plugins = readInstalledPlugins(profile.dir);
      const installed = plugins.find((plugin) => plugin.name === name.value);
      if (!installed)
        throw Error("这个插件不在当前 profile 的已装列表里：" + name.value);
      if (!installed.selected)
        throw Error(
          `${installed.name} 当前是停用状态：热重载只重新组合已启用的插件，不会替你改启用状态（请先启用）`,
        );
      const self = selfPackageName(
        profile.dir,
        plugins.map((plugin) => ({ name: plugin.name, spec: plugin.spec })),
      );
      if (self === installed.name)
        return await deferSelfReload(installed.name, rpcContext, () => manager, log);
      return queue.enqueue({ kind: "reload", target: installed.name });
    },
    /** 已装插件与其配置：导出到文件 / 从文件导入（预检 + 执行）。
     *
     * 导出写进 `<dataDir>/exports/`；导入只接受**插件港湾自己的导出格式**（格式校验失败
     * 一律报错，绝不「当作空清单」继续）。导入的实际变更全部经宿主 `pluginManager`，
     * 并且只增不删（见 `docs/ARCHITECTURE.md`）。
     */
    "export.list": async (): Promise<{ name: string; path: string; bytes: number; at: number }[]> => {
      const dir = uploadsDir();
      if (!existsSync(dir)) return [];
      const out: { name: string; path: string; bytes: number; at: number }[] = [];
      for (const name of readdirSync(dir).sort().reverse()) {
        if (!name.endsWith(".json")) continue;
        const path = join(dir, name);
        try {
          const stats = statSync(path);
          if (!stats.isFile()) continue;
          out.push({ name, path, bytes: stats.size, at: stats.mtimeMs });
        } catch {
          continue;
        }
      }
      return out;
    },
    "export.run": async (payload: any) => {
      const confirmed = requireConfirm(payload?.confirm);
      if (!confirmed.ok) throw Error(confirmed.reason);
      const includeData = payload?.includeData === true;
      const plugins = readInstalledPlugins(profile.dir);
      const entries = manager ? await readHostEntries(manager) : undefined;
      const now = Date.now();
      const bundle = buildExport({
        profileName: profile.name,
        profileDir: profile.dir,
        pluginVersion: VERSION,
        plugins,
        settings,
        ...(entries === undefined ? {} : { entries }),
        includeData,
        selfDirName: "plugin-harbor",
        now,
      });
      const name = exportFileName(profile.name, now);
      const path = join(uploadsDir(), name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, serializeExport(bundle), "utf8");
      const bytes = statSync(path).size;
      log(`导出 ${plugins.length} 个插件 → ${path}（${bytes} 字节）`);
      return {
        name,
        path,
        bytes,
        plugins: bundle.plugins.length,
        files: bundle.plugins.reduce((sum, plugin) => sum + (plugin.files?.length ?? 0), 0),
        omissions: bundle.omissions,
        warnings: bundle.warnings,
      };
    },
    /** 把界面选中的文件收进来，返回可直接用于预检/导入的路径。 */
    "import.upload": async (payload: any) => saveUploaded(payload),
    /** 预检：**不写任何东西**，只把计划与需要人工粘贴的片段算出来给界面看。 */
    "import.preview": async (payload: any): Promise<unknown> => {
      const { bundle, source } = loadExport(resolveExportPath(payload?.path));
      const entries = manager ? await readHostEntries(manager) : undefined;
      const plan = planImport({
        source,
        bundle,
        profileName: profile.name,
        profileDir: profile.dir,
        installed: readInstalledPlugins(profile.dir),
        settings,
        ...(entries === undefined ? {} : { entries }),
      });
      const snippet = patchSnippet(bundle, profile.name);
      return { plan, ...(snippet === undefined ? {} : { snippet }) };
    },
    /**
     * 导入：把**服务端**算好的计划交给队列逐步执行。
     *
     * ⚠️ 客户端只给文件路径与确认，不提供计划内容；每个安装地址都再过一次
     * `validateSpec`（与手动安装同一道闸）。
     */
    "op.import": async (payload: any): Promise<OpTask> => {
      const confirmed = requireConfirm(payload?.confirm);
      if (!confirmed.ok) throw Error(confirmed.reason);
      const path = resolveExportPath(payload?.path);
      const { bundle, source } = loadExport(path);
      const entries = manager ? await readHostEntries(manager) : undefined;
      const plan = planImport({
        source,
        bundle,
        profileName: profile.name,
        profileDir: profile.dir,
        installed: readInstalledPlugins(profile.dir),
        settings,
        ...(entries === undefined ? {} : { entries }),
      });
      const steps = [];
      for (const step of plan.steps) {
        if (step.action === "install") {
          const checked = validateSpec(step.spec);
          if (!checked.ok) throw Error(`导入地址不合法（${step.name}）：${checked.reason}`);
          steps.push({ ...step, spec: checked.value });
          continue;
        }
        steps.push(step);
      }
      /**
       * 带 `config` 的行只能人工粘贴（宿主没有写 config 的接口，本项目也不改 profile 补丁）：
       * 先把片段写到文件里，路径随任务结论一起给用户，省得他自己拼 YAML。
       */
      let snippetPath: string | undefined;
      const snippet = patchSnippet(bundle, profile.name);
      if (snippet !== undefined) {
        snippetPath = join(uploadsDir(), `${exportFileName(profile.name, Date.now()).replace(/\.json$/, "")}-patch.yml`);
        mkdirSync(dirname(snippetPath), { recursive: true });
        writeFileSync(snippetPath, snippet, "utf8");
        log(`导入的配置片段已写到 ${snippetPath}（需要人工粘贴，宿主没有写 config 的接口）`);
      }
      const counts = countSteps(steps);
      return queue.enqueue({
        kind: "import",
        target: path,
        importSteps: steps,
        importCount: plan.steps.length,
        ...(snippetPath === undefined ? {} : { importSnippetPath: snippetPath }),
        note: describePlanCounts(counts),
      });
    },
    /** 运行中的队列 + 跨重启的历史（历史来自 `ops` 表）。 */
    "op.list": async (_payload: any, rpcContext: RpcContext) => {
      const history = await rpcContext.store.call<{ tasks: OpTask[] }>(
        "op.listOps",
        { limit: 50 },
      );
      return {
        active: queue.activeId() ?? null,
        tasks: queue.list(),
        history: history?.tasks ?? [],
      };
    },
    "op.cancel": async (payload: any): Promise<{ cancelled: boolean }> => {
      const id = validateTaskId(payload?.id);
      if (!id.ok) throw Error(id.reason);
      return { cancelled: await queue.cancel(id.value) };
    },
  };

  /**
   * 本插件自己的热重载：**先回执、后动手**。
   *
   * 宿主重新组合会把运行中的本插件换掉，队列与任务对象一起消失，那条 RPC 的响应就
   * 永远发不出去。因此这里先写一条终态记录（如实写「已请求宿主热重载」），把回执送出
   * 去，延迟后再请宿主重新组合；万一那次重载失败（此时插件还在），把历史改成失败原因。
   */
  async function deferSelfReload(
    target: string,
    rpcContext: RpcContext,
    managerOf: () => PluginManagerLike | undefined,
    logLine: (message: string) => void,
  ): Promise<OpTask> {
    const hot = rpcContext.hot();
    const now = Date.now();
    const note = hot
      ? "已请求宿主热重载本插件：正在用磁盘上的新代码替换运行中的实例，面板会重新连接（界面若没有自动更新，刷新一次页面即可）"
      : "本 profile 未启用热重载（宿主没有 hmr 服务）：本插件的新代码要等下次启动 DSH 才生效";
    const task: OpTask = {
      id: `reload-self-${now}`,
      kind: "reload",
      target,
      status: hot ? "done" : "restart-required",
      ...(hot ? {} : { needsRestart: true }),
      note,
      log: [note],
      queuedAt: now,
      endedAt: now,
    };
    // 历史是旁路：写库失败也要把回执发出去
    await rpcContext.store.call("op.putOp", { task }).catch(() => {});
    if (!hot) return task;
    setTimeout(() => {
      void (async () => {
        const current = managerOf();
        if (!current) {
          logLine("自热重载：宿主 pluginManager 服务已不在，跳过");
          return;
        }
        try {
          const outcome = await setEnabledWithManager(current, target, true);
          logLine(`自热重载：${outcome.message}`);
          if (outcome.status === "failed")
            await rpcContext.store
              .call("op.putOp", {
                task: {
                  ...task,
                  status: "failed" as const,
                  error: outcome.message,
                  note: outcome.message,
                  endedAt: Date.now(),
                },
              })
              .catch(() => {});
        } catch (error) {
          logLine(`自热重载失败：${error instanceof Error ? error.message : error}`);
        }
      })();
    }, SELF_RELOAD_DELAY_MS);
    return task;
  }

  const dispatch = createDispatcher({ ...handlers, ...opHandlers });
  /**
   * 同一时刻只跑一次同步：并发点两次「刷新目录」不该拉两遍 19.2MB，
   * 也不该让两次写库互相打断（分片按 chunk_url 整片替换，交叉执行会互相清行）。
   */
  let running: Promise<SyncReport> | null = null;
  const rpc: RpcContext = {
    profile,
    store,
    log: (message) => ctx?.logger?.info?.(`plugin-harbor: ${message}`),
    syncing: () => running !== null,
    /**
     * 热重载能力：宿主上下文里有 `hmr` 服务就说明变更能原地生效（桌面启动器会启用
     * `dsh-base` 的 `hmr` 条目）。**晚绑定**，所以每次调用现读，不缓存。
     */
    hot: () => ctx?.get?.("hmr") !== undefined,
    refresh: () => {
      if (running) return running;
      running = syncCatalog({
        fetch: fetchText,
        store,
        log: (message) => ctx?.logger?.info?.(`plugin-harbor: ${message}`),
        now: () => Date.now(),
        siteBase: SITE_BASE,
        apiBase: API_BASE,
        locale: "zh",
      })
        .catch((error) => {
          rpc.log(`同步失败：${error instanceof Error ? error.message : error}`);
          throw error;
        })
        .finally(() => {
          running = null;
        });
      return running;
    },
  };

  /**
   * 挂到宿主的 connection 通道。
   *
   * 宿主未提供 `connection.fetch.register` 时**静默返回**：本插件不是宿主启动
   * 的必要条件，缺服务只意味着界面打不开，不该让宿主启动失败。
   */
  const mount = () => {
    const connection = ctx.get?.("connection");
    if (!connection?.fetch?.register) return;
    return connection.fetch.register({
      path: RPC_PATH,
      methods: ["POST"],
      requestBody: "buffered",
      async fetch(request: Request) {
        const respond = (rpcId: string, result: unknown) =>
          Response.json({ type: "server-response", rpcId, result });
        try {
          if (request.method !== "POST")
            return new Response("method not allowed", { status: 405 });
          if (
            request.headers.get("content-type")?.split(";")[0] !==
            "application/json"
          )
            return new Response("JSON required", { status: 415 });
          const parsed = readEnvelope(await request.json());
          if (!parsed.ok)
            return respond(parsed.rpcId, {
              ok: false,
              error: {
                code: "plugin-harbor/invalid-envelope",
                message: parsed.reason,
                details: {},
              },
            });
          const outcome: RpcOutcome = await dispatch(
            parsed.envelope.method,
            parsed.envelope.payload,
            rpc,
          );
          return respond(
            parsed.envelope.rpcId,
            outcome.ok
              ? { ok: true, value: outcome.value }
              : { ok: false, error: { ...outcome.error, details: {} } },
          );
        } catch (error) {
          return respond("invalid", {
            ok: false,
            error: {
              code: "plugin-harbor/error",
              message: redact(error),
              details: {},
            },
          });
        }
      },
    });
  };
  if (ctx?.inject) ctx.inject(["connection"], mount);
  else mount();

  /**
   * 宿主管理服务：有它，安装/卸载/启停就走宿主的完整流水线（profile 写锁、
   * registry 回退、失败还原、构建脚本审批、兼容性闸门）；没有则编排层退回
   * `dsh plugin` 子进程（启停没有兜底）。
   */
  const mountManager = () => {
    const service = ctx.get?.("pluginManager");
    if (!service) return;
    manager = service as PluginManagerLike;
    log("宿主 pluginManager 服务已就绪：变更操作优先走宿主流水线");
  };
  if (ctx?.inject) ctx.inject(["pluginManager"], mountManager);
  else mountManager();

  let stopped = false;
  /**
   * 开发用自动重载：`dist/` 一变就请宿主按磁盘上的新代码重新组合本插件。
   *
   * 只在**检出目录**里启用（判据见 `ops/watch.ts#shouldWatch`：包里得有 `src/index.ts`，
   * 而 `package.json` 的 `files` 不含 `src/`，所以正式安装的副本里这段是惰性的）。
   * `PLUGIN_HARBOR_HOT_RELOAD=0` 可显式关掉。
   *
   * ⚠️ 重载动作走宿主 `setBundleEnabled(name, true)`，不自己清模块缓存：那条路要依赖
   * 内核内部结构，而且失败时容易把插件留在半死状态。宿主没有 hmr 服务时如实记一行，
   * 不假装重载成功。
   */
  let stopWatch: (() => void) | undefined;
  const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
  if (shouldWatch(packageDir)) {
    const distDir = join(packageDir, "dist");
    /** 一次构建会连写多个产物，同一时刻只跑一次重载；期间来的变更排队再来一次。 */
    let reloading = false;
    let queued = false;
    const reloadFromDisk = () => {
      if (stopped) return;
      if (reloading) {
        queued = true;
        return;
      }
      const current = manager;
      if (!current) {
        log("自动重载：宿主 pluginManager 服务还没就绪，跳过这次");
        return;
      }
      if (ctx.get?.("hmr") === undefined) {
        log("自动重载：本 profile 没有 hmr 服务（宿主要重启才生效），跳过");
        return;
      }
      reloading = true;
      log("自动重载：检测到 dist 变化，请求宿主按磁盘上的新代码重新组合本插件");
      void setEnabledWithManager(current, name, true)
        .then((outcome) => {
          log(`自动重载：${outcome.message}`);
          if (outcome.status === "failed")
            log(`自动重载失败：${outcome.message}（可点「热重载」按钮重试，或重启 DSH）`);
        })
        .catch((error: any) =>
          log(`自动重载异常：${error instanceof Error ? error.message : error}`),
        )
        .finally(() => {
          reloading = false;
          if (!queued) return;
          queued = false;
          reloadFromDisk();
        });
    };
    stopWatch = watchDist({
      dir: distDir,
      // 只认宿主侧产物：`client.js` 是浏览器入口，改它不需要重新组合宿主
      filter: (file) =>
        file === "index.js" ||
        file === "catalog-worker.js" ||
        file.endsWith("/index.js") ||
        file.endsWith("/catalog-worker.js"),
      onChange: reloadFromDisk,
      logger: { info: log, warn: log },
    });
    log(`自动重载已启用：监视 ${distDir}（PLUGIN_HARBOR_HOT_RELOAD=0 可关闭）`);
    if (typeof ctx.effect === "function") ctx.effect(() => stopWatch);
  }

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    stopWatch?.();
    stopWatch = undefined;
    await store.close();
  };
  return Object.assign(stop, {
    dispatch,
    stop,
    profile,
    store,
    queue,
    rpcMethod: RPC_METHOD,
    rpcPath: RPC_PATH,
    rpcVersion: RPC_VERSION,
  });
}