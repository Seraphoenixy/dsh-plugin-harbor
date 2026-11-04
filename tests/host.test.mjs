/**
 * 真实宿主契约（需要 `node scripts/extract-host.mjs` 提取的本机 cordis）。
 *
 * 只使用临时 DSH_HOME 与**本机 HTTP 桩**（127.0.0.1）：不读真实 profile、
 * 不访问 dsh-plugin.org。桩提供与站点同形的索引页与分片响应，
 * 因此这里跑的是完整链路：RPC 路由 → 同步编排 → 真实 fetch → worker 线程 →
 * SQLite → 查询。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let host;
try {
  host = await import("@deepseek-ai/cordis");
} catch {}
const skip = host
  ? false
  : "缺少真实宿主依赖；运行 node scripts/extract-host.mjs 后重试。";

const fixture = (path) =>
  readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8");

/** 起一个只服务夹具的本机 HTTP 桩（端口随机，只监听回环）。 */
async function startFixtureServer(routes) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    const body = routes[request.url];
    if (body === undefined) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 与站点同形的索引页：`self.__next_f.push([1,"…"])` + JS 字符串转义。 */
function indexHtml(chunks, totalCount) {
  const manifest = {};
  for (const chunk of chunks)
    (manifest[chunk.category] ??= []).push(
      `/directory/zh/${chunk.category}-${chunk.page}-${chunk.hash}.json`,
    );
  const payload =
    `1:"$Sreact.fragment"\n` +
    `2:{"sidebarStats":{"totalCount":${totalCount},"categoryCounts":{"agent":617}},"shardManifest":${JSON.stringify(manifest)}}`;
  return `<html><body><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script></body></html>`;
}

/** 起真实 cordis Context + 桩 connection 服务。 */
function createHost() {
  const { Context, Service } = host;
  const routes = [];
  const disposed = [];
  const ctx = new Context();
  class Connection extends Service {
    constructor(c) {
      super(c, "connection");
    }
    fetch = {
      register: (route) => {
        routes.push(route);
        return () => disposed.push(route.path);
      },
    };
  }
  new Connection(ctx);
  return { ctx, routes, disposed };
}

async function callRoute(route, body) {
  const request = new Request("http://localhost/api/plugin-harbor", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await route.fetch(request);
  return { status: response.status, json: await response.json() };
}

const envelope = (method, payload = {}, rpcId = "t1") => ({
  type: "client-request",
  method: "plugin-harbor",
  rpcId,
  payload: { version: 1, method, payload },
});

/**
 * 每个用例一个独立的临时 DSH_HOME，避免相互污染。
 */
async function withTempHome(run) {
  const dir = mkdtempSync(join(tmpdir(), "pcenter-host-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    return await run(dir);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 在临时 DSH_HOME 里搭一个 desktop profile（清单 + lockfile 夹具 + 假 node_modules）。 */
function writeProfile(home, dependencies, bundles) {
  const profile = join(home, "profiles", "desktop");
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    join(profile, "package.json"),
    JSON.stringify({
      name: "dsh-profile-desktop",
      private: true,
      dsh: { profile: { bundles } },
      dependencies,
    }),
    "utf8",
  );
  writeFileSync(
    join(profile, "pnpm-lock.yaml"),
    readFileSync(new URL("./fixtures/profile-lock.yaml", import.meta.url), "utf8"),
    "utf8",
  );
  const write = (name, pkg) => {
    const target = join(profile, "node_modules", name);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "package.json"), JSON.stringify(pkg), "utf8");
  };
  write("dsh-cost-meter", {
    name: "dsh-cost-meter",
    version: "1.9.28",
    repository: {
      type: "git",
      url: "git+https://github.com/Han-1413141/dsh-cost-meter.git",
    },
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
  });
  write("dsh-local-plugin", { name: "dsh-local-plugin" });
  return profile;
}

test(
  "real host: fiber mounts the RPC route, answers status, and disposes it",
  { skip },
  async () => {
    const { ctx, routes, disposed } = createHost();
    await withTempHome(async () => {
      let fiber;
      try {
        fiber = ctx.plugin(await import("../dist/index.js"));
        while (fiber.inertia) await fiber.inertia;
        assert.equal(fiber.state, 2, String(fiber._error));
        assert.equal(routes.length, 1, "must register exactly one route");
        assert.equal(routes[0].path, "/api/plugin-harbor");

        const ok = await callRoute(routes[0], envelope("status"));
        assert.equal(ok.status, 200);
        assert.equal(ok.json.type, "server-response");
        assert.equal(ok.json.rpcId, "t1");
        assert.equal(ok.json.result.ok, true);
        assert.equal(ok.json.result.value.plugin, "plugin-harbor");
        assert.equal(ok.json.result.value.profile, "desktop");
        assert.equal(typeof ok.json.result.value.store.sqlite, "string");
        // 构建标识：客户端拿它比对，判断宿主里跑的是不是旧构建
        assert.match(ok.json.result.value.build, /^[0-9a-f]{12}$/);
        // 这个宿主上下文里没有 hmr 服务：必须如实报 false（界面据此说「需要重启」）
        assert.equal(ok.json.result.value.hot, false);
        // 目录库必须落在本 profile 下（不是进程当前目录，也不是别的 profile）。
        assert.match(
          ok.json.result.value.dbPath.replaceAll("\\", "/"),
          /profiles\/desktop\/plugin-harbor\/catalog\.sqlite$/,
        );
        assert.ok(
          existsSync(ok.json.result.value.dbPath),
          "store ping must have created the catalog database",
        );

        const foreign = await callRoute(routes[0], {
          ...envelope("status"),
          method: "other-plugin",
        });
        assert.equal(foreign.json.result.ok, false);
        assert.equal(
          foreign.json.result.error.code,
          "plugin-harbor/invalid-envelope",
        );
        assert.equal(foreign.json.rpcId, "t1");

        const unknown = await callRoute(
          routes[0],
          envelope("does.not.exist", {}, "t3"),
        );
        assert.equal(unknown.json.rpcId, "t3");
        assert.equal(
          unknown.json.result.error.code,
          "plugin-harbor/unknown-method",
        );

        const notJson = await routes[0].fetch(
          new Request("http://localhost/api/plugin-harbor", { method: "POST" }),
        );
        assert.equal(notJson.status, 415);

        const wrongVerb = await routes[0].fetch(
          new Request("http://localhost/api/plugin-harbor", { method: "GET" }),
        );
        assert.equal(wrongVerb.status, 405);
      } finally {
        await fiber?.dispose();
        await ctx.stop?.();
      }
      assert.deepEqual(disposed, ["/api/plugin-harbor"]);
    });
  },
);

test("real host: apply exposes dispatch and stop closes the store", { skip }, async () => {
  const { ctx } = createHost();
  await withTempHome(async () => {
    try {
      const { apply, name } = await import("../dist/index.js");
      assert.equal(name, "plugin-harbor");
      const plugin = await apply(ctx);
      assert.equal(plugin.rpcMethod, "plugin-harbor");
      assert.equal(plugin.rpcPath, "/api/plugin-harbor");
      const rpc = plugin.rpc ?? null;
      void rpc;
      const unknown = await plugin.dispatch("nope", {}, {
        profile: plugin.profile,
        store: plugin.store,
        log: () => {},
        syncing: () => false,
        refresh: () => Promise.resolve({}),
      });
      assert.equal(unknown.ok, false);
      assert.equal(unknown.error.code, "plugin-harbor/unknown-method");
      await plugin.stop();
      await assert.rejects(() => plugin.store.call("ping"), /closed/);
    } finally {
      await ctx.stop?.();
    }
  });
});

test(
  "real host: 已装清单与更新判据（本机桩 registry，全程离线）",
  { skip },
  async () => {
    /** npm 精简元数据的最小形态：只要 dist-tags 与对应版本的 dist.integrity。 */
    const packument = (latest, integrity) =>
      JSON.stringify({
        "dist-tags": { latest },
        versions: { [latest]: { dist: { integrity } } },
      });
    const server = await startFixtureServer({
      "/dsh-cost-meter": packument("1.9.47", "sha512-newer"),
      "/plugins.zh.json": fixture("curated-zh.json"),
    });
    const previousRegistry = process.env.PLUGIN_HARBOR_REGISTRY;
    const previousApi = process.env.PLUGIN_HARBOR_API;
    process.env.PLUGIN_HARBOR_REGISTRY = server.base;
    process.env.PLUGIN_HARBOR_API = server.base;
    const { ctx, routes } = createHost();
    try {
      await withTempHome(async (home) => {
        // 只放 registry 与本地路径两类：不含 git 形态，避免 spawn git 出网。
        writeProfile(
          home,
          { "dsh-cost-meter": "^1.9.28", "dsh-local-plugin": "file:../local-plugin" },
          ["dsh-cost-meter", "dsh-local-plugin"],
        );
        let fiber;
        try {
          fiber = ctx.plugin(
            await import(`../dist/index.js?installed-stub=${Date.now()}`),
          );
          while (fiber.inertia) await fiber.inertia;
          assert.equal(fiber.state, 2, String(fiber._error));
          const route = routes[0];

          const listed = await callRoute(route, envelope("installed.list"));
          assert.equal(listed.json.result.ok, true);
          const rows = listed.json.result.value;
          assert.equal(rows.length, 2);
          const meter = rows.find((row) => row.name === "dsh-cost-meter");
          assert.equal(meter.kind, "registry");
          assert.equal(meter.spec, "^1.9.28");
          assert.equal(meter.version, "1.9.28");
          assert.equal(meter.repo, "Han-1413141/dsh-cost-meter");
          assert.equal(meter.selected, true);
          assert.equal(meter.update, undefined, "未检查前不得给出任何结论");
          const local = rows.find((row) => row.name === "dsh-local-plugin");
          assert.equal(local.kind, "path");
          assert.equal(local.version, undefined);

          const checked = await callRoute(route, envelope("updates.check"));
          assert.equal(checked.json.result.ok, true);
          const checks = checked.json.result.value;
          const meterCheck = checks.find((check) => check.name === "dsh-cost-meter");
          assert.equal(meterCheck.updateAvailable, true, "1.9.28 → 1.9.47 应判为有更新");
          assert.equal(meterCheck.latestVersion, "1.9.47");
          assert.equal(meterCheck.latestSource, "registry");
          const localCheck = checks.find((check) => check.name === "dsh-local-plugin");
          assert.equal(localCheck.updateAvailable, null, "本地路径安装不得给出结论");
          assert.match(localCheck.note, /本地路径/);

          // registry 只该被查一次（每个包一次）
          const registryHits = server.requests.filter(
            (url) => url === "/dsh-cost-meter",
          );
          assert.equal(registryHits.length, 1);

          // 结论落库，下次读清单就能带上（界面打开不再出网）
          const again = await callRoute(route, envelope("installed.list"));
          const meterAgain = again.json.result.value.find(
            (row) => row.name === "dsh-cost-meter",
          );
          assert.equal(meterAgain.update.updateAvailable, true);
          assert.equal(meterAgain.update.latestVersion, "1.9.47");
        } finally {
          await fiber?.dispose();
          await ctx.stop?.();
        }
      });
    } finally {
      await server.close();
      if (previousRegistry === undefined) delete process.env.PLUGIN_HARBOR_REGISTRY;
      else process.env.PLUGIN_HARBOR_REGISTRY = previousRegistry;
      if (previousApi === undefined) delete process.env.PLUGIN_HARBOR_API;
      else process.env.PLUGIN_HARBOR_API = previousApi;
    }
  },
);

test(
  "real host: 详情页按需抓取并缓存 24h（桩站点）",
  { skip },
  async () => {
    const chunk = { category: "agent", page: 1, hash: "2ec2dd96" };
    const server = await startFixtureServer({
      "/zh/plugins": indexHtml([chunk], 19866),
      [`/directory/zh/agent-1-${chunk.hash}.json`]: fixture("site-shard-agent-1.json"),
      "/plugins.zh.json": fixture("curated-zh.json"),
      "/zh/plugins/yujunzhixue/dsh-purge": fixture("detail-dsh-purge.html"),
    });
    const previousSite = process.env.PLUGIN_HARBOR_SITE;
    const previousApi = process.env.PLUGIN_HARBOR_API;
    process.env.PLUGIN_HARBOR_SITE = server.base;
    process.env.PLUGIN_HARBOR_API = server.base;
    const { ctx, routes } = createHost();
    try {
      await withTempHome(async () => {
        let fiber;
        try {
          fiber = ctx.plugin(await import(`../dist/index.js?detail-stub=${Date.now()}`));
          while (fiber.inertia) await fiber.inertia;
          const route = routes[0];
          await callRoute(route, envelope("catalog.refresh"));

          const first = await callRoute(
            route,
            envelope("plugin.detail", { repo: "yujunzhixue/dsh-purge" }, "d1"),
          );
          assert.equal(first.json.result.ok, true);
          const detail = first.json.result.value;
          assert.equal(detail.slug, "dsh-purge");
          assert.equal(detail.version, "v1.1.85");
          assert.match(detail.installCommand, /^dsh plugin --profile web add /);
          assert.equal(detail.npmPackage, "");

          const hits = () =>
            server.requests.filter((url) => url === "/zh/plugins/yujunzhixue/dsh-purge").length;
          assert.equal(hits(), 1);
          const second = await callRoute(
            route,
            envelope("plugin.detail", { repo: "yujunzhixue/dsh-purge" }, "d2"),
          );
          assert.equal(second.json.result.value.version, "v1.1.85");
          assert.equal(hits(), 1, "24h 缓存内不得重复抓详情页");

          // 非法 repo 必须被拒（不能让它拼出任意 URL）
          const bad = await callRoute(
            route,
            envelope("plugin.detail", { repo: "../../etc/passwd" }, "d3"),
          );
          assert.equal(bad.json.result.ok, false);
          assert.equal(bad.json.result.error.code, "plugin-harbor/error");
          assert.match(bad.json.result.error.message, /Invalid repo/);

          /**
           * 详情页链接要 `owner` + `slug`（不是 repo）：已装清单必须把它们带出来，
           * 否则界面只能拿 repo 切 —— 而 slug 会重名，会指到别的插件的页面。
           */
          const catalogRows = await callRoute(
            route,
            envelope("catalog.list", { limit: 50 }, "d4"),
          );
          assert.equal(catalogRows.json.result.ok, true);
          const purgeRow = catalogRows.json.result.value.rows.find(
            (row) => row.repo === "yujunzhixue/dsh-purge",
          );
          assert.ok(purgeRow, "目录里要有这条");
          assert.equal(purgeRow.slug, "dsh-purge");
          assert.equal(purgeRow.owner, "yujunzhixue");
        } finally {
          await fiber?.dispose();
          await ctx.stop?.();
        }
      });
    } finally {
      await server.close();
      if (previousSite === undefined) delete process.env.PLUGIN_HARBOR_SITE;
      else process.env.PLUGIN_HARBOR_SITE = previousSite;
      if (previousApi === undefined) delete process.env.PLUGIN_HARBOR_API;
      else process.env.PLUGIN_HARBOR_API = previousApi;
    }
  },
);

test(
  "real host: 变更操作走宿主 pluginManager（桩服务，全程离线）",
  { skip },
  async () => {
    /**
     * 本机 registry 桩：只为「更新要装到核实过的那个版本」这条链提供
     * `dist-tags.latest`。不访问真实 npm。
     */
    const server = await startFixtureServer({
      "/dsh-cost-meter": JSON.stringify({
        name: "dsh-cost-meter",
        "dist-tags": { latest: "1.9.30" },
        versions: { "1.9.30": { name: "dsh-cost-meter", version: "1.9.30" } },
      }),
    });
    const previousRegistry = process.env.PLUGIN_HARBOR_REGISTRY;
    process.env.PLUGIN_HARBOR_REGISTRY = server.base;
    const { ctx, routes } = createHost();
    /**
     * ⚠️ 桩服务器必须在 `finally` 里关：用例失败时若直接抛出，监听中的 server 会
     * 吊住事件循环，整个测试文件迟迟不退出（本轮实测：一个 200ms 就失败的用例把
     * 整个 `node --test` 拖到超时才结束）。
     */
    try {
      /** 桩服务：只记录调用并回「已应用」，不碰任何 profile 文件。 */
      class PluginManager extends host.Service {
      constructor(c) {
        super(c, "pluginManager");
      }
      installs = [];
      removes = [];
      enabledCalls = [];
      async installBundle(spec, options) {
        this.installs.push({ spec, options });
        /**
         * 模拟「新版本真的装上了」：把 node_modules 里的版本号改成 spec 指定的那个。
         * 更新后的自动复查要读的是**磁盘上的真实版本**，桩若什么都不改，复查只能
         * 读到旧版本、结论永远是「仍可更新」，那条路径就没被验证到。
         */
        const installed = /^(dsh-cost-meter)@(\S+)$/.exec(spec);
        if (installed && profileDir !== undefined) {
          const target = join(profileDir, "node_modules", installed[1], "package.json");
          const pkg = JSON.parse(readFileSync(target, "utf8"));
          writeFileSync(target, JSON.stringify({ ...pkg, version: installed[2] }), "utf8");
        }
        return { changed: true, application: "applied", stage: "install", target: spec, enabled: true };
      }
      async removeBundle(name) {
        this.removes.push(name);
        return { changed: true, application: "applied", target: name };
      }
      async setBundleEnabled(name, enabled) {
        this.enabledCalls.push([name, enabled]);
        return { changed: true, application: "applied", target: name, enabled };
      }
      async listBundles() {
        return [];
      }
    }
    /**
     * 桩服务：宿主侧的热重载能力。`status.hot` 就是探测这个服务在不在
     * （真实宿主由 `dsh-base` 的 `hmr` 条目提供，桌面启动器会启用它）。
     */
    class Hmr extends host.Service {
      constructor(c) {
        super(c, "hmr");
      }
    }
    new Hmr(ctx);
    const manager = new PluginManager(ctx);
    let profileDir;
    await withTempHome(async (home) => {
      profileDir = writeProfile(
        home,
        {
          "dsh-cost-meter": "^1.9.28",
          "dsh-local-plugin": "file:../local-plugin",
          // 本插件自己：用 `link:` 指向本仓库，专门覆盖「自热重载」那条分支
          "dsh-plugin-harbor": "link:" + fileURLToPath(new URL("..", import.meta.url)),
          // 未启用的插件：热重载不该替用户改启用状态
          "dsh-idle-plugin": "^1.0.0",
        },
        ["dsh-cost-meter", "dsh-local-plugin", "dsh-plugin-harbor"],
      );
      let fiber;
      try {
        fiber = ctx.plugin(await import(`../dist/index.js?ops-stub=${Date.now()}`));
        while (fiber.inertia) await fiber.inertia;
        assert.equal(fiber.state, 2, String(fiber._error));
        const route = routes[0];

        /** 轮询到任务进入终态（队列是异步跑的）。 */
        const settle = async (id, timeoutMs = 4000) => {
          const started = Date.now();
          let task;
          for (;;) {
            const listed = await callRoute(route, envelope("op.list"));
            const all = [
              ...listed.json.result.value.tasks,
              ...listed.json.result.value.history,
            ];
            task = all.find((entry) => entry.id === id);
            if (task && task.status !== "queued" && task.status !== "running") return task;
            if (Date.now() - started > timeoutMs)
              throw Error("任务未在预期时间内结束：" + JSON.stringify(task));
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        };

        // 1. 安装：必须带 confirm，且真的交给宿主服务
        const denied = await callRoute(route, envelope("op.install", { spec: "dsh-new-plugin" }));
        assert.equal(denied.json.result.ok, false);
        assert.match(denied.json.result.error.message, /需要确认/);

        const badSpec = await callRoute(
          route,
          envelope("op.install", { spec: "-g", confirm: true }),
        );
        assert.equal(badSpec.json.result.ok, false);
        assert.match(badSpec.json.result.error.message, /不能以/);

        const queued = await callRoute(
          route,
          envelope("op.install", { spec: "dsh-new-plugin", confirm: true }, "i1"),
        );
        assert.equal(queued.json.result.ok, true);
        const installedTask = await settle(queued.json.result.value.id);
        assert.equal(installedTask.status, "done");
        assert.equal(installedTask.via, "manager");
        assert.deepEqual(manager.installs.map((entry) => entry.spec), ["dsh-new-plugin"]);
        assert.equal(manager.installs[0].options.enabled, true);
        assert.match(manager.installs[0].options.requestId, /^plugin-harbor:/);

        // 2. 更新：先卸载再安装，结论一律待重启
        //    先跑一次更新检查（走本机 registry 桩），让「目标版本」有据可依。
        const checked = await callRoute(route, envelope("updates.check"));
        assert.equal(checked.json.result.ok, true);
        const verdict = checked.json.result.value.find(
          (entry) => entry.name === "dsh-cost-meter",
        );
        assert.equal(verdict.latestVersion, "1.9.30", JSON.stringify(verdict));
        assert.equal(verdict.updateAvailable, true, JSON.stringify(verdict));

        const updateQueued = await callRoute(
          route,
          envelope("op.update", { name: "dsh-cost-meter", confirm: true }, "u1"),
        );
        assert.equal(updateQueued.json.result.ok, true);
        /**
         * ⚠️ 交给 pnpm 的必须是**可安装地址**，而且要是核实过的那个版本。profile 里记的
         * 是版本范围（`^1.9.28`），把范围直接交给 pnpm 会被当成包名，实测报
         * `ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER`，而那时旧版本已经卸载 ——
         * 插件就此从 profile 里消失（本轮线上故障）。
         */
        assert.equal(updateQueued.json.result.value.installSpec, "dsh-cost-meter@1.9.30");
        assert.equal(updateQueued.json.result.value.restoreSpec, "dsh-cost-meter@^1.9.28");
        assert.equal(updateQueued.json.result.value.spec, "^1.9.28", "记录值仍要保留（只作展示与回滚依据）");
        const updatedTask = await settle(updateQueued.json.result.value.id);
        /**
         * 宿主（这里是有 hmr 服务的桌面形态）回 `applied`，说明新代码已原地生效：
         * 结论必须是「已完成」，不能再谎报需要重启（本轮报障：改为支持热加载）。
         */
        assert.equal(updatedTask.status, "done");
        assert.notEqual(updatedTask.needsRestart, true);
        assert.match(updatedTask.note, /已热加载/);
        assert.deepEqual(manager.removes, ["dsh-cost-meter"]);
        assert.deepEqual(
          manager.installs.map((entry) => entry.spec),
          ["dsh-new-plugin", "dsh-cost-meter@1.9.30"],
        );
        /**
         * 2a. 更新完成后要**自动复查被更新的那个插件**：
         *     - 结论里带复查结果，不能还挂着更新前那句「可更新」；
         *     - 复查结论已落库，界面重读清单就能拿到「已最新」。
         */
        assert.match(updatedTask.note, /更新后已复查/, updatedTask.note);
        assert.match(updatedTask.note, /已是最新/, updatedTask.note);
        assert.equal(
          updatedTask.log.some((line) => /更新后复查 dsh-cost-meter/.test(line)),
          true,
          "复查也要进任务日志：" + JSON.stringify(updatedTask.log),
        );
        const afterUpdate = await callRoute(route, envelope("installed.list", {}, "u1b"));
        const meterAfter = afterUpdate.json.result.value.find(
          (row) => row.name === "dsh-cost-meter",
        );
        assert.equal(
          meterAfter.update.updateAvailable,
          false,
          "复查结论要落库：更新完再看已装页，不该还显示「可更新」",
        );
        assert.equal(meterAfter.update.installedVersion, "1.9.30");
        assert.ok(
          meterAfter.update.checkedAt > verdict.checkedAt,
          "复查的时间戳必须晚于更新前那次检查",
        );
        /**
         * 复查**只查被更新的那个**：registry 桩上 dsh-cost-meter 被查了两次
         * （更新前一次、复查一次），没有因为复查把整张表重查一遍。
         */
        assert.equal(
          server.requests.filter((url) => url === "/dsh-cost-meter").length,
          2,
          "复查只该查被更新的那个插件",
        );

        /**
         * 2b. 本地路径形态：地址按 profile 目录解析成绝对路径（相对路径交给宿主
         * 会按宿主进程 cwd 解析，装到毫无关系的位置）。
         */
        const localQueued = await callRoute(
          route,
          envelope("op.update", { name: "dsh-local-plugin", confirm: true }, "u2"),
        );
        assert.equal(localQueued.json.result.ok, true);
        const localSpec = localQueued.json.result.value.installSpec;
        assert.ok(localSpec.startsWith("file:"), localSpec);
        assert.ok(isAbsolute(localSpec.slice("file:".length)), localSpec);
        assert.match(localSpec, /local-plugin$/);
        await settle(localQueued.json.result.value.id);

        // 3. 更新不存在的插件：明确报错，不入队
        const missing = await callRoute(
          route,
          envelope("op.update", { name: "dsh-not-installed", confirm: true }),
        );
        assert.equal(missing.json.result.ok, false);
        assert.match(missing.json.result.error.message, /不在当前 profile 的已装列表/);

        // 4. 启停
        const disabled = await callRoute(
          route,
          envelope("op.setEnabled", { name: "dsh-cost-meter", enabled: false, confirm: true }, "e1"),
        );
        const disabledTask = await settle(disabled.json.result.value.id);
        assert.equal(disabledTask.status, "done");
        assert.deepEqual(manager.enabledCalls, [["dsh-cost-meter", false]]);

        // 5. 历史落库：任务结束后仍能从历史里读到
        const listed = await callRoute(route, envelope("op.list"));
        const history = listed.json.result.value.history;
        assert.ok(history.length >= 3, "终态任务必须写入历史");
        assert.ok(
          history.some((entry) => entry.id === installedTask.id && entry.status === "done"),
          "历史里应能按 id 找到刚才那次安装",
        );
        /**
         * 历史里也要留下**实际使用的地址**：跨重启回看时界面显示 `installSpec`，
         * 否则又会退回显示 `^1.9.28` 这种「范围当版本」的误导信息。
         */
        const updatedHistory = history.find((entry) => entry.id === updatedTask.id);
        assert.equal(updatedHistory.installSpec, "dsh-cost-meter@1.9.30");
        assert.equal(updatedHistory.spec, "^1.9.28");
        assert.equal(listed.json.result.value.active, null, "队列已排空");

        // 6. 取消不存在的任务：如实返回 false
        const cancel = await callRoute(route, envelope("op.cancel", { id: "nope" }));
        assert.equal(cancel.json.result.value.cancelled, false);
        const badId = await callRoute(route, envelope("op.cancel", { id: "" }));
        assert.equal(badId.json.result.ok, false);

        /**
         * 7. 热重载：`status.hot` 必须如实反映宿主有没有 `hmr` 服务（界面据此选文案），
         *    `op.reload` 走宿主重新组合（等价 `setBundleEnabled(name, true)`）。
         */
        const statusHot = await callRoute(route, envelope("status", {}, "t-hot"));
        assert.equal(statusHot.json.result.value.hot, true);

        const reloadQueued = await callRoute(
          route,
          envelope("op.reload", { name: "dsh-cost-meter", confirm: true }, "r1"),
        );
        assert.equal(reloadQueued.json.result.ok, true);
        const reloadTask = await settle(reloadQueued.json.result.value.id);
        assert.equal(reloadTask.status, "done");
        assert.match(reloadTask.note, /无需重启/);
        assert.ok(
          manager.enabledCalls.some(
            (entry) => entry[0] === "dsh-cost-meter" && entry[1] === true,
          ),
          "热重载必须调用 setBundleEnabled(name, true)",
        );
        // 确认是必需项
        const reloadUnconfirmed = await callRoute(
          route,
          envelope("op.reload", { name: "dsh-cost-meter" }),
        );
        assert.equal(reloadUnconfirmed.json.result.ok, false);
        assert.match(reloadUnconfirmed.json.result.error.message, /需要确认/);
        // 停用的插件不给热重载（重载不改启用状态）
        const reloadIdle = await callRoute(
          route,
          envelope("op.reload", { name: "dsh-idle-plugin", confirm: true }),
        );
        assert.equal(reloadIdle.json.result.ok, false);
        assert.match(reloadIdle.json.result.error.message, /停用状态/);

        /**
         * 8. 自热重载：目标是本插件自己时，**先回执、后动手** —— 否则宿主替换掉
         *    本插件后，这条 RPC 的响应会随它一起消失。
         */
        const enabledBefore = manager.enabledCalls.length;
        const selfReload = await callRoute(
          route,
          envelope("op.reload", { name: "dsh-plugin-harbor", confirm: true }, "r2"),
        );
        assert.equal(selfReload.json.result.ok, true);
        assert.match(selfReload.json.result.value.note, /已请求宿主热重载本插件/);
        assert.equal(selfReload.json.result.value.kind, "reload");
        // 回执里就该有结论（不是「进行中」）：它不会进队列
        assert.notEqual(selfReload.json.result.value.status, "running");
        const historyAfter = await callRoute(route, envelope("op.list", {}, "t-h2"));
        assert.ok(
          historyAfter.json.result.value.history.some(
            (entry) => entry.target === "dsh-plugin-harbor" && entry.kind === "reload",
          ),
          "自热重载也要落历史",
        );
        // 延迟后宿主才真的收到重新组合请求
        const deadline = Date.now() + 3000;
        while (
          manager.enabledCalls.length === enabledBefore &&
          Date.now() < deadline
        )
          await new Promise((resolve) => setTimeout(resolve, 25));
        assert.ok(
          manager.enabledCalls.some(
            (entry) => entry[0] === "dsh-plugin-harbor" && entry[1] === true,
          ),
          "延迟后必须请宿主重新组合自己",
        );

        /**
         * 9. 导出 / 导入：导出写文件、导入先预检再经宿主执行
         *    （全程离线；桩 manager 记录调用，不碰 profile 文件）
         */
        const exportDenied = await callRoute(route, envelope("export.run", {}));
        assert.equal(exportDenied.json.result.ok, false);
        assert.match(exportDenied.json.result.error.message, /需要确认/);

        const exported = await callRoute(
          route,
          envelope("export.run", { includeData: false, confirm: true }, "x1"),
        );
        assert.equal(exported.json.result.ok, true, JSON.stringify(exported.json.result));
        const exportPath = exported.json.result.value.path;
        const exportName = exported.json.result.value.name;
        assert.ok(existsSync(exportPath), "导出文件必须真的落盘：" + exportPath);
        const dumped = JSON.parse(readFileSync(exportPath, "utf8"));
        assert.equal(dumped.format, "dsh-plugin-harbor/export");
        assert.equal(dumped.version, 1);
        assert.equal(dumped.profile, "desktop");
        assert.ok(
          dumped.plugins.some((plugin) => plugin.name === "dsh-cost-meter"),
          "导出要包含已装插件",
        );
        assert.ok(
          dumped.plugins.every((plugin) => plugin.files === undefined),
          "默认不导出插件自己的设置文件",
        );
        assert.ok(Array.isArray(dumped.omissions));

        const exportFiles = await callRoute(route, envelope("export.list", {}, "x2"));
        assert.ok(
          exportFiles.json.result.value.some((file) => file.name === exportName),
          "导出目录里要能看到刚写的文件",
        );

        // 预检自己刚导出的文件：这个 profile 与导出内容一致 ⇒ 全都是「已一致」
        const preview = await callRoute(
          route,
          envelope("import.preview", { path: exportName }, "x3"),
        );
        assert.equal(preview.json.result.ok, true, JSON.stringify(preview.json.result));
        const previewPlan = preview.json.result.value.plan;
        assert.ok(previewPlan.steps.length > 0);
        assert.ok(
          previewPlan.steps.every((step) => step.action === "skip"),
          "同一个 profile 的导出导回来应当全部「已一致」：" + JSON.stringify(previewPlan.steps),
        );

        // 外来 JSON 一律拒绝，绝不「当作空清单」
        const junkPath = join(home, "profiles", "desktop", "plugin-harbor", "exports", "junk.json");
        writeFileSync(junkPath, JSON.stringify({ hello: "world" }), "utf8");
        const junk = await callRoute(route, envelope("import.preview", { path: "junk.json" }, "x4"));
        assert.equal(junk.json.result.ok, false);
        assert.match(junk.json.result.error.message, /不是插件港湾的导出文件/);

        // 手工造一份「另一台机器」的导出：一个没装、一个要停用、一行 config
        const manual = {
          format: "dsh-plugin-harbor/export",
          version: 1,
          exportedAt: 1_700_000_000_000,
          profile: "laptop",
          by: { plugin: "plugin-harbor", version: "x" },
          plugins: [
            { name: "dsh-missing", spec: "^1.0.0", kind: "registry", version: "1.0.3", enabled: true },
            {
              name: "dsh-cost-meter",
              spec: "^1.9.28",
              kind: "registry",
              version: "1.9.46",
              enabled: false,
              config: [{ id: "cost-meter", name: "dsh-cost-meter", config: { budgetUsd: 12 } }],
            },
          ],
          omissions: [],
          warnings: [],
        };
        writeFileSync(junkPath, JSON.stringify(manual), "utf8");
        const manualPreview = await callRoute(
          route,
          envelope("import.preview", { path: "junk.json" }, "x5"),
        );
        const steps = manualPreview.json.result.value.plan.steps;
        const byName2 = new Map(steps.map((step) => [step.name, step]));
        assert.equal(byName2.get("dsh-missing").action, "install");
        assert.equal(byName2.get("dsh-missing").spec, "dsh-missing@1.0.3");
        assert.equal(byName2.get("dsh-cost-meter").action, "disable");
        assert.match(
          manualPreview.json.result.value.snippet,
          /budgetUsd/,
          "带 config 的行要给出可粘贴片段",
        );

        const runsBefore = manager.installs.length;
        const imported = await callRoute(
          route,
          envelope("op.import", { path: "junk.json", confirm: true }, "x6"),
        );
        assert.equal(imported.json.result.ok, true, JSON.stringify(imported.json.result));
        assert.match(imported.json.result.value.note, /计划：安装 1/);
        const importedTask = await settle(imported.json.result.value.id);
        assert.equal(importedTask.status, "done", JSON.stringify(importedTask));
        assert.match(importedTask.note, /1 项安装、1 项改状态/);
        assert.equal(
          importedTask.note.includes(imported.json.result.value.importSnippetPath),
          true,
          "配置片段路径要写进结论",
        );
        assert.match(importedTask.note, /自行粘贴/);
        assert.ok(
          existsSync(imported.json.result.value.importSnippetPath),
          "配置片段文件要真的落盘",
        );
        assert.match(
          readFileSync(imported.json.result.value.importSnippetPath, "utf8"),
          /budgetUsd/,
        );
        assert.deepEqual(
          manager.installs.slice(runsBefore).map((entry) => entry.spec),
          ["dsh-missing@1.0.3"],
        );
        assert.ok(
          manager.enabledCalls.some(
            (entry) => entry[0] === "dsh-cost-meter" && entry[1] === false,
          ),
          "导出里是停用的插件要真的被停用",
        );
        assert.equal(
          manager.removes.includes("dsh-missing"),
          false,
          "导入只增不删：不得卸载任何东西",
        );

        /**
         * 10. 界面上「选择文件…」走的那条路：客户端把文件内容经 RPC 交上来，
         *     服务端先按导出格式校验、再落到本插件自己的 exports/ 目录，返回可直接
         *     给预检/导入用的路径。落点必须在 dataDir/exports 下，不能是别处。
         */
        const uploadDir = join(home, "profiles", "desktop", "plugin-harbor", "exports");
        const uploadBody = JSON.stringify({
          format: "dsh-plugin-harbor/export",
          version: 1,
          exportedAt: 1_700_000_000_000,
          profile: "laptop",
          by: { plugin: "plugin-harbor", version: "x" },
          plugins: [{ name: "dsh-from-picker", spec: "^2.0.0", kind: "registry", enabled: true }],
          omissions: [],
          warnings: [],
        });
        const uploaded = await callRoute(
          route,
          envelope("import.upload", { name: "../../evil name.json", content: uploadBody }, "u1"),
        );
        assert.equal(uploaded.json.result.ok, true, JSON.stringify(uploaded.json.result));
        const uploadedPath = uploaded.json.result.value.path;
        assert.ok(existsSync(uploadedPath), "选中的文件必须真的落盘：" + uploadedPath);
        assert.equal(
          dirname(uploadedPath),
          uploadDir,
          "只能写进本插件自己的 exports/ 目录",
        );
        assert.ok(
          !/[\\/]\.\.[\\/]/.test(uploadedPath) && !uploadedPath.includes("evil name"),
          "文件名里的路径片段与空格必须被清洗掉：" + uploadedPath,
        );
        assert.equal(readFileSync(uploadedPath, "utf8"), uploadBody, "落盘内容要与上传的一致");

        // 上传回来的路径能直接预检（不用再拼名字）
        const pickedPreview = await callRoute(
          route,
          envelope("import.preview", { path: uploadedPath }, "u2"),
        );
        assert.equal(pickedPreview.json.result.ok, true, JSON.stringify(pickedPreview.json.result));
        assert.equal(
          pickedPreview.json.result.value.plan.steps[0].name,
          "dsh-from-picker",
          "预检的必须是刚上传的那份文件",
        );
        assert.ok(
          (await callRoute(route, envelope("export.list", {}, "u3"))).json.result.value.some(
            (file) => file.path === uploadedPath,
          ),
          "上传的文件要出现在导出目录列表里",
        );

        // 选错文件：当场报错，而且不许落盘
        const before = readdirSync(uploadDir).length;
        const notExport = await callRoute(
          route,
          envelope("import.upload", { name: "notes.json", content: '{"hello":"world"}' }, "u4"),
        );
        assert.equal(notExport.json.result.ok, false);
        assert.match(notExport.json.result.error.message, /不能作为导入源/);
        assert.equal(readdirSync(uploadDir).length, before, "校验失败不得留下垃圾文件");

        const empty = await callRoute(
          route,
          envelope("import.upload", { name: "empty.json", content: "   " }, "u5"),
        );
        assert.equal(empty.json.result.ok, false);
        assert.match(empty.json.result.error.message, /空的/);
      } finally {
        await fiber?.dispose();
        await ctx.stop?.();
      }
      });
    } finally {
      await server.close();
      if (previousRegistry === undefined) delete process.env.PLUGIN_HARBOR_REGISTRY;
      else process.env.PLUGIN_HARBOR_REGISTRY = previousRegistry;
    }
  },
);

test(
  "real host: 设置持久化与诊断（本机桩，全程离线）",
  { skip },
  async () => {
    const chunk = { category: "agent", page: 1, hash: "2ec2dd96" };
    const server = await startFixtureServer({
      "/zh/plugins": indexHtml([chunk], 19866),
      // 设置里把 locale 改成 en 之后，诊断与同步都会去抓 en 的索引页：
      // 这里两条路径都提供，正好钉住「locale 真的改变了抓取地址」。
      "/en/plugins": indexHtml([chunk], 19866),
      [`/directory/zh/agent-1-${chunk.hash}.json`]: fixture("site-shard-agent-1.json"),
      "/plugins.zh.json": fixture("curated-zh.json"),
      "/stats.json": JSON.stringify({ total: 5809, verified: 5809 }),
    });
    const previousSite = process.env.PLUGIN_HARBOR_SITE;
    const previousApi = process.env.PLUGIN_HARBOR_API;
    const previousRegistry = process.env.PLUGIN_HARBOR_REGISTRY;
    process.env.PLUGIN_HARBOR_SITE = server.base;
    process.env.PLUGIN_HARBOR_API = server.base;
    process.env.PLUGIN_HARBOR_REGISTRY = server.base;
    const { ctx, routes } = createHost();
    try {
      await withTempHome(async (home) => {
        let fiber;
        try {
          fiber = ctx.plugin(
            await import(`../dist/index.js?settings-stub=${Date.now()}`),
          );
          while (fiber.inertia) await fiber.inertia;
          const route = routes[0];

          const initial = await callRoute(route, envelope("settings.get"));
          assert.equal(initial.json.result.ok, true);
          const defaults = initial.json.result.value;
          assert.equal(defaults.locale, "zh");
          assert.equal(defaults.syncTtlMs, 86_400_000);
          assert.equal(defaults.siteBase, server.base);
          assert.equal(defaults.registry, server.base);
          assert.deepEqual(defaults.notes, [], "首次读取不该有修正说明");

          // 非法值：报错且不落盘
          const bad = await callRoute(
            route,
            envelope("settings.set", { locale: "fr", syncTtlMs: -1 }),
          );
          assert.equal(bad.json.result.ok, false);
          assert.match(bad.json.result.error.message, /locale 只能是/);
          assert.equal(
            existsSync(join(home, "profiles", "desktop", "plugin-harbor", "settings.json")),
            false,
            "非法设置不得写盘",
          );

          // 合法值：落盘 + 即刻生效
          const saved = await callRoute(
            route,
            envelope("settings.set", { locale: "en", syncTtlMs: 1_800_000 }),
          );
          assert.equal(saved.json.result.ok, true);
          assert.equal(saved.json.result.value.locale, "en");
          assert.deepEqual(saved.json.result.value.notes, []);
          const path = join(
            home,
            "profiles",
            "desktop",
            "plugin-harbor",
            "settings.json",
          );
          const written = JSON.parse(readFileSync(path, "utf8"));
          assert.equal(written.locale, "en");
          assert.equal(written.syncTtlMs, 1_800_000);
          const reread = await callRoute(route, envelope("settings.get"));
          assert.equal(reread.json.result.value.locale, "en");

          // 诊断：未同步时 catalog 记「无结论」，站点/API 走桩可达
          const before = await callRoute(route, envelope("diagnostics.run"));
          assert.equal(before.json.result.ok, true);
          const checksBefore = before.json.result.value;
          assert.equal(checksBefore.length, 7);
          const catalogBefore = checksBefore.find((entry) => entry.id === "catalog");
          assert.equal(catalogBefore.ok, null);
          assert.equal(checksBefore.find((entry) => entry.id === "site").ok, true);
          /**
           * 这个宿主上下文里没有 `hmr` 服务：诊断要如实判失败并说清「要重启」，
           * 不能因为桌面宿主通常有 HMR 就假设它一定有。
           */
          const hmrBefore = checksBefore.find((entry) => entry.id === "hmr");
          assert.equal(hmrBefore.ok, false);
          assert.match(hmrBefore.detail, /未提供 hmr 服务/);
          assert.match(
            checksBefore.find((entry) => entry.id === "api").detail,
            /收录 5809/,
          );
          assert.equal(
            checksBefore.find((entry) => entry.id === "store").ok,
            true,
            "存储诊断必须真的连上 worker",
          );

          // 同步一次后再诊断：catalog 转为通过
          await callRoute(route, envelope("catalog.refresh"));
          const after = await callRoute(route, envelope("diagnostics.run"));
          const catalogAfter = after.json.result.value.find(
            (entry) => entry.id === "catalog",
          );
          assert.equal(catalogAfter.ok, true);
          assert.match(catalogAfter.detail, /12 条/);
        } finally {
          await fiber?.dispose();
          await ctx.stop?.();
        }
      });
    } finally {
      await server.close();
      if (previousSite === undefined) delete process.env.PLUGIN_HARBOR_SITE;
      else process.env.PLUGIN_HARBOR_SITE = previousSite;
      if (previousApi === undefined) delete process.env.PLUGIN_HARBOR_API;
      else process.env.PLUGIN_HARBOR_API = previousApi;
      if (previousRegistry === undefined) delete process.env.PLUGIN_HARBOR_REGISTRY;
      else process.env.PLUGIN_HARBOR_REGISTRY = previousRegistry;
    }
  },
);

test(
  "real host: 端到端同步（本机桩站点 → worker → SQLite → RPC 查询）",
  { skip },
  async () => {
    const chunk = { category: "agent", page: 1, hash: "2ec2dd96" };
    const server = await startFixtureServer({
      "/zh/plugins": indexHtml([chunk], 19866),
      [`/directory/zh/agent-1-${chunk.hash}.json`]: fixture(
        "site-shard-agent-1.json",
      ),
      "/plugins.zh.json": fixture("curated-zh.json"),
    });
    const previousSite = process.env.PLUGIN_HARBOR_SITE;
    const previousApi = process.env.PLUGIN_HARBOR_API;
    process.env.PLUGIN_HARBOR_SITE = server.base;
    process.env.PLUGIN_HARBOR_API = server.base;
    const { ctx, routes } = createHost();
    try {
      await withTempHome(async () => {
        let fiber;
        try {
          // 用查询串绕开模块缓存：基址是在模块加载时读取的环境变量。
          fiber = ctx.plugin(
            await import(`../dist/index.js?local-stub=${Date.now()}`),
          );
          while (fiber.inertia) await fiber.inertia;
          assert.equal(fiber.state, 2, String(fiber._error));
          const route = routes[0];

          const before = await callRoute(route, envelope("catalog.status"));
          assert.equal(before.json.result.value.rows, 0, "同步前目录为空");
          assert.equal(before.json.result.value.totalCount, null);

          // 并发触发两次刷新：必须复用同一次运行，站点只被访问一次索引页。
          const [first, second] = await Promise.all([
            callRoute(route, envelope("catalog.refresh", {}, "r1")),
            callRoute(route, envelope("catalog.refresh", {}, "r2")),
          ]);
          for (const response of [first, second]) {
            assert.equal(response.json.result.ok, true);
            assert.equal(response.json.result.value.refreshed, 1);
            assert.equal(response.json.result.value.rows, 12);
            assert.equal(response.json.result.value.totalCount, 19866);
          }
          const indexRequests = server.requests.filter(
            (url) => url === "/zh/plugins",
          );
          assert.equal(indexRequests.length, 1, "并发刷新必须合并成一次同步");

          const after = await callRoute(route, envelope("catalog.status"));
          assert.equal(after.json.result.value.rows, 12);
          assert.equal(after.json.result.value.chunks, 1);
          assert.equal(after.json.result.value.totalCount, 19866);
          assert.equal(after.json.result.value.error, null);
          assert.equal(after.json.result.value.syncing, false);
          assert.equal(after.json.result.value.milestone, "M1");

          const page = await callRoute(
            route,
            envelope("catalog.list", { sort: "stars", limit: 5 }),
          );
          const value = page.json.result.value;
          assert.equal(value.rows.length, 5);
          assert.equal(value.total, 12);
          assert.ok(value.nextCursor, "还有下一页时必须给游标");
          assert.equal(value.facets.category.agent, 12);
          const stars = value.rows.map((row) => row.stars);
          for (let i = 1; i < stars.length; i++)
            assert.ok(stars[i] <= stars[i - 1], "stars 必须单调不增");

          // 数据真的落盘在临时 profile 下（而不是内存里）
          const dbPath = join(
            process.env.DSH_HOME,
            "profiles",
            "desktop",
            "plugin-harbor",
            "catalog.sqlite",
          );
          assert.ok(existsSync(dbPath));
        } finally {
          await fiber?.dispose();
          await ctx.stop?.();
        }
      });
    } finally {
      await server.close();
      if (previousSite === undefined) delete process.env.PLUGIN_HARBOR_SITE;
      else process.env.PLUGIN_HARBOR_SITE = previousSite;
      if (previousApi === undefined) delete process.env.PLUGIN_HARBOR_API;
      else process.env.PLUGIN_HARBOR_API = previousApi;
    }
  },
);
test(
  "real host: 检出目录安装时启用自动重载（dist 变化 → 请宿主重新组合）",
  { skip },
  async () => {
    /**
     * 本仓库的 `package.json` 里有 `src/`，所以 `shouldWatch()` 成立、插件会真的去
     * 监视 `dist/` 并调用 `pluginManager.setBundleEnabled(name, true)`。
     *
     * ⚠️ 触发手段用 `utimesSync` **只改 mtime、不改内容**：既能让 `fs.watch` 报一次
     * change，又不会在测试期间换掉 `dist/index.js`（那会让同一文件里后续用例加载到
     * 半截产物）。真正的防抖/过滤/停止行为由 `tests/watch.test.ts` 覆盖。
     */
    const { ctx, routes } = createHost();
    const reloads = [];
    const { Service } = host;
    class PluginManager extends Service {
      constructor(c) {
        super(c, "pluginManager");
      }
      async setBundleEnabled(name, enabled) {
        reloads.push([name, enabled]);
        return { changed: true, application: "applied", target: name, enabled };
      }
      async installBundle() {
        return { changed: false, application: "applied" };
      }
      async removeBundle() {
        return { changed: false, application: "applied" };
      }
      async listBundles() {
        return [];
      }
    }
    class Hmr extends Service {
      constructor(c) {
        super(c, "hmr");
      }
    }
    new Hmr(ctx);
    new PluginManager(ctx);
    await withTempHome(async () => {
      let fiber;
      try {
        fiber = ctx.plugin(await import(`../dist/index.js?autoreload=${Date.now()}`));
        while (fiber.inertia) await fiber.inertia;
        assert.equal(fiber.state, 2, String(fiber._error));
        assert.equal(routes.length, 1);

        const ok = await callRoute(routes[0], envelope("status"));
        assert.equal(ok.json.result.ok, true);
        assert.equal(ok.json.result.value.hot, true, "这个上下文里有 hmr 服务");

        // 只改 mtime，内容不动 —— 让监视器报一次 change，但不破坏产物
        const target = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");
        const now = Date.now() / 1000;
        utimesSync(target, now, now);

        // 防抖窗口 700ms，留足余量
        const started = Date.now();
        while (reloads.length === 0 && Date.now() - started < 4000)
          await new Promise((resolve) => setTimeout(resolve, 50));

        assert.deepEqual(
          reloads,
          [["plugin-harbor", true]],
          "dist 变化后必须请宿主按磁盘上的新代码重新组合本插件（且只重载一次）",
        );
      } finally {
        await fiber?.dispose();
        await ctx.stop?.();
      }
    });
  },
);

test("real host: Git sync RPC binds confirmation and preview to local facts (offline bare remote)", { skip }, async () => {
  const { execFileSync } = await import("node:child_process");
  await withTempHome(async home => {
    const { ctx, routes } = createHost();
    const profileDir = writeProfile(home, {}, []);
    const remote = join(home, "backup.git");
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore", windowsHide: true });
    let fiber;
    try {
      fiber = ctx.plugin(await import(`../dist/index.js?git-sync=${Date.now()}`));
      while (fiber.inertia) await fiber.inertia;
      const rpc = async (method, payload = {}) => (await callRoute(routes[0], envelope(method, payload))).json.result;
      assert.equal((await rpc("sync.get")).value.config, null);
      assert.equal((await rpc("sync.configure", { remote, environment: "desktop" })).ok, false);
      assert.equal((await rpc("sync.configure", { remote, environment: "desktop", confirm: true })).ok, true);
      const preview = await rpc("sync.preview"); assert.equal(preview.ok, true, JSON.stringify(preview));
      assert.equal(preview.value.hasRemote, false);
      assert.equal((await rpc("sync.publish", { token: preview.value.token })).ok, false);
      const published = await rpc("sync.publish", { token: preview.value.token, confirm: true });
      assert.equal(published.ok, true, JSON.stringify(published));
      assert.equal((await rpc("sync.apply", { token: preview.value.token, confirm: true })).ok, false, "发布后旧 token 失效");
      const again = await rpc("sync.preview"); assert.equal(again.value.hasRemote, true);
      assert.equal((await rpc("sync.apply", { token: again.value.token })).ok, false);
      // 本机事实变化使确认失效；只操作隔离夹具 profile。
      writeFileSync(join(profileDir, "cordis.patch.yml"), '- id: example\n  config:\n    theme: dark\n');
      const stale = await rpc("sync.apply", { token: again.value.token, confirm: true });
      assert.equal(stale.ok, false); assert.match(stale.error.message, /已变化/);
      const fresh = await rpc("sync.preview");
      const applied = await rpc("sync.apply", { token: fresh.value.token, confirm: true });
      assert.equal(applied.ok, true, JSON.stringify(applied));
      assert.equal(applied.value.kind, "import");
    } finally { await fiber?.dispose(); await ctx.stop?.(); }
  });
});

test("real host: confirmed Git sync applies safe config through host editor and preserves local credentials", { skip }, async () => {
  const { execFileSync } = await import("node:child_process");
  await withTempHome(async home => {
    const { ctx, routes } = createHost();
    const profile = writeProfile(home, { "dsh-cost-meter": "1.9.28" }, ["dsh-cost-meter"]);
    writeFileSync(join(profile, "cordis.patch.yml"), '- id: cost-meter\n  name: dsh-cost-meter\n  config:\n    theme: dark\n    token: source-credential\n    dataPath: D:/source\n');
    class Manager extends host.Service {
      constructor(c) { super(c, "pluginManager"); }
      async listPlugins() { return []; }
    }
    new Manager(ctx);
    const entry = { options: { id: "cost-meter", name: "dsh-cost-meter", config: { theme: "light", token: "target-credential", dataPath: "D:/target" } }, fiber: { state: 2 } };
    let edits = 0;
    class Editor extends host.Service {
      constructor(c) { super(c, "configEditor"); }
      entries() { return [entry]; }
      async edit(target, change) { assert.equal(target, entry); edits++; entry.options.config = change(structuredClone(entry.options.config), {}); }
    }
    new Editor(ctx);
    const remote = join(home, "config-backup.git"); execFileSync("git", ["init", "--bare", remote], { stdio: "ignore", windowsHide: true });
    let fiber;
    try {
      fiber = ctx.plugin(await import(`../dist/index.js?sync-config=${Date.now()}`)); while (fiber.inertia) await fiber.inertia;
      const rpc = async (method, payload = {}) => (await callRoute(routes[0], envelope(method, payload))).json.result;
      await rpc("sync.configure", { remote, environment: "shared", confirm: true });
      let preview = await rpc("sync.preview");
      assert.equal((await rpc("sync.publish", { token: preview.value.token, confirm: true })).ok, true);
      preview = await rpc("sync.preview");
      assert.equal(preview.ok, true, JSON.stringify(preview));
      assert.equal(preview.value.configPlans[0].action, "apply");
      assert.deepEqual(preview.value.configPlans[0].paths, ["theme"]);
      assert.equal(preview.value.snippet, undefined, "自动配置行不再要求人工片段");
      assert.doesNotMatch(JSON.stringify(preview), /target-credential|source-credential/);
      assert.equal((await rpc("sync.apply", { token: preview.value.token })).ok, false);
      assert.equal(edits, 0);
      const result = await rpc("sync.apply", { token: preview.value.token, confirm: true });
      assert.equal(result.ok, true, JSON.stringify(result));
      let task;
      for (let i = 0; i < 50; i++) {
        const listed = await rpc("op.list"); task = listed.value.tasks.find(t => t.id === result.value.id);
        if (task && !["queued", "running"].includes(task.status)) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(task.status, "done", JSON.stringify(task));
      assert.match(task.note, /自动应用 1/);
      assert.equal(edits, 1);
      assert.deepEqual(entry.options.config, { theme: "dark", token: "target-credential", dataPath: "D:/target" });
      assert.doesNotMatch(JSON.stringify(task), /target-credential|source-credential/);
    } finally { await fiber?.dispose(); await ctx.stop?.(); }
  });
});
