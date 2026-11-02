/**
 * 插件港湾浏览器入口（侧边栏图标 + 整窗面板）。
 *
 * 形态与参考项目 channel-hub 一致：宿主 `window.__ModuleLoader__` 提供 React，
 * 这里用 `h()` 手写组件（不用 JSX），样式来自 `client.css` 并由 esbuild 以
 * text loader 内联成字符串，随面板挂一个 `<style>`。
 *
 * ⚠️ `sidebar.panellist` 的 `id` 与 `main` 的 `key` **必须逐字相同**：宿主用
 * 这个 id 把图标与面板绑起来，写得不一致时点图标抛 `unknown panel`。
 *
 * ⚠️ 市场列表**必须窗口化**：目录 19,866 条，实测整表渲染 491ms 且产生约
 * 16 万个 DOM 节点（React 元素树本身 23.8MB）。这里用固定行高 + 上下占位块，
 * 只渲染可见窗 ± 缓冲，DOM 行数上限约 30。
 */
import css from "./client.css";

declare const window: Window & { __ModuleLoader__: any };

/** 由 `scripts/build.mjs` 按源码内容哈希注入（模块级声明：`declare` 只能在顶层）。 */
declare const __HARBOR_BUILD__: string;

window.__ModuleLoader__.load({
  id: "dsh-plugin-harbor",
  factory: (require: any) => {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const PANEL_ID = "plugin-harbor";
    const LABEL = "插件港湾";

    /**
     * 本面板的构建标识（与宿主侧同一个注入值）。
     *
     * ⚠️ 客户端 bundle 是**页面加载时从磁盘现取**的，宿主侧 `index.js` 要等重启或一次
     * profile 重新组合才换 —— 于是会出现「面板调用新方法，宿主回
     * `Unknown method: export.run`」。这里拿它和 `/status` 的 `build` 比对，直接把
     * 情况和修法说清楚，而不是让用户对着那句错发愣（本轮实测的报障就是这么来的）。
     */
    const BUILD: string = typeof __HARBOR_BUILD__ === "string" ? __HARBOR_BUILD__ : "dev";
    const STALE_HOST_TEXT =
      "宿主里运行的插件还是旧构建：界面已经从磁盘加载了新版本，宿主侧要等重启 DSH，或对任意" +
      "另一个插件做一次启用 / 停用 / 更新（任何一次 profile 重新组合都会把磁盘上已变化的插件代码换进来）。";
    /** 暴露构建标识：诊断用（测试也能从注册对象上直接读到，见注册处）。 */
    (globalThis as any).__PLUGIN_HARBOR_BUILD__ = BUILD;
    const TABS = [
      { id: "market", label: "市场" },
      { id: "installed", label: "已装" },
      { id: "ops", label: "操作" },
      { id: "settings", label: "设置" },
    ];
    /** 窗口化渲染的三个常数：行高决定滚动条长度，缓冲决定预渲染行数。 */
    const ROW_HEIGHT = 64;
    const OVERSCAN = 6;
    const PAGE_SIZE = 50;
    const SEARCH_DEBOUNCE_MS = 250;
    /** 站点的 11 个一级分类（键与 dsh-plugin.org 一致）。 */
    const CATEGORY_LABELS: Record<string, string> = {
      interface: "界面与体验",
      session: "会话与消息",
      memory: "记忆与上下文",
      tools: "工具与能力",
      agent: "技能与智能体",
      workflow: "工作流与自动化",
      integration: "集成与连接",
      model: "模型与推理",
      dev: "开发与运维",
      knowledge: "数据与知识",
      fun: "娱乐",
    };
    const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);
    const SORTS = [
      { id: "stars", label: "按 Star" },
      { id: "updated", label: "最近更新" },
      { id: "added", label: "最新收录" },
      { id: "name", label: "名称" },
    ];

    const formatStars = (value: any) =>
      typeof value === "number" && Number.isFinite(value)
        ? value.toLocaleString("zh-CN")
        : "—";

    /** 安装形态的中文说法（界面不直接暴露 registry/git 这类术语给所有用户）。 */
    const KIND_LABELS: Record<string, string> = {
      registry: "npm 包",
      git: "GitHub 仓库",
      path: "本地路径",
      tarball: "压缩包",
      unknown: "未知来源",
    };

    const kindLabel = (kind: any) => KIND_LABELS[String(kind)] ?? String(kind ?? "未知来源");

    /** 诊断一行的渲染（纯函数，便于在设置页复用）。 */
    function renderCheck(entry: any) {
      return h(
        "div",
        { className: "pc-diag-row", key: entry.id, "data-check": entry.id },
        h(
          "span",
          {
            className:
              "pc-chip " + (entry.ok === true ? "is-ok" : entry.ok === false ? "is-err" : ""),
          },
          entry.ok === true ? "通过" : entry.ok === false ? "失败" : "无结论",
        ),
        h("span", { className: "pc-diag-label" }, entry.label),
        h("span", { className: "pc-diag-detail", title: entry.detail }, entry.detail),
        h("span", { className: "pc-op-time" }, (entry.ms ?? 0) + "ms"),
      );
    }

    const formatTime = (value: any) =>
      typeof value === "number" && value > 0
        ? new Date(value).toLocaleString("zh-CN", { hour12: false })
        : "—";

    /**
     * 变更怎么生效的一句话。
     *
     * ⚠️ 三态，不许猜：宿主有 `hmr` 服务时改动**原地生效**（实测桌面启动器会启用
     * `dsh-base` 的 `hmr` 条目），没有时才需要重启；`status` 还没回来的那一瞬间也
     * 不替宿主下结论 —— 结论最终以每次操作返回的 `application` 为准。
     */
    const effectText = (status: any): string => {
      if (status?.hot === true) return "宿主热重载后立即生效，无需重启 DSH";
      if (status?.hot === false) return "该 profile 未启用热重载，需要重启 DSH 才生效";
      return "是否要重启由宿主决定（面板会照实显示）";
    };

    /** 队列任务的状态徽标。 */
    const OP_STATUS: Record<string, { label: string; tone: string }> = {
      queued: { label: "排队中", tone: "" },
      running: { label: "进行中", tone: "is-on" },
      done: { label: "已完成", tone: "is-ok" },
      "restart-required": { label: "待重启", tone: "is-warn" },
      failed: { label: "失败", tone: "is-err" },
      cancelled: { label: "已取消", tone: "" },
    };

    /** 操作页一行：进度、最近日志、取消按钮。 */
    function OpRow({ task, onCancel }: any) {
      const status = OP_STATUS[task.status] ?? OP_STATUS.failed;
      const running = task.status === "running" || task.status === "queued";
      /**
       * 显示**真正交给 pnpm 的地址**（`installSpec`）：更新时 profile 里记的是版本范围
       * （`^1.9.28`），而实际安装地址是 `<包名>@<目标版本>`。把范围当地址显示会让人
       * 以为「更新到 ^1.9.28」（本轮实测的误解点），所以优先显示 `installSpec`。
       */
      const shownSpec = task.installSpec ?? task.spec;
      return h(
        "div",
        { className: "pc-op", "data-task": task.id, "data-status": task.status },
        h(
          "div",
          { className: "pc-op-head" },
          h("span", { className: "pc-chip " + status.tone }, status.label),
          h("span", { className: "pc-op-kind" }, task.kind),
          h("span", { className: "pc-op-target", title: shownSpec ?? task.target },
            shownSpec && shownSpec !== task.target
              ? `${task.target} ← ${shownSpec}`
              : task.target),
          h("span", { className: "pc-op-time" }, formatTime(task.endedAt ?? task.queuedAt)),
          typeof task.progress === "number"
            ? h("span", { className: "pc-op-progress" }, task.progress + "%")
            : null,
          running
            ? h(
                "button",
                {
                  type: "button",
                  className: "pc-btn is-small",
                  onClick: () => onCancel(task.id),
                },
                "取消",
              )
            : null,
        ),
        typeof task.progress === "number" && running
          ? h(
              "div",
              { className: "pc-bar" },
              h("div", { className: "pc-bar-fill", style: { width: task.progress + "%" } }),
            )
          : null,
        task.error ? h("p", { className: "pc-row-warn" }, task.error) : null,
        task.note ? h("p", { className: "pc-row-note" }, task.note) : null,
        task.log && task.log.length > 0
          ? h(
              "pre",
              { className: "pc-op-log" },
              task.log.slice(-8).join("\n"),
            )
          : null,
      );
    }

    /** 操作页：进行中 / 排队 / 历史。 */
    function Ops({ ops, error, onCancel, busy }: any) {
      const tasks = Array.isArray(ops?.tasks) ? ops.tasks : [];
      const history = Array.isArray(ops?.history) ? ops.history : [];
      const live = tasks.filter(
        (task: any) => task.status === "queued" || task.status === "running",
      );
      const finished = tasks.filter(
        (task: any) => task.status !== "queued" && task.status !== "running",
      );
      return h(
        "div",
        { className: "pc-market" },
        h(
          "div",
          { className: "pc-summary" },
          h("span", null, `进行中 ${live.length}`),
          h("span", null, `本次会话已完成 ${finished.length}`),
          h("span", null, `历史 ${history.length}`),
          busy ? h("span", null, "刷新中…") : null,
        ),
        error ? h("p", { className: "pc-error" }, error) : null,
        h(
          "div",
          { className: "pc-list" },
          live.length === 0 && finished.length === 0 && history.length === 0
            ? h(
                "p",
                { className: "pc-note" },
                "还没有操作记录。在市场页点「安装」、在已装页点「更新 / 卸载」都会记在这里。",
              )
            : [
                live.length > 0
                  ? h("h4", { className: "pc-op-group", key: "live" }, "进行中")
                  : null,
                live.map((task: any) =>
                  h(OpRow, { key: task.id, task, onCancel }),
                ),
                finished.length > 0
                  ? h("h4", { className: "pc-op-group", key: "done" }, "本次会话")
                  : null,
                finished.map((task: any) =>
                  h(OpRow, { key: task.id, task, onCancel }),
                ),
                history.length > 0
                  ? h("h4", { className: "pc-op-group", key: "history" }, "历史记录（跨重启）")
                  : null,
                history
                  .filter(
                    (task: any) =>
                      !tasks.some((live2: any) => live2.id === task.id),
                  )
                  .map((task: any) => h(OpRow, { key: task.id, task, onCancel })),
              ],
        ),
      );
    }

    /**
     * 确认弹窗。
     *
     * 所有变更操作都必须先过这里：服务端还会再要一次 `confirm: true`
     * （防止别处直接调 RPC），这道弹窗是它对应的用户动作。
     */
    function ConfirmDialog({ dialog, onClose }: any) {
      if (!dialog) return null;
      return h(
        "div",
        { className: "pc-overlay", role: "dialog", "aria-modal": "true" },
        h(
          "div",
          { className: "pc-dialog" },
          h("h3", null, dialog.title),
          h("p", { className: "pc-dialog-body" }, dialog.body),
          dialog.detail
            ? h("pre", { className: "pc-op-log" }, dialog.detail)
            : null,
          h(
            "div",
            { className: "pc-dialog-actions" },
            h(
              "button",
              { type: "button", className: "pc-btn", onClick: () => onClose(null) },
              "取消",
            ),
            h(
              "button",
              {
                type: "button",
                className: "pc-btn is-primary",
                onClick: () => {
                  const action = dialog.action;
                  onClose(null);
                  action?.();
                },
              },
              dialog.confirmLabel ?? "确认",
            ),
          ),
        ),
      );
    }

    /** 站点默认基址（与 `core/settings.ts` 的默认值一致；设置里可改）。 */
    const DEFAULT_SITE_BASE = "https://dsh-plugin.org";

    /**
     * 目录行 → **dsh-plugin.org 上的插件详情页**地址。
     *
     * 路径段是 `/<lang>/plugins/<owner>/<slug>`（见 `docs/DATA-SOURCES.md` §4）。
     *
     * ⚠️ 必须是 owner + **slug**，不能拿 `repo` 切：slug 会重名（单分片实测 23 组，
     * `dsh-purge` 同时属于 4 个不同仓库），而详情页正是按 slug 路由的。
     * 也不接受 `repo` 兜底 —— 拼错会把用户带到别的插件的页面，比不给链接更糟。
     *
     * 安全：owner/slug 都来自外部数据，必须逐字符校验后再拼进 `href`，
     * 绝不直接拼接（`javascript:` 之类会被浏览器执行）。任一段不合法就返回空串，
     * 由调用方决定不渲染链接。
     */
    function siteUrl(row: any, siteBase?: string): string {
      const owner = typeof row?.owner === "string" ? row.owner.trim() : "";
      const slug = typeof row?.slug === "string" ? row.slug.trim() : "";
      if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(slug)) return "";
      const base = normalizeSiteBase(siteBase);
      if (base === "") return "";
      return `${base}/zh/plugins/${owner}/${slug}`;
    }

    /** 站点基址归一：只接受 http/https、去掉尾斜杠；不合法返回空串。 */
    function normalizeSiteBase(value: any): string {
      const raw =
        typeof value === "string" && value.trim() !== "" ? value.trim() : DEFAULT_SITE_BASE;
      try {
        const url = new URL(raw);
        if (url.protocol !== "https:" && url.protocol !== "http:") return "";
        // 带凭据的地址不进 href（会被当成认证信息泄露给页面）
        if (url.username !== "" || url.password !== "") return "";
        return url.origin + url.pathname.replace(/\/+$/, "");
      } catch {
        return "";
      }
    }

    /** 侧边栏图标：纯装饰（宿主已提供 aria-label，这里再加会让读屏念两遍）。 */
    function CenterIcon(props: any) {
      const size = typeof props?.size === "number" ? props.size : 18;
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.8,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          focusable: "false",
        },
        h("rect", { x: 3, y: 4, width: 18, height: 6.5, rx: 1.6 }),
        h("rect", { x: 3, y: 13.5, width: 7.5, height: 6.5, rx: 1.6 }),
        h("rect", { x: 13.5, y: 13.5, width: 7.5, height: 6.5, rx: 1.6 }),
        h("path", { d: "M6.6 7.2h10.8" }),
      );
    }

    function kv(label: string, value: any) {
      const shown =
        value === undefined || value === null || value === ""
          ? "—"
          : String(value);
      return h(
        "div",
        { className: "pc-kv-row", key: label },
        h("dt", null, label),
        h("dd", { title: shown }, shown),
      );
    }

    /** 一行插件：高度固定（窗口化依赖这一约定）。 */
    function Row({ row, installed, onInstall, siteBase }: any) {
      /**
       * 点仓库名 / 「源站」按钮 → **dsh-plugin.org 上该插件的详情页**。
       *
       * ⚠️ 用真的 `<a href target="_blank" rel="noopener noreferrer">`，不要
       * `window.open`：桌面宿主主窗口的 `setWindowOpenHandler` 对 http/https
       * 走 `shell.openExternal(url)` 再 `deny`（见 `lib/main.js`），所以新窗口
       * 不会真的在应用里开一个网页，而是交给系统浏览器 —— 这正是要的效果。
       */
      const url = siteUrl(row, siteBase);
      return h(
        "div",
        { className: "pc-row", "data-repo": row.repo },
        h(
          "div",
          { className: "pc-row-main" },
          h(
            "div",
            { className: "pc-row-title" },
            h("span", { className: "pc-row-name" }, row.displayName || row.name),
            // owner/slug 不合法（拼不出安全地址）时退回纯文本：不给能执行脚本的 href
            url === ""
              ? h("span", { className: "pc-row-repo" }, row.repo)
              : h(
                  "a",
                  {
                    className: "pc-row-repo is-link",
                    href: url,
                    target: "_blank",
                    rel: "noopener noreferrer",
                    title: "在浏览器中打开 dsh-plugin.org 详情页：" + url,
                    "data-open-site": row.repo,
                  },
                  row.repo,
                ),
          ),
          h(
            "p",
            { className: "pc-row-desc", title: row.description },
            row.description || "（站点未提供描述）",
          ),
        ),
        h(
          "div",
          { className: "pc-row-meta" },
          installed ? h("span", { className: "pc-chip is-on" }, "已装") : null,
          h("span", { className: "pc-row-stars" }, "★ " + formatStars(row.stars)),
          row.language ? h("span", { className: "pc-row-lang" }, row.language) : null,
          row.status === "verified"
            ? h("span", { className: "pc-chip is-ok" }, "已验证")
            : row.status
              ? h("span", { className: "pc-chip" }, row.status)
              : null,
          /**
           * 除了点仓库名，再给一个显式按钮：仓库名那行字很小、又可能被省略号截断，
           * 明确写「详情页」的按钮更好找（两者指向同一个地址）。
           */
          url === ""
            ? null
            : h(
                "a",
                {
                  className: "pc-btn is-small",
                  href: url,
                  target: "_blank",
                  rel: "noopener noreferrer",
                  title: "在浏览器中打开 dsh-plugin.org 详情页：" + url,
                  "data-open-site-button": row.repo,
                },
                "详情页",
              ),
          installed
            ? null
            : h(
                "button",
                {
                  type: "button",
                  className: "pc-btn is-small",
                  onClick: () => onInstall?.(row),
                },
                "安装",
              ),
        ),
      );
    }

    /** 市场页：目录浏览。组件不接触 URL 与 fetch，数据全部走 RPC。 */
    function Market({ call, installedRepos, onInstall, siteBase }: any) {
      const [state, setState] = useState({
        rows: [] as any[],
        total: null as number | null,
        facets: null as any,
        cursor: null as any,
        /** 输入框的即时值；`q` 是防抖后的实际查询词。 */
        qInput: "",
        q: "",
        category: "",
        sort: "stars",
        scrollTop: 0,
        viewportH: 560,
        busy: false,
        error: "",
        status: null as any,
        syncing: false,
      });
      const listRef = useRef(null);
      const scrollFrame = useRef(0);
      const mounted = useRef(true);

      const patch = useCallback(
        (values: any) => setState((previous: any) => ({ ...previous, ...values })),
        [],
      );

      /** 取一页（重置或追加）。查询条件由参数显式传入，避免闭包读到旧值。 */
      const loadRows = useCallback(
        async (options: any = {}) => {
          const query = {
            q: options.q ?? state.q,
            category: options.category ?? state.category,
            sort: options.sort ?? state.sort,
            limit: PAGE_SIZE,
            ...(options.cursor ? { cursor: options.cursor } : {}),
          };
          try {
            const page = await call("catalog.list", query);
            if (!mounted.current) return;
            setState((previous: any) => ({
              ...previous,
              rows: options.reset ? page.rows : [...previous.rows, ...page.rows],
              total: page.total,
              facets: page.facets ?? previous.facets,
              cursor: page.nextCursor ?? null,
              busy: false,
            }));
          } catch (cause: any) {
            patch({ busy: false, error: String(cause?.message ?? cause) });
          }
        },
        [call, state.q, state.category, state.sort, patch],
      );
      // 挂载 effect 只跑一次，因此通过 ref 取「最新的」loadRows，而不是把它列进
      // 依赖数组（列进去会让查询条件一变就重跑挂载逻辑，重复取第一页）。
      const loadRowsRef = useRef(null as any);
      loadRowsRef.current = loadRows;

      /**
       * 首次挂载：读目录状态；**没有目录数据且没有同步在跑**时自动拉一次
       * （对应「首次无缓存进入市场页」这条出网许可），随后取第一页。
       * 之后打开面板不会再自动出网。
       */
      useEffect(() => {
        mounted.current = true;
        let cancelled = false;
        (async () => {
          try {
            const status = await call("catalog.status");
            if (cancelled || !mounted.current) return;
            patch({ status, syncing: Boolean(status?.syncing) });
            if ((status?.rows ?? 0) === 0 && !status?.syncing) {
              patch({ busy: true });
              const report = await call("catalog.refresh");
              if (cancelled || !mounted.current) return;
              patch({
                error:
                  report?.failures?.length > 0
                    ? "部分分片取数失败：" + report.failures[0].reason
                    : "",
                syncing: false,
              });
            }
            await loadRowsRef.current?.({ reset: true });
          } catch (cause: any) {
            patch({ busy: false, error: String(cause?.message ?? cause) });
          }
        })();
        return () => {
          cancelled = true;
          mounted.current = false;
        };
      }, [call, patch]);

      // 搜索防抖：输入停下 250ms 后才真正查询。
      useEffect(() => {
        if (state.qInput === state.q) return undefined;
        const timer = setTimeout(() => {
          patch({ q: state.qInput, rows: [], cursor: null });
        }, SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
      }, [state.qInput, state.q, patch]);

      // 查询条件变化 → 清空并取第一页（首次由挂载 effect 负责，这里跳过）。
      const queryKey = state.q + "\u0000" + state.category + "\u0000" + state.sort;
      const lastKey = useRef("");
      useEffect(() => {
        if (lastKey.current === "") {
          lastKey.current = queryKey;
          return;
        }
        if (lastKey.current === queryKey) return;
        lastKey.current = queryKey;
        patch({ busy: true, error: "" });
        loadRows({
          reset: true,
          q: state.q,
          category: state.category,
          sort: state.sort,
        });
      }, [queryKey, patch, loadRows, state.q, state.category, state.sort]);

      // 量容器高度（宿主有 ResizeObserver；夹具里没有就保持默认值）。
      useEffect(() => {
        const element = listRef.current;
        if (!element || typeof ResizeObserver === "undefined") return undefined;
        const observer = new ResizeObserver(() => {
          const height = element.clientHeight;
          if (height > 0)
            setState((previous: any) =>
              previous.viewportH === height
                ? previous
                : { ...previous, viewportH: height },
            );
        });
        observer.observe(element);
        return () => observer.disconnect();
      }, []);

      const onScroll = useCallback(
        (event: any) => {
          const top = event?.currentTarget?.scrollTop ?? 0;
          if (typeof requestAnimationFrame !== "function") {
            patch({ scrollTop: top });
            return;
          }
          if (scrollFrame.current) return;
          scrollFrame.current = requestAnimationFrame(() => {
            scrollFrame.current = 0;
            patch({ scrollTop: top });
          });
        },
        [patch],
      );

      const rows = state.rows;
      const rowsPerScreen = Math.ceil(state.viewportH / ROW_HEIGHT);
      const windowSize = rowsPerScreen + OVERSCAN * 2;
      const start = Math.max(0, Math.floor(state.scrollTop / ROW_HEIGHT) - OVERSCAN);
      const end = Math.min(rows.length, start + windowSize);
      const visible = rows.slice(start, end);
      const nearEnd = end + rowsPerScreen >= rows.length;

      // 触底预取：距末尾不足一屏且还有游标时追加下一页。
      useEffect(() => {
        if (!nearEnd || state.busy || !state.cursor) return;
        patch({ busy: true });
        loadRows({ cursor: state.cursor });
      }, [nearEnd, state.busy, state.cursor, loadRows, patch]);

      const facets = state.facets;
      const categories = CATEGORY_ORDER.filter(
        (key) => (facets?.category?.[key] ?? 0) > 0,
      );

      return h(
        "div",
        { className: "pc-market" },
        h(
          "div",
          { className: "pc-toolbar" },
          h("input", {
            className: "pc-search",
            type: "search",
            placeholder: "搜索插件名称、描述、标签…",
            value: state.qInput,
            "aria-label": "搜索插件",
            onChange: (event: any) => patch({ qInput: event?.target?.value ?? "" }),
          }),
          h(
            "select",
            {
              className: "pc-select",
              value: state.sort,
              "aria-label": "排序方式",
              onChange: (event: any) => patch({ sort: event?.target?.value ?? "stars" }),
            },
            SORTS.map((sort) => h("option", { key: sort.id, value: sort.id }, sort.label)),
          ),
          h(
            "button",
            {
              type: "button",
              className: "pc-btn",
              disabled: state.busy || state.syncing,
              onClick: async () => {
                patch({ busy: true, error: "" });
                try {
                  const report = await call("catalog.refresh");
                  await loadRowsRef.current?.({ reset: true });
                  patch({
                    busy: false,
                    error:
                      report?.failures?.length > 0
                        ? "部分分片取数失败：" + report.failures[0].reason
                        : "",
                  });
                } catch (cause: any) {
                  patch({ busy: false, error: String(cause?.message ?? cause) });
                }
              },
            },
            state.syncing ? "同步中…" : "刷新目录",
          ),
        ),
        h(
          "div",
          { className: "pc-tabs is-sub" },
          h(
            "button",
            {
              key: "all",
              type: "button",
              className: "pc-tab" + (state.category === "" ? " is-on" : ""),
              onClick: () => patch({ category: "", rows: [], cursor: null }),
            },
            "全部",
          ),
          categories.map((key) =>
            h(
              "button",
              {
                key,
                type: "button",
                className: "pc-tab" + (state.category === key ? " is-on" : ""),
                onClick: () => patch({ category: key, rows: [], cursor: null }),
              },
              CATEGORY_LABELS[key] ?? key,
            ),
          ),
        ),
        h(
          "div",
          { className: "pc-summary" },
          state.error
            ? h("span", { className: "pc-error-inline" }, state.error)
            : null,
          h(
            "span",
            null,
            state.total === null
              ? "尚未取得目录"
              : `共 ${state.total.toLocaleString("zh-CN")} 条`,
          ),
          h("span", null, `已载入 ${rows.length} 条`),
          state.status?.lastSyncAt
            ? h(
                "span",
                null,
                "同步于 " + new Date(state.status.lastSyncAt).toLocaleString("zh-CN"),
              )
            : h("span", null, "尚未同步"),
          state.busy ? h("span", null, "读取中…") : null,
        ),
        h(
          "div",
          { className: "pc-list", ref: listRef, onScroll },
          rows.length === 0
            ? h(
                "p",
                { className: "pc-note" },
                state.busy
                  ? "正在从 dsh-plugin.org 拉取目录…（首次约 19MB，期间可继续用其他功能）"
                  : "没有匹配的插件。",
              )
            : [
                h("div", {
                  key: "top",
                  className: "pc-list-spacer",
                  style: { height: start * ROW_HEIGHT + "px" },
                }),
                visible.map((row: any) =>
                  h(Row, {
                    key: row.repo,
                    row,
                    installed: installedRepos?.has?.(row.repo) === true,
                    onInstall,
                    siteBase,
                  }),
                ),
                h("div", {
                  key: "bottom",
                  className: "pc-list-spacer",
                  style: { height: (rows.length - end) * ROW_HEIGHT + "px" },
                }),
              ],
        ),
      );
    }

    /** 已装页：profile 事实 + 更新结论。数量是个位数到几十个，不做窗口化。 */
    function Installed({
      call,
      installed,
      error,
      onReload,
      onUpdate,
      onHotReload,
      onRemove,
      onToggle,
      siteBase,
    }: any) {
      const [state, setState] = useState({ busy: false, error: "" });
      const [transfer, setTransfer] = useState(false);
      const rows = Array.isArray(installed) ? installed : [];
      const counts = { update: 0, latest: 0, unknown: 0 };
      let lastChecked = 0;
      for (const row of rows) {
        const verdict = row?.update?.updateAvailable;
        if (verdict === true) counts.update += 1;
        else if (verdict === false) counts.latest += 1;
        else counts.unknown += 1;
        const at = row?.update?.checkedAt ?? 0;
        if (at > lastChecked) lastChecked = at;
      }
      const check = async () => {
        setState({ busy: true, error: "" });
        try {
          await call("updates.check");
          await onReload?.();
          setState({ busy: false, error: "" });
        } catch (cause: any) {
          setState({ busy: false, error: String(cause?.message ?? cause) });
        }
      };
      return h(
        "div",
        { className: "pc-market" },
        h(
          "div",
          { className: "pc-toolbar" },
          h(
            "button",
            {
              type: "button",
              className: "pc-btn",
              disabled: state.busy,
              onClick: check,
            },
            state.busy ? "检查中…" : "检查更新",
          ),
          h(
            "button",
            {
              type: "button",
              className: "pc-btn",
              onClick: () => setTransfer((value: boolean) => !value),
            },
            transfer ? "收起导出 / 导入" : "导出 / 导入",
          ),
          h("span", { className: "pc-summary-inline" }, `已装 ${rows.length} 个插件`),
        ),
        transfer ? h(Transfer, { call, onDone: onReload }) : null,
        h(
          "div",
          { className: "pc-summary" },
          h("span", null, `可更新 ${counts.update}`),
          h("span", null, `已最新 ${counts.latest}`),
          h("span", null, `未判定 ${counts.unknown}`),
          lastChecked > 0
            ? h(
                "span",
                null,
                "检查于 " + new Date(lastChecked).toLocaleString("zh-CN"),
              )
            : h("span", null, "尚未检查"),
        ),
        error || state.error
          ? h("p", { className: "pc-error" }, error || state.error)
          : null,
        h(
          "div",
          { className: "pc-list" },
          rows.length === 0
            ? h(
                "p",
                { className: "pc-note" },
                "这个 profile 里没有第三方插件（宿主自带包不算）。",
              )
            : rows.map((row: any) =>
              h(InstalledRow, {
                key: row.name,
                row,
                onUpdate,
                onHotReload,
                onRemove,
                onToggle,
                siteBase,
              }),
            ),
        ),
      );
    }

    /** 卡片标题（设置页与导出 / 导入面板共用）。 */
    const cardHead = (title: string, sub: string) =>
      h(
        "header",
        { className: "pc-card-head" },
        h("h3", null, title),
        h("p", { className: "pc-card-sub" }, sub),
      );

    /**
     * 导出 / 导入面板（已装页内展开）。
     *
     * 口径（界面上也要说清，别让用户以为能一键还原一切）：
     *  - 导出：插件清单 + 归属到各插件的 profile 补丁行 + 本插件设置；插件自己的设置文件
     *    是**可选项**，导出时脱敏（数据库 / 缓存 / 日志 / 二进制一律不进）；
     *  - 导入：只增不删（不卸载任何东西），实际变更交给宿主；带 `config` 的补丁行宿主管不了，
     *    导入后会生成一份片段文件，需要人工粘贴。
     */
    function Transfer({ call, onDone }: any) {
      const [includeData, setIncludeData] = useState(false);
      const [busy, setBusy] = useState("");
      const [error, setError] = useState("");
      const [exported, setExported] = useState(null as any);
      const [files, setFiles] = useState([] as any[]);
      const [chosen, setChosen] = useState("");
      const [custom, setCustom] = useState("");
      const [preview, setPreview] = useState(null as any);
      const [imported, setImported] = useState(null as any);
      /**
       * 文件浏览器选中的那份文件的**服务端路径**。一旦选过，它优先于下拉框与手填路径 ——
       * 用户刚点的文件就是他想要的那个，不该再被「导出目录里的第一个文件」盖过去。
       */
      const [picked, setPicked] = useState(null as any);
      const fileInput = useRef(null as any);

      const loadFiles = useCallback(async () => {
        try {
          const rows = await call("export.list");
          const list = Array.isArray(rows) ? rows : [];
          setFiles(list);
          setChosen((current: string) => current || list[0]?.name || "");
        } catch (cause: any) {
          setError(String(cause?.message ?? cause));
        }
      }, [call]);

      useEffect(() => {
        loadFiles();
      }, [loadFiles]);

      const source =
        picked !== null ? picked.path : custom.trim() !== "" ? custom.trim() : chosen;

      /**
       * 预检一份**指定的**来源。
       *
       * ⚠️ 必须显式传路径，不能用闭包里的 `source`：选中文件后立刻预检时，state 还没
       * 重新渲染，闭包读到的仍是上一轮的 `source`（实测会预检到「导出目录里第一个文件」
       * 上，用户以为在看自己选的那份）。`runPreview` 是给按钮用的那个。
       */
      const previewOf = useCallback(
        async (path: string) => {
          setBusy("preview");
          setError("");
          setImported(null);
          try {
            setPreview(await call("import.preview", { path }));
          } catch (cause: any) {
            setPreview(null);
            setError(String(cause?.message ?? cause));
          } finally {
            setBusy("");
          }
        },
        [call],
      );

      /**
       * 「选择文件…」：读内容 → 交给服务端落盘 → 立刻预检。
       *
       * 浏览器只给 `File` 对象（内容在内存里），而预检与导入都只认服务端读得到的路径，
       * 所以内容要经 `import.upload` 落到本插件自己的 `exports/` 目录。宿主没有给插件
       * 用的原生文件对话框，`<input type="file">` 是唯一跨宿主可用的选择入口。
       */
      const pickFile = useCallback(
        async (file: any) => {
          if (!file) return;
          setBusy("pick");
          setError("");
          setPreview(null);
          setImported(null);
          try {
            const text = await file.text();
            const saved = await call("import.upload", { name: file.name, content: text });
            setPicked(saved);
            await loadFiles();
            await previewOf(saved.path);
          } catch (cause: any) {
            setPicked(null);
            setPreview(null);
            setError(String(cause?.message ?? cause));
          } finally {
            setBusy("");
          }
        },
        [call, loadFiles, previewOf],
      );

      const runExport = useCallback(async () => {
        setBusy("export");
        setError("");
        try {
          const result = await call("export.run", { includeData, confirm: true });
          setExported(result);
          setPreview(null);
          await loadFiles();
        } catch (cause: any) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy("");
        }
      }, [call, includeData, loadFiles]);

      const runPreview = useCallback(async () => await previewOf(source), [previewOf, source]);

      const runImport = useCallback(async () => {
        setBusy("import");
        setError("");
        try {
          const task = await call("op.import", { path: source, confirm: true });
          setImported(task);
          setPreview(null);
          await onDone?.();
        } catch (cause: any) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy("");
        }
      }, [call, source, onDone]);

      const plan = preview?.plan;
      return h(
        "section",
        { className: "pc-card", "data-transfer": "1" },
        cardHead("导出 / 导入", "把已装插件与它们的配置带走：导出到文件，或按导出恢复"),
        h(
          "div",
          { className: "pc-field" },
          h("span", { className: "pc-field-label" }, "导出"),
          h(
            "div",
            { className: "pc-form-footer is-inline" },
            h(
              "label",
              { className: "pc-field-hint" },
              h("input", {
                type: "checkbox",
                checked: includeData,
                onChange: (event: any) => setIncludeData(Boolean(event?.target?.checked)),
              }),
              " 同时导出各插件自己的设置文件（脱敏：疑似凭据替换为 [已脱敏]；数据库 / 缓存 / 日志 / 二进制不导出）",
            ),
            h(
              "button",
              {
                type: "button",
                className: "pc-btn",
                disabled: busy === "export",
                onClick: runExport,
              },
              busy === "export" ? "导出中…" : "导出到文件",
            ),
          ),
          exported
            ? h(
                "div",
                { className: "pc-note-block" },
                h("p", null, `已导出 ${exported.plugins} 个插件（${exported.bytes} 字节）→ ${exported.path}`),
                exported.files > 0
                  ? h("p", null, `含 ${exported.files} 个插件设置文件（已脱敏）`)
                  : null,
                exported.omissions?.length > 0
                  ? h(
                      "p",
                      null,
                      `未导出 ${exported.omissions.length} 项（数据库 / 缓存 / 认不出归属等），明细在文件的 omissions 里`,
                    )
                  : null,
                (exported.warnings ?? []).map((line: string) =>
                  h("p", { key: line, className: "pc-field-hint" }, "· " + line),
                ),
              )
            : null,
        ),
        h(
          "div",
          { className: "pc-field" },
          h("span", { className: "pc-field-label" }, "导入"),
          h(
            "div",
            { className: "pc-toolbar" },
            /**
             * 「选择文件…」是主入口：真实的 `<input type="file">` 交给浏览器弹文件浏览器，
             * 面板只负责把内容交给服务端落盘（`import.upload`）再预检。
             *
             * 样式上把 input 藏起来、用按钮代理点击 —— 原生 file 控件在各平台的宽度与
             * 按钮文案都不受控，放进来会把这一行撑变形；但它必须真的在 DOM 里且可点，
             * 否则脚本化的 click 在部分浏览器里不弹框。
             */
            h("input", {
              ref: fileInput,
              type: "file",
              accept: ".json,application/json",
              "data-pick": "1",
              style: { display: "none" },
              onChange: (event: any) => {
                const file = event?.target?.files?.[0];
                // 清空 value：否则连续选同一个文件不会再触发 change
                if (event?.target) event.target.value = "";
                void pickFile(file);
              },
            }),
            h(
              "button",
              {
                type: "button",
                className: "pc-btn is-primary",
                disabled: busy !== "",
                onClick: () => fileInput.current?.click(),
              },
              busy === "pick" ? "读取中…" : "选择文件…",
            ),
            h(
              "select",
              {
                className: "pc-input",
                value: chosen,
                onChange: (event: any) => {
                  setPicked(null);
                  setCustom("");
                  setChosen(String(event?.target?.value ?? ""));
                },
              },
              files.length === 0
                ? h("option", { value: "" }, "（导出目录里还没有文件）")
                : files.map((file: any) =>
                    h(
                      "option",
                      { key: file.name, value: file.name },
                      `${file.name}（${Math.round(file.bytes / 1024)}KB）`,
                    ),
                  ),
            ),
            h("input", {
              className: "pc-input",
              placeholder: "或填别的绝对路径（例如从另一台机器拷来的导出文件）",
              value: custom,
              onChange: (event: any) => {
                setPicked(null);
                setCustom(String(event?.target?.value ?? ""));
              },
            }),
            h(
              "button",
              {
                type: "button",
                className: "pc-btn",
                disabled: busy !== "" || source === "",
                onClick: runPreview,
              },
              busy === "preview" ? "预检中…" : "预检",
            ),
          ),
          picked !== null
            ? h(
                "span",
                { className: "pc-field-hint", "data-picked": "1" },
                `已选择：${picked.name}（${Math.round(picked.bytes / 1024)}KB）—— 已存入本插件的导出目录，可直接预检或导入`,
              )
            : null,
          h(
            "span",
            { className: "pc-field-hint" },
            "导入只增不删：只装缺失的、按导出恢复启用状态；不会卸载任何插件，也不改 profile 的 package.json / cordis.patch.yml。",
          ),
          plan ? h(PlanView, { plan }) : null,
          plan && plan.steps?.length > 0
            ? h(
                "button",
                {
                  type: "button",
                  className: "pc-btn is-primary",
                  disabled: busy === "import",
                  onClick: runImport,
                },
                busy === "import" ? "已下发…" : "开始导入",
              )
            : null,
          preview?.snippet
            ? h(
                "span",
                { className: "pc-field-hint" },
                `注意：导出里有 ${plan?.configRows ?? 0} 行带 config 的补丁行 —— 宿主没有写 config 的接口，` +
                  "开始导入后会生成一份 YAML 片段文件，需要你确认后自行粘贴到 profile 的 cordis.patch.yml。",
              )
            : null,
          imported
            ? h(
                "div",
                { className: "pc-note-block" },
                h("p", null, `已加入操作队列：${imported.note ?? ""}`),
                h("p", { className: "pc-field-hint" }, "进度与逐项结果在「操作」页；导入不阻塞这个面板。"),
              )
            : null,
        ),
        error ? h("p", { className: "pc-error" }, error) : null,
      );
    }

    const PLAN_LABELS: Record<string, string> = {
      install: "将安装",
      enable: "将启用",
      disable: "将停用",
      entries: "恢复条目开关",
      skip: "已一致",
      blocked: "无法处理",
    };

    /** 预检结果：先把「会发生什么」写清楚，再让用户点导入。 */
    function PlanView({ plan }: any) {
      const counts: Record<string, number> = {};
      for (const step of plan.steps ?? [])
        counts[step.action] = (counts[step.action] ?? 0) + 1;
      const summary = Object.entries(counts)
        .map(([action, count]) => `${PLAN_LABELS[action] ?? action} ${count}`)
        .join("｜");
      return h(
        "div",
        { className: "pc-plan", "data-plan": "1" },
        h("p", { className: "pc-summary-inline" }, summary || "没有需要处理的插件"),
        (plan.steps ?? []).map((step: any) =>
          h(
            "p",
            { key: step.name + step.action, className: "pc-note", "data-step": step.action },
            `${step.name}：${PLAN_LABELS[step.action] ?? step.action}` +
              (step.spec ? ` ← ${step.spec}` : "") +
              (step.reason ? `（${step.reason}）` : "") +
              (step.entries ? `（${step.entries.length} 个条目）` : ""),
          ),
        ),
        plan.settings?.changed?.length > 0
          ? h(
              "p",
              { className: "pc-note" },
              `本插件自己的设置会被覆盖：${plan.settings.changed.join("、")}`,
            )
          : null,
        plan.unattributedRows > 0
          ? h(
              "p",
              { className: "pc-note" },
              `另有 ${plan.unattributedRows} 行补丁没归到已装插件（已原样带在导出文件里）`,
            )
          : null,
        (plan.warnings ?? []).map((line: string) =>
          h("p", { key: line, className: "pc-field-hint" }, "· " + line),
        ),
      );
    }

    /** 已装页一行：名称 / 来源 / 当前版本 / 最新 / 结论徽标 + 变更按钮。 */
    function InstalledRow({ row, onUpdate, onHotReload, onRemove, onToggle, siteBase }: any) {
      const verdict = row?.update?.updateAvailable;
      const badge =
        verdict === true
          ? h("span", { className: "pc-chip is-warn" }, "可更新")
          : verdict === false
            ? h("span", { className: "pc-chip is-ok" }, "已最新")
            : h("span", { className: "pc-chip" }, "未判定");
      const latest =
        row?.update?.latestVersion ??
        (row?.update?.latestCommit
          ? row.update.latestCommit.slice(0, 7)
          : row?.detailVersion ?? "—");
      const detail = [
        `来源 ${row.spec || "未知"}（${kindLabel(row.kind)}）`,
        row.category ? CATEGORY_LABELS[row.category] ?? row.category : "",
        row.detailVersion ? `站点 ${row.detailVersion}` : "",
        row.dshTarget ? `目标 ${row.dshTarget}` : "",
      ]
        .filter((item) => item !== "")
        .join(" · ");
      const url = siteUrl(row, siteBase);
      return h(
        "div",
        { className: "pc-row is-tall", "data-plugin": row.name },
        h(
          "div",
          { className: "pc-row-main" },
          h(
            "div",
            { className: "pc-row-title" },
            h("span", { className: "pc-row-name" }, row.displayName || row.name),
            /**
             * 已装页的入口指向**站点详情页**：`slug`/`owner` 由服务端从目录行带过来
             * （`InstalledRow.slug`/`owner`）。拼不出安全地址就只显示文字。
             */
            url === ""
              ? h("span", { className: "pc-row-repo" }, row.name + (row.repo ? " · " + row.repo : ""))
              : h(
                  "a",
                  {
                    className: "pc-row-repo is-link",
                    href: url,
                    target: "_blank",
                    rel: "noopener noreferrer",
                    title: "在浏览器中打开 dsh-plugin.org 详情页：" + url,
                    "data-open-site": row.repo,
                  },
                  row.name + " · " + row.repo,
                ),
            badge,
            row.selected
              ? null
              : h("span", { className: "pc-chip is-muted" }, "未启用"),
          ),
          h("p", { className: "pc-row-desc", title: detail }, detail),
          row?.update?.error
            ? h("p", { className: "pc-row-warn" }, row.update.error)
            : row?.update?.note
              ? h("p", { className: "pc-row-note" }, row.update.note)
              : row?.installCommand
                ? h("p", { className: "pc-row-note" }, row.installCommand)
                : null,
        ),
        h(
          "div",
          { className: "pc-row-meta" },
          h("span", null, "当前 " + (row.version ?? "—")),
          h("span", null, "最新 " + latest),
          typeof row.stars === "number"
            ? h("span", null, "★ " + formatStars(row.stars))
            : null,
          // 变更动作：更新 / 卸载 / 启停。路径与压缩包装的插件没有远方版本可比，
          // 「更新」按钮仍给出（它会原样重装），但徽标已如实标成「未判定」。
          h(
            "button",
            {
              type: "button",
              className: "pc-btn is-small",
              onClick: () => onUpdate?.(row),
            },
            "更新",
          ),
          /**
           * 热重载只对**已启用**的插件开放：它是「按磁盘上当前的代码重新组合」，
           * 不改启用状态（重建过 dist/ 的已链接包靠它生效，不用重启 DSH）。
           */
          row.selected
            ? h(
                "button",
                {
                  type: "button",
                  className: "pc-btn is-small",
                  onClick: () => onHotReload?.(row),
                },
                "热重载",
              )
            : null,
          h(
            "button",
            {
              type: "button",
              className: "pc-btn is-small",
              onClick: () => onToggle?.(row),
            },
            row.selected ? "停用" : "启用",
          ),
          h(
            "button",
            {
              type: "button",
              className: "pc-btn is-small is-danger",
              onClick: () => onRemove?.(row),
            },
            "卸载",
          ),
        ),
      );
    }

    /**
     * 设置页。
     *
     * 同步间隔在界面上用**小时**输入、下发时换算成毫秒：这是最容易写错的一处，
     * 因此换算单独钉一条测试。
     */
    function Settings({ call, settings, status, error, onSaved }: any) {
      const [form, setForm] = useState({
        locale: settings?.locale ?? "zh",
        hours: settings ? String(Math.round((settings.syncTtlMs ?? 0) / 3_600_000)) : "24",
        siteBase: settings?.siteBase ?? "",
        apiBase: settings?.apiBase ?? "",
        registry: settings?.registry ?? "",
        proxy: settings?.proxy ?? "",
      });
      const [state, setState] = useState({
        busy: false,
        error: "",
        ok: "",
        checks: null as any,
        diagBusy: false,
        diagError: "",
      });
      /** 目录现状（条目数 / 上次同步），只读且仅本地。 */
      const [catalog, setCatalog] = useState(null as any);
      useEffect(() => {
        let cancelled = false;
        (async () => {
          try {
            const value = await call("catalog.status");
            if (!cancelled) setCatalog(value);
          } catch {
            // 读不到就在「存储与运行」里显示 —，不打扰用户
          }
        })();
        return () => {
          cancelled = true;
        };
      }, [call]);
      const set = (key: string, value: any) =>
        setForm((previous: any) => ({ ...previous, [key]: value }));

      const save = async () => {
        const hours = Number(form.hours);
        if (!Number.isFinite(hours) || hours <= 0) {
          setState((previous: any) => ({
            ...previous,
            ok: "",
            error: "同步间隔必须是大于 0 的小时数",
          }));
          return;
        }
        setState((previous: any) => ({ ...previous, busy: true, error: "", ok: "" }));
        try {
          const next = await call("settings.set", {
            locale: form.locale,
            syncTtlMs: Math.round(hours * 3_600_000),
            siteBase: form.siteBase,
            apiBase: form.apiBase,
            registry: form.registry,
            proxy: form.proxy,
          });
          onSaved?.(next);
          setState((previous: any) => ({ ...previous, busy: false, ok: "已保存" }));
        } catch (cause: any) {
          setState((previous: any) => ({
            ...previous,
            busy: false,
            error: String(cause?.message ?? cause),
          }));
        }
      };

      const runDiagnostics = async () => {
        setState((previous: any) => ({ ...previous, diagBusy: true, diagError: "" }));
        try {
          const checks = await call("diagnostics.run");
          setState((previous: any) => ({
            ...previous,
            diagBusy: false,
            checks: Array.isArray(checks) ? checks : [],
          }));
        } catch (cause: any) {
          setState((previous: any) => ({
            ...previous,
            diagBusy: false,
            diagError: String(cause?.message ?? cause),
          }));
        }
      };

      const field = (label: string, key: string, extra: any = {}) =>
        h(
          "label",
          { className: "pc-field", key },
          h("span", { className: "pc-field-label" }, label),
          extra.options
            ? h(
                "select",
                {
                  className: "pc-select pc-input",
                  value: (form as any)[key],
                  "aria-label": label,
                  onChange: (event: any) => set(key, event?.target?.value ?? ""),
                },
                extra.options.map((option: any) =>
                  h("option", { key: option.value, value: option.value }, option.label),
                ),
              )
            : h("input", {
                className: "pc-input",
                type: extra.type ?? "text",
                ...(extra.inputMode ? { inputMode: extra.inputMode } : {}),
                value: (form as any)[key],
                "aria-label": label,
                placeholder: extra.placeholder ?? "",
                onChange: (event: any) => set(key, event?.target?.value ?? ""),
              }),
          extra.hint ? h("span", { className: "pc-field-hint" }, extra.hint) : null,
        );

      const checks = state.checks;
      const summary = Array.isArray(checks)
        ? checks.reduce(
            (acc: any, entry: any) => {
              if (entry.ok === true) acc.ok += 1;
              else if (entry.ok === false) acc.fail += 1;
              else acc.unknown += 1;
              return acc;
            },
            { ok: 0, fail: 0, unknown: 0 },
          )
        : null;

      return h(
        "div",
        { className: "pc-market" },
        error || state.error
          ? h("p", { className: "pc-error" }, error || state.error)
          : null,
        h(
          "section",
          { className: "pc-card" },
          cardHead("目录与来源", "决定抓哪一套目录、多久刷新一次"),
          h(
            "div",
            { className: "pc-form" },
            field("界面与目录语言", "locale", {
              options: [
                { value: "zh", label: "简体中文（zh）" },
                { value: "en", label: "English（en）" },
              ],
              hint: "决定抓 /zh 还是 /en 的分片；界面文案暂不随此切换",
            }),
            field("自动刷新间隔（小时）", "hours", {
              placeholder: "24",
              inputMode: "decimal",
              hint: "15 分钟 – 30 天。无变更刷新只花 253KB",
            }),
            field("官网基址", "siteBase", {
              placeholder: "https://dsh-plugin.org",
              hint: "目录分片与插件详情页",
            }),
            field("API 中心基址", "apiBase", {
              placeholder: "https://api.dsh-plugin.org",
              hint: "curated 增强与收录统计",
            }),
          ),
          Array.isArray(settings?.notes) && settings.notes.length > 0
            ? h(
                "p",
                { className: "pc-note-block" },
                "读取设置时有字段被退回默认值：" + settings.notes.join("；"),
              )
            : null,
        ),
        h(
          "section",
          { className: "pc-card" },
          cardHead("网络与镜像", "留空表示用官方源与宿主代理"),
          h(
            "div",
            { className: "pc-form" },
            field("npm registry（留空用官方源）", "registry", {
              placeholder: "https://registry.npmjs.org",
              hint: "更新判据与安装都走它；可填国内镜像",
            }),
            field("出网代理（留空交给宿主）", "proxy", {
              placeholder: "http://127.0.0.1:7890",
              hint: "目录、registry、git 取数统一走它",
            }),
          ),
        ),
        h(
          "footer",
          { className: "pc-form-footer" },
          h(
            "span",
            { className: "pc-field-hint" },
            status?.dataDir ? "保存在 " + status.dataDir + "/settings.json" : "保存在本插件数据目录",
          ),
          state.ok ? h("span", { className: "pc-ok-inline" }, state.ok) : null,
          h(
            "button",
            {
              type: "button",
              className: "pc-btn is-primary",
              disabled: state.busy,
              onClick: save,
            },
            state.busy ? "保存中…" : "保存设置",
          ),
        ),
        h(
          "section",
          { className: "pc-card" },
          cardHead("存储与运行", "本地索引的现状（只读）"),
          h(
            "dl",
            { className: "pc-kv" },
            kv("profile", status?.profile),
            kv("数据目录", status?.dataDir),
            kv("目录库", status?.dbPath),
            kv("SQLite", status?.store?.sqlite),
            kv(
              "目录条目",
              catalog
                ? `${catalog.rows.toLocaleString("zh-CN")} 条` +
                  (catalog.totalCount === null
                    ? ""
                    : `（站点自报 ${catalog.totalCount.toLocaleString("zh-CN")}）`)
                : "—",
            ),
            kv("上次同步", catalog?.lastSyncAt ? formatTime(catalog.lastSyncAt) : "尚未同步"),
            kv("上次同步错误", catalog?.error ?? "无"),
            /**
             * 热重载能力：决定装完/改完要不要重启。来自宿主上下文里的 `hmr` 服务探测，
             * 不需要跑诊断就能看见（诊断里另有一项同样口径的检查）。
             */
            kv(
              "热重载",
              status?.hot === true
                ? "宿主已启用（变更原地生效，无需重启）"
                : status?.hot === false
                  ? "宿主未启用（变更需要重启 DSH）"
                  : "未知",
            ),
          ),
        ),
        h(
          "section",
          { className: "pc-card" },
          cardHead("诊断", "只读连通性检查，平时不会自动出网"),
          h(
            "div",
            { className: "pc-form-footer is-inline" },
            summary
              ? h(
                  "span",
                  { className: "pc-summary-inline" },
                  `通过 ${summary.ok}｜失败 ${summary.fail}｜无结论 ${summary.unknown}`,
                )
              : h("span", { className: "pc-field-hint" }, "还没有检查过"),
            h(
              "button",
              {
                type: "button",
                className: "pc-btn",
                disabled: state.diagBusy,
                onClick: runDiagnostics,
              },
              state.diagBusy ? "检查中…" : "运行诊断",
            ),
          ),
          state.diagError ? h("p", { className: "pc-error" }, state.diagError) : null,
          Array.isArray(checks) ? h("div", { className: "pc-diag" }, checks.map(renderCheck)) : null,
        ),
      );
    }

    function Panel(props: any) {
      const ctx = props?.ctx;
      /**
       * 版本化 RPC：与服务端 `readEnvelope` 的信封一一对应。
       * `result.ok === false` 时抛错，让界面走统一的错误条，而不是渲染半个页面。
       */
      const call = useCallback(
        (method: string, payload: any = {}) =>
          ctx.connection.rpc
            .call("/api", "plugin-harbor", { version: 1, method, payload })
            .then((result: any) => {
              if (result?.ok === false) {
                const message = String(result.error?.message ?? "请求失败");
                /**
                 * 宿主不认识这个方法 ⇒ 宿主侧跑的是旧构建（见 `STALE_HOST_TEXT`）。
                 * 把原始报文留在末尾，便于排查别的原因。
                 */
                if (/Unknown method/i.test(message))
                  throw Error(`${STALE_HOST_TEXT}（宿主回：${message}）`);
                throw Error(message);
              }
              return result.value ?? result;
            }),
        [ctx],
      );
      const [status, setStatus] = useState(null as any);
      const [error, setError] = useState("");
      const [tab, setTab] = useState("market");
      const [installed, setInstalled] = useState(null as any);
      const [installedError, setInstalledError] = useState("");
      const [ops, setOps] = useState(null as any);
      const [opsError, setOpsError] = useState("");
      const [dialog, setDialog] = useState(null as any);
      const [settings, setSettings] = useState(null as any);
      const [settingsError, setSettingsError] = useState("");
      const lastLive = useRef(-1);
      /**
       * 宿主是不是旧构建：`status.build` 与本面板的构建标识不一致（老宿主根本不报
       * `build` 字段，同样按不一致处理）。只做提示，不拦功能 —— 旧宿主本来就没有新方法。
       */
      const staleHost = status !== null && (status as any)?.build !== BUILD;

      useEffect(() => {
        let cancelled = false;
        (async () => {
          setError("");
          try {
            const value = await call("status");
            if (!cancelled) setStatus(value);
          } catch (cause: any) {
            if (!cancelled) setError(String(cause?.message ?? cause));
          }
        })();
        return () => {
          cancelled = true;
        };
      }, [call]);

      /** 已装清单：只读本地事实与缓存的更新结论，**不触发出网**。 */
      const loadInstalled = useCallback(async () => {
        try {
          const rows = await call("installed.list");
          setInstalled(Array.isArray(rows) ? rows : []);
          setInstalledError("");
        } catch (cause: any) {
          setInstalledError(String(cause?.message ?? cause));
        }
      }, [call]);
      useEffect(() => {
        loadInstalled();
      }, [loadInstalled]);

      /** 设置：只读本地文件（服务端读取时会把坏字段退回默认并附说明）。 */
      const loadSettings = useCallback(async () => {
        try {
          const value = await call("settings.get");
          setSettings(value);
          setSettingsError("");
        } catch (cause: any) {
          setSettingsError(String(cause?.message ?? cause));
        }
      }, [call]);
      useEffect(() => {
        loadSettings();
      }, [loadSettings]);

      /** 市场行的「已装」徽标：按 repo 匹配（同名不同仓库不能混为一谈）。 */
      const installedRepos = new Set(
        (Array.isArray(installed) ? installed : [])
          .map((row: any) => row?.repo)
          .filter((repo: any) => typeof repo === "string"),
      );

      /** 读操作队列与历史。 */
      const loadOps = useCallback(async () => {
        try {
          const value = await call("op.list");
          setOps(value);
          setOpsError("");
          return value;
        } catch (cause: any) {
          setOpsError(String(cause?.message ?? cause));
          return undefined;
        }
      }, [call]);
      useEffect(() => {
        loadOps();
      }, [loadOps]);

      const liveCount = Array.isArray(ops?.tasks)
        ? ops.tasks.filter(
            (task: any) => task.status === "queued" || task.status === "running",
          ).length
        : 0;

      /**
       * 只在**有任务在跑**时轮询（1s），跑完立刻停：这样一次安装能被看到进度，
       * 而空闲时不会有任何定时器在后台跑。
       */
      useEffect(() => {
        if (liveCount === 0) return undefined;
        const timer = setInterval(() => {
          loadOps();
        }, 1000);
        return () => clearInterval(timer);
      }, [liveCount, loadOps]);

      /** 队列从「有任务」回到「空闲」时，重读已装清单（版本/徽标要跟着变）。 */
      useEffect(() => {
        if (lastLive.current > 0 && liveCount === 0) loadInstalled();
        lastLive.current = liveCount;
      }, [liveCount, loadInstalled]);

      /** 真正下发一次变更：服务端还会再校验一次 `confirm`。 */
      const runOp = useCallback(
        async (method: string, payload: any) => {
          setOpsError("");
          try {
            await call(method, { ...payload, confirm: true });
            await loadOps();
          } catch (cause: any) {
            setOpsError(String(cause?.message ?? cause));
          }
        },
        [call, loadOps],
      );

      const askInstall = useCallback(
        (row: any) => {
          const spec = row?.npmPackage
            ? row.npmPackage
            : row?.repo
              ? `github:${row.repo}`
              : "";
          setDialog({
            title: "安装插件",
            body: row?.displayName || row?.name || row?.repo || "",
            detail:
              spec === ""
                ? "站点没有给出可用的安装地址"
                : `dsh plugin add ${spec}；${effectText(status)}`,
            confirmLabel: "安装",
            action:
              spec === ""
                ? undefined
                : () => runOp("op.install", { spec }),
          });
        },
        [runOp, status],
      );

      const askUpdate = useCallback(
        (row: any) => {
          setDialog({
            title: "更新插件",
            body:
              `${row?.name}：${row?.version ?? "未知版本"} → ` +
              `${row?.update?.latestVersion ?? (row?.update?.latestCommit ?? "最新").slice?.(0, 7) ?? "最新"}`,
            detail:
              row?.kind === "registry"
                ? `宿主会先卸载旧版本再安装新版本；${effectText(status)}`
                : `按原地址重装（${row?.spec ?? "未知来源"}）；${effectText(status)}`,
            confirmLabel: "更新",
            action: () => runOp("op.update", { name: row?.name }),
          });
        },
        [runOp, status],
      );

      /**
       * 热重载：不改启用状态、不换版本，只让宿主按**磁盘上当前的代码**重新组合并加载。
       * 重建过 `dist/` 的已链接插件靠它生效（宿主 HMR 会替换磁盘上已变化的模块）。
       */
      const askHotReload = useCallback(
        (row: any) => {
          setDialog({
            title: "热重载插件",
            body: `${row?.name}`,
            detail: `按磁盘上当前的代码重新组合并加载；${effectText(status)}`,
            confirmLabel: "热重载",
            action: () => runOp("op.reload", { name: row?.name }),
          });
        },
        [runOp, status],
      );

      const askRemove = useCallback(
        (row: any) => {
          setDialog({
            title: "卸载插件",
            body: `${row?.name}`,
            detail: `会从当前 profile 的依赖里移除该插件，并停用它的 bundle；${effectText(status)}`,
            confirmLabel: "卸载",
            action: () => runOp("op.remove", { name: row?.name }),
          });
        },
        [runOp, status],
      );

      const askToggle = useCallback(
        (row: any) => {
          const enabled = !row?.selected;
          setDialog({
            title: enabled ? "启用插件" : "停用插件",
            body: `${row?.name}`,
            detail: enabled
              ? `把它加入当前 profile 的 bundle 列表；${effectText(status)}`
              : `保留依赖，但从 bundle 列表里移除（不卸载）；${effectText(status)}`,
            confirmLabel: enabled ? "启用" : "停用",
            action: () => runOp("op.setEnabled", { name: row?.name, enabled }),
          });
        },
        [runOp, status],
      );

      return h(
        "div",
        { className: "pc" },
        h("style", null, css),
        h(
          "header",
          { className: "pc-head" },
          h(
            "div",
            { className: "pc-title" },
            h("h2", null, LABEL),
            status?.version
              ? h("span", { className: "pc-ver" }, "v" + status.version)
              : null,
          ),
          h(
            "div",
            { className: "pc-actions" },
            status?.dbPath
              ? h("span", { className: "pc-ver", title: status.dbPath }, "目录库 " + status.store?.sqlite)
              : null,
          ),
        ),
        h(
          "nav",
          { className: "pc-tabs" },
          TABS.map((item) =>
            h(
              "button",
              {
                key: item.id,
                type: "button",
                className: "pc-tab" + (item.id === tab ? " is-on" : ""),
                "aria-pressed": item.id === tab,
                onClick: () => setTab(item.id),
              },
              item.label,
            ),
          ),
        ),
        h(
          "div",
          { className: "pc-body" },
          error ? h("p", { className: "pc-error" }, error) : null,
          /**
           * 新旧构建错配的提示（本轮实测报障：面板点「导出」回
           * `Unknown method: export.run`）。先说清原因与修法，别让用户对着原始报文猜。
           */
          staleHost
            ? h(
                "div",
                { className: "pc-note-block", "data-stale-host": "1" },
                h("p", null, STALE_HOST_TEXT),
                h(
                  "p",
                  { className: "pc-field-hint" },
                  `面板构建 ${BUILD}｜宿主构建 ${(status as any)?.build ?? "未上报（更旧的构建）"}`,
                ),
              )
            : null,
          tab === "market"
            ? h(Market, {
                call,
                installedRepos,
                onInstall: askInstall,
                // 详情页地址按本 profile 的站点基址拼（设置页可改，默认 dsh-plugin.org）
                siteBase: settings?.siteBase,
              })
            : null,
          tab === "installed"
            ? h(Installed, {
                call,
                installed,
                error: installedError,
                onReload: loadInstalled,
                onUpdate: askUpdate,
                onHotReload: askHotReload,
                onRemove: askRemove,
                onToggle: askToggle,
                siteBase: settings?.siteBase,
              })
            : null,
          tab === "ops"
            ? h(Ops, { ops, error: opsError, onCancel: (id: any) => runOp("op.cancel", { id }), busy: false })
            : null,
          tab === "settings"
            ? h(Settings, {
                call,
                settings,
                status,
                error: settingsError,
                onSaved: (next: any) => setSettings(next),
              })
            : null,
        ),
        h(ConfirmDialog, { dialog, onClose: setDialog }),
      );
    }

    return {
      name: "plugin-harbor",
      id: "dsh-plugin-harbor",
      inject: ["slots", "connection"],
      apply(ctx: any) {
        ctx.slots.inject("sidebar.panellist", () =>
          ctx.slots.register(
            {
              name: "sidebar.panellist",
              id: PANEL_ID,
              order: 36,
              label: () => LABEL,
              /**
               * 构建标识随注册一起交出去：宿主会忽略这个多余字段，但它让测试与诊断能直接
               * 读到「这份面板是哪次构建」，从而构造/验证「宿主是旧构建」的错配场景。
               */
              build: BUILD,
            },
            CenterIcon,
          ),
        );
        // 只有一个入口：整窗主区域。设置页不放第二份（宽度只有约 564px）。
        ctx.slots.inject("main", () =>
          ctx.slots.register({ name: "main", key: PANEL_ID }, (props: any) =>
            h(Panel, { ...props, ctx }),
          ),
        );
      },
    };
  },
});