// src/index.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync2, readdirSync as readdirSync2, readFileSync as readFileSync4, realpathSync as realpathSync2, statSync as statSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { dirname as dirname3, isAbsolute as isAbsolute2, join as join7, resolve as resolve3 } from "node:path";
import { fileURLToPath } from "node:url";

// src/core/dispatch.ts
var RPC_METHOD = "plugin-harbor";
var RPC_PATH = "/api/plugin-harbor";
var RPC_VERSION = 1;
function readEnvelope(message) {
  const rpcId = typeof message?.rpcId === "string" ? message.rpcId : "invalid";
  if (message?.type !== "client-request")
    return { ok: false, reason: "Invalid versioned RPC envelope", rpcId };
  if (message?.method !== RPC_METHOD)
    return { ok: false, reason: "Invalid versioned RPC envelope", rpcId };
  if (message?.payload?.version !== RPC_VERSION)
    return { ok: false, reason: "Invalid versioned RPC envelope", rpcId };
  if (typeof message?.payload?.method !== "string")
    return { ok: false, reason: "Invalid versioned RPC envelope", rpcId };
  return {
    ok: true,
    envelope: {
      rpcId,
      method: message.payload.method,
      payload: message.payload.payload ?? {}
    }
  };
}
function redact(error) {
  const text2 = error instanceof Error ? error.message : String(error);
  return text2.replace(
    /(token|secret|password|cookie|authorization)([=:]\s*)\S+/gi,
    "$1$2[redacted]"
  ).slice(0, 200);
}
function createDispatcher(handlers2) {
  return async function dispatch(method, payload, ctx) {
    const handler = handlers2[method];
    if (!handler)
      return {
        ok: false,
        error: {
          code: "plugin-harbor/unknown-method",
          message: "Unknown method: " + method
        }
      };
    try {
      return { ok: true, value: await handler(payload ?? {}, ctx) ?? null };
    } catch (error) {
      return {
        ok: false,
        error: { code: "plugin-harbor/error", message: redact(error) }
      };
    }
  };
}

// src/core/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
var PROFILE_NAME = /^[A-Za-z0-9_.-]+$/;
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}
function assertProfileName(name2) {
  if (name2 === "." || name2 === ".." || !PROFILE_NAME.test(name2))
    throw Error("Invalid DSH profile name");
  return name2;
}
function resolveProfile(ctx) {
  const context = ctx?.get?.("profileContext") ?? {};
  const name2 = assertProfileName(
    context.name ?? process.env.DSH_PROFILE ?? "desktop"
  );
  const dir = join(dshHome(), "profiles", name2);
  const dataDir = join(dir, "plugin-harbor");
  return { name: name2, dir, dataDir, dbPath: join(dataDir, "catalog.sqlite") };
}

// src/core/flight.ts
function extractFlightPayload(html) {
  const marker = "self.__next_f.push(";
  let cursor = 0;
  let out = "";
  for (; ; ) {
    const at = html.indexOf(marker, cursor);
    if (at === -1) break;
    cursor = at + marker.length;
    const literal = readStringLiteral(html, cursor);
    if (literal !== null) out += literal;
  }
  return out;
}
function readStringLiteral(source, from) {
  let i = from;
  while (i < source.length && source[i] !== '"') {
    const ch = source[i];
    if (ch !== "[" && ch !== "]" && ch !== "," && !/[0-9\s]/.test(ch))
      return null;
    if (i - from > 24) return null;
    i++;
  }
  if (source[i] !== '"') return null;
  let value = "";
  for (let j = i + 1; j < source.length; j++) {
    const ch = source[j];
    if (ch !== "\\") {
      if (ch === '"') return value;
      value += ch;
      continue;
    }
    const next = source[j + 1];
    if (next === void 0) return null;
    if (next === "u") {
      const hex = source.slice(j + 2, j + 6);
      value += /^[0-9a-fA-F]{4}$/.test(hex) ? String.fromCharCode(Number.parseInt(hex, 16)) : "u";
      j += 5;
      continue;
    }
    if (next === "x") {
      const hex = source.slice(j + 2, j + 4);
      value += /^[0-9a-fA-F]{2}$/.test(hex) ? String.fromCharCode(Number.parseInt(hex, 16)) : "x";
      j += 3;
      continue;
    }
    value += unescapeChar(next);
    j += 1;
  }
  return null;
}
function unescapeChar(next) {
  switch (next) {
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "	";
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "v":
      return "\v";
    case "0":
      return "\0";
    default:
      return next;
  }
}
function stringMask(text2) {
  const mask = new Uint8Array(text2.length);
  let inString = false;
  for (let i = 0; i < text2.length; i++) {
    const ch = text2[i];
    if (!inString) {
      if (ch === '"') inString = true;
      continue;
    }
    if (ch === "\\") {
      mask[i] = 1;
      if (i + 1 < text2.length) mask[i + 1] = 1;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = false;
      continue;
    }
    mask[i] = 1;
  }
  return mask;
}
function findOutsideString(text2, needle, mask) {
  let from = 0;
  for (; ; ) {
    const at = text2.indexOf(needle, from);
    if (at === -1) return void 0;
    if (mask[at] === 0) return at;
    from = at + 1;
  }
}
function findObjectStart(text2, inner, mask) {
  let depth = 0;
  for (let i = inner; i >= 0; i--) {
    if (mask[i] === 1) continue;
    const ch = text2[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return void 0;
}
function findObjectEnd(text2, start, mask) {
  let depth = 0;
  for (let i = start; i < text2.length; i++) {
    if (mask[i] === 1) continue;
    const ch = text2[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return void 0;
}
function readJsonObjectAfter(payload, key) {
  const mask = stringMask(payload);
  const at = findOutsideString(payload, `"${key}":`, mask);
  if (at === void 0) return void 0;
  let i = at + key.length + 3;
  while (i < payload.length && /\s/.test(payload[i])) i++;
  if (payload[i] !== "{") return void 0;
  const end = findObjectEnd(payload, i, mask);
  if (end === void 0) return void 0;
  try {
    return JSON.parse(payload.slice(i, end + 1));
  } catch {
    return void 0;
  }
}

// src/core/site.ts
var CHUNK_URL = /\/directory\/([a-z]{2})\/([a-z]+)-(\d+)-([0-9a-f]{8})\.json/g;
function parseChunkUrl(url) {
  const match = /\/directory\/([a-z]{2})\/([a-z]+)-(\d+)-([0-9a-f]{8})\.json$/.exec(url);
  if (!match) return void 0;
  const page = Number(match[3]);
  if (page < 1) return void 0;
  return {
    url,
    lang: match[1],
    category: match[2],
    page,
    hash: match[4]
  };
}
function readShardManifest(payload, lang) {
  const stats = readJsonObjectAfter(payload, "sidebarStats");
  const declared = readJsonObjectAfter(payload, "shardManifest");
  const chunks = [];
  const push = (url) => {
    if (typeof url !== "string") return;
    const ref = parseChunkUrl(url);
    if (ref && !chunks.some((entry) => entry.url === ref.url)) chunks.push(ref);
  };
  if (declared && typeof declared === "object") {
    for (const urls of Object.values(declared))
      if (Array.isArray(urls)) for (const url of urls) push(url);
  }
  const source = chunks.length > 0 ? "manifest" : "url-scan";
  if (chunks.length === 0)
    for (const match of payload.matchAll(CHUNK_URL)) push(match[0]);
  chunks.sort(
    (a, b) => a.category === b.category ? a.page - b.page : a.category.localeCompare(b.category)
  );
  return {
    lang,
    chunks,
    totalCount: typeof stats?.totalCount === "number" ? stats.totalCount : void 0,
    categoryCounts: stats?.categoryCounts && typeof stats.categoryCounts === "object" ? stats.categoryCounts : void 0,
    source
  };
}
var text = (value) => typeof value === "string" ? value : "";
var list = (value) => Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
function extractPluginRecord(payload) {
  const mask = stringMask(payload);
  const anchor = findOutsideString(payload, '"install":{"type"', mask) ?? findOutsideString(payload, '"install":{', mask);
  if (anchor === void 0) return void 0;
  const start = findObjectStart(payload, anchor, mask);
  if (start === void 0) return void 0;
  const end = findObjectEnd(payload, start, mask);
  if (end === void 0) return void 0;
  const slice = payload.slice(start, end + 1);
  try {
    return { text: slice, record: JSON.parse(slice) };
  } catch {
    return void 0;
  }
}
function readDetailRecord(payload) {
  const extracted = extractPluginRecord(payload);
  if (!extracted) return void 0;
  const record = extracted.record;
  const slug = text(record.slug);
  const repo = text(record.source?.repo);
  if (slug === "" || repo === "") return void 0;
  const out = {
    slug,
    repo,
    npmPackage: text(record.source?.npmPackage)
  };
  const version = text(record.version);
  if (version !== "") out.version = version;
  const installType = text(record.install?.type);
  if (installType !== "") out.installType = installType;
  const command = text(record.install?.command);
  if (command !== "") out.installCommand = command;
  if (typeof record.install?.webInstallable === "boolean")
    out.webInstallable = record.install.webInstallable;
  if (typeof record.compatibility?.dshTarget === "string")
    out.dshTarget = record.compatibility.dshTarget;
  const status = text(record.compatibility?.status);
  if (status !== "") out.status = status;
  if (Array.isArray(record.compatibility?.platforms))
    out.platforms = list(record.compatibility.platforms);
  const reason = text(record.manualInstallReason);
  if (reason !== "") out.manualInstallReason = reason;
  return out;
}
function readSitemapLocations(xml) {
  const out = [];
  for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const url = match[1].trim();
    if (url !== "" && !out.includes(url)) out.push(url);
  }
  return out;
}

// src/core/sync.ts
function planSync(manifest, known) {
  const fetch2 = [];
  const seen = /* @__PURE__ */ new Set();
  let skipped = 0;
  for (const chunk of manifest.chunks) {
    if (seen.has(chunk.url)) continue;
    seen.add(chunk.url);
    if (known.get(chunk.url) === chunk.hash) {
      skipped += 1;
      continue;
    }
    fetch2.push(chunk);
  }
  const remove = [...known.keys()].filter((url) => !seen.has(url));
  return { fetch: fetch2, skipped, remove };
}
function describeRefresh(outcome) {
  const parts = [`\u5DF2\u66F4\u65B0 ${outcome.refreshed}/${outcome.refreshed + outcome.skipped} \u4E2A\u5206\u7247`];
  if (outcome.skipped > 0) parts.push(`\u8DF3\u8FC7 ${outcome.skipped} \u4E2A\uFF08\u5185\u5BB9\u672A\u53D8\uFF09`);
  if (outcome.failures.length > 0)
    parts.push(
      `\u5931\u8D25 ${outcome.failures.length} \u4E2A\uFF1A` + outcome.failures.slice(0, 3).map((failure2) => `${failure2.url}\uFF1A${failure2.reason}`).join("\uFF1B")
    );
  if (outcome.degraded) parts.push("\u964D\u7EA7\uFF1A" + outcome.degraded);
  return parts.join("\uFF1B") + "\u3002";
}

// src/upstream/fetch.ts
async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 3e4
  );
  try {
    const headers = {
      accept: options.accept ?? "text/html,application/json,application/xml;q=0.9,*/*;q=0.5",
      "user-agent": "dsh-plugin-harbor (DeepSeek Harness plugin)"
    };
    if (options.etag) headers["if-none-match"] = options.etag;
    const response = await fetch(url, { headers, signal: controller.signal });
    const etag = response.headers.get("etag") ?? void 0;
    if (response.status === 304)
      return { ok: true, status: 304, body: "", ...etag ? { etag } : {} };
    const body = await response.text();
    if (!response.ok)
      return {
        ok: false,
        status: response.status,
        body: "",
        error: `HTTP ${response.status}`,
        ...etag ? { etag } : {}
      };
    return { ok: true, status: response.status, body, ...etag ? { etag } : {} };
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError" ? `\u8D85\u65F6\uFF08${options.timeoutMs ?? 3e4}ms\uFF09` : error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, body: "", error: reason };
  } finally {
    clearTimeout(timer);
  }
}
async function mapLimited(items, limit, run) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(limit, 1), items.length) },
    async () => {
      for (; ; ) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await run(items[index], index);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

// src/core/catalog.ts
var SHARD_TIMEOUT_MS = 6e4;
var INDEX_TIMEOUT_MS = 3e4;
var CURATED_TIMEOUT_MS = 12e4;
var CURATED_TTL_MS = 24 * 3600 * 1e3;
function indexPath(deps) {
  return `${deps.siteBase}/${deps.locale}/plugins`;
}
async function fetchChunk(deps, chunk) {
  let last = "\u672A\u77E5\u9519\u8BEF";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await deps.fetch(`${deps.siteBase}${chunk.url}`, {
      timeoutMs: SHARD_TIMEOUT_MS
    });
    if (result.ok && result.body !== "") return { ok: true, body: result.body };
    last = result.error ?? "\u7A7A\u54CD\u5E94";
    deps.log(`\u5206\u7247\u53D6\u6570\u5931\u8D25\uFF08\u7B2C ${attempt} \u6B21\uFF09\uFF1A${chunk.url}\uFF1A${last}`);
  }
  return { ok: false, body: "", error: last };
}
async function fetchDetail(deps, repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return void 0;
  const result = await deps.fetch(
    `${deps.siteBase}/${deps.locale}/plugins/${repo}`,
    { timeoutMs: 3e4 }
  );
  if (!result.ok || result.body === "") return void 0;
  return readDetailRecord(extractFlightPayload(result.body));
}
async function syncCatalog(deps) {
  const now = deps.now();
  const index = await deps.fetch(indexPath(deps), {
    timeoutMs: INDEX_TIMEOUT_MS
  });
  if (!index.ok || index.body === "") {
    const reason = index.error ?? "\u7A7A\u54CD\u5E94";
    await deps.store.call("catalog.setSyncState", {
      state: { lang: deps.locale, lastError: `\u7D22\u5F15\u9875\u53D6\u6570\u5931\u8D25\uFF1A${reason}` }
    });
    return {
      refreshed: 0,
      skipped: 0,
      failures: [{ url: indexPath(deps), reason }],
      rows: 0,
      source: "none"
    };
  }
  const manifest = readShardManifest(
    extractFlightPayload(index.body),
    deps.locale
  );
  if (manifest.chunks.length === 0) {
    const sitemap = await deps.fetch(`${deps.siteBase}/sitemaps/plugins/1.xml`, {
      timeoutMs: INDEX_TIMEOUT_MS
    });
    const degraded = sitemap.ok && readSitemapLocations(sitemap.body).length > 0 ? "\u7D22\u5F15\u9875\u89E3\u6790\u4E0D\u51FA\u5206\u7247\u6E05\u5355\uFF0C\u5DF2\u786E\u8BA4 sitemap \u53EF\u7528\uFF1B\u5206\u7247\u515C\u5E95\u679A\u4E3E\u5C1A\u672A\u63A5\u5165" : "\u7D22\u5F15\u9875\u89E3\u6790\u4E0D\u51FA\u5206\u7247\u6E05\u5355\uFF0C\u4E14 sitemap \u4E0D\u53EF\u7528";
    await deps.store.call("catalog.setSyncState", {
      state: { lang: deps.locale, lastError: degraded }
    });
    return {
      refreshed: 0,
      skipped: 0,
      failures: [{ url: indexPath(deps), reason: "\u6E05\u5355\u4E3A\u7A7A" }],
      rows: 0,
      source: "none",
      degraded
    };
  }
  const known = await deps.store.call(
    "catalog.knownChunks",
    { lang: deps.locale }
  );
  const plan = planSync(manifest, new Map(known?.chunks ?? []));
  deps.log(
    `\u540C\u6B65\u8BA1\u5212\uFF1A\u53D6 ${plan.fetch.length} \u7247\u3001\u8DF3\u8FC7 ${plan.skipped} \u7247\u3001\u6E05\u7406 ${plan.remove.length} \u7247`
  );
  if (plan.remove.length > 0) {
    const removed = await deps.store.call(
      "catalog.removeChunks",
      { urls: plan.remove }
    );
    deps.log(`\u6E05\u7406\u9648\u65E7\u5206\u7247 ${plan.remove.length} \u4E2A\uFF08${removed?.removed ?? 0} \u884C\uFF09`);
  }
  const fetchResults = await mapLimited(
    plan.fetch,
    deps.concurrency ?? 3,
    async (chunk) => ({ chunk, ...await fetchChunk(deps, chunk) })
  );
  const failures = [];
  let refreshed = 0;
  let rows = 0;
  for (const result of fetchResults) {
    if (!result.ok) {
      failures.push({ url: result.chunk.url, reason: result.error ?? "\u672A\u77E5\u9519\u8BEF" });
      continue;
    }
    try {
      const applied = await deps.store.call(
        "catalog.applyChunk",
        { chunk: result.chunk, body: result.body }
      );
      refreshed += 1;
      rows += applied?.rows ?? 0;
    } catch (error) {
      failures.push({
        url: result.chunk.url,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
  let curated;
  const curatedState = await deps.store.call(
    "catalog.counts",
    { lang: "curated" }
  );
  const curatedAge = curatedState?.lastSyncAt != null ? now - curatedState.lastSyncAt : Infinity;
  if (refreshed > 0 || curatedAge > CURATED_TTL_MS) {
    const body = await deps.fetch(`${deps.apiBase}/plugins.${deps.locale}.json`, {
      timeoutMs: CURATED_TIMEOUT_MS
    });
    if (body.ok && body.body !== "") {
      curated = await deps.store.call("catalog.applyCurated", { body: body.body });
      await deps.store.call("catalog.setSyncState", {
        state: { lang: "curated", lastSyncAt: now }
      });
    } else {
      deps.log(`curated \u589E\u5F3A\u53D6\u6570\u5931\u8D25\uFF1A${body.error ?? "\u7A7A\u54CD\u5E94"}`);
    }
  }
  const counts = await deps.store.call("catalog.counts", {
    lang: deps.locale
  });
  const outcome = {
    refreshed,
    skipped: plan.skipped,
    failures,
    rows: counts?.rows ?? rows,
    totalCount: manifest.totalCount
  };
  await deps.store.call("catalog.setSyncState", {
    state: {
      lang: deps.locale,
      totalCount: manifest.totalCount,
      lastSyncAt: now,
      lastError: failures.length > 0 ? describeRefresh(outcome) : null
    }
  });
  return {
    ...outcome,
    source: manifest.source,
    ...curated ? { curated } : {}
  };
}

// src/core/installed.ts
import { existsSync, readFileSync } from "node:fs";
import { join as join2 } from "node:path";
import { parse as parseYaml } from "yaml";
var HOST_SCOPE = "@deepseek-ai/";
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return void 0;
  }
}
function githubRepoOf(url) {
  if (typeof url === "string") {
    const text2 = url.trim();
    const long = /github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i.exec(text2);
    if (long) return `${long[1]}/${long[2].replace(/\.git$/, "")}`;
    const short = /^github:([^/\s]+)\/([^/\s#?]+)$/i.exec(text2);
    if (short) return `${short[1]}/${short[2].replace(/\.git$/, "")}`;
  }
  if (url && typeof url === "object") {
    const record = url;
    return githubRepoOf(record.url ?? record.directory ?? void 0);
  }
  return void 0;
}
function classifySpec(spec) {
  const text2 = spec.trim();
  if (text2 === "") return "unknown";
  if (/^(github:|git\+|git:)/i.test(text2)) return "git";
  if (/^https?:\/\//i.test(text2)) return /\.git(#|$)/i.test(text2) ? "git" : "tarball";
  if (/\.git(#|$)/i.test(text2)) return "git";
  if (/^(file:|link:|\.{1,2}[\\/]|[A-Za-z]:[\\/])/i.test(text2)) {
    return /\.tgz$/i.test(text2) ? "tarball" : "path";
  }
  if (/\.tgz$/i.test(text2)) return "tarball";
  return "registry";
}
function readLockfile(profileDir) {
  const path = join2(profileDir, "pnpm-lock.yaml");
  if (!existsSync(path)) return void 0;
  try {
    return parseYaml(readFileSync(path, "utf8"));
  } catch {
    return void 0;
  }
}
function findPackage(lockfile, name2, resolved) {
  if (!lockfile?.packages || resolved === void 0) return void 0;
  const exact = lockfile.packages[`${name2}@${resolved}`];
  if (exact) return exact;
  const core = resolved.replace(/\([^()]*\)\s*$/, "");
  const stripped = lockfile.packages[`${name2}@${core}`];
  if (stripped) return stripped;
  const prefix = `${name2}@`;
  for (const [key, value] of Object.entries(lockfile.packages))
    if (key.startsWith(prefix) && (key.includes(core) || core.includes(key.slice(prefix.length))))
      return value;
  return void 0;
}
function commitOfTarball(tarball) {
  if (typeof tarball !== "string") return void 0;
  const match = /\/tar\.gz\/([0-9a-f]{7,40})/i.exec(tarball);
  return match ? match[1].toLowerCase() : void 0;
}
function readInstalledPlugins(profileDir) {
  const manifest = readJson(join2(profileDir, "package.json"));
  if (!manifest || typeof manifest !== "object") return [];
  const dependencies = manifest.dependencies && typeof manifest.dependencies === "object" ? manifest.dependencies : {};
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles.filter(
    (item) => typeof item === "string"
  ) : [];
  const lockfile = readLockfile(profileDir);
  const importer = lockfile?.importers?.["."]?.dependencies ?? {};
  const plugins = [];
  for (const [name2, rawSpec] of Object.entries(dependencies)) {
    if (name2.startsWith(HOST_SCOPE)) continue;
    const declared = typeof rawSpec === "string" ? rawSpec : "";
    const entry = importer[name2];
    const spec = typeof entry?.specifier === "string" && entry.specifier !== "" ? entry.specifier : declared;
    const resolved = typeof entry?.version === "string" && entry.version !== "" ? entry.version : void 0;
    const kind = classifySpec(spec);
    const pkgDir = join2(profileDir, "node_modules", name2);
    const pkg = readJson(join2(pkgDir, "package.json"));
    const pkgEntry = findPackage(lockfile, name2, resolved);
    const tarball = pkgEntry?.resolution?.tarball ?? (kind === "git" ? resolved : void 0);
    const plugin = {
      name: name2,
      spec,
      kind,
      selected: bundles.includes(name2),
      present: pkg !== void 0,
      bundle: typeof pkg?.dsh?.bundle?.patch === "string",
      hasClient: pkg?.dsh?.client !== void 0
    };
    const version = typeof pkg?.version === "string" ? pkg.version : void 0;
    if (version !== void 0) plugin.version = version;
    if (typeof pkg?.name === "string" && pkg.name !== "") plugin.packageName = pkg.name;
    const repo = githubRepoOf(pkg?.repository) ?? githubRepoOf(spec);
    if (repo !== void 0) plugin.repo = repo;
    const commit = commitOfTarball(tarball);
    if (commit !== void 0) plugin.commit = commit;
    const integrity = pkgEntry?.resolution?.integrity;
    if (typeof integrity === "string" && integrity !== "")
      plugin.integrity = integrity;
    plugins.push(plugin);
  }
  return plugins.sort((a, b) => a.name.localeCompare(b.name));
}

// src/core/transfer.ts
import { readFileSync as readFileSync2, readdirSync, statSync } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { basename, extname, join as join3, resolve as resolve2 } from "node:path";
import { parse as parseYaml2 } from "yaml";

// src/ops/spec.ts
import { homedir as homedir2 } from "node:os";
import { isAbsolute, resolve } from "node:path";
var LOCAL_PROTOCOL = /^(file|link):(.*)$/s;
var NON_REGISTRY_VALUE = /^(?!(?:npm|jsr|workspace|catalog):)[a-z][a-z0-9+.-]*:|^[^@/:\s]+@[^:/\s]+:/i;
var HTTP_USER_INFO = /^((?:git\+)?https?:\/\/)[^/]*@/i;
function redactSpec(value) {
  return value.replace(HTTP_USER_INFO, "$1");
}
function installSpecFor(source, profileDir, targetVersion) {
  const name2 = source.name;
  const recorded = (source.spec ?? "").trim();
  const local = LOCAL_PROTOCOL.exec(recorded);
  if (local) return withName(name2, `${local[1]}:${absoluteLocal(local[2], profileDir)}`, source.packageName);
  if (recorded !== "" && NON_REGISTRY_VALUE.test(recorded))
    return withName(name2, redactSpec(recorded), source.packageName);
  if (source.kind === "path" || source.kind === "tarball") {
    if (profileDir === void 0) return withName(name2, recorded, source.packageName);
    const bare = recorded.replace(/^(file|link):/, "");
    return withName(name2, `file:${absoluteLocal(bare, profileDir)}`, source.packageName);
  }
  const range = targetVersion !== void 0 && targetVersion !== "" ? targetVersion : recorded;
  return `${name2}@${range === "" ? "latest" : range}`;
}
function latestSpec(kind, spec, name2, profileDir) {
  const text2 = spec.trim();
  if (kind === "registry") return `${name2}@latest`;
  const looksRegistry = kind === void 0 && (/^(\^|~)?\d|^\*$|^latest$/i.test(text2) || text2 === "");
  if (looksRegistry) return `${name2}@latest`;
  if (kind === void 0 && text2 === "") return `${name2}@latest`;
  return installSpecFor(
    { name: name2, spec: text2, kind: kind === "git" || kind === "path" || kind === "tarball" ? kind : "unknown" },
    profileDir
  );
}
function absoluteLocal(path, profileDir) {
  const expanded = path.replace(/^~(?=$|[\\/])/, () => homedir2());
  if (isAbsolute(expanded)) return expanded;
  if (expanded.startsWith("~/") || expanded.startsWith("~\\")) return expanded;
  return profileDir === void 0 ? expanded : resolve(profileDir, expanded);
}
function withName(name2, spec, packageName) {
  const own = packageName ?? name2;
  return own === name2 ? spec : `${name2}@${spec}`;
}

// src/core/transfer.ts
var EXPORT_FORMAT = "dsh-plugin-harbor/export";
var EXPORT_VERSION = 1;
var MAX_FILE_BYTES = 256 * 1024;
var MAX_TOTAL_BYTES = 4 * 1024 * 1024;
var MAX_DEPTH = 3;
var TEXT_EXTENSIONS = /* @__PURE__ */ new Set([
  ".json",
  ".jsonc",
  ".yml",
  ".yaml",
  ".txt",
  ".md",
  ".toml",
  ".ini",
  ".cfg",
  ".conf"
]);
var EXCLUDED_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  "cache",
  "caches",
  ".git",
  "exports",
  "logs",
  "log",
  "tmp",
  "temp"
]);
var EXCLUDED_FILE = /\.(sqlite3?|db|db3|log|lock|tgz|tar|gz|zip|bin|node|dll|exe|so|dylib)(-wal|-shm)?$/i;
var SECRET_KEY = /(token|secret|passwd|password|apikey|accesskey|privatekey|credential|cookie|authorization|sessionid|clientsecret)/;
var SECRET_VALUE = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/,
  /\bnpm_[A-Za-z0-9]{16,}/,
  /\bBearer\s+\S+/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,
  /:\/\/[^/\s:@]+:[^/\s:@]+@/
];
var REDACTED = "[\u5DF2\u8131\u654F]";
function buildExport(input) {
  const now = input.now ?? Date.now();
  const warnings = [];
  const omissions = [];
  const patch = readProfilePatch(input.profileDir);
  if (patch.error !== void 0) warnings.push(`profile \u8865\u4E01\u672A\u80FD\u89E3\u6790\uFF1A${patch.error}`);
  const unattributed = [];
  const attributed = [];
  let redactions = 0;
  const plugins = input.plugins.map((plugin) => {
    const rowIds = declaredRowIds(input.profileDir, plugin.name);
    const myEntries = (input.entries ?? []).filter((entry) => isEntryOf(entry.moduleName, plugin.name));
    const mine = [];
    for (const row of patch.rows) {
      if (!belongsTo(row, plugin.name, rowIds)) continue;
      if (row.id !== void 0) attributed.push(row.id);
      const safe = redactRow(row);
      redactions += safe.count;
      mine.push(safe.row);
    }
    const exported = {
      name: plugin.name,
      spec: plugin.spec,
      kind: plugin.kind,
      enabled: plugin.selected
    };
    if (plugin.version !== void 0) exported.version = plugin.version;
    if (plugin.repo !== void 0) exported.repo = plugin.repo;
    if (plugin.packageName !== void 0) exported.packageName = plugin.packageName;
    if (input.entries !== void 0)
      exported.entries = myEntries.map((entry) => ({
        entryId: entry.entryId,
        moduleName: entry.moduleName,
        enabled: entry.enabled
      }));
    if (mine.length > 0) exported.config = mine;
    if (input.includeData === true) {
      const scan = collectDataFiles(input.profileDir, plugin, myEntries, input.selfDirName);
      omissions.push(...scan.omissions);
      redactions += scan.redactions;
      if (scan.files.length > 0) exported.files = scan.files;
    }
    return exported;
  });
  for (const row of patch.rows) {
    if (row.id !== void 0 && attributed.includes(row.id)) continue;
    if (row.config === void 0 && row.disabled === void 0) continue;
    const safe = redactRow(row);
    redactions += safe.count;
    unattributed.push(safe.row);
  }
  if (patch.rows.length > 0 && unattributed.length > 0)
    warnings.push(
      `\u6709 ${unattributed.length} \u884C\u8865\u4E01\u6CA1\u5F52\u5230\u5BFC\u51FA\u8303\u56F4\u5185\u7684\u5DF2\u88C5\u63D2\u4EF6\uFF08\u591A\u534A\u914D\u7F6E\u7684\u662F\u5BBF\u4E3B\u81EA\u5E26\u6761\u76EE\u6216\u5176\u4ED6\u5305\uFF09\uFF0C\u5DF2\u539F\u6837\u653E\u5728 profilePatch.unattributed \u91CC`
    );
  if (input.includeData === true) {
    if (redactions > 0)
      warnings.push(`\u63D2\u4EF6\u8BBE\u7F6E\u91CC\u6709 ${redactions} \u5904\u7591\u4F3C\u51ED\u636E\u7684\u5B57\u6BB5/\u53D6\u503C\uFF0C\u5DF2\u66FF\u6362\u4E3A ${REDACTED}`);
    warnings.push("\u63D2\u4EF6\u81EA\u5DF1\u7684\u8BBE\u7F6E\u6587\u4EF6\u53EA\u5BFC\u51FA\u3001\u4E0D\u81EA\u52A8\u5BFC\u5165\uFF1A\u90A3\u662F\u5404\u63D2\u4EF6\u81EA\u5DF1\u7684\u6570\u636E\uFF0C\u672C\u9879\u76EE\u4E0D\u4EE3\u5199");
    const owned = ownedDataDirNames(
      input.profileDir,
      input.plugins,
      input.entries ?? [],
      input.selfDirName
    );
    for (const dir of unownedProfileDirs(input.profileDir, owned))
      omissions.push({ path: dir, reason: "\u8BA4\u4E0D\u51FA\u5C5E\u4E8E\u54EA\u4E2A\u5DF2\u88C5\u63D2\u4EF6\uFF0C\u672A\u5BFC\u51FA\u5176\u5185\u5BB9" });
  }
  if (input.entries === void 0)
    warnings.push("\u5BBF\u4E3B pluginManager \u670D\u52A1\u4E0D\u53EF\u7528\uFF1A\u672A\u5305\u542B\u6761\u76EE\u7EA7\u4FE1\u606F\uFF08\u6761\u76EE\u5F00\u5173\u65E0\u6CD5\u5BFC\u51FA/\u5BFC\u5165\uFF09");
  const bundle = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now,
    profile: input.profileName,
    by: { plugin: "plugin-harbor", version: input.pluginVersion },
    plugins,
    profilePatch: {
      attributed: [...new Set(attributed)],
      unattributed,
      ...patch.error === void 0 ? {} : { error: patch.error }
    },
    omissions,
    warnings
  };
  bundle.settings = redactSettings(input.settings);
  return bundle;
}
function serializeExport(bundle) {
  return JSON.stringify(bundle, null, 2) + "\n";
}
function exportFileName(profileName, now) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  return `${stamp}-${profileName}.json`;
}
function readExport(text2) {
  let parsed;
  try {
    parsed = JSON.parse(text2);
  } catch (error) {
    return { error: "\u4E0D\u662F\u5408\u6CD5 JSON\uFF1A" + (error instanceof Error ? error.message : String(error)) };
  }
  if (!parsed || typeof parsed !== "object") return { error: "\u5185\u5BB9\u4E0D\u662F\u5BF9\u8C61" };
  if (parsed.format !== EXPORT_FORMAT)
    return { error: `\u4E0D\u662F\u63D2\u4EF6\u6E2F\u6E7E\u7684\u5BFC\u51FA\u6587\u4EF6\uFF08format=${String(parsed.format)}\uFF09` };
  if (parsed.version !== EXPORT_VERSION)
    return { error: `\u5BFC\u51FA\u683C\u5F0F\u7248\u672C\u4E0D\u652F\u6301\uFF1A${String(parsed.version)}\uFF08\u672C\u63D2\u4EF6\u652F\u6301 ${EXPORT_VERSION}\uFF09` };
  if (!Array.isArray(parsed.plugins)) return { error: "\u7F3A\u5C11 plugins \u6570\u7EC4" };
  for (const plugin of parsed.plugins) {
    if (!plugin || typeof plugin.name !== "string" || plugin.name === "")
      return { error: "plugins \u91CC\u6709\u6761\u76EE\u7F3A\u5C11 name" };
    if (typeof plugin.spec !== "string") return { error: `\u63D2\u4EF6 ${plugin.name} \u7F3A\u5C11 spec` };
    if (typeof plugin.kind !== "string") return { error: `\u63D2\u4EF6 ${plugin.name} \u7F3A\u5C11 kind` };
  }
  return { bundle: parsed };
}
function planImport(input) {
  const exists = input.exists ?? existsSyncSafe;
  const byName = new Map(input.installed.map((plugin) => [plugin.name, plugin]));
  const entryByName = /* @__PURE__ */ new Map();
  for (const entry of input.entries ?? []) {
    const owner = [...byName.keys()].find((name2) => isEntryOf(entry.moduleName, name2));
    if (owner === void 0) continue;
    const list2 = entryByName.get(owner) ?? [];
    list2.push(entry);
    entryByName.set(owner, list2);
  }
  const steps = [];
  for (const exported of input.bundle.plugins) {
    const current = byName.get(exported.name);
    const kind = exported.kind;
    if (current === void 0) {
      const address = installAddressFor(exported, input.profileDir, exists);
      if (address.blocked !== void 0) {
        steps.push({ name: exported.name, action: "blocked", kind, reason: address.blocked });
        continue;
      }
      steps.push({
        name: exported.name,
        action: "install",
        spec: address.spec,
        enabled: exported.enabled !== false,
        kind
      });
      continue;
    }
    const wantEnabled = exported.enabled !== false;
    if (wantEnabled !== current.selected) {
      steps.push({ name: exported.name, action: wantEnabled ? "enable" : "disable", kind });
      continue;
    }
    const wanted = (exported.entries ?? []).filter((entry) => entry.enabled !== void 0);
    const live = entryByName.get(exported.name) ?? [];
    const changes = input.entries === void 0 ? [] : wanted.map((entry) => {
      const actual = live.find((row) => row.entryId === entry.entryId);
      if (actual === void 0 || actual.readOnlyReason !== void 0) return void 0;
      return actual.enabled === entry.enabled ? void 0 : { entryId: entry.entryId, enabled: entry.enabled };
    }).filter((row) => row !== void 0);
    if (changes.length > 0) {
      steps.push({ name: exported.name, action: "entries", entries: changes, kind });
      continue;
    }
    steps.push({
      name: exported.name,
      action: "skip",
      kind,
      reason: input.entries === void 0 ? "\u4F9D\u8D56\u4E0E\u542F\u7528\u72B6\u6001\u5DF2\u4E00\u81F4\uFF08\u5BBF\u4E3B\u670D\u52A1\u4E0D\u53EF\u7528\uFF0C\u672A\u6BD4\u5BF9\u6761\u76EE\u5F00\u5173\uFF09" : "\u4F9D\u8D56\u3001\u542F\u7528\u72B6\u6001\u4E0E\u6761\u76EE\u5F00\u5173\u90FD\u5DF2\u4E00\u81F4"
    });
  }
  const changed = [];
  const exportedSettings = input.bundle.settings;
  if (exportedSettings !== void 0) {
    for (const [key, value] of Object.entries(exportedSettings))
      if (JSON.stringify(input.settings?.[key]) !== JSON.stringify(value))
        changed.push(key);
  }
  const warnings = [...input.bundle.warnings ?? []];
  if (input.bundle.profile !== void 0 && input.bundle.profile !== input.profileName)
    warnings.push(
      `\u5BFC\u51FA\u6587\u4EF6\u6765\u81EA profile\u300C${input.bundle.profile}\u300D\uFF0C\u672C\u673A\u662F\u300C${input.profileName}\u300D\uFF1A\u672C\u5730\u8DEF\u5F84\u5F62\u6001\u53EF\u80FD\u5BF9\u4E0D\u4E0A`
    );
  return {
    source: input.source,
    ...input.bundle.profile === void 0 ? {} : { exportProfile: input.bundle.profile },
    ...input.bundle.exportedAt === void 0 ? {} : { exportedAt: input.bundle.exportedAt },
    steps,
    settings: { changed },
    configRows: input.bundle.plugins.reduce((sum, plugin) => sum + (plugin.config?.length ?? 0), 0),
    unattributedRows: input.bundle.profilePatch?.unattributed?.length ?? 0,
    omissions: input.bundle.omissions ?? [],
    warnings
  };
}
function patchSnippet(bundle, profileName) {
  const rows = [];
  for (const plugin of bundle.plugins)
    for (const row of plugin.config ?? [])
      if (row.config !== void 0 || row.disabled !== void 0) rows.push(row);
  if (rows.length === 0) return void 0;
  const header = [
    `# \u63D2\u4EF6\u6E2F\u6E7E\u5BFC\u51FA\uFF08${bundle.exportedAt ? new Date(bundle.exportedAt).toLocaleString("zh-CN", { hour12: false }) : "\u672A\u77E5\u65F6\u95F4"} \xB7 profile ${bundle.profile ?? "?"}\uFF09`,
    `# \u8FD9\u4E9B\u884C\u5E26 config\uFF0C\u5BBF\u4E3B\u7684 pluginManager \u6CA1\u6709\u5199 config \u7684\u63A5\u53E3\uFF0C\u9700\u8981\u4F60\u786E\u8BA4\u540E\u81EA\u884C\u7C98\u8D34\u5230`,
    `# ~/.dsh/profiles/${profileName}/cordis.patch.yml\uFF08profile \u8865\u4E01\u662F YAML \u5E8F\u5217\uFF0C\u5B57\u6BB5\u6309 id \u751F\u6548\uFF09`,
    "# \u7C98\u8D34\u524D\u8BF7\u6838\u5BF9\uFF1A\u672C\u673A\u63D2\u4EF6\u7248\u672C/\u8DEF\u5F84\u53EF\u80FD\u4E0D\u540C\uFF0Cconfig \u91CC\u7684\u5730\u5740\u3001\u5BC6\u94A5\u7B49\u9700\u8981\u6309\u672C\u673A\u73AF\u5883\u8C03\u6574\u3002",
    ""
  ].join("\n");
  return header + rows.map((row) => serializeRow(row)).join("\n") + "\n";
}
function redactRow(row) {
  const config = row.config === void 0 ? void 0 : redactValue(row.config);
  const count = config?.count ?? 0;
  const out = {};
  if (row.id !== void 0) out.id = row.id;
  if (row.name !== void 0) out.name = row.name;
  if (row.disabled !== void 0) out.disabled = row.disabled;
  if (config !== void 0) out.config = config.value;
  return { row: out, count };
}
function serializeRow(row) {
  const lines = ["- id: " + JSON.stringify(row.id ?? "")];
  if (row.name !== void 0) lines.push("  name: " + JSON.stringify(row.name));
  if (typeof row.disabled === "boolean") lines.push("  disabled: " + String(row.disabled));
  else if (typeof row.disabled === "string")
    lines.push("  disabled: !!js " + JSON.stringify(row.disabled));
  if (row.config !== void 0)
    lines.push(
      "  config:",
      ...JSON.stringify(row.config, null, 2).split("\n").map((line) => "    " + line)
    );
  return lines.join("\n");
}
function installAddressFor(exported, profileDir, exists = existsSyncSafe) {
  const source = {
    name: exported.name,
    spec: exported.spec,
    kind: exported.kind,
    ...exported.packageName === void 0 ? {} : { packageName: exported.packageName }
  };
  if (exported.kind === "registry") {
    const version = exported.version;
    return {
      spec: installSpecFor(
        source,
        profileDir,
        version === void 0 || version === "" ? void 0 : version
      )
    };
  }
  if (exported.kind === "git") return { spec: installSpecFor(source, profileDir) };
  if (exported.kind === "tarball") {
    const spec2 = installSpecFor(source, profileDir);
    if (/^https?:\/\//i.test(spec2)) return { spec: spec2 };
    const path2 = localPathOf(spec2);
    if (path2 === void 0) return { spec: spec2 };
    return exists(path2) ? { spec: spec2 } : {
      blocked: `\u5BFC\u51FA\u8BB0\u5F55\u7684\u662F\u672C\u673A\u538B\u7F29\u5305\uFF08${path2}\uFF09\uFF0C\u76EE\u6807\u673A\u5668\u4E0A\u6CA1\u6709\u8FD9\u4E2A\u6587\u4EF6\uFF1A\u5148\u628A\u5305\u653E\u8FC7\u53BB\uFF0C\u6216\u6539\u7528 registry / git \u5730\u5740`
    };
  }
  const spec = installSpecFor(source, profileDir);
  const path = localPathOf(spec);
  if (path === void 0) return { spec };
  return exists(path) ? { spec } : {
    blocked: `\u5BFC\u51FA\u8BB0\u5F55\u7684\u662F\u672C\u673A\u8DEF\u5F84\u5F62\u6001\uFF08${path}\uFF09\uFF0C\u76EE\u6807\u673A\u5668\u4E0A\u6CA1\u6709\u8FD9\u4E2A\u8DEF\u5F84\uFF1A\u5148\u628A\u5305\u653E\u5230\u8BE5\u4F4D\u7F6E\uFF0C\u6216\u6539\u7528 registry / git \u5730\u5740`
  };
}
function localPathOf(spec) {
  const local = /^(?:file|link):(.+)$/s.exec(spec);
  if (local) return local[1].replace(/^~(?=$|[\\/])/, () => homedir3());
  if (/^[A-Za-z]:[\\/]/.test(spec) || spec.startsWith("/") || spec.startsWith("./") || spec.startsWith("../"))
    return spec;
  return void 0;
}
function existsSyncSafe(path) {
  try {
    return statSync(path).isDirectory() || statSync(path).isFile();
  } catch {
    return false;
  }
}
function readProfilePatch(profileDir) {
  let text2;
  try {
    text2 = readFileSync2(join3(profileDir, "cordis.patch.yml"), "utf8");
  } catch (error) {
    const code = error.code;
    if (code === "ENOENT") return { rows: [] };
    return { rows: [], error: error instanceof Error ? error.message : String(error) };
  }
  let document;
  try {
    document = parseYaml2(text2, {
      customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value) => value }]
    });
  } catch (error) {
    return { rows: [], error: error instanceof Error ? error.message : String(error) };
  }
  if (!Array.isArray(document)) return { rows: [], error: "profile \u8865\u4E01\u4E0D\u662F YAML \u5E8F\u5217" };
  const rows = [];
  for (const item of document) {
    if (!item || typeof item !== "object") continue;
    const row = item;
    if (Array.isArray(row.insert)) {
      for (const inner of row.insert) {
        if (!inner || typeof inner !== "object") continue;
        rows.push(normalizeRow(inner));
      }
      continue;
    }
    rows.push(normalizeRow(row));
  }
  return { rows };
}
function normalizeRow(row) {
  const out = {};
  if (typeof row.id === "string") out.id = row.id;
  if (typeof row.name === "string") out.name = row.name;
  if (typeof row.disabled === "boolean") out.disabled = row.disabled;
  else if (typeof row.disabled === "string") out.disabled = row.disabled;
  if (row.config !== void 0) out.config = row.config;
  if (row.insert !== void 0) out.insert = row.insert;
  return out;
}
function declaredRowIds(profileDir, name2) {
  const dir = pluginDirOf(profileDir, name2);
  if (dir === void 0) return [];
  let patchPath;
  try {
    const pkg = JSON.parse(readFileSync2(join3(dir, "package.json"), "utf8"));
    const declared = pkg?.dsh?.bundle?.patch;
    if (typeof declared === "string") patchPath = resolve2(dir, declared);
  } catch {
    return [];
  }
  if (patchPath === void 0) return [];
  let text2;
  try {
    text2 = readFileSync2(patchPath, "utf8");
  } catch {
    return [];
  }
  const ids = [];
  try {
    const document = parseYaml2(text2, {
      customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value) => value }]
    });
    if (Array.isArray(document))
      for (const item of document) {
        if (!item || typeof item !== "object") continue;
        const row = item;
        const list2 = Array.isArray(row.insert) ? row.insert : [row];
        for (const inner of list2)
          if (inner && typeof inner === "object" && typeof inner.id === "string")
            ids.push(inner.id);
      }
  } catch {
    return [];
  }
  return [...new Set(ids)];
}
function pluginDirOf(profileDir, name2) {
  const dir = join3(profileDir, "node_modules", name2);
  try {
    statSync(dir);
    return dir;
  } catch {
    return void 0;
  }
}
function belongsTo(row, name2, rowIds) {
  if (row.id !== void 0 && rowIds.includes(row.id)) return true;
  if (row.name === name2) return true;
  if (row.name !== void 0 && row.name.startsWith(name2 + "/")) return true;
  return false;
}
function isEntryOf(moduleName, name2) {
  if (moduleName === name2) return true;
  return moduleName.startsWith(name2 + "/");
}
function dataDirCandidates(profileDir, plugin, entries) {
  return [
    .../* @__PURE__ */ new Set([
      plugin.name,
      plugin.name.split("/").pop() ?? plugin.name,
      ...declaredRowIds(profileDir, plugin.name),
      ...entries.map((entry) => entry.entryId.replace(/^include:/, ""))
    ])
  ];
}
function collectDataFiles(profileDir, plugin, entries, selfDirName) {
  const result = { files: [], omissions: [], redactions: 0 };
  for (const candidate of dataDirCandidates(profileDir, plugin, entries)) {
    const dir = join3(profileDir, candidate);
    if (selfDirName !== void 0 && candidate === selfDirName) {
      result.omissions.push({ path: candidate, reason: "\u672C\u63D2\u4EF6\u81EA\u5DF1\u7684\u6570\u636E\u76EE\u5F55\uFF08\u8BBE\u7F6E\u5DF2\u5355\u72EC\u5BFC\u51FA\uFF09" });
      continue;
    }
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    let total = 0;
    walk(dir, candidate, 0, (rel, absolute, size) => {
      const name2 = basename(absolute);
      if (EXCLUDED_FILE.test(name2)) {
        result.omissions.push({ path: rel, reason: "\u6570\u636E\u5E93/\u65E5\u5FD7/\u9501/\u538B\u7F29\u5305\uFF0C\u4E0D\u5BFC\u51FA" });
        return;
      }
      if (!TEXT_EXTENSIONS.has(extname(name2).toLowerCase())) {
        result.omissions.push({ path: rel, reason: "\u975E\u6587\u672C\u6269\u5C55\u540D\uFF0C\u4E0D\u5BFC\u51FA" });
        return;
      }
      if (size > MAX_FILE_BYTES) {
        result.omissions.push({ path: rel, reason: `\u8D85\u8FC7 ${Math.round(MAX_FILE_BYTES / 1024)}KB\uFF0C\u4E0D\u5BFC\u51FA` });
        return;
      }
      if (total + size > MAX_TOTAL_BYTES) {
        result.omissions.push({ path: rel, reason: "\u8D85\u51FA\u672C\u6B21\u5BFC\u51FA\u7684\u603B\u4F53\u79EF\u4E0A\u9650\uFF0C\u4E0D\u5BFC\u51FA" });
        return;
      }
      let text2;
      try {
        const raw = readFileSync2(absolute);
        if (raw.includes(0)) {
          result.omissions.push({ path: rel, reason: "\u4E8C\u8FDB\u5236\u5185\u5BB9\uFF0C\u4E0D\u5BFC\u51FA" });
          return;
        }
        text2 = raw.toString("utf8");
      } catch (error) {
        result.omissions.push({
          path: rel,
          reason: "\u8BFB\u53D6\u5931\u8D25\uFF1A" + (error instanceof Error ? error.message : String(error))
        });
        return;
      }
      const redacted = redactText(text2);
      if (redacted.count > 0) result.redactions += redacted.count;
      total += size;
      result.files.push({ path: rel, bytes: size, content: redacted.text });
    });
  }
  return result;
}
function walk(dir, prefix, depth, visit) {
  if (depth > MAX_DEPTH) return;
  let items;
  try {
    items = readdirSync(dir);
  } catch {
    return;
  }
  for (const item of items.sort()) {
    const absolute = join3(dir, item);
    const rel = prefix + "/" + item;
    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      if (EXCLUDED_DIRS.has(item.toLowerCase())) continue;
      walk(absolute, rel, depth + 1, visit);
      continue;
    }
    if (!stats.isFile()) continue;
    visit(rel, absolute, stats.size);
  }
}
function redactValue(value, key = "") {
  if (typeof value === "string") {
    const redacted = redactText(value);
    if (normalizeKey(key) !== "" && SECRET_KEY.test(normalizeKey(key)))
      return { value: REDACTED, count: Math.max(1, redacted.count) };
    return { value: redacted.text, count: redacted.count };
  }
  if (Array.isArray(value)) {
    let count = 0;
    const out = value.map((item) => {
      const nested = redactValue(item, key);
      count += nested.count;
      return nested.value;
    });
    return { value: out, count };
  }
  if (value && typeof value === "object") {
    let count = 0;
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const nested = redactValue(childValue, childKey);
      count += nested.count;
      out[childKey] = nested.value;
    }
    return { value: out, count };
  }
  return { value, count: 0 };
}
function redactText(text2) {
  let count = 0;
  let out = text2;
  for (const pattern of SECRET_VALUE) {
    out = out.replace(new RegExp(pattern.source, "gi"), () => {
      count += 1;
      return REDACTED;
    });
  }
  return { text: out, count };
}
function redactSettings(settings) {
  const { value } = redactValue(settings);
  return value;
}
function normalizeKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}
function ownedDataDirNames(profileDir, plugins, entries = [], selfDirName) {
  const owned = /* @__PURE__ */ new Set();
  for (const plugin of plugins)
    for (const name2 of dataDirCandidates(profileDir, plugin, entries)) owned.add(name2);
  if (selfDirName !== void 0) owned.add(selfDirName);
  return owned;
}
function unownedProfileDirs(profileDir, owned) {
  let items;
  try {
    items = readdirSync(profileDir);
  } catch {
    return [];
  }
  const out = [];
  for (const item of items.sort()) {
    if (owned.has(item)) continue;
    if (item.startsWith(".")) continue;
    if (["node_modules", "cache", "logs"].includes(item.toLowerCase())) continue;
    try {
      if (!statSync(join3(profileDir, item)).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push(item);
  }
  return out;
}

// src/core/updates.ts
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return void 0;
  for (let i = 0; i < 3; i++) {
    if (left.numbers[i] !== right.numbers[i])
      return left.numbers[i] < right.numbers[i] ? -1 : 1;
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;
  const length = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < length; i++) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === void 0) return -1;
    if (r === void 0) return 1;
    if (l === r) continue;
    const lNum = /^\d+$/.test(l);
    const rNum = /^\d+$/.test(r);
    if (lNum && rNum) return Number(l) < Number(r) ? -1 : 1;
    if (lNum !== rNum) return lNum ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}
function parseVersion(value) {
  if (typeof value !== "string") return void 0;
  const text2 = value.trim().replace(/^[v=]+/i, "");
  if (text2 === "") return void 0;
  const [core, ...rest] = text2.split("+")[0].split("-");
  const parts = core.split(".");
  if (parts.length === 0 || parts.length > 3) return void 0;
  const numbers = [0, 0, 0];
  for (let i = 0; i < parts.length; i++) {
    if (!/^\d+$/.test(parts[i])) return void 0;
    numbers[i] = Number(parts[i]);
  }
  const pre = rest.length === 0 ? [] : rest.join("-").split(".").filter((item) => item !== "");
  return { numbers, pre };
}
async function checkPlugin(plugin, deps) {
  const checkedAt = (deps.now ?? Date.now)();
  const base = {
    name: plugin.name,
    kind: plugin.kind,
    spec: plugin.spec,
    updateAvailable: null,
    checkedAt
  };
  if (plugin.repo) base.repo = plugin.repo;
  if (plugin.version) base.installedVersion = plugin.version;
  if (plugin.commit) base.installedCommit = plugin.commit;
  if (plugin.kind === "path" || plugin.kind === "tarball" || plugin.kind === "unknown") {
    base.note = "\u672C\u5730\u8DEF\u5F84 / \u538B\u7F29\u5305\u5B89\u88C5\uFF0C\u6CA1\u6709\u8FDC\u7AEF\u53EF\u6BD4";
    return base;
  }
  if (plugin.kind === "git") {
    if (!plugin.repo) {
      base.error = "\u8BFB\u4E0D\u5230\u4ED3\u5E93\u8EAB\u4EFD\uFF08package.json \u65E0 repository\uFF0Cspec \u4E5F\u4E0D\u662F\u4ED3\u5E93\u5730\u5740\uFF09";
      return base;
    }
    if (!deps.git) {
      base.error = "\u672A\u914D\u7F6E git \u67E5\u8BE2";
      return base;
    }
    const remote = await deps.git(plugin.repo);
    if (remote.error || !remote.commit) {
      base.error = remote.error ?? "\u8FDC\u7AEF\u6CA1\u6709\u8FD4\u56DE commit";
      return base;
    }
    base.latestCommit = remote.commit;
    base.latestSource = "git";
    if (!plugin.commit) {
      base.error = "lockfile \u91CC\u6CA1\u6709\u8FD9\u6761\u4F9D\u8D56\u7684 commit\uFF08\u65E0\u6CD5\u4E0E\u8FDC\u7AEF\u6BD4\u8F83\uFF09";
      return base;
    }
    base.updateAvailable = remote.commit !== plugin.commit;
    return base;
  }
  if (!deps.registry) {
    base.error = "\u672A\u914D\u7F6E registry \u67E5\u8BE2";
    return base;
  }
  const facts = await deps.registry(plugin.name);
  if (facts.error || !facts.latest) {
    base.error = facts.error ?? "registry \u6CA1\u6709\u8FD4\u56DE latest";
    return base;
  }
  base.latestVersion = facts.latest;
  base.latestSource = "registry";
  if (!plugin.version) {
    base.error = "\u8BFB\u4E0D\u5230\u672C\u5730\u7248\u672C\uFF08node_modules \u91CC\u7F3A\u8FD9\u4E2A\u5305\uFF1F\uFF09";
    return base;
  }
  const order = compareVersions(facts.latest, plugin.version);
  if (order === void 0) {
    base.error = `\u7248\u672C\u4E0D\u53EF\u6BD4\uFF1A${facts.latest} vs ${plugin.version}`;
    return base;
  }
  base.updateAvailable = order > 0;
  return base;
}
async function checkPlugins(plugins, deps) {
  return await mapLimited(plugins, deps.concurrency ?? 4, async (plugin) => {
    try {
      return await checkPlugin(plugin, deps);
    } catch (error) {
      return {
        name: plugin.name,
        kind: plugin.kind,
        updateAvailable: null,
        error: error instanceof Error ? error.message : String(error),
        checkedAt: (deps.now ?? Date.now)()
      };
    }
  });
}

// src/upstream/registry.ts
var DEFAULT_REGISTRY = "https://registry.npmjs.org";
function packagePath(name2) {
  return name2.replace("/", "%2f");
}
async function fetchRegistryFacts(name2, options = {}) {
  const base = (options.registry ?? DEFAULT_REGISTRY).replace(/\/$/, "");
  const url = `${base}/${packagePath(name2)}`;
  const result = await fetchText(url, {
    timeoutMs: options.timeoutMs ?? 15e3,
    accept: "application/vnd.npm.install-v1+json"
  });
  if (!result.ok) return { error: result.error ?? `HTTP ${result.status}` };
  let parsed;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    return { error: "registry \u8FD4\u56DE\u7684\u4E0D\u662F JSON" };
  }
  const latest = parsed?.["dist-tags"]?.latest;
  if (typeof latest !== "string" || latest === "")
    return { error: "registry \u6CA1\u6709 dist-tags.latest" };
  const integrity = parsed?.versions?.[latest]?.dist?.integrity;
  return {
    latest,
    ...typeof integrity === "string" && integrity !== "" ? { integrity } : {}
  };
}

// src/core/diagnostics.ts
var INDEX_TIMEOUT_MS2 = 2e4;
var SMALL_TIMEOUT_MS = 1e4;
async function runDiagnostics(deps) {
  const now = deps.now ?? Date.now;
  const results = [];
  const check = async (id, label, run) => {
    const started = now();
    try {
      const outcome = await run();
      results.push({ id, label, ok: outcome.ok, detail: outcome.detail, ms: now() - started });
    } catch (error) {
      results.push({
        id,
        label,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        ms: now() - started
      });
    }
  };
  await check("catalog", "\u76EE\u5F55\u6570\u636E", async () => {
    const counts = await deps.counts();
    if (counts.rows === 0)
      return {
        ok: null,
        detail: counts.lastError ? `\u5C1A\u672A\u540C\u6B65\uFF08\u4E0A\u6B21\u5931\u8D25\uFF1A${counts.lastError}\uFF09` : "\u5C1A\u672A\u540C\u6B65\u76EE\u5F55"
      };
    const when = counts.lastSyncAt ? new Date(counts.lastSyncAt).toLocaleString("zh-CN", { hour12: false }) : "\u672A\u77E5\u65F6\u95F4";
    return {
      ok: counts.lastError === null,
      detail: `${counts.rows.toLocaleString("zh-CN")} \u6761\uFF0C\u7AD9\u70B9\u81EA\u62A5 ${counts.totalCount === null ? "\u672A\u77E5" : counts.totalCount.toLocaleString("zh-CN")}\uFF1B\u540C\u6B65\u4E8E ${when}` + (counts.lastError ? `\uFF1B\u4E0A\u6B21\u5931\u8D25\uFF1A${counts.lastError}` : "")
    };
  });
  await check("store", "\u76EE\u5F55\u5E93", async () => {
    const ping = await deps.storePing();
    return {
      ok: ping.sqlite !== "",
      detail: `SQLite ${ping.sqlite}\uFF0C${ping.tables} \u5F20\u8868\uFF1B${ping.path}`
    };
  });
  await check("site", "\u5B98\u7F51\u76EE\u5F55\uFF08dsh-plugin.org\uFF09", async () => {
    const url = `${deps.settings.siteBase}/${deps.settings.locale}/plugins`;
    const result = await deps.fetch(url, { timeoutMs: INDEX_TIMEOUT_MS2 });
    if (!result.ok) return { ok: false, detail: `${url}\uFF1A${result.error ?? "\u53D6\u6570\u5931\u8D25"}` };
    return {
      ok: result.body.length > 0,
      detail: `${url}\uFF1AHTTP ${result.status}\uFF0C${result.body.length.toLocaleString("zh-CN")} \u5B57\u8282`
    };
  });
  await check("api", "API \u4E2D\u5FC3\uFF08stats.json\uFF09", async () => {
    const url = `${deps.settings.apiBase}/stats.json`;
    const result = await deps.fetch(url, {
      timeoutMs: SMALL_TIMEOUT_MS,
      accept: "application/json"
    });
    if (!result.ok) return { ok: false, detail: `${url}\uFF1A${result.error ?? "\u53D6\u6570\u5931\u8D25"}` };
    try {
      const parsed = JSON.parse(result.body);
      return {
        ok: true,
        detail: `${url}\uFF1A\u6536\u5F55 ${parsed.total ?? "?"}\uFF0C\u5DF2\u9A8C\u8BC1 ${parsed.verified ?? "?"}`
      };
    } catch {
      return { ok: true, detail: `${url}\uFF1AHTTP ${result.status}\uFF08\u54CD\u5E94\u4E0D\u662F JSON\uFF09` };
    }
  });
  await check("registry", "npm registry", async () => {
    const base = deps.settings.registry === "" ? DEFAULT_REGISTRY : deps.settings.registry;
    const url = `${base}/-/ping`;
    const result = await deps.fetch(url, {
      timeoutMs: SMALL_TIMEOUT_MS,
      accept: "application/json"
    });
    if (!result.ok && result.status === 0)
      return { ok: false, detail: `${base}\uFF1A${result.error ?? "\u4E0D\u53EF\u8FBE"}` };
    return {
      ok: true,
      detail: `${base}\uFF1AHTTP ${result.status}${result.ok ? "" : "\uFF08\u8BE5\u955C\u50CF\u672A\u5B9E\u73B0 /-/ping\uFF0C\u4F46\u53EF\u8FBE\uFF09"}`
    };
  });
  await check("git", "git \u53EF\u7528\u6027", async () => {
    const version = await deps.gitVersion();
    return { ok: version.ok, detail: version.detail };
  });
  await check("hmr", "\u70ED\u91CD\u8F7D\uFF08hmr\uFF09", async () => {
    const hot = deps.hot();
    return hot ? {
      ok: true,
      detail: "\u5BBF\u4E3B\u63D0\u4F9B hmr \u670D\u52A1\uFF1A\u5B89\u88C5/\u66F4\u65B0/\u542F\u505C/\u70ED\u91CD\u8F7D\u7531\u5BBF\u4E3B\u539F\u5730\u751F\u6548\uFF0C\u65E0\u9700\u91CD\u542F DSH\uFF08\u91CD\u5EFA\u540E\u7684\u5DF2\u94FE\u63A5\u63D2\u4EF6\u6309\u300C\u70ED\u91CD\u8F7D\u300D\u5373\u53EF\u751F\u6548\uFF09"
    } : {
      ok: false,
      detail: "\u5BBF\u4E3B\u672A\u63D0\u4F9B hmr \u670D\u52A1\uFF1A\u53D8\u66F4\u8981\u7B49\u4E0B\u6B21\u542F\u52A8 DSH \u624D\u751F\u6548\uFF08\u684C\u9762\u542F\u52A8\u5668\u63D0\u4F9B profileContext \u65F6 dsh-base \u4F1A\u542F\u7528 hmr \u6761\u76EE\uFF09"
    };
  });
  return results;
}

// src/core/settings.ts
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync3, renameSync, writeFileSync } from "node:fs";
import { dirname, join as join4 } from "node:path";
var MIN_TTL_MS = 15 * 60 * 1e3;
var MAX_TTL_MS = 30 * 24 * 3600 * 1e3;
function defaultSettings() {
  return {
    version: 1,
    locale: "zh",
    syncTtlMs: 24 * 3600 * 1e3,
    siteBase: process.env.PLUGIN_HARBOR_SITE ?? "https://dsh-plugin.org",
    apiBase: process.env.PLUGIN_HARBOR_API ?? "https://api.dsh-plugin.org",
    registry: process.env.PLUGIN_HARBOR_REGISTRY ?? "",
    proxy: ""
  };
}
function settingsPath(dataDir) {
  return join4(dataDir, "settings.json");
}
var isHttpUrl = (value) => /^https?:\/\/[^\s]+$/i.test(value);
var clean = (value) => value.trim();
function normalizeSettings(raw, defaults = defaultSettings()) {
  const notes = [];
  const isRecord = raw !== null && typeof raw === "object" && !Array.isArray(raw);
  const record = isRecord ? raw : {};
  if (raw !== void 0 && !isRecord)
    notes.push("\u8BBE\u7F6E\u6587\u4EF6\u4E0D\u662F\u5BF9\u8C61\uFF0C\u5DF2\u5168\u90E8\u9000\u56DE\u9ED8\u8BA4\u503C");
  const locale = record.locale === "en" || record.locale === "zh" ? record.locale : defaults.locale;
  if (record.locale !== void 0 && record.locale !== locale)
    notes.push(`locale \u53D6\u503C\u975E\u6CD5\uFF08${String(record.locale)}\uFF09\uFF0C\u5DF2\u9000\u56DE ${locale}`);
  let syncTtlMs = defaults.syncTtlMs;
  if (typeof record.syncTtlMs === "number" && Number.isFinite(record.syncTtlMs)) {
    if (record.syncTtlMs >= MIN_TTL_MS && record.syncTtlMs <= MAX_TTL_MS)
      syncTtlMs = Math.round(record.syncTtlMs);
    else
      notes.push(
        `syncTtlMs \u8D85\u51FA\u5141\u8BB8\u533A\u95F4\uFF08${MIN_TTL_MS}\u2013${MAX_TTL_MS}\uFF09\uFF0C\u5DF2\u9000\u56DE ${defaults.syncTtlMs}`
      );
  } else if (record.syncTtlMs !== void 0) {
    notes.push("syncTtlMs \u4E0D\u662F\u6570\u5B57\uFF0C\u5DF2\u9000\u56DE\u9ED8\u8BA4\u503C");
  }
  const url = (key) => {
    const value = record[key];
    if (typeof value !== "string" || clean(value) === "") {
      if (value !== void 0) notes.push(`${key} \u4E0D\u662F\u5408\u6CD5\u5730\u5740\uFF0C\u5DF2\u9000\u56DE\u9ED8\u8BA4\u503C`);
      return defaults[key];
    }
    if (!isHttpUrl(clean(value))) {
      notes.push(`${key} \u4E0D\u662F http(s) \u5730\u5740\uFF08${clean(value)}\uFF09\uFF0C\u5DF2\u9000\u56DE\u9ED8\u8BA4\u503C`);
      return defaults[key];
    }
    return clean(value).replace(/\/$/, "");
  };
  let registry = defaults.registry;
  const registryRaw = record.registry;
  if (typeof registryRaw === "string") {
    if (clean(registryRaw) === "") registry = "";
    else if (isHttpUrl(clean(registryRaw))) registry = clean(registryRaw).replace(/\/$/, "");
    else notes.push("registry \u4E0D\u662F http(s) \u5730\u5740\uFF0C\u5DF2\u9000\u56DE\u9ED8\u8BA4\u503C");
  } else if (registryRaw !== void 0) {
    notes.push("registry \u4E0D\u662F\u5B57\u7B26\u4E32\uFF0C\u5DF2\u9000\u56DE\u9ED8\u8BA4\u503C");
  }
  let proxy = defaults.proxy;
  const proxyRaw = record.proxy;
  if (typeof proxyRaw === "string") {
    if (clean(proxyRaw).length > 200) notes.push("proxy \u8FC7\u957F\uFF08>200\uFF09\uFF0C\u5DF2\u9000\u56DE\u9ED8\u8BA4\u503C");
    else proxy = clean(proxyRaw);
  } else if (proxyRaw !== void 0) {
    notes.push("proxy \u4E0D\u662F\u5B57\u7B26\u4E32\uFF0C\u5DF2\u9000\u56DE\u9ED8\u8BA4\u503C");
  }
  return {
    settings: {
      version: 1,
      locale,
      syncTtlMs,
      siteBase: url("siteBase"),
      apiBase: url("apiBase"),
      registry,
      proxy
    },
    notes
  };
}
function readSettingsFile(dataDir, defaults = defaultSettings()) {
  const path = settingsPath(dataDir);
  if (!existsSync2(path)) return { settings: defaults, notes: [] };
  try {
    const parsed = JSON.parse(readFileSync3(path, "utf8"));
    return normalizeSettings(parsed, defaults);
  } catch (error) {
    return {
      settings: defaults,
      notes: [
        "\u8BBE\u7F6E\u6587\u4EF6\u65E0\u6CD5\u89E3\u6790\uFF0C\u5DF2\u9000\u56DE\u9ED8\u8BA4\u503C\uFF1A" + (error instanceof Error ? error.message : String(error))
      ]
    };
  }
}
function writeSettingsFile(dataDir, settings) {
  const path = settingsPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}
function applySettingsPatch(current, patch) {
  const merged = { ...current };
  for (const key of [
    "locale",
    "syncTtlMs",
    "siteBase",
    "apiBase",
    "registry",
    "proxy"
  ]) {
    if (patch[key] !== void 0) merged[key] = patch[key];
  }
  const { settings } = normalizeSettings(merged, current);
  const problems = [];
  if (patch.locale !== void 0 && settings.locale !== patch.locale)
    problems.push("locale \u53EA\u80FD\u662F zh \u6216 en");
  if (patch.syncTtlMs !== void 0 && settings.syncTtlMs !== patch.syncTtlMs)
    problems.push(`syncTtlMs \u5FC5\u987B\u662F ${MIN_TTL_MS}\u2013${MAX_TTL_MS} \u4E4B\u95F4\u7684\u6BEB\u79D2\u6570`);
  for (const key of ["siteBase", "apiBase"])
    if (patch[key] !== void 0 && settings[key] !== clean(String(patch[key])).replace(/\/$/, ""))
      problems.push(`${key} \u5FC5\u987B\u662F http(s) \u5730\u5740`);
  if (patch.registry !== void 0 && settings.registry !== clean(String(patch.registry)).replace(/\/$/, ""))
    problems.push("registry \u5FC5\u987B\u662F http(s) \u5730\u5740\u6216\u7A7A\u4E32");
  if (patch.proxy !== void 0 && settings.proxy !== clean(String(patch.proxy)))
    problems.push("proxy \u5FC5\u987B\u662F \u2264200 \u5B57\u7B26\u7684\u5B57\u7B26\u4E32");
  return { settings, problems };
}

// src/storage/client.ts
import { Worker } from "node:worker_threads";
var CatalogStore = class {
  constructor(options) {
    this.options = options;
  }
  #worker = null;
  #pending = /* @__PURE__ */ new Map();
  #seq = 0;
  #closed = false;
  /** 超时或 worker 失败的累计次数，供界面标注「存储异常」而不谎报成功。 */
  failedWrites = 0;
  get closed() {
    return this.#closed;
  }
  #start() {
    if (this.#worker) return this.#worker;
    const worker = new Worker(this.options.workerPath, {
      workerData: { dbPath: this.options.dbPath }
    });
    worker.on("message", (message) => {
      const entry = this.#pending.get(message?.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.#pending.delete(message.id);
      if (message.ok) entry.resolve(message.value);
      else entry.reject(Error(String(message.message)));
    });
    worker.on("error", (error) => this.#fail(error));
    worker.on("exit", () => {
      this.#worker = null;
      if (!this.#closed) this.#fail(Error("catalog worker exited"));
    });
    worker.unref();
    this.#worker = worker;
    return worker;
  }
  #fail(error) {
    this.failedWrites += 1;
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.#pending.clear();
  }
  call(method, payload = {}) {
    if (this.#closed)
      return Promise.reject(Error("catalog store is closed"));
    const worker = this.#start();
    const id = ++this.#seq;
    const timeoutMs = this.options.timeoutMs ?? 5e3;
    return new Promise((resolve4, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.failedWrites += 1;
        reject(Error("catalog store call timed out: " + method));
      }, timeoutMs);
      this.#pending.set(id, { resolve: resolve4, reject, timer });
      worker.postMessage({ id, method, payload });
    });
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const worker = this.#worker;
    this.#worker = null;
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(Error("catalog store is closed"));
    }
    this.#pending.clear();
    if (worker) await worker.terminate();
  }
};

// src/upstream/git.ts
import { spawn } from "node:child_process";
var SHA = /^[0-9a-f]{7,40}$/i;
function parseLsRemote(stdout) {
  const facts = {};
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const symref = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(trimmed);
    if (symref) {
      facts.defaultBranch = symref[1];
      continue;
    }
    const head = /^([0-9a-f]{7,40})\s+HEAD$/i.exec(trimmed);
    if (head && SHA.test(head[1])) facts.commit = head[1].toLowerCase();
  }
  return facts;
}
async function readGitVersion(options = {}) {
  return await new Promise((resolve4) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve4(value);
    };
    const child = spawn(options.gitPath ?? "git", ["--version"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, detail: "git --version \u8D85\u65F6" });
    }, options.timeoutMs ?? 5e3);
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on(
      "error",
      (error) => finish({
        ok: false,
        detail: error?.code === "ENOENT" ? "\u672C\u673A\u6CA1\u6709 git \u53EF\u6267\u884C\u6587\u4EF6\uFF08git \u5F62\u6001\u7684\u66F4\u65B0\u5224\u636E\u4F1A\u4E0D\u53EF\u7528\uFF09" : String(error?.message ?? error)
      })
    );
    child.on(
      "close",
      (code) => finish(
        code === 0 ? { ok: true, detail: stdout.trim() || "git \u53EF\u7528" } : { ok: false, detail: `git --version \u9000\u51FA\u7801 ${code}` }
      )
    );
  });
}
async function readRemoteHead(repo, options = {}) {
  const url = /^https?:|^git@/.test(repo) ? repo : `https://github.com/${repo.replace(/\.git$/, "")}.git`;
  return await new Promise((resolve4) => {
    let settled = false;
    const finish = (facts) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve4(facts);
    };
    const child = spawn(
      options.gitPath ?? "git",
      ["ls-remote", "--symref", url, "HEAD"],
      {
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never",
          GIT_ASKPASS: ""
        },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    const timer = setTimeout(() => {
      child.kill();
      finish({ error: `git ls-remote \u8D85\u65F6\uFF08${options.timeoutMs ?? 15e3}ms\uFF09` });
    }, options.timeoutMs ?? 15e3);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      finish({
        error: error?.code === "ENOENT" ? "\u672C\u673A\u6CA1\u6709 git \u53EF\u6267\u884C\u6587\u4EF6" : String(error?.message ?? error)
      });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        finish({
          error: stderr.trim().split("\n").slice(-1)[0] || `git \u9000\u51FA\u7801 ${code}`
        });
        return;
      }
      const facts = parseLsRemote(stdout);
      if (!facts.commit) {
        finish({ error: "git \u6CA1\u6709\u8FD4\u56DE HEAD commit" });
        return;
      }
      finish(facts);
    });
  });
}

// src/ops/queue.ts
var OpQueue = class {
  constructor(runner, options = {}) {
    this.runner = runner;
    this.#maxLogLines = options.maxLogLines ?? 200;
    this.#now = options.now ?? Date.now;
    this.#idFactory = options.idFactory ?? (() => `op-${++this.#seq}-${this.#now()}`);
    this.#onFinish = options.onFinish;
  }
  #tasks = [];
  #running = null;
  #active = null;
  #idle = Promise.resolve();
  #maxLogLines;
  #now;
  #idFactory;
  #onFinish;
  #seq = 0;
  /** 入队并开始（若空闲）。返回任务对象供界面轮询。 */
  enqueue(input) {
    const task = {
      id: this.#idFactory(),
      kind: input.kind,
      target: input.target,
      status: "queued",
      log: [],
      queuedAt: this.#now(),
      ...input.spec !== void 0 ? { spec: input.spec } : {},
      ...input.specKind !== void 0 ? { specKind: input.specKind } : {},
      ...input.installSpec !== void 0 ? { installSpec: input.installSpec } : {},
      ...input.restoreSpec !== void 0 ? { restoreSpec: input.restoreSpec } : {},
      ...input.importSteps !== void 0 ? { importSteps: input.importSteps } : {},
      ...input.importCount !== void 0 ? { importCount: input.importCount } : {},
      ...input.importSnippetPath !== void 0 ? { importSnippetPath: input.importSnippetPath } : {},
      ...input.note !== void 0 ? { note: input.note } : {}
    };
    this.#tasks.push(task);
    this.#pump();
    return task;
  }
  /** 全部任务（含历史），按入队顺序。 */
  list() {
    return this.#tasks.map((task) => ({ ...task, log: [...task.log] }));
  }
  /** 当前运行中的任务 id（没有则 undefined）。 */
  activeId() {
    return this.#active?.id;
  }
  /** 队列是否为空且没有在跑的任务。 */
  isIdle() {
    return this.#active === null && this.#tasks.every((task) => task.status !== "queued");
  }
  /**
   * 等待队列排空（测试与关停用）。
   *
   * ⚠️ 不能只 `await this.#idle` 一次：`#idle` 是「当前那个任务」的 promise，
   * 它在任务结束、下一个任务已启动时就被替换了 —— 只等一次会在第 N 个任务
   * 完成时提前返回（本轮实测：三个任务的用例只看到前两个）。这里循环等到
   * **既没有运行中的任务、也没有排队中的任务**。
   */
  async drain() {
    let guard = 0;
    while (!this.isIdle()) {
      await this.#idle;
      if (++guard > 1e4) break;
    }
  }
  /**
   * 取消一个任务。
   *
   * 排队中的直接标取消；运行中的把请求转给运行器并等待其收尾 —— 调用方拿到的
   * `true` 表示「取消已被接受」，不代表文件改动已经还原（那由运行器保证）。
   */
  async cancel(id) {
    const task = this.#tasks.find((entry) => entry.id === id);
    if (!task) return false;
    if (task.status === "queued") {
      task.status = "cancelled";
      task.endedAt = this.#now();
      task.note = "\u6392\u961F\u65F6\u88AB\u53D6\u6D88";
      this.#onFinish?.(task);
      this.#pump();
      return true;
    }
    const running = this.#running;
    if (task.status !== "running" || !running || this.#active?.id !== id) return false;
    running.cancelled = true;
    task.note = "\u53D6\u6D88\u8BF7\u6C42\u5DF2\u53D1\u51FA\uFF0C\u7B49\u5F85\u6536\u5C3E";
    for (const handler of running.handlers.splice(0)) {
      try {
        await handler();
      } catch {
      }
    }
    return true;
  }
  #pump() {
    if (this.#active) return;
    const next = this.#tasks.find((task) => task.status === "queued");
    if (!next) return;
    this.#active = next;
    this.#idle = this.#run(next);
  }
  async #run(task) {
    const running = {
      cancelled: false,
      handlers: [],
      control: {
        onCancel: (handler) => {
          if (running.cancelled) void handler();
          else running.handlers.push(handler);
        },
        progress: (value, line) => {
          if (typeof value === "number") {
            const clamped = Math.max(0, Math.min(100, value));
            task.progress = typeof task.progress === "number" ? Math.max(task.progress, clamped) : clamped;
          }
          if (typeof line === "string" && line !== "") this.#pushLog(task, line);
        },
        log: (line) => this.#pushLog(task, line),
        get cancelled() {
          return running.cancelled;
        }
      }
    };
    this.#running = running;
    task.status = "running";
    task.startedAt = this.#now();
    let result;
    try {
      result = await this.runner(task, running.control);
    } catch (error) {
      result = {
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      };
    }
    if (running.cancelled && result.status !== "done" && result.status !== "restart-required")
      result = { ...result, status: "cancelled", note: result.note ?? "\u5DF2\u53D6\u6D88" };
    task.status = result.status;
    task.endedAt = this.#now();
    if (result.error) task.error = result.error;
    if (result.note) task.note = result.note;
    if (result.needsRestart) task.needsRestart = true;
    if (result.via) task.via = result.via;
    if (result.status === "done") task.progress = 100;
    this.#running = null;
    this.#active = null;
    this.#onFinish?.(task);
    this.#pump();
  }
  #pushLog(task, line) {
    for (const entry of line.split(/\r?\n/)) {
      const trimmed = entry.trim();
      if (trimmed === "") continue;
      task.log.push(trimmed);
    }
    if (task.log.length > this.#maxLogLines)
      task.log.splice(0, task.log.length - this.#maxLogLines);
  }
};

// src/ops/manager.ts
function normalizeOutcome(raw, fallbackTarget) {
  const application = raw?.application === "applied" || raw?.application === "restart-required" || raw?.application === "cancelled" || raw?.application === "failed" || raw?.application === "overridden" ? raw.application : void 0;
  const errorCode = typeof raw?.error?.code === "string" ? raw.error.code : void 0;
  const kind = typeof raw?.packageResult?.kind === "string" ? raw.packageResult.kind : void 0;
  const status = application === "applied" || application === "overridden" ? "done" : application === "restart-required" ? "restart" : application === "cancelled" ? "cancelled" : "failed";
  const outcome = {
    status,
    changed: raw?.changed === true,
    target: typeof raw?.target === "string" && raw.target !== "" ? raw.target : fallbackTarget,
    message: "",
    warnings: Array.isArray(raw?.warnings) ? raw.warnings.filter((item) => typeof item === "string") : []
  };
  if (application) outcome.application = application;
  if (typeof raw?.stage === "string") outcome.stage = raw.stage;
  if (typeof raw?.enabled === "boolean") outcome.enabled = raw.enabled;
  if (typeof raw?.restartReason === "string") outcome.restartReason = raw.restartReason;
  if (errorCode) outcome.errorCode = errorCode;
  if (typeof raw?.packageResult?.logPath === "string")
    outcome.logPath = raw.packageResult.logPath;
  if (Array.isArray(raw?.error?.incompatible)) outcome.incompatible = raw.error.incompatible;
  if (Array.isArray(raw?.pendingBuilds))
    outcome.pendingBuilds = raw.pendingBuilds.filter(
      (item) => typeof item === "string"
    );
  outcome.message = describeOutcome(outcome, {
    diagnostic: typeof raw?.error?.diagnostic === "string" ? raw.error.diagnostic : void 0,
    kind
  });
  return outcome;
}
function describeOutcome(outcome, extra = {}) {
  if (outcome.status === "done")
    return outcome.application === "overridden" ? "\u5DF2\u751F\u6548\uFF08\u8986\u76D6\u4E86\u540C id \u7684\u65E2\u6709\u6761\u76EE\uFF09" : "\u5DF2\u5B8C\u6210";
  if (outcome.status === "restart") {
    const why = {
      "no-hmr": "\u8BE5 profile \u672A\u5F00\u542F\u70ED\u91CD\u8F7D",
      "package-moved": "\u5305\u4F4D\u7F6E\u53D1\u751F\u4E86\u53D8\u5316",
      "host-module": "\u6D89\u53CA\u5BBF\u4E3B\u81EA\u5E26\u6A21\u5757",
      "unmanaged-plugin": "\u8BE5\u63D2\u4EF6\u4E0D\u7531\u63D2\u4EF6\u7BA1\u7406\u5668\u88C5\u8F7D",
      "module-comparison": "\u6A21\u5757\u89E3\u6790\u7ED3\u679C\u53D1\u751F\u53D8\u5316"
    };
    return "\u6539\u52A8\u5DF2\u843D\u76D8\uFF0C\u9700\u8981\u91CD\u542F DSH \u624D\u751F\u6548" + (outcome.restartReason ? `\uFF08${why[outcome.restartReason] ?? outcome.restartReason}\uFF09` : "");
  }
  if (outcome.status === "cancelled") return "\u5DF2\u53D6\u6D88\uFF08\u5BBF\u4E3B\u7684\u6587\u4EF6\u6539\u52A8\u5DF2\u8FD8\u539F\uFF09";
  const byCode = {
    "already-installed": "\u8FD9\u4E2A\u5305\u5DF2\u7ECF\u88C5\u8FC7\uFF1A\u70ED\u91CD\u8F7D\u4E0B\u5BBF\u4E3B\u4E0D\u80FD\u539F\u5730\u8986\u76D6\uFF0C\u9700\u8981\u5148\u5378\u8F7D\u518D\u5B89\u88C5",
    "incompatible-version": describeIncompatible(outcome),
    "not-removable": "\u5BBF\u4E3B\u4E0D\u5141\u8BB8\u79FB\u9664\u8FD9\u4E2A\u5305\uFF08\u5B83\u53EF\u80FD\u5728\u542F\u52A8\u65F6\u5C31\u88AB\u5360\u7528\uFF09",
    "not-bundle": "\u8FD9\u4E2A\u5305\u4E0D\u662F DSH \u63D2\u4EF6\uFF08\u6CA1\u6709 bundle patch\uFF09",
    "unknown-plugin": "\u5BBF\u4E3B\u4E0D\u8BA4\u8BC6\u8FD9\u4E2A\u540D\u5B57\uFF08\u53EF\u80FD\u4E0D\u5728\u5F53\u524D profile \u7684\u4F9D\u8D56\u6216 bundle \u5217\u8868\u91CC\uFF09",
    "invalid-spec": "\u5B89\u88C5\u5730\u5740\u4E0D\u5408\u6CD5",
    "ambiguous-install": "\u8FD9\u4E2A\u540D\u5B57\u5BF9\u5E94\u591A\u4E2A\u53EF\u5B89\u88C5\u76EE\u6807\uFF0C\u9700\u8981\u66F4\u5177\u4F53\u7684\u5730\u5740",
    "management-required": "\u9700\u8981\u7BA1\u7406\u6743\u9650\uFF08\u6216\u8BE5\u64CD\u4F5C\u4E0D\u5728\u5F53\u524D\u5141\u8BB8\u8303\u56F4\u5185\uFF09",
    "unaddressable": "\u65E0\u6CD5\u552F\u4E00\u5B9A\u4F4D\u8FD9\u4E2A\u6761\u76EE",
    "stop-profile": "\u9700\u8981\u5148\u505C\u6B62\u5F53\u524D profile",
    "bundle-in-use": "\u8BE5 bundle \u6B63\u5728\u4F7F\u7528\u4E2D",
    "stale-approval": "\u6279\u51C6\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u786E\u8BA4",
    "operation-error": "\u5BBF\u4E3B\u7684\u5305\u64CD\u4F5C\u5931\u8D25"
  };
  const byKind = {
    network: "\u7F51\u7EDC\u4E0D\u53EF\u8FBE\uFF08registry \u6216\u4ED3\u5E93\u53D6\u4E0D\u5230\uFF09",
    timeout: "\u62C9\u53D6\u8D85\u65F6",
    integrity: "\u4E0B\u8F7D\u5185\u5BB9\u6821\u9A8C\u5931\u8D25",
    "pnpm-missing": "\u627E\u4E0D\u5230 pnpm",
    "not-found": "registry / \u4ED3\u5E93\u91CC\u6CA1\u6709\u8FD9\u4E2A\u5305",
    "no-matching-version": "\u6CA1\u6709\u5339\u914D\u7684\u7248\u672C",
    "disk-full": "\u78C1\u76D8\u7A7A\u95F4\u4E0D\u8DB3",
    permission: "\u6CA1\u6709\u5199\u5165\u6743\u9650",
    "build-blocked": "pnpm \u62E6\u4E0B\u4E86\u6784\u5EFA\u811A\u672C\uFF1A\u9700\u8981\u5728 profile \u7684 pnpm-workspace.yaml \u7684 allowBuilds \u91CC\u653E\u884C\u8BE5\u5305\u540E\u91CD\u8BD5"
  };
  const diagnostic = extra.diagnostic;
  if (outcome.errorCode) {
    if (outcome.errorCode === "operation-error") {
      const kindText = extra.kind ? byKind[extra.kind] : void 0;
      if (diagnostic !== void 0 && diagnostic.trim() !== "")
        return describeDiagnostic(diagnostic, kindText ?? "\u5BBF\u4E3B\u7684\u5305\u64CD\u4F5C\u5931\u8D25");
      return kindText !== void 0 ? `${kindText}\uFF08\u5BBF\u4E3B\u6CA1\u6709\u7ED9\u51FA\u8BCA\u65AD\uFF0C\u8BF7\u67E5\u770B\u64CD\u4F5C\u65E5\u5FD7\uFF09` : "\u5BBF\u4E3B\u7684\u5305\u64CD\u4F5C\u5931\u8D25\uFF08\u5BBF\u4E3B\u6CA1\u6709\u7ED9\u51FA\u8BCA\u65AD\uFF0C\u8BF7\u67E5\u770B\u64CD\u4F5C\u65E5\u5FD7\uFF09";
    }
    const canned = byCode[outcome.errorCode];
    if (canned)
      return diagnostic !== void 0 && diagnostic.trim() !== "" ? `${canned}\uFF08${describeDiagnostic(diagnostic, "")}\uFF09` : canned;
  }
  if (extra.kind && byKind[extra.kind]) {
    const tail = diagnostic ? `\uFF08${truncate(diagnostic)}\uFF09` : "";
    return byKind[extra.kind] + tail;
  }
  if (!outcome.application && diagnostic === void 0)
    return "\u5BBF\u4E3B\u6CA1\u6709\u8FD4\u56DE\u7ED3\u679C\uFF08\u672A\u77E5\u72B6\u6001\uFF09\uFF0C\u8BF7\u67E5\u770B\u64CD\u4F5C\u65E5\u5FD7";
  return diagnostic ? describeDiagnostic(diagnostic, "") : "\u64CD\u4F5C\u5931\u8D25";
}
var DIAGNOSTIC_SIGNATURES = [
  [
    /ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER|isn't supported by any available resolver/i,
    "\u4EA4\u7ED9 pnpm \u7684\u5B89\u88C5\u5730\u5740\u88AB\u5F53\u6210\u5305\u540D\u4E86\uFF08\u7F3A `<\u5305\u540D>@` \u524D\u7F00\uFF09"
  ],
  [/ERR_PNPM_NO_MATCHING_VERSION|No matching version found/i, "\u6CA1\u6709\u5339\u914D\u7684\u7248\u672C"],
  [
    /ERR_PNPM_FETCH_404|ERR_PNPM_FETCH_401|404 Not Found|not in this registry/i,
    "registry / \u4ED3\u5E93\u91CC\u6CA1\u6709\u8FD9\u4E2A\u5305\u6216\u7248\u672C\uFF08\u6216\u6CA1\u6709\u6743\u9650\uFF09"
  ],
  [/ERR_PNPM_TARBALL_INTEGRITY/, "\u4E0B\u8F7D\u5185\u5BB9\u6821\u9A8C\u5931\u8D25"],
  [
    /ERR_PNPM_TARBALL_URL_MISMATCH/,
    "lockfile \u91CC\u7684 tarball \u5730\u5740\u4E0E\u5F53\u524D registry \u4E0D\u4E00\u81F4\uFF08\u6362\u8FC7 registry \u7684\u5305\u8981\u5148\u5378\u8F7D\u518D\u88C5\uFF09"
  ],
  [
    /ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED|ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/i,
    "pnpm \u62E6\u4E0B\u4E86\u6784\u5EFA\u811A\u672C\uFF1A\u9700\u8981\u5728 profile \u7684 pnpm-workspace.yaml \u7684 allowBuilds \u91CC\u653E\u884C\u8BE5\u5305\u540E\u91CD\u8BD5"
  ],
  [
    /Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/,
    "\u52A0\u8F7D\u8FD9\u4E2A\u63D2\u4EF6\u65F6\u627E\u4E0D\u5230\u5B83\u7684\u6A21\u5757\uFF1A\u5B83\u4F9D\u8D56\u7684\u5305\u591A\u534A\u5DF2\u7ECF\u4E0D\u5728\u4E86\uFF08\u5148\u91CD\u65B0\u5B89\u88C5\uFF0C\u518D\u542F\u7528\uFF09"
  ],
  [
    /ERR_PNPM_OUTDATED_LOCKFILE|frozen-lockfile/i,
    "lockfile \u4E0E package.json \u4E0D\u4E00\u81F4\uFF08`--frozen-lockfile` \u62D2\u7EDD\u4E86\u8FD9\u6B21\u6539\u52A8\uFF09"
  ],
  [
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|network failure/i,
    "\u7F51\u7EDC\u4E0D\u53EF\u8FBE\uFF08registry \u6216\u4ED3\u5E93\u53D6\u4E0D\u5230\uFF09"
  ],
  [/ENOSPC|no space left/i, "\u78C1\u76D8\u7A7A\u95F4\u4E0D\u8DB3"],
  [/EACCES|EPERM|permission denied/i, "\u6CA1\u6709\u5199\u5165\u6743\u9650"]
];
function describeDiagnostic(diagnostic, fallback) {
  const hit = DIAGNOSTIC_SIGNATURES.find(([pattern]) => pattern.test(diagnostic));
  const raw = truncate(diagnostic);
  if (hit) return `${hit[1]}\uFF1A${raw}`;
  return fallback === "" ? raw : `${fallback}\uFF1A${raw}`;
}
function describeIncompatible(outcome) {
  const first = outcome.incompatible?.[0];
  if (!first) return "\u7248\u672C\u4E0D\u517C\u5BB9\uFF08\u5BBF\u4E3B\u62D2\u7EDD\u4E86\u8FD9\u6B21\u5B89\u88C5\uFF09";
  const unmet = Object.entries(first.requirements ?? {}).map(([key, value]) => `${key} ${value}`).join("\u3001");
  return `${first.name}@${first.version} \u4E0E\u5F53\u524D DSH ${first.runtimeVersion} \u4E0D\u517C\u5BB9` + (unmet ? `\uFF08\u8981\u6C42 ${unmet}\uFF09` : "") + `\uFF1B\u5982\u786E\u8BA4\u8981\u88C5\uFF0C\u53EF\u6267\u884C dsh plugin allow-version ${first.name}@${first.version} --dsh-version ${first.runtimeVersion} --accept-risk`;
}
function truncate(text2, max = 160) {
  const clean2 = text2.replace(/\s+/g, " ").trim();
  return clean2.length > max ? clean2.slice(0, max) + "\u2026" : clean2;
}
async function readHostEntries(manager) {
  if (typeof manager.listPlugins !== "function") return void 0;
  try {
    const rows = await manager.listPlugins();
    if (!Array.isArray(rows)) return void 0;
    const out = [];
    for (const row of rows) {
      if (!row || typeof row.entryId !== "string" || typeof row.moduleName !== "string" || typeof row.enabled !== "boolean")
        continue;
      out.push({
        entryId: row.entryId,
        moduleName: row.moduleName,
        enabled: row.enabled,
        ...typeof row.readOnlyReason === "string" ? { readOnlyReason: row.readOnlyReason } : {}
      });
    }
    return out;
  } catch {
    return void 0;
  }
}
async function setEntryEnabledWithManager(manager, entryId, enabled) {
  if (typeof manager.setPluginEnabled !== "function") return "unsupported";
  try {
    return normalizeOutcome(await manager.setPluginEnabled(entryId, enabled), entryId);
  } catch (error) {
    return failure(entryId, error);
  }
}
async function installWithManager(manager, spec, options = {}) {
  try {
    const raw = await manager.installBundle(spec, options);
    return normalizeOutcome(raw, spec);
  } catch (error) {
    return failure(spec, error);
  }
}
async function removeWithManager(manager, name2) {
  try {
    return normalizeOutcome(await manager.removeBundle(name2), name2);
  } catch (error) {
    return failure(name2, error);
  }
}
async function setEnabledWithManager(manager, name2, enabled) {
  try {
    return normalizeOutcome(await manager.setBundleEnabled(name2, enabled), name2);
  } catch (error) {
    return failure(name2, error);
  }
}
function failure(target, error) {
  const text2 = error instanceof Error ? error.message : String(error);
  return {
    status: "failed",
    changed: false,
    target,
    message: truncate(text2),
    warnings: []
  };
}
function isAlreadyInstalled(outcome) {
  return outcome.errorCode === "already-installed";
}
function isIncompatible(outcome) {
  return outcome.errorCode === "incompatible-version";
}

// src/ops/subprocess.ts
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync as existsSync3 } from "node:fs";
import { dirname as dirname2, join as join5 } from "node:path";
var HOST_CLI_RELATIVE = [
  "resources",
  "app.asar",
  "dsh",
  "node_modules",
  "@deepseek-ai",
  "dsh-desktop-host",
  "lib",
  "cli.js"
];
function hostCliCandidates(execPath) {
  const out = [];
  let dir = dirname2(execPath);
  for (let depth = 0; depth < 4; depth++) {
    out.push(join5(dir, ...HOST_CLI_RELATIVE));
    const parent = dirname2(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}
function needsShell(command, platform = process.platform) {
  return platform === "win32" && /\.(cmd|bat)$/i.test(command);
}
function resolveDshCommand(options = {}) {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync3;
  const execPath = options.execPath ?? process.execPath;
  const override = env.PLUGIN_HARBOR_DSH;
  if (typeof override === "string" && override.trim() !== "") {
    const command = override.trim();
    return {
      command,
      prefixArgs: [],
      useShell: needsShell(command),
      source: "override"
    };
  }
  for (const candidate of hostCliCandidates(execPath)) {
    if (!exists(candidate)) continue;
    return {
      command: execPath,
      prefixArgs: ["--expose-internals", candidate],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      useShell: false,
      source: "host-cli"
    };
  }
  const probe = options.probePath ?? ((name2) => {
    const pathValue = env.PATH ?? env.Path ?? "";
    const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
    for (const dir of pathValue.split(process.platform === "win32" ? ";" : ":")) {
      if (dir.trim() === "") continue;
      for (const extension of extensions) {
        const candidate = join5(dir.trim(), name2 + extension.toLowerCase());
        if (exists(candidate)) return candidate;
      }
    }
    return void 0;
  });
  const found = probe("dsh");
  if (found) {
    return { command: found, prefixArgs: [], useShell: needsShell(found), source: "path" };
  }
  return void 0;
}
var defaultSpawn = (command, args, options) => nodeSpawn(command, args, options);
function estimateProgress(text2, current = 0) {
  const line = text2.replace(/\r/g, "\n");
  let value = current;
  const resolved = /Progress: resolved (\d+)/.exec(line);
  const handled = /(?:reused|downloaded|added) (\d+)/.exec(line);
  if (resolved) {
    const total = Number(resolved[1]);
    const done = handled ? Number(handled[1]) : 0;
    if (total > 0) {
      const ratio = done <= total ? done / total : 1;
      value = Math.max(value, 8 + Math.round(ratio * 22));
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
function classifyDshFailure(code, output, timedOut = false) {
  const text2 = output;
  if (timedOut) return { kind: "timeout", message: "\u547D\u4EE4\u8D85\u65F6\uFF0C\u5DF2\u7EC8\u6B62" };
  if (/ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED|ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/i.test(text2))
    return {
      kind: "build-blocked",
      message: "pnpm \u62E6\u4E0B\u4E86\u4F9D\u8D56\u7684\u6784\u5EFA\u811A\u672C\uFF1A\u9700\u8981\u5728 profile \u7684 pnpm-workspace.yaml \u91CC\u628A\u8BE5\u5305\u52A0\u5165 allowBuilds \u540E\u91CD\u8BD5"
    };
  if (/ERR_PNPM_TARBALL_URL_MISMATCH/.test(text2))
    return {
      kind: "tarball-mismatch",
      message: "lockfile \u91CC\u7684 tarball \u5730\u5740\u4E0E\u5F53\u524D registry \u4E0D\u4E00\u81F4\uFF08\u6362\u8FC7 registry \u7684\u5305\u9700\u8981\u5148\u5378\u8F7D\u518D\u88C5\uFF09"
    };
  if (/ERR_PNPM_FETCH_404|404 Not Found|not in this registry|No matching version/i.test(text2))
    return { kind: "not-found", message: "registry / \u4ED3\u5E93\u91CC\u6CA1\u6709\u8FD9\u4E2A\u5305\u6216\u7248\u672C" };
  if (/EACCES|EPERM|permission denied/i.test(text2))
    return { kind: "permission", message: "\u6CA1\u6709\u5199\u5165\u6743\u9650" };
  if (/ENOSPC|no space left/i.test(text2))
    return { kind: "disk-full", message: "\u78C1\u76D8\u7A7A\u95F4\u4E0D\u8DB3" };
  const lastLine = text2.split(/\r?\n/).map((item) => item.trim()).filter((item) => item !== "").slice(-1)[0] ?? "";
  return {
    kind: "unknown",
    message: lastLine === "" ? `\u547D\u4EE4\u5931\u8D25\uFF08\u9000\u51FA\u7801 ${code ?? "\u672A\u77E5"}\uFF09` : lastLine.slice(0, 200)
  };
}
async function runDshPlugin(options, hooks = {}) {
  const resolved = options.resolve ? options.resolve() : options.dshCommand ? {
    command: options.dshCommand,
    prefixArgs: options.dshPrefixArgs ?? [],
    ...options.env ? { env: options.env } : {},
    useShell: options.useShell ?? needsShell(options.dshCommand),
    source: "override"
  } : resolveDshCommand();
  if (!resolved) {
    return {
      code: null,
      output: "",
      timedOut: false,
      error: "\u627E\u4E0D\u5230 dsh \u547D\u4EE4",
      failure: {
        kind: "dsh-missing",
        message: "\u627E\u4E0D\u5230\u53EF\u7528\u7684 dsh \u547D\u4EE4\uFF1A\u5BBF\u4E3B CLI \u4E0D\u5728\u9884\u671F\u4F4D\u7F6E\uFF0CPATH \u4E0A\u4E5F\u6CA1\u6709 dsh\u3002\u53EF\u4EE5\u7528 PLUGIN_HARBOR_DSH \u6307\u5B9A\u53EF\u6267\u884C\u6587\u4EF6\u8DEF\u5F84\u3002"
      }
    };
  }
  const command = resolved.command;
  const shellArgs = [
    ...options.dshPrefixArgs ?? resolved.prefixArgs,
    "plugin",
    "--profile",
    options.profile,
    options.action,
    options.spec
  ];
  const childEnv = { ...resolved.env ?? {}, ...options.env ?? {} };
  const spawnImpl = options.spawn ?? defaultSpawn;
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1e3;
  return await new Promise((resolve4) => {
    let settled = false;
    let timedOut = false;
    let output = "";
    let progress = 0;
    let child = null;
    const killTree = () => {
      if (!child) return;
      const pid = child.pid;
      try {
        if (process.platform === "win32" && typeof pid === "number") {
          nodeSpawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore"
          }).on("error", () => child?.kill());
        } else {
          child.kill();
        }
      } catch {
        try {
          child.kill();
        } catch {
        }
      }
    };
    hooks.onCancel?.(killTree);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve4(result);
    };
    let timer;
    try {
      child = resolved.useShell ? spawnImpl(
        [command, ...shellArgs].map((part) => `"${part.replace(/"/g, '""')}"`).join(" "),
        [],
        {
          windowsHide: true,
          shell: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, ...childEnv }
        }
      ) : spawnImpl(command, shellArgs, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...childEnv }
      });
    } catch (error) {
      finish({
        code: null,
        output: "",
        timedOut: false,
        error: error instanceof Error ? error.message : String(error),
        failure: {
          kind: error?.code === "ENOENT" ? "dsh-missing" : "unknown",
          message: error?.code === "ENOENT" ? "\u627E\u4E0D\u5230 dsh \u547D\u4EE4\uFF1A\u8BF7\u786E\u8BA4\u5B83\u5728 PATH \u4E0A\uFF0C\u6216\u7528 PLUGIN_HARBOR_DSH \u6307\u5B9A\u8DEF\u5F84" : String(error)
        }
      });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    const absorb = (chunk) => {
      const text2 = String(chunk);
      output += text2;
      if (output.length > 2e5) output = output.slice(-1e5);
      hooks.chunk?.(text2);
      const lines = text2.split(/\r?\n/).filter((line) => line.trim() !== "");
      for (const line of lines) hooks.log?.(line.trim());
      progress = estimateProgress(text2, progress);
      hooks.progress?.(progress, lines.slice(-1)[0] ?? "");
    };
    child.stdout?.on("data", absorb);
    child.stderr?.on("data", absorb);
    child.on("error", (error) => {
      finish({
        code: null,
        output,
        timedOut: false,
        error: String(error?.message ?? error),
        failure: {
          kind: error?.code === "ENOENT" ? "dsh-missing" : "unknown",
          message: error?.code === "ENOENT" ? "\u627E\u4E0D\u5230 dsh \u547D\u4EE4\uFF1A\u8BF7\u786E\u8BA4\u5B83\u5728 PATH \u4E0A\uFF0C\u6216\u7528 PLUGIN_HARBOR_DSH \u6307\u5B9A\u8DEF\u5F84" : String(error?.message ?? error)
        }
      });
    });
    child.on("close", (code) => {
      const failure2 = code === 0 && !timedOut ? void 0 : classifyDshFailure(code, output, timedOut);
      finish({
        code,
        output,
        timedOut,
        ...failure2 ? { failure: failure2 } : {}
      });
    });
  });
}

// src/ops/execute.ts
var SUBPROCESS_RETRY_CODES = /* @__PURE__ */ new Set(["already-installed", "not-bundle"]);
var REMOVE_REFUSED_CODES = /* @__PURE__ */ new Set([
  "not-removable",
  "stop-profile",
  "bundle-in-use",
  "unaddressable",
  "unknown-plugin"
]);
async function executeTask(task, control, deps) {
  const log = deps.log ? (message) => {
    control.log(message);
    deps.log?.(message);
  } : (message) => control.log(message);
  switch (task.kind) {
    case "install":
      return await doInstall(task, control, deps, log);
    case "update":
      return await doUpdate(task, control, deps, log);
    case "remove":
      return await doRemove(task, control, deps, log);
    case "enable":
    case "disable":
      return await doSetEnabled(task, control, deps, log);
    case "reload":
      return await doReload(task, control, deps, log);
    case "import":
      return await doImport(task, control, deps, log);
  }
}
async function doInstall(task, control, deps, log) {
  const spec = task.spec ?? task.target;
  if (deps.manager) {
    const requestId = requestIdOf(task, deps);
    const outcome = await installWithManager(deps.manager, spec, {
      enabled: true,
      requestId,
      ...deps.registry ? { registry: deps.registry } : {}
    });
    control.progress(outcome.status === "done" ? 100 : void 0, outcome.message);
    if (outcome.status === "done" || outcome.status === "restart")
      return fromManager(outcome);
    if (outcome.errorCode && SUBPROCESS_RETRY_CODES.has(outcome.errorCode)) {
      log(`\u5BBF\u4E3B\u62D2\u7EDD\u4E86\u8FD9\u6B21\u5B89\u88C5\uFF08${outcome.errorCode}\uFF09\uFF0C\u6539\u7528\u5B50\u8FDB\u7A0B dsh plugin add`);
      return await viaSubprocess(task, control, deps, "add", spec);
    }
    if (isIncompatible(outcome))
      return { ...fromManager(outcome), error: outcome.message };
    return { ...fromManager(outcome), error: outcome.message };
  }
  log("\u5BBF\u4E3B\u672A\u63D0\u4F9B pluginManager \u670D\u52A1\uFF0C\u6539\u7528\u5B50\u8FDB\u7A0B dsh plugin add");
  return await viaSubprocess(task, control, deps, "add", spec);
}
async function doUpdate(task, control, deps, log) {
  const name2 = task.target;
  const recorded = task.spec ?? "";
  const spec = installSpecOf(task, deps);
  const restoreSpec = task.restoreSpec ?? latestSpec(task.specKind, recorded, name2, deps.profileDir);
  if (!deps.manager) {
    log("\u5BBF\u4E3B\u672A\u63D0\u4F9B pluginManager \u670D\u52A1\uFF0C\u6539\u7528\u5B50\u8FDB\u7A0B\u539F\u5730\u8986\u76D6\u5B89\u88C5");
    return await viaSubprocess(task, control, deps, "add", spec);
  }
  control.progress(5, "\u5148\u5378\u8F7D\u5DF2\u88C5\u7248\u672C");
  const removed = await removeWithManager(deps.manager, name2);
  if (removed.status === "failed" && !REMOVE_REFUSED_CODES.has(removed.errorCode ?? "")) {
    return { ...fromManager(removed), error: removed.message };
  }
  if (removed.status === "failed") {
    log(`\u5BBF\u4E3B\u4E0D\u5141\u8BB8\u5148\u5378\u8F7D\uFF08${removed.errorCode}\uFF09\uFF0C\u6539\u7528\u5B50\u8FDB\u7A0B\u539F\u5730\u8986\u76D6`);
    return await viaSubprocess(task, control, deps, "add", spec);
  }
  control.progress(40, "\u5DF2\u5378\u8F7D\uFF0C\u5F00\u59CB\u5B89\u88C5\u65B0\u7248\u672C");
  const installed = await installWithManager(deps.manager, spec, {
    enabled: true,
    requestId: requestIdOf(task, deps),
    ...deps.registry ? { registry: deps.registry } : {}
  });
  const mapped = fromManager(installed);
  if (mapped.status === "done")
    return {
      ...mapped,
      note: `\u5DF2\u5378\u8F7D\u65E7\u7248\u672C\u5E76\u5B89\u88C5\u65B0\u7248\u672C\uFF1A${spec}\uFF08\u5BBF\u4E3B\u5DF2\u70ED\u52A0\u8F7D\uFF0C\u65E0\u9700\u91CD\u542F\uFF09`
    };
  if (mapped.status === "restart-required")
    return {
      ...mapped,
      // 宿主给的 restartReason 要说出来（包位置变化 / 涉及宿主模块 / 未开热重载…）
      note: `\u5DF2\u5378\u8F7D\u65E7\u7248\u672C\u5E76\u5B89\u88C5\u65B0\u7248\u672C\uFF1B${mapped.note ?? "\u9700\u8981\u91CD\u542F DSH \u624D\u751F\u6548"}`
    };
  if (mapped.status === "cancelled")
    return {
      ...mapped,
      // 取消发生在「已卸载」之后：不能假装 profile 没事，也不能背着用户装回去。
      note: `\u5DF2\u53D6\u6D88\uFF1A\u65E7\u7248\u672C\u5DF2\u7ECF\u5378\u8F7D\uFF0C\u65B0\u7248\u672C\u6CA1\u6709\u88C5\u4E0A\uFF0C${name2} \u73B0\u5728\u4E0D\u5728 profile \u7684\u4F9D\u8D56\u91CC\uFF1B\u8BF7\u91CD\u65B0\u5B89\u88C5`,
      error: `\u5DF2\u53D6\u6D88\uFF1A\u65E7\u7248\u672C\u5DF2\u7ECF\u5378\u8F7D\uFF0C\u65B0\u7248\u672C\u6CA1\u6709\u88C5\u4E0A\uFF0C${name2} \u73B0\u5728\u4E0D\u5728 profile \u7684\u4F9D\u8D56\u91CC\uFF1B\u8BF7\u91CD\u65B0\u5B89\u88C5`
    };
  const rolled = await rollbackUpdate(task, control, deps, log, restoreSpec);
  return { ...mapped, error: `${mapped.error ?? "\u66F4\u65B0\u5931\u8D25"}${rolled}` };
}
async function rollbackUpdate(task, control, deps, log, restoreSpec) {
  const name2 = task.target;
  if (!deps.manager) return "\uFF1B\u4F9D\u8D56\u5DF2\u4ECE profile \u79FB\u9664\uFF0C\u8BF7\u91CD\u65B0\u5B89\u88C5";
  log(`\u65B0\u7248\u672C\u6CA1\u88C5\u4E0A\uFF0C\u6309\u539F\u5730\u5740\u88C5\u56DE ${restoreSpec}`);
  control.progress(45, "\u56DE\u6EDA\uFF1A\u88C5\u56DE\u539F\u7248\u672C");
  const back = await installWithManager(deps.manager, restoreSpec, {
    enabled: true,
    requestId: requestIdOf(task, deps, ":rollback"),
    ...deps.registry ? { registry: deps.registry } : {}
  });
  if (back.status === "done" || back.status === "restart")
    return `\uFF1B\u5DF2\u6309\u539F\u5730\u5740\u628A ${name2} \u88C5\u56DE\uFF08profile \u6062\u590D\u539F\u72B6\uFF09\uFF0C\u91CD\u542F\u540E\u4ECD\u662F\u539F\u6765\u7684\u7248\u672C`;
  return `\uFF1B\u56DE\u6EDA\u4E5F\u6CA1\u6210\u529F\uFF08${back.message}\uFF09\uFF1A${name2} \u73B0\u5728\u4E0D\u5728 profile \u7684\u4F9D\u8D56\u91CC\uFF0C\u8BF7\u91CD\u65B0\u5B89\u88C5`;
}
function installSpecOf(task, deps) {
  const prepared = task.installSpec?.trim();
  if (prepared !== void 0 && prepared !== "") return prepared;
  return latestSpec(task.specKind, task.spec ?? "", task.target, deps.profileDir);
}
async function doImport(task, control, deps, log) {
  const steps = task.importSteps ?? [];
  if (steps.length === 0)
    return { status: "done", via: "manager", note: "\u8FD9\u6B21\u5BFC\u5165\u6CA1\u6709\u9700\u8981\u6267\u884C\u7684\u6B65\u9AA4" };
  if (!deps.manager)
    return {
      status: "failed",
      error: "\u5BFC\u5165\u9700\u8981\u5BBF\u4E3B pluginManager \u670D\u52A1\uFF08\u5B50\u8FDB\u7A0B\u6539\u4E0D\u4E86\u542F\u7528\u72B6\u6001\u4E0E\u6761\u76EE\u5F00\u5173\uFF09\uFF1B\u8BF7\u91CD\u542F DSH \u540E\u91CD\u8BD5"
    };
  const outcome = await runImportSteps(task, control, deps, log, steps);
  control.progress(100, outcome.note);
  log(outcome.note ?? outcome.error ?? "\u5BFC\u5165\u7ED3\u675F");
  return outcome;
}
async function runImportSteps(task, control, deps, log, steps) {
  const manager = deps.manager;
  const tally = {
    installed: 0,
    changed: 0,
    same: 0,
    blocked: 0,
    failed: [],
    needsRestart: false,
    cancelled: false
  };
  for (const [index, step] of steps.entries()) {
    if (control.cancelled) {
      tally.cancelled = true;
      log(`\u5DF2\u53D6\u6D88\uFF1A\u7B2C ${index + 1}/${steps.length} \u6B65\u4E4B\u540E\u6CA1\u6709\u518D\u52A8 profile`);
      break;
    }
    const at = Math.round(index / steps.length * 95);
    control.progress(at, `${index + 1}/${steps.length} ${step.name}\uFF1A${stepLabel(step.action)}`);
    if (step.action === "skip") {
      tally.same += 1;
      log(`\u8DF3\u8FC7 ${step.name}\uFF1A${step.reason ?? "\u5DF2\u4E00\u81F4"}`);
      continue;
    }
    if (step.action === "blocked") {
      tally.blocked += 1;
      log(`\u65E0\u6CD5\u5904\u7406 ${step.name}\uFF1A${step.reason ?? "\u672C\u673A\u73AF\u5883\u4E0D\u6EE1\u8DB3"}`);
      continue;
    }
    const requestId = requestIdOf(task, deps, `:${index}`);
    if (step.action === "install") {
      const result2 = await installWithManager(manager, step.spec ?? step.name, {
        enabled: step.enabled !== false,
        requestId,
        ...deps.registry ? { registry: deps.registry } : {}
      });
      if (result2.status === "done") {
        tally.installed += 1;
        log(`\u5DF2\u5B89\u88C5 ${step.name}\uFF08${step.spec ?? step.name}\uFF09`);
        continue;
      }
      if (result2.status === "restart") {
        tally.installed += 1;
        tally.needsRestart = true;
        log(`\u5DF2\u5B89\u88C5 ${step.name}\uFF08${step.spec ?? step.name}\uFF09\uFF1A${result2.message}`);
        continue;
      }
      if (isAlreadyInstalled(result2)) {
        tally.same += 1;
        log(`${step.name} \u5DF2\u7ECF\u88C5\u8FC7\uFF0C\u8DF3\u8FC7`);
        continue;
      }
      tally.failed.push(`${step.name} \u5B89\u88C5\u5931\u8D25\uFF1A${result2.message}`);
      log(`\u5B89\u88C5\u5931\u8D25 ${step.name}\uFF1A${result2.message}`);
      continue;
    }
    if (step.action === "entries") {
      let changed = 0;
      for (const entry of step.entries ?? []) {
        const result2 = await setEntryEnabledWithManager(manager, entry.entryId, entry.enabled);
        if (result2 === "unsupported") {
          tally.failed.push(`${step.name} \u7684\u6761\u76EE\u5F00\u5173\uFF1A\u5BBF\u4E3B\u6CA1\u6709 setPluginEnabled \u63A5\u53E3`);
          log(`\u6761\u76EE\u5F00\u5173\u5931\u8D25 ${entry.entryId}\uFF1A\u5BBF\u4E3B\u6CA1\u6709 setPluginEnabled \u63A5\u53E3`);
          continue;
        }
        if (result2.status === "done" || result2.status === "restart") {
          changed += 1;
          if (result2.status === "restart") tally.needsRestart = true;
          log(`\u6761\u76EE ${entry.entryId} \u2192 ${entry.enabled ? "\u542F\u7528" : "\u505C\u7528"}\uFF1A${result2.message}`);
          continue;
        }
        tally.failed.push(`${step.name} \u7684\u6761\u76EE ${entry.entryId}\uFF1A${result2.message}`);
        log(`\u6761\u76EE\u5F00\u5173\u5931\u8D25 ${entry.entryId}\uFF1A${result2.message}`);
      }
      if (changed > 0) tally.changed += 1;
      else tally.same += 1;
      continue;
    }
    const wanted = step.action === "enable";
    const result = await setEnabledWithManager(manager, step.name, wanted);
    if (result.status === "done" || result.status === "restart") {
      tally.changed += 1;
      if (result.status === "restart") tally.needsRestart = true;
      log(`${wanted ? "\u5DF2\u542F\u7528" : "\u5DF2\u505C\u7528"} ${step.name}\uFF1A${result.message}`);
      continue;
    }
    tally.failed.push(`${step.name} ${wanted ? "\u542F\u7528" : "\u505C\u7528"}\u5931\u8D25\uFF1A${result.message}`);
    log(`${wanted ? "\u542F\u7528" : "\u505C\u7528"}\u5931\u8D25 ${step.name}\uFF1A${result.message}`);
  }
  const total = steps.length;
  const manual = task.importSnippetPath === void 0 ? "" : `\uFF1B\u5E26 config \u7684\u8865\u4E01\u7247\u6BB5\u5DF2\u5199\u5230 ${task.importSnippetPath}\uFF0C\u9700\u8981\u4F60\u786E\u8BA4\u540E\u81EA\u884C\u7C98\u8D34\u5230 profile \u7684 cordis.patch.yml\uFF08\u5BBF\u4E3B\u6CA1\u6709\u5199 config \u7684\u63A5\u53E3\uFF09`;
  const summary = `\u5BFC\u5165\u5B8C\u6210\uFF1A${tally.installed} \u9879\u5B89\u88C5\u3001${tally.changed} \u9879\u6539\u72B6\u6001\u3001${tally.same} \u9879\u5DF2\u4E00\u81F4` + (tally.blocked > 0 ? `\u3001${tally.blocked} \u9879\u65E0\u6CD5\u5904\u7406` : "") + (tally.failed.length > 0 ? `\u3001${tally.failed.length} \u9879\u5931\u8D25` : "") + `\uFF08\u5171 ${total} \u9879\uFF09` + manual;
  if (tally.failed.length > 0)
    return {
      status: "failed",
      via: "manager",
      note: summary,
      error: `${summary}\uFF1B\u9996\u4E2A\u5931\u8D25\uFF1A${tally.failed[0]}`
    };
  if (tally.cancelled)
    return {
      status: "cancelled",
      via: "manager",
      note: `\u5DF2\u53D6\u6D88\uFF1A${summary}`,
      error: `\u5DF2\u53D6\u6D88\uFF1A${summary}`
    };
  if (tally.needsRestart)
    return {
      status: "restart-required",
      via: "manager",
      needsRestart: true,
      note: summary + "\uFF1B\u5176\u4E2D\u4E00\u6B65\u5BBF\u4E3B\u62A5\u544A\u9700\u8981\u91CD\u542F DSH"
    };
  return {
    status: "done",
    via: "manager",
    note: summary + (tally.blocked > 0 ? "\uFF1B\u65E0\u6CD5\u5904\u7406\u7684\u9879\u5DF2\u6309\u539F\u6837\u4FDD\u7559\uFF0C\u8BF7\u6309\u63D0\u793A\u8865\u9F50\u540E\u518D\u5BFC\u5165\u4E00\u6B21" : "\uFF08\u90FD\u662F\u5BBF\u4E3B\u539F\u5730\u751F\u6548\uFF0C\u65E0\u9700\u91CD\u542F\uFF09")
  };
}
function stepLabel(action) {
  switch (action) {
    case "install":
      return "\u5B89\u88C5";
    case "enable":
      return "\u542F\u7528";
    case "disable":
      return "\u505C\u7528";
    case "entries":
      return "\u6062\u590D\u6761\u76EE\u5F00\u5173";
    case "skip":
      return "\u5DF2\u4E00\u81F4";
    case "blocked":
      return "\u65E0\u6CD5\u5904\u7406";
  }
}
async function doReload(task, control, deps, log) {
  if (!deps.manager) {
    return {
      status: "failed",
      error: "\u5BBF\u4E3B\u672A\u63D0\u4F9B pluginManager \u670D\u52A1\uFF0C\u65E0\u6CD5\u70ED\u91CD\u8F7D\uFF08\u5B50\u8FDB\u7A0B\u6539\u4E0D\u4E86\u8FD0\u884C\u4E2D\u7684\u5BBF\u4E3B\uFF09\uFF1B\u8BF7\u91CD\u542F DSH \u540E\u91CD\u8BD5"
    };
  }
  const outcome = await setEnabledWithManager(deps.manager, task.target, true);
  control.progress(outcome.status === "done" ? 100 : void 0, outcome.message);
  log(outcome.message);
  if (outcome.status === "done")
    return {
      ...fromManager(outcome),
      note: "\u5DF2\u6309\u78C1\u76D8\u4E0A\u7684\u5F53\u524D\u4EE3\u7801\u91CD\u65B0\u7EC4\u5408\u5E76\u70ED\u52A0\u8F7D\uFF08\u65E0\u9700\u91CD\u542F DSH\uFF09"
    };
  if (outcome.status === "restart") return fromManager(outcome);
  return { ...fromManager(outcome), error: outcome.message };
}
async function doRemove(task, control, deps, log) {
  if (deps.manager) {
    const outcome = await removeWithManager(deps.manager, task.target);
    control.progress(outcome.status === "done" ? 100 : void 0, outcome.message);
    if (outcome.status === "done" || outcome.status === "restart")
      return fromManager(outcome);
    if (outcome.errorCode === "not-bundle" || outcome.errorCode === "unknown-plugin") {
      log(`\u5BBF\u4E3B\u65E0\u6CD5\u5904\u7406\uFF08${outcome.errorCode}\uFF09\uFF0C\u6539\u7528\u5B50\u8FDB\u7A0B dsh plugin remove`);
      return await viaSubprocess(task, control, deps, "remove", task.target);
    }
    return { ...fromManager(outcome), error: outcome.message };
  }
  log("\u5BBF\u4E3B\u672A\u63D0\u4F9B pluginManager \u670D\u52A1\uFF0C\u6539\u7528\u5B50\u8FDB\u7A0B dsh plugin remove");
  return await viaSubprocess(task, control, deps, "remove", task.target);
}
async function doSetEnabled(task, control, deps, log) {
  const enabled = task.kind === "enable";
  if (!deps.manager) {
    return {
      status: "failed",
      error: "\u5BBF\u4E3B\u672A\u63D0\u4F9B pluginManager \u670D\u52A1\uFF0C\u65E0\u6CD5\u542F\u505C\u63D2\u4EF6\uFF08\u5B50\u8FDB\u7A0B\u6539\u4E0D\u4E86\u542F\u7528\u72B6\u6001\uFF09\uFF1B\u8BF7\u91CD\u542F DSH \u8BA9\u670D\u52A1\u5C31\u7EEA\u540E\u91CD\u8BD5"
    };
  }
  const outcome = await setEnabledWithManager(deps.manager, task.target, enabled);
  control.progress(outcome.status === "done" ? 100 : void 0, outcome.message);
  log(outcome.message);
  if (outcome.status === "done" || outcome.status === "restart") return fromManager(outcome);
  const missing = enabled && deps.dependencyPresent !== void 0 && !deps.dependencyPresent(task.target);
  const message = missing ? `${outcome.message}\uFF1B${task.target} \u5DF2\u7ECF\u4E0D\u5728 profile \u7684 dependencies \u91CC\uFF08\u591A\u534A\u662F\u4E0A\u4E00\u6B21\u5931\u8D25\u7684\u66F4\u65B0\u628A\u5B83\u5220\u6389\u4E86\uFF09\uFF0C\u5BBF\u4E3B\u65E0\u6CD5\u5728\u7F3A\u4F9D\u8D56\u65F6\u542F\u7528\u5B83 \u2014\u2014 \u8BF7\u5728\u5E02\u573A\u9875\u91CD\u65B0\u5B89\u88C5` : outcome.message;
  return { ...fromManager(outcome), error: message, note: message };
}
async function viaSubprocess(task, control, deps, action, spec) {
  const run = deps.runDsh ?? runDshPlugin;
  const result = await run(
    {
      profile: deps.profileName,
      action,
      spec,
      ...deps.spawn ? { spawn: deps.spawn } : {},
      ...deps.dshCommand ? { dshCommand: deps.dshCommand } : {},
      ...deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}
    },
    {
      log: (line) => control.log(line),
      progress: (value, line) => control.progress(value, line),
      onCancel: (handler) => control.onCancel(handler)
    }
  );
  if (result.code === 0 && !result.timedOut) {
    return {
      status: "restart-required",
      needsRestart: true,
      via: "subprocess",
      note: "\u5DF2\u901A\u8FC7 dsh plugin \u5B8C\u6210\uFF1B\u6539\u52A8\u5728\u4E0B\u6B21\u542F\u52A8 DSH \u65F6\u751F\u6548\uFF08\u82E5\u63D2\u4EF6\u672A\u51FA\u73B0\u5728\u5DF2\u542F\u7528\u5217\u8868\uFF0C\u8BF7\u5728\u5BBF\u4E3B\u63D2\u4EF6\u9875\u542F\u7528\uFF09"
    };
  }
  if (control.cancelled)
    return { status: "cancelled", via: "subprocess", note: "\u5DF2\u53D6\u6D88\uFF08\u5B50\u8FDB\u7A0B\u5DF2\u7EC8\u6B62\uFF09" };
  const failure2 = result.failure;
  return {
    status: "failed",
    via: "subprocess",
    error: failure2?.message ?? result.error ?? `dsh plugin ${action} \u5931\u8D25\uFF08\u9000\u51FA\u7801 ${result.code ?? "\u672A\u77E5"}\uFF09`
  };
}
function requestIdOf(task, deps, suffix = "") {
  const base = deps.requestIdFor ? deps.requestIdFor(task) : `plugin-harbor:${task.id}`;
  if (suffix !== "") return `${base}${suffix}`;
  task.requestId = base;
  return base;
}
function fromManager(outcome) {
  const status = outcome.status === "done" ? "done" : outcome.status === "restart" ? "restart-required" : outcome.status === "cancelled" ? "cancelled" : "failed";
  const result = {
    status,
    via: "manager",
    ...outcome.status === "restart" ? { needsRestart: true } : {},
    note: outcome.message,
    managerOutcome: outcome
  };
  if (outcome.logPath) result.note = `${outcome.message}\uFF08\u65E5\u5FD7\uFF1A${outcome.logPath}\uFF09`;
  if (status === "failed") result.error = result.note;
  return result;
}

// src/ops/watch.ts
import { existsSync as existsSync4, realpathSync, watch } from "node:fs";
import { join as join6 } from "node:path";
function shouldWatch(packageDir, env = process.env, exists = existsSync4) {
  if (env.PLUGIN_HARBOR_HOT_RELOAD === "0") return false;
  if (!exists(join6(packageDir, "src", "index.ts"))) return false;
  return exists(join6(packageDir, "dist"));
}
function watchDist(options) {
  const { dir, onChange, filter, logger = console } = options;
  const debounceMs = options.debounceMs ?? 700;
  let timer;
  let stopped = false;
  let watcher;
  let target = dir;
  try {
    target = realpathSync(dir);
  } catch {
  }
  try {
    watcher = watch(target, { recursive: true });
  } catch (error) {
    logger.warn?.(`plugin-harbor: \u65E0\u6CD5\u76D1\u89C6 ${target}\uFF08${error?.message ?? error}\uFF09`);
    return () => {
    };
  }
  const schedule = (_event, filename) => {
    if (stopped) return;
    if (filename !== null && filter !== void 0) {
      if (!filter(String(filename).replaceAll("\\", "/"))) return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = void 0;
      if (!stopped) onChange();
    }, debounceMs);
    timer.unref?.();
  };
  watcher.on("change", schedule);
  watcher.on("rename", schedule);
  watcher.on(
    "error",
    (error) => logger.warn?.(`plugin-harbor: \u76D1\u89C6\u5668\u9519\u8BEF\uFF08${error?.message ?? error}\uFF09`)
  );
  watcher.unref?.();
  return () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    timer = void 0;
    try {
      watcher.close();
    } catch {
    }
  };
}

// src/ops/validate.ts
var NAME = /^[A-Za-z0-9@][A-Za-z0-9@/._-]*$/;
var SPEC = /^[A-Za-z0-9@.][A-Za-z0-9@/._~:+#=^%\\-]*$/;
var CONTROL = /[\u0000-\u001f\u007f\s]/;
function validateName(input) {
  if (typeof input !== "string") return { ok: false, reason: "\u5305\u540D\u5FC5\u987B\u662F\u5B57\u7B26\u4E32" };
  const name2 = input.trim();
  if (name2 === "") return { ok: false, reason: "\u5305\u540D\u4E0D\u80FD\u4E3A\u7A7A" };
  if (name2.length > 214) return { ok: false, reason: "\u5305\u540D\u8FC7\u957F\uFF08>214\uFF09" };
  if (CONTROL.test(name2)) return { ok: false, reason: "\u5305\u540D\u542B\u7A7A\u767D\u6216\u63A7\u5236\u5B57\u7B26" };
  if (name2.startsWith("-") || !NAME.test(name2))
    return { ok: false, reason: `\u5305\u540D\u4E0D\u5408\u6CD5\uFF1A${name2}` };
  return { ok: true, value: name2 };
}
function validateSpec(input) {
  if (typeof input !== "string") return { ok: false, reason: "\u5B89\u88C5\u5730\u5740\u5FC5\u987B\u662F\u5B57\u7B26\u4E32" };
  const spec = input.trim();
  if (spec === "") return { ok: false, reason: "\u5B89\u88C5\u5730\u5740\u4E0D\u80FD\u4E3A\u7A7A" };
  if (spec.length > 300) return { ok: false, reason: "\u5B89\u88C5\u5730\u5740\u8FC7\u957F\uFF08>300\uFF09" };
  if (CONTROL.test(spec)) return { ok: false, reason: "\u5B89\u88C5\u5730\u5740\u542B\u7A7A\u767D\u6216\u63A7\u5236\u5B57\u7B26" };
  if (spec.startsWith("-")) return { ok: false, reason: "\u5B89\u88C5\u5730\u5740\u4E0D\u80FD\u4EE5 `-` \u5F00\u5934" };
  if (/^[\^~*]/.test(spec))
    return { ok: false, reason: "\u5B89\u88C5\u5730\u5740\u7F3A\u5C11\u5305\u540D\uFF1A\u4E0D\u80FD\u4EE5\u7248\u672C\u8303\u56F4\u5F00\u5934" };
  if (!SPEC.test(spec)) return { ok: false, reason: `\u5B89\u88C5\u5730\u5740\u542B\u975E\u6CD5\u5B57\u7B26\uFF1A${spec}` };
  return { ok: true, value: spec };
}
function requireConfirm(input) {
  return input === true ? { ok: true, value: "confirmed" } : { ok: false, reason: "\u8FD9\u4E2A\u64CD\u4F5C\u9700\u8981\u786E\u8BA4\uFF08\u754C\u9762\u4F1A\u5F39\u786E\u8BA4\u6846\uFF09" };
}
function validateTaskId(input) {
  if (typeof input !== "string") return { ok: false, reason: "\u4EFB\u52A1 id \u5FC5\u987B\u662F\u5B57\u7B26\u4E32" };
  const id = input.trim();
  if (id === "" || id.length > 120 || CONTROL.test(id))
    return { ok: false, reason: "\u4EFB\u52A1 id \u4E0D\u5408\u6CD5" };
  return { ok: true, value: id };
}

// src/index.ts
var name = "plugin-harbor";
var VERSION = "0.1.0-alpha.1";
var BUILD = true ? "11e857d03cf4" : "dev";
var SITE_BASE = process.env.PLUGIN_HARBOR_SITE ?? "https://dsh-plugin.org";
var API_BASE = process.env.PLUGIN_HARBOR_API ?? "https://api.dsh-plugin.org";
var DEFAULT_REGISTRY2 = process.env.PLUGIN_HARBOR_REGISTRY ?? "";
var DETAIL_TTL_MS = 24 * 3600 * 1e3;
var CHECK_TTL_MS = 10 * 60 * 1e3;
var SELF_RELOAD_DELAY_MS = 600;
function realpathOf(path) {
  try {
    return realpathSync2(path);
  } catch {
    return void 0;
  }
}
function selfPackageName(profileDir, entries, moduleDir = dirname3(dirname3(fileURLToPath(import.meta.url)))) {
  const here = realpathOf(moduleDir);
  if (here === void 0) return void 0;
  for (const entry of entries) {
    const local = /^(file|link):(.*)$/s.exec(entry.spec.trim());
    const candidates = [];
    if (local) {
      const target = local[2].replace(/^~(?=$|[\\/])/, () => homedir4());
      candidates.push(resolve3(profileDir, target));
    }
    candidates.push(join7(profileDir, "node_modules", entry.name));
    for (const candidate of candidates)
      if (realpathOf(candidate) === here) return entry.name;
  }
  return void 0;
}
var handlers = {
  status: async (_payload, rpc) => ({
    plugin: name,
    version: VERSION,
    build: BUILD,
    profile: rpc.profile.name,
    dataDir: rpc.profile.dataDir,
    dbPath: rpc.profile.dbPath,
    store: await rpc.store.call("ping"),
    hot: rpc.hot()
  }),
  /**
   * 目录状态。读不到就说读不到：`totalCount` 为 null 时不填 0，
   * `error` 透传上次同步的失败原因（AGENTS.md：不用默认值填充）。
   */
  "catalog.status": async (_payload, rpc) => {
    const counts = await rpc.store.call("catalog.counts", { lang: "zh" });
    return {
      rows: counts?.rows ?? 0,
      chunks: counts?.chunks ?? 0,
      totalCount: counts?.totalCount ?? null,
      lastSyncAt: counts?.lastSyncAt ?? null,
      error: counts?.lastError ?? null,
      syncing: rpc.syncing(),
      curatedOrphans: counts?.curatedOrphans ?? 0,
      milestone: "M1"
    };
  },
  "catalog.list": async (payload, rpc) => rpc.store.call("catalog.list", { query: payload ?? {} }),
  /**
   * 已装清单：profile 事实（清单/lockfile/node_modules）+ 目录信息 + 缓存的更新结论。
   *
   * ⚠️ 这里**不出网**：更新结论来自 `updates.check` 写下的缓存；缓存缺失时
   * `update` 为 undefined（界面显示「未检查」），而不是当场去查。
   */
  "installed.list": async (_payload, rpc) => {
    const plugins = readInstalledPlugins(rpc.profile.dir);
    if (plugins.length === 0) return [];
    const repos = plugins.map((plugin) => plugin.repo).filter((repo) => typeof repo === "string");
    const [catalog, details, checks] = await Promise.all([
      rpc.store.call("catalog.rowsByRepo", { repos }),
      rpc.store.call(
        "catalog.getDetails",
        { repos }
      ),
      rpc.store.call("installed.getChecks")
    ]);
    const byRepo = new Map((catalog?.rows ?? []).map((row) => [row.repo, row]));
    const detailByRepo = new Map(details?.details ?? []);
    const checkByName = new Map((checks?.checks ?? []).map((check) => [check.name, check]));
    return plugins.map((plugin) => {
      const row = { ...plugin };
      const catalogRow = plugin.repo ? byRepo.get(plugin.repo) : void 0;
      if (catalogRow) {
        row.displayName = catalogRow.displayName;
        row.category = catalogRow.category;
        row.stars = catalogRow.stars;
        if (typeof catalogRow.slug === "string") row.slug = catalogRow.slug;
        if (typeof catalogRow.owner === "string") row.owner = catalogRow.owner;
      }
      const detail = plugin.repo ? detailByRepo.get(plugin.repo)?.record : void 0;
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
  }
  /**
   * 更新与详情页都要按本 profile 的设置（registry / siteBase / locale）出网，
   * 因此它们与 `settings.*`、`catalog.refresh`、`diagnostics.run` 一起放在
   * apply 作用域里（见下面的 runtimeHandlers）。
   */
};
async function apply(ctx) {
  const profile = resolveProfile(ctx);
  const store = new CatalogStore({
    workerPath: fileURLToPath(new URL("./catalog-worker.js", import.meta.url)),
    dbPath: profile.dbPath
  });
  const log = (message) => ctx?.logger?.info?.(`plugin-harbor: ${message}`);
  const loaded = readSettingsFile(profile.dataDir);
  let settings = loaded.settings;
  const settingNotes = [...loaded.notes];
  for (const note of settingNotes) log("\u8BBE\u7F6E\uFF1A" + note);
  let manager;
  const checkUpdates = async (target, only) => {
    const plugins = readInstalledPlugins(profile.dir);
    const selected = only === void 0 ? plugins : plugins.filter((plugin) => only.includes(plugin.name));
    if (selected.length === 0) return [];
    const checks = await checkPlugins(selected, {
      now: () => Date.now(),
      concurrency: 4,
      registry: (packageName) => fetchRegistryFacts(packageName, {
        ...settings.registry !== "" ? { registry: settings.registry } : {}
      }),
      git: (repo) => readRemoteHead(repo)
    });
    await target.call("installed.putChecks", { checks });
    return checks;
  };
  const appendNote = (note, extra) => note === void 0 || note === "" ? extra : `${note}${/[；;]\s*$/.test(note) ? "" : "\uFF1B"}${extra}`;
  const describeCheck = (check) => {
    if (!check) return "\u6CA1\u6709\u62FF\u5230\u590D\u67E5\u7ED3\u8BBA";
    if (check.updateAvailable === true) {
      const latest = check.latestVersion ?? check.latestCommit?.slice(0, 7) ?? "\u672A\u77E5";
      return `\u4ECD\u53EF\u66F4\u65B0\uFF08\u6700\u65B0 ${latest}\uFF09`;
    }
    if (check.updateAvailable === false) {
      const current = check.installedVersion ?? check.installedCommit?.slice(0, 7) ?? "\u5F53\u524D\u7248\u672C";
      return `\u5DF2\u662F\u6700\u65B0\uFF08${current}\uFF09`;
    }
    const why = check.error ?? check.note ?? "\u6CA1\u6709\u53EF\u6BD4\u5BF9\u7684\u8FDC\u7AEF";
    return `\u672A\u5224\u5B9A\uFF08${why}\uFF09`;
  };
  const queue = new OpQueue(
    async (task, control) => {
      const result = await executeTask(task, control, {
        profileName: profile.name,
        profileDir: profile.dir,
        ...manager ? { manager } : {},
        runDsh: runDshPlugin,
        log,
        // 只在失败解释时调用：读一次当前依赖列表，判断「启用」是不是根本没依赖可启用。
        dependencyPresent: (name2) => readInstalledPlugins(profile.dir).some((plugin) => plugin.name === name2),
        ...settings.registry !== "" ? { registry: settings.registry } : {}
      });
      if (task.kind !== "update") return result;
      const present = readInstalledPlugins(profile.dir).some(
        (plugin) => plugin.name === task.target
      );
      if (!present) {
        control.log("\u66F4\u65B0\u540E\u590D\u67E5\uFF1A\u63D2\u4EF6\u5DF2\u4E0D\u5728 profile \u7684\u4F9D\u8D56\u91CC\uFF0C\u8DF3\u8FC7");
        return result;
      }
      try {
        control.progress(100, "\u590D\u67E5\u66F4\u65B0\u72B6\u6001");
        const [check] = await checkUpdates(store, [task.target]);
        const sentence = describeCheck(check);
        control.log(`\u66F4\u65B0\u540E\u590D\u67E5 ${task.target}\uFF1A${sentence}`);
        return { ...result, note: appendNote(result.note, `\u66F4\u65B0\u540E\u5DF2\u590D\u67E5\uFF1A${sentence}`) };
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        control.log(`\u66F4\u65B0\u540E\u590D\u67E5\u5931\u8D25\uFF1A${why}`);
        return { ...result, note: appendNote(result.note, `\u66F4\u65B0\u540E\u590D\u67E5\u5931\u8D25\uFF1A${why}`) };
      }
    },
    {
      onFinish: (task) => {
        void store.call("op.putOp", { task }).catch(() => {
        });
      }
    }
  );
  const uploadsDir = () => join7(profile.dataDir, "exports");
  const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
  const resolveExportPath = (input) => {
    if (typeof input !== "string") throw Error("\u5BFC\u5165\u6587\u4EF6\u8DEF\u5F84\u5FC5\u987B\u662F\u5B57\u7B26\u4E32");
    const raw = input.trim();
    if (raw === "") throw Error("\u5BFC\u5165\u6587\u4EF6\u8DEF\u5F84\u4E0D\u80FD\u4E3A\u7A7A");
    if (raw.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw))
      throw Error("\u5BFC\u5165\u6587\u4EF6\u8DEF\u5F84\u4E0D\u5408\u6CD5\uFF08\u542B\u63A7\u5236\u5B57\u7B26\u6216\u8FC7\u957F\uFF09");
    return isAbsolute2(raw) ? raw : join7(uploadsDir(), raw);
  };
  const saveUploaded = (payload) => {
    const raw = payload?.content;
    if (typeof raw !== "string") throw Error("\u4E0A\u4F20\u5185\u5BB9\u5FC5\u987B\u662F\u5B57\u7B26\u4E32");
    const text2 = raw;
    if (text2.trim() === "") throw Error("\u8FD9\u4E2A\u6587\u4EF6\u662F\u7A7A\u7684");
    const bytes = Buffer.byteLength(text2, "utf8");
    if (bytes > MAX_EXPORT_BYTES)
      throw Error(`\u6587\u4EF6\u6709 ${bytes} \u5B57\u8282\uFF0C\u8D85\u8FC7 ${MAX_EXPORT_BYTES} \u4E0A\u9650\uFF1A\u4E0D\u662F\u63D2\u4EF6\u6E2F\u6E7E\u7684\u5BFC\u51FA\u6587\u4EF6\uFF1F`);
    const parsed = readExport(text2);
    if (parsed.bundle === void 0) throw Error(`\u8FD9\u4E2A\u6587\u4EF6\u4E0D\u80FD\u4F5C\u4E3A\u5BFC\u5165\u6E90\uFF1A${parsed.error}`);
    const base = typeof payload?.name === "string" ? payload.name : "";
    const suffix = base.replace(/^.*[\\/]/, "").replace(/\.json$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 80);
    const stamp = exportFileName(profile.name, Date.now()).replace(/\.json$/, "");
    const name2 = suffix === "" ? `${stamp}.json` : `${stamp}-${suffix}.json`;
    const path = join7(uploadsDir(), name2);
    mkdirSync2(dirname3(path), { recursive: true });
    writeFileSync2(path, text2, "utf8");
    log(`\u5BFC\u5165\u6587\u4EF6\u5DF2\u5B58\u5165 ${path}\uFF08${bytes} \u5B57\u8282\uFF09`);
    return { name: name2, path, bytes };
  };
  const loadExport = (path) => {
    let stats;
    try {
      stats = statSync2(path);
    } catch {
      throw Error("\u8BFB\u4E0D\u5230\u8FD9\u4E2A\u6587\u4EF6\uFF1A" + path);
    }
    if (!stats.isFile()) throw Error("\u8FD9\u4E0D\u662F\u4E00\u4E2A\u6587\u4EF6\uFF1A" + path);
    if (stats.size > MAX_EXPORT_BYTES)
      throw Error(`\u6587\u4EF6\u6709 ${stats.size} \u5B57\u8282\uFF0C\u8D85\u8FC7 ${MAX_EXPORT_BYTES} \u4E0A\u9650\uFF1A\u4E0D\u662F\u63D2\u4EF6\u6E2F\u6E7E\u7684\u5BFC\u51FA\u6587\u4EF6\uFF1F`);
    const parsed = readExport(readFileSync4(path, "utf8"));
    if (parsed.bundle === void 0)
      throw Error(`\u8FD9\u4E2A\u6587\u4EF6\u4E0D\u80FD\u4F5C\u4E3A\u5BFC\u5165\u6E90\uFF1A${parsed.error}`);
    return { bundle: parsed.bundle, source: path };
  };
  const countSteps = (steps) => {
    const counts = { install: 0, enable: 0, disable: 0, entries: 0, skip: 0, blocked: 0 };
    for (const step of steps ?? []) counts[step.action] += 1;
    return counts;
  };
  const describePlanCounts = (counts) => `\u8BA1\u5212\uFF1A\u5B89\u88C5 ${counts.install}\u3001\u542F\u7528 ${counts.enable}\u3001\u505C\u7528 ${counts.disable}\u3001\u6062\u590D\u6761\u76EE\u5F00\u5173 ${counts.entries}\u3001\u5DF2\u4E00\u81F4 ${counts.skip}\u3001\u65E0\u6CD5\u5904\u7406 ${counts.blocked}`;
  const opHandlers = {
    /** 当前设置 + 读取时的修正说明（界面要能看见「哪一项被退回了默认值」）。 */
    "settings.get": async () => ({
      ...settings,
      notes: settingNotes
    }),
    /**
     * 修改设置。非法值**报错**（不替用户改写意图）；合法则原子写盘并即刻生效。
     */
    "settings.set": async (payload) => {
      const { settings: next, problems } = applySettingsPatch(settings, payload ?? {});
      if (problems.length > 0) throw Error(problems.join("\uFF1B"));
      writeSettingsFile(profile.dataDir, next);
      settings = next;
      settingNotes.length = 0;
      log(
        `\u8BBE\u7F6E\u5DF2\u66F4\u65B0\uFF1Alocale=${next.locale} syncTtlMs=${next.syncTtlMs} siteBase=${next.siteBase} registry=${next.registry === "" ? "(\u9ED8\u8BA4)" : next.registry}`
      );
      return { ...next, notes: [] };
    },
    /** 强制同步：同一时刻只允许一次，重复请求复用同一次运行的结果。 */
    "catalog.refresh": async () => await rpc.refresh(),
    /**
     * 检查更新：registry（`dist-tags.latest`）/ git（lockfile commit vs 远端 HEAD）。
     *
     * 判不了的一律 `updateAvailable: null` + 原因，绝不当成「已最新」。
     */
    "updates.check": async (_payload, rpcContext) => {
      const checks = await checkUpdates(rpcContext.store);
      const fresh = checks.filter((check) => check.updateAvailable === true).length;
      log(`\u66F4\u65B0\u68C0\u67E5\u5B8C\u6210\uFF1A${checks.length} \u4E2A\u5DF2\u88C5\u63D2\u4EF6\uFF0C\u5176\u4E2D ${fresh} \u4E2A\u6709\u65B0\u7248\u672C`);
      return checks;
    },
    /**
     * 按需拉一个插件的详情页（站点精确版本 / 安装命令 / dshTarget），带 24h 缓存。
     * 目录列表里没有这些字段，只有详情页有。
     */
    "plugin.detail": async (payload, rpcContext) => {
      const repo = String(payload?.repo ?? "");
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw Error("Invalid repo: " + repo);
      const cached = await rpcContext.store.call("catalog.getDetails", { repos: [repo] });
      const hit = cached?.details?.find(([key]) => key === repo)?.[1];
      if (hit && Date.now() - hit.at < DETAIL_TTL_MS)
        return hit.record;
      const record = await fetchDetail(
        { fetch: fetchText, siteBase: settings.siteBase, locale: settings.locale },
        repo
      );
      if (!record) return null;
      await rpcContext.store.call("catalog.putDetail", { repo, record });
      return record;
    },
    /**
     * 连通性诊断：**只读**，且只在用户点「运行诊断」时跑（其中几项要出网）。
     */
    "diagnostics.run": async (_payload, rpcContext) => await runDiagnostics({
      fetch: fetchText,
      gitVersion: () => readGitVersion(),
      storePing: () => rpcContext.store.call("ping"),
      counts: () => rpcContext.store.call("catalog.counts", { lang: settings.locale }),
      settings,
      hot: () => rpcContext.hot(),
      now: () => Date.now()
    }),
    "op.install": async (payload) => {
      const spec = validateSpec(payload?.spec);
      if (!spec.ok) throw Error(spec.reason);
      const confirmed = requireConfirm(payload?.confirm);
      if (!confirmed.ok) throw Error(confirmed.reason);
      return queue.enqueue({ kind: "install", target: spec.value, spec: spec.value });
    },
    "op.update": async (payload, rpcContext) => {
      const name2 = validateName(payload?.name);
      if (!name2.ok) throw Error(name2.reason);
      const confirmed = requireConfirm(payload?.confirm);
      if (!confirmed.ok) throw Error(confirmed.reason);
      const installed = readInstalledPlugins(profile.dir).find(
        (plugin) => plugin.name === name2.value
      );
      if (!installed)
        throw Error("\u8FD9\u4E2A\u63D2\u4EF6\u4E0D\u5728\u5F53\u524D profile \u7684\u5DF2\u88C5\u5217\u8868\u91CC\uFF1A" + name2.value);
      const checks = await rpcContext.store.call(
        "installed.getChecks"
      );
      const check = (checks?.checks ?? []).find((item) => item.name === installed.name);
      const target = check?.latestVersion;
      const installSpec = installSpecFor(
        installed,
        profile.dir,
        typeof target === "string" && target !== "" ? target : void 0
      );
      const verified = validateSpec(installSpec);
      if (!verified.ok)
        throw Error(`\u65E0\u6CD5\u4ECE\u5DF2\u88C5\u4E8B\u5B9E\u7EC4\u88C5\u5B89\u88C5\u5730\u5740\uFF1A${verified.reason}\uFF08\u8BB0\u5F55\u503C ${redactSpec(installed.spec)}\uFF09`);
      return queue.enqueue({
        kind: "update",
        target: installed.name,
        // 记录值只作展示与回滚依据；凭据不进操作历史。
        spec: redactSpec(installed.spec),
        installSpec: verified.value,
        restoreSpec: installSpecFor(installed, profile.dir),
        specKind: installed.kind
      });
    },
    "op.remove": async (payload) => {
      const name2 = validateName(payload?.name);
      if (!name2.ok) throw Error(name2.reason);
      const confirmed = requireConfirm(payload?.confirm);
      if (!confirmed.ok) throw Error(confirmed.reason);
      return queue.enqueue({ kind: "remove", target: name2.value });
    },
    "op.setEnabled": async (payload) => {
      const name2 = validateName(payload?.name);
      if (!name2.ok) throw Error(name2.reason);
      if (typeof payload?.enabled !== "boolean")
        throw Error("enabled \u5FC5\u987B\u662F\u5E03\u5C14\u503C");
      const confirmed = requireConfirm(payload?.confirm);
      if (!confirmed.ok) throw Error(confirmed.reason);
      return queue.enqueue({
        kind: payload.enabled ? "enable" : "disable",
        target: name2.value
      });
    },
    /**
     * 热重载：让宿主按**磁盘上当前的代码**重新组合并加载这个插件，无需重启。
     *
     * 典型用途：本插件或任何 `link:` 包重建了 `dist/` 之后，把新代码换进运行中的宿主。
     * 只对**当前已启用**的插件开放 —— 重载不改启用状态（要改请用启停）。
     */
    "op.reload": async (payload, rpcContext) => {
      const name2 = validateName(payload?.name);
      if (!name2.ok) throw Error(name2.reason);
      const confirmed = requireConfirm(payload?.confirm);
      if (!confirmed.ok) throw Error(confirmed.reason);
      const plugins = readInstalledPlugins(profile.dir);
      const installed = plugins.find((plugin) => plugin.name === name2.value);
      if (!installed)
        throw Error("\u8FD9\u4E2A\u63D2\u4EF6\u4E0D\u5728\u5F53\u524D profile \u7684\u5DF2\u88C5\u5217\u8868\u91CC\uFF1A" + name2.value);
      if (!installed.selected)
        throw Error(
          `${installed.name} \u5F53\u524D\u662F\u505C\u7528\u72B6\u6001\uFF1A\u70ED\u91CD\u8F7D\u53EA\u91CD\u65B0\u7EC4\u5408\u5DF2\u542F\u7528\u7684\u63D2\u4EF6\uFF0C\u4E0D\u4F1A\u66FF\u4F60\u6539\u542F\u7528\u72B6\u6001\uFF08\u8BF7\u5148\u542F\u7528\uFF09`
        );
      const self = selfPackageName(
        profile.dir,
        plugins.map((plugin) => ({ name: plugin.name, spec: plugin.spec }))
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
    "export.list": async () => {
      const dir = uploadsDir();
      if (!existsSync5(dir)) return [];
      const out = [];
      for (const name2 of readdirSync2(dir).sort().reverse()) {
        if (!name2.endsWith(".json")) continue;
        const path = join7(dir, name2);
        try {
          const stats = statSync2(path);
          if (!stats.isFile()) continue;
          out.push({ name: name2, path, bytes: stats.size, at: stats.mtimeMs });
        } catch {
          continue;
        }
      }
      return out;
    },
    "export.run": async (payload) => {
      const confirmed = requireConfirm(payload?.confirm);
      if (!confirmed.ok) throw Error(confirmed.reason);
      const includeData = payload?.includeData === true;
      const plugins = readInstalledPlugins(profile.dir);
      const entries = manager ? await readHostEntries(manager) : void 0;
      const now = Date.now();
      const bundle = buildExport({
        profileName: profile.name,
        profileDir: profile.dir,
        pluginVersion: VERSION,
        plugins,
        settings,
        ...entries === void 0 ? {} : { entries },
        includeData,
        selfDirName: "plugin-harbor",
        now
      });
      const name2 = exportFileName(profile.name, now);
      const path = join7(uploadsDir(), name2);
      mkdirSync2(dirname3(path), { recursive: true });
      writeFileSync2(path, serializeExport(bundle), "utf8");
      const bytes = statSync2(path).size;
      log(`\u5BFC\u51FA ${plugins.length} \u4E2A\u63D2\u4EF6 \u2192 ${path}\uFF08${bytes} \u5B57\u8282\uFF09`);
      return {
        name: name2,
        path,
        bytes,
        plugins: bundle.plugins.length,
        files: bundle.plugins.reduce((sum, plugin) => sum + (plugin.files?.length ?? 0), 0),
        omissions: bundle.omissions,
        warnings: bundle.warnings
      };
    },
    /** 把界面选中的文件收进来，返回可直接用于预检/导入的路径。 */
    "import.upload": async (payload) => saveUploaded(payload),
    /** 预检：**不写任何东西**，只把计划与需要人工粘贴的片段算出来给界面看。 */
    "import.preview": async (payload) => {
      const { bundle, source } = loadExport(resolveExportPath(payload?.path));
      const entries = manager ? await readHostEntries(manager) : void 0;
      const plan = planImport({
        source,
        bundle,
        profileName: profile.name,
        profileDir: profile.dir,
        installed: readInstalledPlugins(profile.dir),
        settings,
        ...entries === void 0 ? {} : { entries }
      });
      const snippet = patchSnippet(bundle, profile.name);
      return { plan, ...snippet === void 0 ? {} : { snippet } };
    },
    /**
     * 导入：把**服务端**算好的计划交给队列逐步执行。
     *
     * ⚠️ 客户端只给文件路径与确认，不提供计划内容；每个安装地址都再过一次
     * `validateSpec`（与手动安装同一道闸）。
     */
    "op.import": async (payload) => {
      const confirmed = requireConfirm(payload?.confirm);
      if (!confirmed.ok) throw Error(confirmed.reason);
      const path = resolveExportPath(payload?.path);
      const { bundle, source } = loadExport(path);
      const entries = manager ? await readHostEntries(manager) : void 0;
      const plan = planImport({
        source,
        bundle,
        profileName: profile.name,
        profileDir: profile.dir,
        installed: readInstalledPlugins(profile.dir),
        settings,
        ...entries === void 0 ? {} : { entries }
      });
      const steps = [];
      for (const step of plan.steps) {
        if (step.action === "install") {
          const checked = validateSpec(step.spec);
          if (!checked.ok) throw Error(`\u5BFC\u5165\u5730\u5740\u4E0D\u5408\u6CD5\uFF08${step.name}\uFF09\uFF1A${checked.reason}`);
          steps.push({ ...step, spec: checked.value });
          continue;
        }
        steps.push(step);
      }
      let snippetPath;
      const snippet = patchSnippet(bundle, profile.name);
      if (snippet !== void 0) {
        snippetPath = join7(uploadsDir(), `${exportFileName(profile.name, Date.now()).replace(/\.json$/, "")}-patch.yml`);
        mkdirSync2(dirname3(snippetPath), { recursive: true });
        writeFileSync2(snippetPath, snippet, "utf8");
        log(`\u5BFC\u5165\u7684\u914D\u7F6E\u7247\u6BB5\u5DF2\u5199\u5230 ${snippetPath}\uFF08\u9700\u8981\u4EBA\u5DE5\u7C98\u8D34\uFF0C\u5BBF\u4E3B\u6CA1\u6709\u5199 config \u7684\u63A5\u53E3\uFF09`);
      }
      const counts = countSteps(steps);
      return queue.enqueue({
        kind: "import",
        target: path,
        importSteps: steps,
        importCount: plan.steps.length,
        ...snippetPath === void 0 ? {} : { importSnippetPath: snippetPath },
        note: describePlanCounts(counts)
      });
    },
    /** 运行中的队列 + 跨重启的历史（历史来自 `ops` 表）。 */
    "op.list": async (_payload, rpcContext) => {
      const history = await rpcContext.store.call(
        "op.listOps",
        { limit: 50 }
      );
      return {
        active: queue.activeId() ?? null,
        tasks: queue.list(),
        history: history?.tasks ?? []
      };
    },
    "op.cancel": async (payload) => {
      const id = validateTaskId(payload?.id);
      if (!id.ok) throw Error(id.reason);
      return { cancelled: await queue.cancel(id.value) };
    }
  };
  async function deferSelfReload(target, rpcContext, managerOf, logLine) {
    const hot = rpcContext.hot();
    const now = Date.now();
    const note = hot ? "\u5DF2\u8BF7\u6C42\u5BBF\u4E3B\u70ED\u91CD\u8F7D\u672C\u63D2\u4EF6\uFF1A\u6B63\u5728\u7528\u78C1\u76D8\u4E0A\u7684\u65B0\u4EE3\u7801\u66FF\u6362\u8FD0\u884C\u4E2D\u7684\u5B9E\u4F8B\uFF0C\u9762\u677F\u4F1A\u91CD\u65B0\u8FDE\u63A5\uFF08\u754C\u9762\u82E5\u6CA1\u6709\u81EA\u52A8\u66F4\u65B0\uFF0C\u5237\u65B0\u4E00\u6B21\u9875\u9762\u5373\u53EF\uFF09" : "\u672C profile \u672A\u542F\u7528\u70ED\u91CD\u8F7D\uFF08\u5BBF\u4E3B\u6CA1\u6709 hmr \u670D\u52A1\uFF09\uFF1A\u672C\u63D2\u4EF6\u7684\u65B0\u4EE3\u7801\u8981\u7B49\u4E0B\u6B21\u542F\u52A8 DSH \u624D\u751F\u6548";
    const task = {
      id: `reload-self-${now}`,
      kind: "reload",
      target,
      status: hot ? "done" : "restart-required",
      ...hot ? {} : { needsRestart: true },
      note,
      log: [note],
      queuedAt: now,
      endedAt: now
    };
    await rpcContext.store.call("op.putOp", { task }).catch(() => {
    });
    if (!hot) return task;
    setTimeout(() => {
      void (async () => {
        const current = managerOf();
        if (!current) {
          logLine("\u81EA\u70ED\u91CD\u8F7D\uFF1A\u5BBF\u4E3B pluginManager \u670D\u52A1\u5DF2\u4E0D\u5728\uFF0C\u8DF3\u8FC7");
          return;
        }
        try {
          const outcome = await setEnabledWithManager(current, target, true);
          logLine(`\u81EA\u70ED\u91CD\u8F7D\uFF1A${outcome.message}`);
          if (outcome.status === "failed")
            await rpcContext.store.call("op.putOp", {
              task: {
                ...task,
                status: "failed",
                error: outcome.message,
                note: outcome.message,
                endedAt: Date.now()
              }
            }).catch(() => {
            });
        } catch (error) {
          logLine(`\u81EA\u70ED\u91CD\u8F7D\u5931\u8D25\uFF1A${error instanceof Error ? error.message : error}`);
        }
      })();
    }, SELF_RELOAD_DELAY_MS);
    return task;
  }
  const dispatch = createDispatcher({ ...handlers, ...opHandlers });
  let running = null;
  const rpc = {
    profile,
    store,
    log: (message) => ctx?.logger?.info?.(`plugin-harbor: ${message}`),
    syncing: () => running !== null,
    /**
     * 热重载能力：宿主上下文里有 `hmr` 服务就说明变更能原地生效（桌面启动器会启用
     * `dsh-base` 的 `hmr` 条目）。**晚绑定**，所以每次调用现读，不缓存。
     */
    hot: () => ctx?.get?.("hmr") !== void 0,
    refresh: () => {
      if (running) return running;
      running = syncCatalog({
        fetch: fetchText,
        store,
        log: (message) => ctx?.logger?.info?.(`plugin-harbor: ${message}`),
        now: () => Date.now(),
        siteBase: SITE_BASE,
        apiBase: API_BASE,
        locale: "zh"
      }).catch((error) => {
        rpc.log(`\u540C\u6B65\u5931\u8D25\uFF1A${error instanceof Error ? error.message : error}`);
        throw error;
      }).finally(() => {
        running = null;
      });
      return running;
    }
  };
  const mount = () => {
    const connection = ctx.get?.("connection");
    if (!connection?.fetch?.register) return;
    return connection.fetch.register({
      path: RPC_PATH,
      methods: ["POST"],
      requestBody: "buffered",
      async fetch(request) {
        const respond = (rpcId, result) => Response.json({ type: "server-response", rpcId, result });
        try {
          if (request.method !== "POST")
            return new Response("method not allowed", { status: 405 });
          if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
            return new Response("JSON required", { status: 415 });
          const parsed = readEnvelope(await request.json());
          if (!parsed.ok)
            return respond(parsed.rpcId, {
              ok: false,
              error: {
                code: "plugin-harbor/invalid-envelope",
                message: parsed.reason,
                details: {}
              }
            });
          const outcome = await dispatch(
            parsed.envelope.method,
            parsed.envelope.payload,
            rpc
          );
          return respond(
            parsed.envelope.rpcId,
            outcome.ok ? { ok: true, value: outcome.value } : { ok: false, error: { ...outcome.error, details: {} } }
          );
        } catch (error) {
          return respond("invalid", {
            ok: false,
            error: {
              code: "plugin-harbor/error",
              message: redact(error),
              details: {}
            }
          });
        }
      }
    });
  };
  if (ctx?.inject) ctx.inject(["connection"], mount);
  else mount();
  const mountManager = () => {
    const service = ctx.get?.("pluginManager");
    if (!service) return;
    manager = service;
    log("\u5BBF\u4E3B pluginManager \u670D\u52A1\u5DF2\u5C31\u7EEA\uFF1A\u53D8\u66F4\u64CD\u4F5C\u4F18\u5148\u8D70\u5BBF\u4E3B\u6D41\u6C34\u7EBF");
  };
  if (ctx?.inject) ctx.inject(["pluginManager"], mountManager);
  else mountManager();
  let stopped = false;
  let stopWatch;
  const packageDir = dirname3(dirname3(fileURLToPath(import.meta.url)));
  if (shouldWatch(packageDir)) {
    const distDir = join7(packageDir, "dist");
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
        log("\u81EA\u52A8\u91CD\u8F7D\uFF1A\u5BBF\u4E3B pluginManager \u670D\u52A1\u8FD8\u6CA1\u5C31\u7EEA\uFF0C\u8DF3\u8FC7\u8FD9\u6B21");
        return;
      }
      if (ctx.get?.("hmr") === void 0) {
        log("\u81EA\u52A8\u91CD\u8F7D\uFF1A\u672C profile \u6CA1\u6709 hmr \u670D\u52A1\uFF08\u5BBF\u4E3B\u8981\u91CD\u542F\u624D\u751F\u6548\uFF09\uFF0C\u8DF3\u8FC7");
        return;
      }
      reloading = true;
      log("\u81EA\u52A8\u91CD\u8F7D\uFF1A\u68C0\u6D4B\u5230 dist \u53D8\u5316\uFF0C\u8BF7\u6C42\u5BBF\u4E3B\u6309\u78C1\u76D8\u4E0A\u7684\u65B0\u4EE3\u7801\u91CD\u65B0\u7EC4\u5408\u672C\u63D2\u4EF6");
      void setEnabledWithManager(current, name, true).then((outcome) => {
        log(`\u81EA\u52A8\u91CD\u8F7D\uFF1A${outcome.message}`);
        if (outcome.status === "failed")
          log(`\u81EA\u52A8\u91CD\u8F7D\u5931\u8D25\uFF1A${outcome.message}\uFF08\u53EF\u70B9\u300C\u70ED\u91CD\u8F7D\u300D\u6309\u94AE\u91CD\u8BD5\uFF0C\u6216\u91CD\u542F DSH\uFF09`);
      }).catch(
        (error) => log(`\u81EA\u52A8\u91CD\u8F7D\u5F02\u5E38\uFF1A${error instanceof Error ? error.message : error}`)
      ).finally(() => {
        reloading = false;
        if (!queued) return;
        queued = false;
        reloadFromDisk();
      });
    };
    stopWatch = watchDist({
      dir: distDir,
      // 只认宿主侧产物：`client.js` 是浏览器入口，改它不需要重新组合宿主
      filter: (file) => file === "index.js" || file === "catalog-worker.js" || file.endsWith("/index.js") || file.endsWith("/catalog-worker.js"),
      onChange: reloadFromDisk,
      logger: { info: log, warn: log }
    });
    log(`\u81EA\u52A8\u91CD\u8F7D\u5DF2\u542F\u7528\uFF1A\u76D1\u89C6 ${distDir}\uFF08PLUGIN_HARBOR_HOT_RELOAD=0 \u53EF\u5173\u95ED\uFF09`);
    if (typeof ctx.effect === "function") ctx.effect(() => stopWatch);
  }
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    stopWatch?.();
    stopWatch = void 0;
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
    rpcVersion: RPC_VERSION
  });
}
export {
  BUILD,
  VERSION,
  apply,
  name,
  selfPackageName
};
