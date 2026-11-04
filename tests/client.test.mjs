/**
 * 浏览器入口契约（读构建产物，不依赖宿主）。
 *
 * 断言的是**宿主契约**与**渲染规模**，不是实现细节：注册了几个入口、图标与
 * 面板的 id 是否逐字相同、样式是否来自 `src/client.css` 并被内联、是否存在
 * 宿主里会抛错的调用（`prompt()`）、市场列表是否真的窗口化（DOM 行数上限）。
 *
 * 夹具是一个极小的 React：createElement / useState / useEffect / useCallback /
 * useRef，**按组件分配 hook 槽位**（与真实 React 一致）。若改成扁平槽位，
 * 多个组件会互相读到对方的状态 —— 早期版本正是这样把 `Row` 的渲染读成了
 * `Panel` 的状态。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(
  new URL("../dist/client.js", import.meta.url),
  "utf8",
);
const css = readFileSync(new URL("../src/client.css", import.meta.url), "utf8");

const statusPayload = {
  plugin: "plugin-harbor",
  version: "0.1.0-alpha.1",
  profile: "desktop",
  dataDir: "C:/tmp/profiles/desktop/plugin-harbor",
  dbPath: "C:/tmp/profiles/desktop/plugin-harbor/catalog.sqlite",
  store: { path: "C:/tmp/catalog.sqlite", sqlite: "3.44.0", tables: 4 },
  // 桌面宿主默认加载 hmr：默认按「热重载可用」构造，缺失/未知的分支另有用例
  hot: true,
};

const catalogStatus = {
  rows: 19866,
  chunks: 37,
  totalCount: 19866,
  lastSyncAt: 1_700_000_000_000,
  error: null,
  syncing: false,
  curatedOrphans: 6,
  milestone: "M1",
};

/** 生成 N 条目录行（身份是 repo，不是 slug）。 */
function makeRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    repo: `owner${index}/plugin-${index}`,
    slug: `plugin-${index}`,
    name: `plugin-${index}`,
    displayName: `plugin-${index}`,
    owner: `owner${index}`,
    category: index % 2 === 0 ? "tools" : "agent",
    description: `第 ${index} 条描述`,
    stars: 10_000 - index,
    forks: 3,
    language: "TypeScript",
    status: "verified",
    npmPackage: "",
    topics: ["dsh"],
    features: [],
    h1: "",
    repoCreatedAt: "",
    repoUpdatedAt: "2026-10-01T00:00:00Z",
    addedAt: "2026-10-01",
    pageUpdatedAt: "2026-10-31",
    license: "MIT",
    dshTopic: true,
  }));
}

function createHarness(handler) {
  const registrations = [];
  const calls = [];
  const slots = new Map();
  const intervals = [];
  let current = null;
  let definition;
  const enter = (type) => {
    let slot = slots.get(type);
    if (!slot) {
      slot = {
        state: [],
        effects: [],
        memo: [],
        effectMemo: [],
        index: 0,
        memoIndex: 0,
        effectIndex: 0,
      };
      slots.set(type, slot);
    }
    current = slot;
    return slot;
  };
  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children,
    }),
    Fragment: "fragment",
    useState: (initial) => {
      const slot = current;
      const index = slot.index++;
      if (!(index in slot.state))
        slot.state[index] = typeof initial === "function" ? initial() : initial;
      return [
        slot.state[index],
        (value) => {
          slot.state[index] =
            typeof value === "function" ? value(slot.state[index]) : value;
        },
      ];
    },
    useRef: (initial) => {
      const slot = current;
      const index = slot.index++;
      if (!(index in slot.state)) slot.state[index] = { current: initial };
      return slot.state[index];
    },
    useCallback: (fn, deps) => {
      const slot = current;
      const index = slot.memoIndex++;
      const previous = slot.memo[index];
      if (
        previous &&
        Array.isArray(deps) &&
        previous.deps.length === deps.length &&
        previous.deps.every((dep, i) => Object.is(dep, deps[i]))
      )
        return previous.fn;
      slot.memo[index] = { fn, deps: deps ?? [] };
      return fn;
    },
    useEffect: (fn, deps) => {
      const slot = current;
      const index = slot.effectIndex++;
      const previous = slot.effectMemo[index];
      const changed =
        previous === undefined ||
        !Array.isArray(deps) ||
        previous.deps.length !== deps.length ||
        deps.some((dep, i) => !Object.is(dep, previous.deps[i]));
      slot.effectMemo[index] = { deps: deps ?? [] };
      if (changed) slot.effects.push(fn);
    },
  };
  /** 沙箱对象就是 vm 里的 globalThis：客户端写进去的构建标识在这里读得回来。 */
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (module) => {
          definition = module;
        },
      },
    },
    // ⚠️ 浏览器里必然存在的定时器必须在夹具里也有：搜索防抖用 setTimeout，
    // 缺了它整条路径抛 ReferenceError（本轮实测：防抖用例因此失败，
    // 而产品代码本身是对的）。
    setTimeout,
    clearTimeout,
    // ⚠️ 轮询用的 setInterval 用**假实现**：夹具不执行 effect 的 cleanup，
    // 真起一个 1s 定时器会一直挂着、拖住 node --test 退出。回调会被记下来，
    // 由 `runIntervals()` 显式驱动一次 —— 否则「队列跑完 → 重读清单」这条
    // 路径在夹具里永远不会被触发（本轮实测：更新后复查的用例因此卡住）。
    setInterval: (fn) => {
      intervals.push(fn);
      return intervals.length;
    },
    clearInterval: () => {},
    /**
     * ⚠️ `URL` 必须注入：详情页链接的基址归一用它校验协议与凭据。vm 沙箱默认
     * 没有 `URL`，缺了它 `normalizeSiteBase()` 会走 catch 分支返回空串 ——
     * 表现是「链接一个都不渲染」，看起来像产品缺陷（本轮实测踩到）。
     */
    URL,
    console,
  };
  vm.runInNewContext(source, sandbox);
  assert.ok(definition, "must register through window.__ModuleLoader__.load");
  assert.ok(definition, "must register through window.__ModuleLoader__.load");
  assert.equal(definition.id, "dsh-plugin-harbor");
  const api = definition.factory((id) => (id === "react" ? React : {}));
  const ctx = {
    slots: {
      inject: (_name, run) => run(),
      register: (config, component) => {
        registrations.push({ config, component });
        return () => {};
      },
    },
    connection: {
      rpc: {
        call: async (path, method, body) => {
          assert.equal(path, "/api");
          assert.equal(method, "plugin-harbor");
          assert.equal(body.version, 1);
          calls.push({ method: body.method, payload: body.payload });
          const result = await handler(body.method, body.payload);
          /**
           * 宿主桩默认与面板同构建：`status` 没报 `build` 时补上（老宿主不报这个字段，
           * 界面会因此提示「宿主是旧构建」—— 那条路径由专门的用例显式构造）。
           */
          if (
            body.method === "status" &&
            result?.ok === true &&
            result.value !== null &&
            typeof result.value === "object" &&
            result.value.build === undefined
          )
            return { ...result, value: { ...result.value, build } };
          return result;
        },
      },
    },
  };
  api.apply(ctx);
  /**
   * 构建标识：客户端把它随面板注册一起交出去（宿主忽略这个多余字段），这里读回来。
   * 夹具默认把宿主桩配成同一个值，否则每个用例都会命中「宿主是旧构建」的提示条 ——
   * 那条提示另有专门用例验证。
   */
  const build =
    registrations.map((entry) => entry?.config?.build).find((value) => typeof value === "string") ??
    "dev";
  assert.ok(build !== "dev", "客户端必须把构建标识随注册交出来（本夹具读它来对齐宿主桩）");

  /** 渲染一次面板：归零所有组件的 hook 游标 → 解析 → 跑副作用。 */
  const renderPanel = (props = {}) => {
    for (const slot of slots.values()) {
      slot.index = 0;
      slot.memoIndex = 0;
      slot.effectIndex = 0;
      slot.effects = [];
    }
    const tree = resolveTree(registrations[1].component(props), enter);
    const effects = [];
    for (const slot of slots.values()) effects.push(...slot.effects);
    for (const effect of effects) effect();
    return tree;
  };
  /** 显式跑一次已登记的定时器回调（模拟 1s 轮询到点）。 */
  const runIntervals = () => {
    for (const fn of [...intervals]) fn();
  };
  return { api, registrations, renderPanel, calls, build, runIntervals };
}

/** 调用函数组件直到只剩宿主节点（夹具版 reconciler）。 */
function resolveTree(node, enter) {
  if (node === null || node === undefined || node === false) return null;
  if (typeof node === "string" || typeof node === "number") return node;
  // ⚠️ 数组子节点必须展开：真实 React 会摊平 `[a, b]`，夹具若不摊平，
  // 列表那一整块会被当成一个「未知类型」节点丢掉（本轮实测：窗口化列表
  // 因此渲染出 0 行，看起来像产品缺陷）。
  if (Array.isArray(node))
    return node
      .map((child) => resolveTree(child, enter))
      .flat()
      .filter((child) => child !== null);
  if (typeof node !== "object") return null;
  if (typeof node.type === "function") {
    enter(node.type);
    return resolveTree(
      node.type({ ...node.props, children: node.children }),
      enter,
    );
  }
  return {
    type: node.type,
    props: node.props,
    children: (node.children ?? [])
      .map((child) => resolveTree(child, enter))
      .flat()
      .filter((child) => child !== null),
  };
}

function nodes(node, out = []) {
  if (!node || typeof node !== "object") return out;
  out.push(node);
  for (const child of node.children ?? []) nodes(child, out);
  return out;
}

function text(node) {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node !== "object") return "";
  return (node.children ?? []).map(text).join(" ");
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const findNode = (node, predicate) => nodes(node).find(predicate);

/**
 * 跨 vm 边界的对象比较。
 *
 * ⚠️ 客户端是在 `vm.runInNewContext` 里跑的，它构造的对象与我这边字面量对象
 * **原型不同源**，`deepStrictEqual` 会报「结构相同但引用不等」。载荷本身是纯
 * JSON，做一次 JSON 往返再比即可（本轮实测踩到）。
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

const centerSettings = {
  locale: "zh",
  syncTtlMs: 86_400_000,
  siteBase: "https://dsh-plugin.org",
  apiBase: "https://api.dsh-plugin.org",
  registry: "",
  proxy: "",
  notes: [],
};

/** 默认处理器：目录已同步、列表分页返回 50 条、已装清单为空。 */
function defaultHandler(rows = makeRows(500), installed = []) {
  return async (method, payload) => {
    if (method === "status") return { ok: true, value: statusPayload };
    if (method === "catalog.status") return { ok: true, value: catalogStatus };
    if (method === "installed.list") return { ok: true, value: installed };
    if (method === "settings.get") return { ok: true, value: centerSettings };
    if (method === "settings.set")
      return { ok: true, value: { ...centerSettings, ...payload, notes: [] } };
    if (method === "diagnostics.run")
      return {
        ok: true,
        value: [
          { id: "catalog", label: "目录数据", ok: true, detail: "19,866 条", ms: 1 },
          { id: "site", label: "官网目录（dsh-plugin.org）", ok: false, detail: "超时（20000ms）", ms: 20000 },
          { id: "git", label: "git 可用性", ok: null, detail: "未检查", ms: 0 },
        ],
      };
    if (method === "op.list")
      return { ok: true, value: { active: null, tasks: [], history: [] } };
    if (method === "catalog.list") {
      const startIndex = payload?.cursor
        ? rows.findIndex((row) => row.repo === payload.cursor.repo) + 1
        : 0;
      const limit = payload?.limit ?? 50;
      const page = rows.slice(startIndex, startIndex + limit);
      const hasMore = startIndex + limit < rows.length;
      return {
        ok: true,
        value: {
          rows: page,
          total: rows.length,
          facets: { category: { tools: 250, agent: 250 }, language: { TypeScript: 500 }, status: { verified: 500 } },
          nextCursor: hasMore
            ? { key: String(page[page.length - 1].stars), repo: page[page.length - 1].repo }
            : null,
        },
      };
    }
    throw Error("夹具未登记的 RPC 方法：" + method);
  };
}

test("registers exactly the sidebar icon and the window panel, with one shared id", () => {
  const harness = createHarness(defaultHandler());
  const list = harness.registrations;
  assert.equal(list.length, 2);
  const [icon, panel] = list;
  assert.equal(icon.config.name, "sidebar.panellist");
  assert.equal(panel.config.name, "main");
  // 宿主按这个 id 把图标与面板绑起来；两者不一致时点图标抛 unknown panel。
  assert.equal(icon.config.id, panel.config.key);
  assert.equal(icon.config.label(), "插件港湾");
  assert.ok(
    !list.some((entry) => String(entry.config.name).startsWith("settings.")),
    "must not register a settings entry",
  );
  const iconTree = nodes(resolveTree(icon.component({ size: 18 }), () => ({}))).find(
    (node) => node.type === "svg",
  );
  assert.equal(iconTree.props["aria-hidden"], "true");
});

test("inlines the stylesheet from src/client.css into the panel", () => {
  const harness = createHarness(defaultHandler());
  const style = findNode(harness.renderPanel(), (node) => node.type === "style");
  assert.ok(style, "panel must mount a <style> node");
  assert.equal(style.children[0], css, "must be client.css verbatim");
  assert.match(source, /\.pc-body/);
  assert.match(source, /\.pc-list-spacer/);
});

test("打开面板只读状态，不自动同步已有目录", async () => {
  const harness = createHarness(defaultHandler());
  harness.renderPanel();
  await tick();
  const methods = harness.calls.map((entry) => entry.method);
  assert.ok(methods.includes("status"));
  assert.ok(methods.includes("catalog.status"));
  assert.ok(methods.includes("catalog.list"));
  assert.ok(
    methods.includes("installed.list"),
    "已装清单是本地事实，打开面板就该读",
  );
  assert.ok(
    !methods.includes("catalog.refresh"),
    "已有目录时打开面板不得自动出网",
  );
  assert.ok(
    !methods.includes("updates.check"),
    "打开面板不得自动检查更新（必须由用户点按钮）",
  );
});

test("首次无缓存时自动拉一次目录，并把失败原因显示出来", async () => {
  const harness = createHarness(async (method) => {
    if (method === "status") return { ok: true, value: statusPayload };
    if (method === "catalog.status")
      return { ok: true, value: { ...catalogStatus, rows: 0, totalCount: null, lastSyncAt: null } };
    if (method === "catalog.refresh")
      return {
        ok: true,
        value: {
          refreshed: 36,
          skipped: 0,
          failures: [{ url: "/directory/zh/tools-9-ffffffff.json", reason: "HTTP 500" }],
          rows: 19800,
          totalCount: 19866,
        },
      };
    if (method === "catalog.list")
      return { ok: true, value: { rows: makeRows(5), total: 5, facets: {}, nextCursor: null } };
    throw Error("unexpected " + method);
  });
  harness.renderPanel();
  await tick();
  const methods = harness.calls.map((entry) => entry.method);
  assert.deepEqual(
    methods.filter((name) => name === "catalog.refresh").length,
    1,
    "首次进入市场页只自动同步一次",
  );
  const shown = text(harness.renderPanel());
  assert.match(shown, /HTTP 500/, "失败原因必须出现在界面上");
});

test("市场列表窗口化：500 条只渲染可见窗", async () => {
  const harness = createHarness(defaultHandler(makeRows(500)));
  harness.renderPanel();
  await tick();
  const tree = harness.renderPanel();
  const rowNodes = nodes(tree).filter(
    (node) => node.props?.className === "pc-row",
  );
  assert.ok(rowNodes.length > 0, "至少要渲染出可见行");
  assert.ok(
    rowNodes.length <= 30,
    `窗口化后 DOM 行数应 ≤30，实际 ${rowNodes.length}`,
  );
  // 上下占位块把滚动条长度撑到「全部行 × 行高」
  const spacers = nodes(tree).filter((node) =>
    String(node.props?.className ?? "").includes("pc-list-spacer"),
  );
  assert.equal(spacers.length, 2, "上下各一个占位块");
  const shown = text(tree);
  assert.match(shown, /共 500 条/);
  assert.match(shown, /已载入 50 条/, "首屏只取一页");
});

test("滚动到中段时窗口跟着移动，且不会渲染整表", async () => {
  const harness = createHarness(defaultHandler(makeRows(500)));
  harness.renderPanel();
  await tick();
  harness.renderPanel();
  const listNode = findNode(
    harness.renderPanel(),
    (node) => node.props?.className === "pc-list",
  );
  assert.ok(listNode, "必须有滚动容器");
  listNode.props.onScroll({ currentTarget: { scrollTop: 64 * 200 } });
  const tree = harness.renderPanel();
  const rowNodes = nodes(tree).filter(
    (node) => node.props?.className === "pc-row",
  );
  assert.ok(rowNodes.length <= 30, "滚动后仍然只渲染可见窗");
  // 顶占位块高度 = (起点 - 缓冲) × 行高，行高必须仍是 64
  const top = nodes(tree).filter(
    (node) => String(node.props?.className ?? "").includes("pc-list-spacer"),
  )[0];
  assert.equal(top.props.style.height, 64 * (200 - 6) + "px");
});

test("搜索防抖后带查询词取数", async () => {
  const harness = createHarness(defaultHandler(makeRows(20)));
  harness.renderPanel();
  await tick();
  const search = findNode(
    harness.renderPanel(),
    (node) => node.props?.className === "pc-search",
  );
  assert.ok(search, "必须有搜索框");
  search.props.onChange({ target: { value: "purge" } });
  harness.renderPanel();
  // 防抖窗口内不应发查询
  const before = harness.calls.filter((entry) => entry.method === "catalog.list").length;
  await new Promise((resolve) => setTimeout(resolve, 320));
  harness.renderPanel();
  const searches = harness.calls.filter(
    (entry) => entry.method === "catalog.list" && entry.payload?.q === "purge",
  );
  assert.ok(searches.length >= 1, "防抖结束后应带 q 查询");
  assert.ok(
    harness.calls.filter((entry) => entry.method === "catalog.list").length > before,
  );
});

test("已装页：列出事实与结论徽标，检查更新由按钮触发", async () => {
  const installed = [
    {
      name: "dsh-cost-meter",
      spec: "^1.9.28",
      kind: "registry",
      version: "1.9.28",
      repo: "Han-1413141/dsh-cost-meter",
      selected: true,
      present: true,
      bundle: true,
      hasClient: false,
      displayName: "dsh-cost-meter",
      category: "dev",
      stars: 1234,
      update: {
        name: "dsh-cost-meter",
        kind: "registry",
        updateAvailable: true,
        latestVersion: "1.9.47",
        latestSource: "registry",
        checkedAt: 1_700_000_000_000,
      },
    },
    {
      name: "dsh-local-plugin",
      spec: "file:../local-plugin",
      kind: "path",
      selected: true,
      present: true,
      bundle: false,
      hasClient: false,
      update: {
        name: "dsh-local-plugin",
        kind: "path",
        updateAvailable: null,
        note: "本地路径 / 压缩包安装，没有远端可比",
        checkedAt: 1_700_000_000_000,
      },
    },
  ];
  let checks = 0;
  const harness = createHarness(async (method, payload) => {
    if (method === "updates.check") {
      checks += 1;
      return { ok: true, value: installed.map((row) => row.update) };
    }
    return await defaultHandler(makeRows(20), installed)(method, payload);
  });
  harness.renderPanel();
  await tick();
  // 切到「已装」页签
  const tab = findNode(
    harness.renderPanel(),
    (node) => node.type === "button" && text(node) === "已装",
  );
  assert.ok(tab, "必须有已装页签");
  tab.props.onClick();
  const tree = harness.renderPanel();
  const shown = text(tree);
  assert.match(shown, /dsh-cost-meter/);
  assert.match(shown, /当前 1\.9\.28/);
  assert.match(shown, /最新 1\.9\.47/);
  assert.match(shown, /可更新/, "有更新必须给出徽标");
  assert.match(shown, /未判定/, "判不了的不能显示成「已最新」");
  assert.match(shown, /本地路径/, "判不了的原因要如实显示");
  assert.match(shown, /npm 包/, "安装形态用中文说明");
  // 每一行都带 data-plugin，便于定位；徽标要落在**行内**而不是只看整页文本
  // （页头统计里本来就有「已最新 N」这一项，整页匹配会误判）。
  const meterRow = nodes(tree).find(
    (node) => node.props?.["data-plugin"] === "dsh-cost-meter",
  );
  assert.ok(meterRow, "已装行必须带 data-plugin");
  assert.match(text(meterRow), /可更新/);
  assert.doesNotMatch(text(meterRow), /已最新/);
  const localRow = nodes(tree).find(
    (node) => node.props?.["data-plugin"] === "dsh-local-plugin",
  );
  assert.match(text(localRow), /未判定/);
  assert.doesNotMatch(text(localRow), /已最新/);

  assert.equal(checks, 0, "打开已装页不得自动检查更新");
  const button = findNode(
    tree,
    (node) => node.type === "button" && text(node) === "检查更新",
  );
  assert.ok(button, "必须有检查更新按钮");
  await button.props.onClick();
  await tick();
  assert.equal(checks, 1, "按钮必须触发一次 updates.check");
});

test("市场行提供「在浏览器中打开数据源详情页」的链接（真 <a>，新窗口打开）", async () => {
  const harness = createHarness(defaultHandler(makeRows(5), []));
  harness.renderPanel();
  await tick();
  const tree = harness.renderPanel();
  const row = nodes(tree).find((node) => node.props?.["data-repo"] === "owner2/plugin-2");
  assert.ok(row, "市场行要在列表里");

  // 仓库名本身是链接，指向 **dsh-plugin.org 的详情页**（不是 GitHub）
  const repoLink = nodes(row).find((node) => node.props?.["data-open-site"] === "owner2/plugin-2");
  assert.ok(repoLink, "仓库名要渲染成可点链接");
  assert.equal(repoLink.type, "a", "必须是真 <a>，不能是 onClick + window.open");
  assert.equal(repoLink.props.href, "https://dsh-plugin.org/zh/plugins/owner2/plugin-2");
  assert.doesNotMatch(repoLink.props.href, /github\.com/, "不能指向代码仓库");
  assert.equal(repoLink.props.target, "_blank");
  assert.equal(repoLink.props.rel, "noopener noreferrer", "新窗口不能反向控制 opener");
  assert.match(text(repoLink), /owner2\/plugin-2/);

  // 另有一个显式的「详情页」按钮（同为 <a>），指向同一地址
  const button = nodes(row).find(
    (node) => node.props?.["data-open-site-button"] === "owner2/plugin-2",
  );
  assert.ok(button, "还要有一个显式的「详情页」入口");
  assert.equal(button.type, "a");
  assert.equal(button.props.href, "https://dsh-plugin.org/zh/plugins/owner2/plugin-2");
  assert.equal(button.props.target, "_blank");
  assert.equal(button.props.rel, "noopener noreferrer");
  assert.match(text(button), /详情页/);

  // 行高固定（窗口化依赖这一约定），多一个链接不能把行撑高
  assert.equal(row.props.className, "pc-row");
});

test("详情页链接用 owner + slug 拼（slug 会重名，不能拿 repo 切）", async () => {
  /**
   * 数据源里 slug 会重名：`dsh-purge` 同时属于 4 个不同仓库，而详情页正是按
   * `/<owner>/<slug>` 路由的。所以链接必须用目录行自己的 owner/slug，
   * 拿 repo 切出来会拼到别的插件的页面。
   */
  const base = makeRows(1)[0];
  const rows = [
    { ...base, repo: "yujunzhixue/dsh-purge", owner: "yujunzhixue", slug: "dsh-purge", name: "dsh-purge" },
    { ...base, repo: "kingcharleslzy-ai/dsh-purge", owner: "kingcharleslzy-ai", slug: "dsh-purge", name: "dsh-purge" },
    // 仓库名与 slug 不一致的常见情形（repo 叫 dsh-xxx，slug 是别的）
    { ...base, repo: "some-owner/repo-name", owner: "some-owner", slug: "display-slug", name: "display-slug" },
  ];
  const harness = createHarness(defaultHandler(rows, []));
  harness.renderPanel();
  await tick();
  const tree = harness.renderPanel();

  const hrefOf = (repo) =>
    nodes(tree).find((node) => node.props?.["data-open-site"] === repo)?.props?.href;
  assert.equal(hrefOf("yujunzhixue/dsh-purge"), "https://dsh-plugin.org/zh/plugins/yujunzhixue/dsh-purge");
  assert.equal(
    hrefOf("kingcharleslzy-ai/dsh-purge"),
    "https://dsh-plugin.org/zh/plugins/kingcharleslzy-ai/dsh-purge",
    "同名 slug 的两个仓库要各自指向自己的详情页",
  );
  assert.equal(
    hrefOf("some-owner/repo-name"),
    "https://dsh-plugin.org/zh/plugins/some-owner/display-slug",
    "路径段用 slug，不是仓库名",
  );
});

test("详情页链接只接受安全的 owner/slug：拼不出安全地址就不渲染链接", async () => {
  /**
   * 目录数据来自 dsh-plugin.org，是不可信输入。绝不能把它直接塞进 href ——
   * `javascript:` 之类会被浏览器执行。这里逐个喂恶意值，断言不出链接。
   */
  const cases = [
    { owner: "javascript:alert(1)", slug: "x" },
    { owner: "ok", slug: "javascript:alert(1)" },
    { owner: "ok", slug: "../../etc" },
    { owner: 'ok"onmouseover="alert(1)', slug: "x" },
    { owner: "", slug: "x" },
    { owner: "ok", slug: "" },
  ];
  const rows = cases.map((entry, index) => ({
    ...makeRows(1)[0],
    repo: `evil/plugin-${index}`,
    owner: entry.owner,
    slug: entry.slug,
    name: `evil-${index}`,
    displayName: `evil-${index}`,
  }));
  const harness = createHarness(defaultHandler(rows, []));
  harness.renderPanel();
  await tick();
  const tree = harness.renderPanel();

  for (const [index] of cases.entries()) {
    const row = nodes(tree).find((node) => node.props?.["data-repo"] === `evil/plugin-${index}`);
    assert.ok(row, "这一行要在列表里：" + index);
    assert.ok(
      !nodes(row).some((node) => node.type === "a"),
      "非法 owner/slug 不得渲染成链接：" + index,
    );
    assert.ok(
      !nodes(row).some(
        (node) =>
          typeof node.props?.href === "string" && /javascript:|\.\.\//.test(node.props.href),
      ),
      "绝不能出现可疑 href：" + index,
    );
    assert.match(text(row), new RegExp(`evil-${index}`), "整行仍要渲染出来");
  }
});

test("详情页链接跟随设置里的站点基址（自建镜像也对得上）", async () => {
  const harness = createHarness(async (method, payload) => {
    if (method === "settings.get")
      return { ok: true, value: { ...centerSettings, siteBase: "https://mirror.example.com/" } };
    return await defaultHandler(makeRows(3), [])(method, payload);
  });
  harness.renderPanel();
  await tick();
  const tree = harness.renderPanel();
  const link = nodes(tree).find((node) => node.props?.["data-open-site"] === "owner0/plugin-0");
  assert.ok(link, "要有链接");
  assert.equal(
    link.props.href,
    "https://mirror.example.com/zh/plugins/owner0/plugin-0",
    "站点基址要跟随设置（尾斜杠归一化，不出现双斜杠）",
  );
});

test("市场行按 repo 打「已装」徽标（同名不同仓库不混为一谈）", async () => {
  const rows = makeRows(30);
  const installed = [
    {
      name: "plugin-3",
      spec: "github:owner3/plugin-3",
      kind: "git",
      repo: "owner3/plugin-3",
      selected: true,
      present: true,
      bundle: true,
      hasClient: false,
    },
  ];
  const harness = createHarness(defaultHandler(rows, installed));
  harness.renderPanel();
  await tick();
  const tree = harness.renderPanel();
  const installedRow = nodes(tree).find(
    (node) => node.props?.["data-repo"] === "owner3/plugin-3",
  );
  assert.ok(installedRow, "已装的那行必须在列表里");
  assert.match(text(installedRow), /已装/);
  const otherRow = nodes(tree).find(
    (node) => node.props?.["data-repo"] === "owner4/plugin-4",
  );
  assert.ok(otherRow);
  assert.doesNotMatch(text(otherRow), /已装/, "未装的行不得带已装徽标");
});

test("市场「安装」必须先过确认弹窗，确认后才带 confirm 下发", async () => {
  const rows = makeRows(5);
  rows[0].npmPackage = "dsh-whale-widget";
  rows[1].npmPackage = "";
  const opCalls = [];
  const harness = createHarness(async (method, payload) => {
    if (method === "op.list")
      return { ok: true, value: { active: null, tasks: [], history: [] } };
    if (method === "op.install") {
      opCalls.push({ method, payload });
      return { ok: true, value: { id: "op-1", status: "queued" } };
    }
    return await defaultHandler(rows, [])(method, payload);
  });
  harness.renderPanel();
  await tick();
  let tree = harness.renderPanel();
  const installButtons = nodes(tree).filter(
    (node) => node.type === "button" && text(node) === "安装",
  );
  assert.ok(installButtons.length >= 2, "未装的插件都要有安装按钮");

  installButtons[0].props.onClick();
  tree = harness.renderPanel();
  const dialog = findNode(tree, (node) => node.props?.className === "pc-overlay");
  assert.ok(dialog, "点击安装必须先弹确认框");
  // 有 npm 包名就用它，否则退回 github:owner/repo
  assert.match(text(dialog), /dsh plugin add dsh-whale-widget/);
  // 生效方式三态里，宿主有热重载时不许说「需要重启」
  assert.match(text(dialog), /宿主热重载后立即生效，无需重启 DSH/);
  assert.equal(opCalls.length, 0, "未点确认前不得下发任何变更");

  const confirm = findNode(
    dialog,
    (node) => node.type === "button" && text(node) === "安装",
  );
  await confirm.props.onClick();
  await tick();
  assert.deepEqual(plain(opCalls), [
    { method: "op.install", payload: { spec: "dsh-whale-widget", confirm: true } },
  ]);

  // 没有 npm 包名的那一行用 github:owner/repo
  tree = harness.renderPanel();
  const second = nodes(tree).filter(
    (node) => node.type === "button" && text(node) === "安装",
  )[1];
  second.props.onClick();
  tree = harness.renderPanel();
  assert.match(
    text(findNode(tree, (node) => node.props?.className === "pc-overlay")),
    /github:owner1\/plugin-1/,
  );
});

test("确认弹窗点取消什么都不做", async () => {
  const rows = makeRows(3);
  rows[0].npmPackage = "dsh-x";
  let installs = 0;
  const harness = createHarness(async (method, payload) => {
    if (method === "op.list")
      return { ok: true, value: { active: null, tasks: [], history: [] } };
    if (method === "op.install") {
      installs += 1;
      return { ok: true, value: { id: "op-1" } };
    }
    return await defaultHandler(rows, [])(method, payload);
  });
  harness.renderPanel();
  await tick();
  let tree = harness.renderPanel();
  nodes(tree)
    .filter((node) => node.type === "button" && text(node) === "安装")[0]
    .props.onClick();
  tree = harness.renderPanel();
  const dialog = findNode(tree, (node) => node.props?.className === "pc-overlay");
  const cancel = findNode(
    dialog,
    (node) => node.type === "button" && text(node) === "取消",
  );
  await cancel.props.onClick();
  await tick();
  assert.equal(installs, 0, "取消后不得下发");
  assert.ok(
    !findNode(harness.renderPanel(), (node) => node.props?.className === "pc-overlay"),
    "取消后弹窗必须关闭",
  );
});

test("已装页的更新 / 停用 / 卸载都要过确认弹窗", async () => {
  const installed = [
    {
      name: "dsh-cost-meter",
      spec: "^1.9.28",
      kind: "registry",
      version: "1.9.28",
      repo: "Han-1413141/dsh-cost-meter",
      selected: true,
      present: true,
      bundle: true,
      hasClient: false,
      update: { name: "dsh-cost-meter", kind: "registry", updateAvailable: true, latestVersion: "1.9.47", checkedAt: 1 },
    },
  ];
  const opCalls = [];
  const harness = createHarness(async (method, payload) => {
    if (method === "op.list")
      return { ok: true, value: { active: null, tasks: [], history: [] } };
    if (method.startsWith("op.")) {
      opCalls.push({ method, payload });
      return { ok: true, value: { id: "op-" + opCalls.length } };
    }
    return await defaultHandler(makeRows(5), installed)(method, payload);
  });
  harness.renderPanel();
  await tick();
  const tab = findNode(
    harness.renderPanel(),
    (node) => node.type === "button" && text(node) === "已装",
  );
  tab.props.onClick();
  let tree = harness.renderPanel();

  const press = async (label, expectMethod, expectPayload) => {
    const button = findNode(
      tree,
      (node) => node.type === "button" && text(node) === label,
    );
    assert.ok(button, `必须有「${label}」按钮`);
    button.props.onClick();
    const dialog = findNode(
      harness.renderPanel(),
      (node) => node.props?.className === "pc-overlay",
    );
    assert.ok(dialog, `「${label}」必须先弹确认框`);
    const confirm = findNode(
      dialog,
      (node) => node.type === "button" && text(node) === label,
    );
    await confirm.props.onClick();
    await tick();
    assert.deepEqual(plain(opCalls[opCalls.length - 1]), {
      method: expectMethod,
      payload: expectPayload,
    });
    tree = harness.renderPanel();
  };

  await press("更新", "op.update", { name: "dsh-cost-meter", confirm: true });
  await press("热重载", "op.reload", { name: "dsh-cost-meter", confirm: true });
  await press("停用", "op.setEnabled", {
    name: "dsh-cost-meter",
    enabled: false,
    confirm: true,
  });
  await press("卸载", "op.remove", { name: "dsh-cost-meter", confirm: true });
});

test("更新完成后：队列回到空闲，已装页自动换成复查后的结论", async () => {
  /**
   * 时序口径：服务端在**任务进入终态之前**就复查完并落库，客户端看到「已完成」
   * 后重读清单时，拿到的必须已经是复查后的结论（不该还挂着「可更新」）。
   */
  const before = [
    {
      name: "dsh-cost-meter",
      spec: "^1.9.28",
      kind: "registry",
      version: "1.9.28",
      selected: true,
      present: true,
      bundle: true,
      hasClient: false,
      update: {
        name: "dsh-cost-meter",
        kind: "registry",
        installedVersion: "1.9.28",
        updateAvailable: true,
        latestVersion: "1.9.47",
        checkedAt: 1,
      },
    },
  ];
  const after = [
    {
      ...before[0],
      version: "1.9.47",
      update: {
        name: "dsh-cost-meter",
        kind: "registry",
        installedVersion: "1.9.47",
        updateAvailable: false,
        latestVersion: "1.9.47",
        checkedAt: 2,
        note: "已是最新",
      },
    },
  ];
  let phase = "idle";
  let installedReads = 0;
  const harness = createHarness(async (method, payload) => {
    if (method === "installed.list") {
      installedReads += 1;
      return { ok: true, value: phase === "done" ? after : before };
    }
    if (method === "op.list") {
      if (phase === "running")
        return {
          ok: true,
          value: {
            active: "op-u",
            tasks: [{ id: "op-u", kind: "update", target: "dsh-cost-meter", status: "running", log: [], queuedAt: 1 }],
            history: [],
          },
        };
      if (phase === "done")
        return {
          ok: true,
          value: {
            active: null,
            tasks: [
              {
                id: "op-u",
                kind: "update",
                target: "dsh-cost-meter",
                status: "done",
                note: "已卸载旧版本并安装新版本（宿主已热加载，无需重启）；更新后已复查：已是最新（1.9.47）",
                log: ["更新后复查 dsh-cost-meter：已是最新（1.9.47）"],
                queuedAt: 1,
                endedAt: 2,
              },
            ],
            history: [],
          },
        };
      return { ok: true, value: { active: null, tasks: [], history: [] } };
    }
    if (method.startsWith("op.")) return { ok: true, value: { id: "op-u" } };
    return await defaultHandler(makeRows(3), before)(method, payload);
  });

  harness.renderPanel();
  await tick();
  findNode(
    harness.renderPanel(),
    (node) => node.type === "button" && text(node) === "已装",
  ).props.onClick();
  let tree = harness.renderPanel();
  assert.match(text(tree), /可更新/, "更新前该显示「可更新」");

  // 下发更新 → 队列进入运行中
  phase = "running";
  findNode(tree, (node) => node.type === "button" && text(node) === "更新").props.onClick();
  const dialog = findNode(
    harness.renderPanel(),
    (node) => node.props?.className === "pc-overlay",
  );
  await findNode(dialog, (node) => node.type === "button" && text(node) === "更新").props.onClick();
  await tick();
  tree = harness.renderPanel();

  // 队列回到空闲 → 必须重读已装清单，拿到复查后的结论
  phase = "done";
  const readsBefore = installedReads;
  // 模拟 1s 轮询到点：重新读到 op.list 的终态（status 变成 done、队列为空）
  harness.runIntervals();
  await tick();
  tree = harness.renderPanel();
  await tick();
  tree = harness.renderPanel();

  assert.ok(installedReads > readsBefore, "队列由「有任务」回到空闲时必须重读已装清单");
  const installedText = text(tree);
  assert.match(installedText, /已最新/, "复查后应显示「已最新」");
  const updateButton = findNode(tree, node => node.type === "button" && text(node) === "更新");
  assert.equal(updateButton.props.disabled, true, "已最新时更新按钮必须禁用");
  updateButton.props.onClick();
  assert.ok(!findNode(harness.renderPanel(), node => node.props?.className === "pc-overlay"), "已最新时不应打开更新确认框");
  assert.match(installedText, /1\.9\.47/, "版本号要跟着更新");

  // 复查结论也写进了任务结论，在「操作」页能看到
  findNode(
    tree,
    (node) => node.type === "button" && text(node) === "操作",
  ).props.onClick();
  tree = harness.renderPanel();
  assert.match(text(tree), /更新后已复查/, "任务结论里要带上复查结果");
});

test("已装页：热重载按钮只给已启用的插件，弹窗说明热重载怎么生效", async () => {
  const installed = [
    {
      name: "dsh-cost-meter",
      spec: "^1.9.28",
      kind: "registry",
      version: "1.9.28",
      selected: true,
      present: true,
      bundle: true,
      hasClient: false,
    },
    {
      name: "dsh-idle",
      spec: "^1.0.0",
      kind: "registry",
      version: "1.0.0",
      selected: false,
      present: true,
      bundle: true,
      hasClient: false,
    },
  ];
  const opCalls = [];
  const harness = createHarness(async (method, payload) => {
    if (method === "op.list")
      return { ok: true, value: { active: null, tasks: [], history: [] } };
    if (method.startsWith("op.")) {
      opCalls.push({ method, payload });
      return { ok: true, value: { id: "op-" + opCalls.length } };
    }
    return await defaultHandler(makeRows(3), installed)(method, payload);
  });
  harness.renderPanel();
  await tick();
  findNode(
    harness.renderPanel(),
    (node) => node.type === "button" && text(node) === "已装",
  ).props.onClick();
  let tree = harness.renderPanel();

  const reloadButtons = nodes(tree).filter(
    (node) => node.type === "button" && text(node) === "热重载",
  );
  assert.equal(
    reloadButtons.length,
    1,
    "只有已启用的那一个插件能给「热重载」；实际按钮：" +
      nodes(tree)
        .filter((node) => node.type === "button")
        .map(text)
        .join(","),
  );
  assert.equal(
    nodes(tree).filter((node) => node.type === "button" && text(node) === "启用").length,
    1,
    "停用的插件仍只给「启用」",
  );

  reloadButtons[0].props.onClick();
  tree = harness.renderPanel();
  const dialog = findNode(tree, (node) => node.props?.className === "pc-overlay");
  assert.ok(dialog, "热重载必须先弹确认框");
  assert.match(text(dialog), /按磁盘上当前的代码重新组合并加载/);
  assert.match(text(dialog), /热重载后立即生效，无需重启 DSH/);

  await findNode(
    dialog,
    (node) => node.type === "button" && text(node) === "热重载",
  ).props.onClick();
  await tick();
  assert.deepEqual(plain(opCalls), [
    { method: "op.reload", payload: { name: "dsh-cost-meter", confirm: true } },
  ]);
});

test("未启用热重载的 profile：变更弹窗如实说「需要重启」，不许承诺立即生效", async () => {
  const installed = [
    {
      name: "dsh-cost-meter",
      spec: "^1.9.28",
      kind: "registry",
      version: "1.9.28",
      selected: true,
      present: true,
      bundle: true,
      hasClient: false,
    },
  ];
  const harness = createHarness(async (method, payload) => {
    if (method === "op.list")
      return { ok: true, value: { active: null, tasks: [], history: [] } };
    if (method === "status") return { ok: true, value: { ...statusPayload, hot: false } };
    return await defaultHandler(makeRows(3), installed)(method, payload);
  });
  harness.renderPanel();
  await tick();
  findNode(
    harness.renderPanel(),
    (node) => node.type === "button" && text(node) === "已装",
  ).props.onClick();
  const tree = harness.renderPanel();
  findNode(tree, (node) => node.type === "button" && text(node) === "热重载").props.onClick();
  const dialog = findNode(
    harness.renderPanel(),
    (node) => node.props?.className === "pc-overlay",
  );
  assert.ok(dialog, "热重载必须先弹确认框");
  assert.match(text(dialog), /未启用热重载，需要重启 DSH 才生效/);
  assert.doesNotMatch(text(dialog), /立即生效/);
});

test("导出 / 导入面板：导出要确认、预检先给计划、导入再确认下发", async () => {
  const installed = [
    {
      name: "dsh-cost-meter",
      spec: "^1.9.28",
      kind: "registry",
      version: "1.9.46",
      selected: true,
      present: true,
      bundle: true,
      hasClient: false,
    },
  ];
  const calls = [];
  const harness = createHarness(async (method, payload) => {
    if (method === "op.list")
      return { ok: true, value: { active: null, tasks: [], history: [] } };
    if (method === "export.list")
      return {
        ok: true,
        value: [{ name: "2026-11-02-desktop.json", path: "P:/exports/x.json", bytes: 4096, at: 1 }],
      };
    if (method === "export.run") {
      calls.push({ method, payload });
      return {
        ok: true,
        value: {
          name: "2026-11-02-desktop.json",
          path: "P:/exports/2026-11-02-desktop.json",
          bytes: 4096,
          plugins: 2,
          files: 0,
          omissions: [{ path: "cost-meter/state.sqlite", reason: "数据库/日志/锁/压缩包，不导出" }],
          warnings: ["插件设置里有 1 处疑似凭据的字段/取值，已替换为 [已脱敏]"],
        },
      };
    }
    if (method === "import.preview") {
      calls.push({ method, payload });
      return {
        ok: true,
        value: {
          plan: {
            source: "2026-11-02-desktop.json",
            exportProfile: "laptop",
            steps: [
              { name: "dsh-new", action: "install", spec: "dsh-new@1.0.3", kind: "registry" },
              { name: "dsh-cost-meter", action: "disable", kind: "registry" },
              { name: "dsh-same", action: "skip", reason: "依赖、启用状态与条目开关都已一致" },
              { name: "dsh-local", action: "blocked", reason: "目标机器上没有这个路径" },
            ],
            settings: { changed: ["locale"] },
            configRows: 1,
            unattributedRows: 2,
            builtinRows: 11,
            unresolved: [{ id: "mystery", reason: "条目归属尚未确认，不自动删除" }],
            omissions: [],
            warnings: ["导出文件来自 profile「laptop」，本机是「desktop」：本地路径形态可能对不上"],
          },
          snippet: '- id: "cost-meter"\n  config:\n    budgetUsd: 12\n',
        },
      };
    }
    if (method === "op.import") {
      calls.push({ method, payload });
      return {
        ok: true,
        value: { id: "op-9", kind: "import", target: "x.json", note: "计划：安装 1、启用 0…" },
      };
    }
    return await defaultHandler(makeRows(3), installed)(method, payload);
  });
  harness.renderPanel();
  await tick();
  findNode(
    harness.renderPanel(),
    (node) => node.type === "button" && text(node) === "已装",
  ).props.onClick();
  let tree = harness.renderPanel();
  assert.ok(
    !findNode(tree, (node) => node.props?.["data-transfer"] === "1"),
    "默认不展开导出 / 导入面板",
  );
  findNode(
    tree,
    (node) => node.type === "button" && text(node) === "导出 / 导入",
  ).props.onClick();
  tree = harness.renderPanel();
  assert.ok(
    findNode(tree, (node) => node.props?.["data-transfer"] === "1"),
    "点开后要出现面板",
  );

  // 勾上「同时导出插件设置」再导出（改状态后必须重新渲染，否则点到的还是旧闭包）
  findNode(tree, (node) => node.type === "input" && node.props?.type === "checkbox").props.onChange({
    target: { checked: true },
  });
  tree = harness.renderPanel();
  findNode(
    tree,
    (node) => node.type === "button" && text(node) === "导出到文件",
  ).props.onClick();
  await tick();
  tree = harness.renderPanel();
  assert.deepEqual(plain(calls[0]), {
    method: "export.run",
    payload: { includeData: true, confirm: true },
  });
  const exportText = text(tree);
  assert.match(exportText, /已导出 2 个插件/);
  assert.match(exportText, /P:\/exports\/2026-11-02-desktop\.json/);
  assert.match(exportText, /未导出 1 项/);
  assert.match(exportText, /\[已脱敏\]/);

  // 预检：计划逐条列出来，且这一步不产生任何变更
  findNode(tree, (node) => node.type === "button" && text(node) === "预检").props.onClick();
  await tick();
  tree = harness.renderPanel();
  assert.deepEqual(plain(calls[1]), {
    method: "import.preview",
    payload: { path: "2026-11-02-desktop.json" },
  });
  const planText = text(tree);
  assert.match(planText, /将安装 1/);
  assert.match(planText, /将停用 1/);
  assert.match(planText, /dsh-new：将安装 ← dsh-new@1\.0\.3/);
  assert.match(planText, /dsh-local：无法处理（目标机器上没有这个路径）/);
  assert.match(planText, /本插件自己的设置会被覆盖：locale/);
  assert.match(planText, /另有 2 行补丁归属尚未确认/);
  assert.match(planText, /11 行宿主内置配置/);
  assert.match(planText, /mystery：条目归属尚未确认/);
  assert.doesNotMatch(planText, /已原样带在导出文件里/);
  assert.match(planText, /1 行带 config 的补丁行/);
  assert.match(planText, /自行粘贴/);
  assert.equal(calls.length, 2, "预检不得下发任何变更");

  // 导入：确认后才下发，并且只发路径与确认
  findNode(
    tree,
    (node) => node.type === "button" && text(node) === "开始导入",
  ).props.onClick();
  await tick();
  tree = harness.renderPanel();
  assert.deepEqual(plain(calls[2]), {
    method: "op.import",
    payload: { path: "2026-11-02-desktop.json", confirm: true },
  });
  assert.match(text(tree), /已加入操作队列/);
  assert.match(text(tree), /进度与逐项结果在「操作」页/);
});

test("导入：文件浏览器选中文件 → 上传落盘 → 立刻预检该文件（不是下拉框里第一个）", async () => {
  const calls = [];
  const harness = createHarness(async (method, payload) => {
    if (method === "op.list")
      return { ok: true, value: { active: null, tasks: [], history: [] } };
    if (method === "export.list")
      return {
        ok: true,
        value: [
          { name: "2026-01-01-desktop.json", path: "P:/exports/old.json", bytes: 2048, at: 1 },
        ],
      };
    if (method === "import.upload") {
      calls.push({ method, payload });
      return {
        ok: true,
        value: { name: "2026-11-02-desktop-laptop.json", path: "P:/exports/2026-11-02-desktop-laptop.json", bytes: 4096 },
      };
    }
    if (method === "import.preview") {
      calls.push({ method, payload });
      return {
        ok: true,
        value: {
          plan: {
            source: "2026-11-02-desktop-laptop.json",
            steps: [{ name: "dsh-new", action: "install", spec: "dsh-new@1.0.3", kind: "registry" }],
            settings: { changed: [] },
            configRows: 0,
            unattributedRows: 0,
            omissions: [],
            warnings: [],
          },
        },
      };
    }
    return await defaultHandler(makeRows(3), [])(method, payload);
  });
  harness.renderPanel();
  await tick();
  findNode(
    harness.renderPanel(),
    (node) => node.type === "button" && text(node) === "已装",
  ).props.onClick();
  let tree = harness.renderPanel();
  findNode(
    tree,
    (node) => node.type === "button" && text(node) === "导出 / 导入",
  ).props.onClick();
  tree = harness.renderPanel();

  // 真的有一个文件输入框，且按钮点了会去触发它
  const input = findNode(tree, (node) => node.type === "input" && node.props?.type === "file");
  assert.ok(input, "导入区必须有一个 type=file 的输入框（文件浏览器入口）");
  assert.equal(input.props.accept, ".json,application/json", "只让选 JSON");
  assert.equal(input.props["data-pick"], "1");
  assert.equal(input.props.style?.display, "none", "原生控件藏起来，由按钮代理点击");
  const pick = findNode(tree, (node) => node.type === "button" && text(node) === "选择文件…");
  assert.ok(pick, "要有一个显式的「选择文件…」按钮");
  assert.equal(pick.props.disabled, false);

  // 选中一个文件：先上传，再**用返回的路径**预检（不能退回下拉框里的旧文件）
  await input.props.onChange({
    target: {
      files: [
        {
          name: "laptop.json",
          text: async () => '{"format":"dsh-plugin-harbor/export","version":1,"plugins":[]}',
        },
      ],
      value: "C:\\fakepath\\laptop.json",
    },
  });
  await tick();
  tree = harness.renderPanel();

  assert.deepEqual(plain(calls[0]), {
    method: "import.upload",
    payload: {
      name: "laptop.json",
      content: '{"format":"dsh-plugin-harbor/export","version":1,"plugins":[]}',
    },
  });
  assert.deepEqual(
    plain(calls[1]),
    { method: "import.preview", payload: { path: "P:/exports/2026-11-02-desktop-laptop.json" } },
    "预检必须用刚上传文件的路径，而不是导出目录里的第一个文件",
  );
  assert.match(text(tree), /已选择：2026-11-02-desktop-laptop\.json/);
  assert.match(text(tree), /dsh-new：将安装/);
  assert.equal(
    tree.children.some((child) => child?.props?.["data-pick"] === "1" && child?.props?.value !== ""),
    false,
    "选完要清空 input.value，否则再选同一个文件不触发 change",
  );
});

test("导入：选错文件时如实报错，不留半截状态", async () => {
  const harness = createHarness(async (method, payload) => {
    if (method === "op.list")
      return { ok: true, value: { active: null, tasks: [], history: [] } };
    if (method === "export.list") return { ok: true, value: [] };
    if (method === "import.upload")
      return {
        ok: false,
        error: { code: "plugin-harbor/error", message: "这个文件不能作为导入源：不是插件港湾的导出文件（format=undefined）" },
      };
    return await defaultHandler(makeRows(3), [])(method, payload);
  });
  harness.renderPanel();
  await tick();
  findNode(
    harness.renderPanel(),
    (node) => node.type === "button" && text(node) === "已装",
  ).props.onClick();
  let tree = harness.renderPanel();
  findNode(
    tree,
    (node) => node.type === "button" && text(node) === "导出 / 导入",
  ).props.onClick();
  tree = harness.renderPanel();

  const input = findNode(tree, (node) => node.type === "input" && node.props?.type === "file");
  await input.props.onChange({
    target: { files: [{ name: "notes.json", text: async () => '{"hello":"world"}' }], value: "x" },
  });
  await tick();
  tree = harness.renderPanel();
  assert.match(text(tree), /这个文件不能作为导入源/);
  assert.ok(
    !findNode(tree, (node) => node.props?.["data-picked"] === "1"),
    "上传失败时不能显示「已选择」",
  );
  assert.ok(
    !findNode(tree, (node) => node.type === "button" && text(node) === "开始导入"),
    "没有预检结果就不该出现导入按钮",
  );
});

test("调用不存在的方法时：仅显示实际错误，不追加构建提示", async () => {
  const harness = createHarness(async (method) => {
    if (method === "op.list")
      return { ok: true, value: { active: null, tasks: [], history: [] } };
    if (method === "export.list") return { ok: true, value: [] };
    if (method === "export.run")
      return {
        ok: false,
        error: {
          code: "plugin-harbor/unknown-method",
          message: "Unknown method: export.run",
        },
      };
    return await defaultHandler(makeRows(3), [])(method, {});
  });
  harness.renderPanel();
  await tick();
  findNode(
    harness.renderPanel(),
    (node) => node.type === "button" && text(node) === "已装",
  ).props.onClick();
  let tree = harness.renderPanel();
  findNode(
    tree,
    (node) => node.type === "button" && text(node) === "导出 / 导入",
  ).props.onClick();
  tree = harness.renderPanel();
  findNode(
    tree,
    (node) => node.type === "button" && text(node) === "导出到文件",
  ).props.onClick();
  await tick();
  const shown = text(harness.renderPanel());
  assert.doesNotMatch(shown, /插件构建不一致|热重载后会自动重新核对/);
  assert.match(shown, /Unknown method: export\.run/, "原始报文要留一份便于排查");
});

test("操作页显示进度、日志与取消按钮", async () => {
  const tasks = [
    {
      id: "op-live",
      kind: "install",
      target: "dsh-x",
      spec: "github:o/r",
      status: "running",
      progress: 42,
      log: ["Progress: resolved 10", "Packages: +3"],
      queuedAt: 1,
      startedAt: 2,
    },
    {
      id: "op-done",
      kind: "update",
      target: "dsh-y",
      // 更新任务里 `spec` 是 profile 记的版本范围，`installSpec` 才是真正交给 pnpm 的地址
      spec: "^1.9.28",
      installSpec: "dsh-y@1.9.30",
      status: "restart-required",
      needsRestart: true,
      note: "已卸载旧版本并安装新版本；请重启 DSH 让新代码生效",
      queuedAt: 1,
      endedAt: 3,
    },
  ];
  const history = [
    {
      id: "op-old",
      kind: "remove",
      target: "dsh-z",
      status: "failed",
      error: "宿主不允许移除这个包",
      queuedAt: 1,
      endedAt: 2,
    },
  ];
  const opCalls = [];
  const harness = createHarness(async (method, payload) => {
    if (method === "op.list")
      return { ok: true, value: { active: "op-live", tasks, history } };
    if (method === "op.cancel") {
      opCalls.push(payload);
      return { ok: true, value: { cancelled: true } };
    }
    return await defaultHandler(makeRows(5), [])(method, payload);
  });
  harness.renderPanel();
  await tick();
  const tab = findNode(
    harness.renderPanel(),
    (node) => node.type === "button" && text(node) === "操作",
  );
  tab.props.onClick();
  const tree = harness.renderPanel();
  const shown = text(tree);
  assert.match(shown, /进行中 1/);
  assert.match(shown, /42%/);
  assert.match(shown, /Progress: resolved 10/);
  assert.match(shown, /待重启/);
  assert.match(shown, /重启 DSH/);
  assert.match(shown, /历史记录/);
  assert.match(shown, /宿主不允许移除这个包/);
  /**
   * 操作行显示**实际交给 pnpm 的地址**：显示 `← ^1.9.28` 会让人以为「更新到
   * ^1.9.28」（范围不是版本，本轮线上就是这个误解）。
   */
  assert.match(shown, /dsh-y ← dsh-y@1\.9\.30/);
  assert.doesNotMatch(shown, /← \^1\.9\.28/);
  const bar = findNode(tree, (node) => node.props?.className === "pc-bar-fill");
  assert.equal(bar.props.style.width, "42%");

  const cancel = findNode(
    tree,
    (node) => node.type === "button" && text(node) === "取消",
  );
  assert.ok(cancel, "运行中的任务要有取消按钮");
  await cancel.props.onClick();
  await tick();
  assert.deepEqual(plain(opCalls), [{ id: "op-live", confirm: true }]);
});

test("设置页：显示当前值，保存把小时换算成毫秒下发全部字段", async () => {
  const setCalls = [];
  const harness = createHarness(async (method, payload) => {
    if (method === "settings.set") {
      setCalls.push(payload);
      return { ok: true, value: { ...centerSettings, ...payload } };
    }
    return await defaultHandler(makeRows(5), [])(method, payload);
  });
  harness.renderPanel();
  await tick();
  const tab = findNode(
    harness.renderPanel(),
    (node) => node.type === "button" && text(node) === "设置",
  );
  tab.props.onClick();
  let tree = harness.renderPanel();
  const shown = text(tree);
  assert.match(shown, /目录与来源/);

  /** 按 aria-label 找到输入框：基址这类值落在 input 的 value 上，不进文本。 */
  const input = (label) =>
    findNode(
      tree,
      (node) => node.props?.["aria-label"] === label,
    );
  assert.equal(
    input("官网基址").props.value,
    "https://dsh-plugin.org",
    "必须回填当前基址",
  );
  const hours = input("自动刷新间隔（小时）");
  assert.equal(hours.props.value, "24", "24 小时应回填为 24");
  hours.props.onChange({ target: { value: "12" } });
  const registry = input("npm registry（留空用官方源）");
  registry.props.onChange({ target: { value: "https://registry.npmmirror.com" } });

  const save = findNode(
    harness.renderPanel(),
    (node) => node.type === "button" && text(node) === "保存设置",
  );
  await save.props.onClick();
  await tick();
  assert.equal(setCalls.length, 1);
  assert.deepEqual(plain(setCalls[0]), {
    locale: "zh",
    syncTtlMs: 12 * 3_600_000,
    siteBase: "https://dsh-plugin.org",
    apiBase: "https://api.dsh-plugin.org",
    registry: "https://registry.npmmirror.com",
    proxy: "",
  });
  assert.match(text(harness.renderPanel()), /已保存/);
});

test("设置页：非法的小时数在本地拦下，不惊动服务端", async () => {
  let sets = 0;
  const harness = createHarness(async (method, payload) => {
    if (method === "settings.set") {
      sets += 1;
      return { ok: true, value: centerSettings };
    }
    return await defaultHandler(makeRows(5), [])(method, payload);
  });
  harness.renderPanel();
  await tick();
  findNode(
    harness.renderPanel(),
    (node) => node.type === "button" && text(node) === "设置",
  ).props.onClick();
  let tree = harness.renderPanel();
  const hours = findNode(
    tree,
    (node) => node.props?.["aria-label"] === "自动刷新间隔（小时）",
  );
  hours.props.onChange({ target: { value: "0" } });
  const save = findNode(
    harness.renderPanel(),
    (node) => node.type === "button" && text(node) === "保存设置",
  );
  await save.props.onClick();
  await tick();
  assert.equal(sets, 0, "非法输入不该下发");
  assert.match(text(harness.renderPanel()), /必须是大于 0 的小时数/);
});

test("设置页：诊断结果分「通过 / 失败 / 无结论」三态显示", async () => {
  const harness = createHarness(defaultHandler(makeRows(5), []));
  harness.renderPanel();
  await tick();
  findNode(
    harness.renderPanel(),
    (node) => node.type === "button" && text(node) === "设置",
  ).props.onClick();
  let tree = harness.renderPanel();
  assert.ok(
    !findNode(tree, (node) => node.props?.["data-check"]),
    "未点按钮前不该有诊断结果",
  );
  const run = findNode(
    tree,
    (node) => node.type === "button" && text(node) === "运行诊断",
  );
  await run.props.onClick();
  await tick();
  tree = harness.renderPanel();
  const shown = text(tree);
  assert.match(shown, /通过 1｜失败 1｜无结论 1/);
  assert.match(shown, /超时（20000ms）/, "失败原因要显示出来");
  const siteRow = findNode(tree, (node) => node.props?.["data-check"] === "site");
  assert.match(text(siteRow), /失败/);
  const gitRow = findNode(tree, (node) => node.props?.["data-check"] === "git");
  assert.match(text(gitRow), /无结论/);
});

test("四个页面都不再渲染过时的「M2–M3 落地」占位卡片", async () => {
  // 真实缺陷：占位卡片写成 `tab === "ops" ? null : placeholder`，
  // 于是市场/已装/设置三页底部都挂着一张「这一页在 M2–M3 落地…」的待办卡。
  const harness = createHarness(defaultHandler(makeRows(5), []));
  harness.renderPanel();
  await tick();
  for (const label of ["市场", "已装", "操作", "设置"]) {
    const tab = findNode(
      harness.renderPanel(),
      (node) => node.type === "button" && text(node) === label,
    );
    assert.ok(tab, `必须有「${label}」页签`);
    tab.props.onClick();
    const shown = text(harness.renderPanel());
    assert.doesNotMatch(shown, /M2–M3 落地/, `${label} 页不该再出现过时占位卡片`);
    assert.doesNotMatch(
      shown,
      /这一页在/,
      `${label} 页不该再出现任何「这一页在…落地」的措辞`,
    );
  }
});

test("设置页结构：分段卡片 + 字段说明 + 保存条 + 存储现状", async () => {
  const harness = createHarness(defaultHandler(makeRows(5), []));
  harness.renderPanel();
  await tick();
  findNode(
    harness.renderPanel(),
    (node) => node.type === "button" && text(node) === "设置",
  ).props.onClick();
  // 设置页挂载后才会去读 catalog.status，必须再渲染一次并让出微任务
  // （否则「存储与运行」还是空值 —— 本轮实测踩到）。
  harness.renderPanel();
  await tick();
  const tree = harness.renderPanel();
  const shown = text(tree);
  for (const section of ["目录与来源", "网络与镜像", "存储与运行", "诊断"])
    assert.match(shown, new RegExp(section), `设置页应有「${section}」分区`);
  // 每个字段都带说明，且控件是表单样式（不是市场页的搜索框样式）。
  // ⚠️ 用「空格分隔的类名 token」判断，不能用 includes：`pc-field-hint` 也
  // 包含 `pc-field` 子串，会把说明本身当成字段（本轮实测踩到）。
  const hasClass = (node, name) =>
    String(node.props?.className ?? "").split(/\s+/).includes(name);
  const fields = nodes(tree).filter((node) => hasClass(node, "pc-field"));
  assert.ok(fields.length >= 6, `字段数量应 ≥6，实际 ${fields.length}`);
  for (const field of fields) {
    assert.ok(
      nodes(field).some((node) => hasClass(node, "pc-field-hint")),
      "每个字段都该有一句说明",
    );
    const control = nodes(field).find(
      (node) => node.type === "input" || node.type === "select",
    );
    assert.ok(hasClass(control, "pc-input"), "字段控件必须是表单样式");
  }
  // 保存条：显示落盘路径
  assert.match(shown, /settings\.json/);
  // 存储现状：目录条目与上次同步来自 catalog.status
  assert.match(shown, /19,866 条/);
  assert.match(shown, /站点自报 19,866/);
});

test("surfaces a failed RPC instead of rendering a half page", async () => {
  const harness = createHarness(async () => ({
    ok: false,
    error: { message: "catalog store is closed" },
  }));
  harness.renderPanel();
  await tick();
  const shown = text(harness.renderPanel());
  assert.match(shown, /catalog store is closed/);
});

test("does not use APIs the host GUI does not implement", () => {
  // 宿主 GUI 跑在 Electron 渲染进程：prompt() 未实现，调用即抛错。
  assert.doesNotMatch(source, /\bwindow\.prompt\b|\bprompt\(/);
  assert.doesNotMatch(source, /innerHTML/);
  assert.doesNotMatch(source, /document\.createElement/);
  /**
   * 外链一律用 `<a target="_blank" rel="noopener noreferrer">`，不用 `window.open`：
   * 桌面宿主的 `setWindowOpenHandler` 会把 http/https 交给 `shell.openExternal`，
   * 而 `window.open` 在新版浏览器里容易被弹窗拦截，还拿不到同等的 rel 保护。
   */
  assert.doesNotMatch(source, /\bwindow\.open\s*\(/);
});
test("Git sync panel stays local until requested and confirms publishing/applying", async () => {
  const calls = [];
  const config = { remote: "git@github.com:you/shared.git", environment: "desktop" };
  const harness = createHarness(async (method, payload) => {
    if (method.startsWith("sync.")) calls.push({ method, payload });
    if (method === "sync.get") return { ok: true, value: { config, branch: "harbor-sync" } };
    if (method === "sync.preview") return { ok: true, value: {
      configPlans: [{ plugin: "example", id: "example", action: "apply", paths: ["theme"], skipped: ["token"] }],
      token: "server-token", commit: "abc123", hasRemote: true, same: false, history: ["abc123 2026-11-04"], versions: ["example：安装来源或版本不同，首版保留本机版本"],
      local: { plugins: [{ name: "example", enabled: true }], configRows: 1, snapshot: '{"config":"[已脱敏]"}', omissions: [], warnings: [] },
      plan: { steps: [{ name: "example", action: "install", spec: "example@1.0.0" }], settings: { changed: [] }, configRows: 1, omissions: [], warnings: [] },
      snippet: "# 人工恢复配置",
    } };
    if (method === "sync.publish") return { ok: true, value: { commit: "def456", unchanged: false } };
    if (method === "sync.apply") return { ok: true, value: { id: "sync-op" } };
    return await defaultHandler(makeRows(2), [])(method, payload);
  });
  const click = (label) => findNode(harness.renderPanel(), n => n.type === "button" && text(n) === label).props.onClick();
  harness.renderPanel(); await tick(); click("已装"); click("导出 / 导入"); harness.renderPanel(); await tick();
  assert.deepEqual(calls.map(c => c.method), ["sync.get"], "打开同步面板不查询远端");
  click("检查远端并预检"); await tick();
  assert.match(text(harness.renderPanel()), /首版保留本机版本/);
  assert.match(text(harness.renderPanel()), /自动合并 theme/);
  assert.doesNotMatch(text(harness.renderPanel()), /需人工恢复的配置片段|未自动应用的配置（查看原因与片段）/, "只有自动配置计划时，不显示人工片段，即使旧数据残留 snippet");
  click("发布本机快照");
  assert.equal(calls.filter(c => c.method === "sync.publish").length, 0);
  click("取消");
  assert.equal(calls.filter(c => c.method === "sync.publish").length, 0);
  click("发布本机快照"); click("确认"); await tick();
  assert.deepEqual(plain(calls.find(c => c.method === "sync.publish").payload), { token: "server-token", confirm: true });
  click("检查远端并预检"); await tick(); click("应用远端快照");
  assert.equal(calls.filter(c => c.method === "sync.apply").length, 0);
  click("确认"); await tick();
  assert.deepEqual(plain(calls.find(c => c.method === "sync.apply").payload), { token: "server-token", confirm: true });
});


test("构建不同也不显示提示，空闲时不轮询宿主构建号", async () => {
  const calls = [];
  const harness = createHarness(async (method, payload) => {
    calls.push(method);
    if (method === "status") return { ok: true, value: { ...statusPayload, build: "different-build" } };
    return await defaultHandler(makeRows(2), [])(method, payload);
  });
  harness.renderPanel(); await tick();
  harness.runIntervals(); await tick();
  const tree = harness.renderPanel();
  assert.ok(!findNode(tree, node => node.props?.["data-stale-host"] === "1"));
  assert.doesNotMatch(text(tree), /插件构建不一致|热重载后会自动重新核对/);
  assert.equal(calls.filter(method => method === "status").length, 1);
});

test("本地开发插件不提供远端更新，保留热重载入口", async () => {
  const harness = createHarness(defaultHandler(makeRows(2), [{ name: "dev-plugin", kind: "path", spec: "link:../dev-plugin", selected: true, version: "1.0.0", update: { updateAvailable: null } }]));
  harness.renderPanel(); await tick();
  findNode(harness.renderPanel(), n => n.type === "button" && text(n) === "已装").props.onClick();
  const row = findNode(harness.renderPanel(), n => n.props?.["data-plugin"] === "dev-plugin");
  const update = findNode(row, n => n.type === "button" && text(n) === "更新");
  assert.equal(update.props.disabled, true);
  assert.match(update.props.title, /本地路径插件/);
  assert.ok(findNode(row, n => n.type === "button" && text(n) === "热重载"));
  update.props.onClick();
  assert.ok(!findNode(harness.renderPanel(), n => n.props?.className === "pc-overlay"));
  assert.match(text(row), /未判定/);
});
