/**
 * 导出 / 导入的回归（全部离线，夹具是临时目录里的假 profile）。
 *
 * 重点钉死三件事：
 *  1. **不静默少东西**：没进导出的每一项都要在 omissions 里带原因；
 *  2. **不泄凭据**：疑似凭据的字段/取值一律替换成 [已脱敏]；
 *  3. **导入只增不删**，并且算出的每一步都能照做（安装地址、启用/停用、条目开关、阻塞原因）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPORT_FORMAT,
  buildExport,
  declaredRowIds,
  exportFileName,
  installAddressFor,
  isEntryOf,
  patchSnippet,
  planImport,
  readExport,
  redactText,
  redactValue,
  serializeExport,
  type ExportBundle,
} from "../src/core/transfer.ts";
import type { CenterSettingsFile } from "../src/core/settings.ts";
import type { InstalledPlugin } from "../src/core/types.ts";

const settings: CenterSettingsFile = {
  version: 1,
  locale: "zh",
  syncTtlMs: 86_400_000,
  siteBase: "https://dsh-plugin.org",
  apiBase: "https://api.dsh-plugin.org",
  registry: "",
  proxy: "",
};

function makePlugin(over: Partial<InstalledPlugin> & { name: string }): InstalledPlugin {
  return {
    spec: "^1.0.0",
    kind: "registry",
    selected: true,
    present: true,
    bundle: true,
    hasClient: false,
    ...over,
  };
}

/** 一个假 profile：两个已装插件 + 补丁行 + 各自的数据目录。 */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "harbor-transfer-"));
  const profile = join(home, "profiles", "desktop");
  const write = (rel: string, body: string) => {
    const path = join(profile, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body, "utf8");
  };
  write(
    "package.json",
    JSON.stringify({
      name: "dsh-profile-desktop",
      dependencies: {
        "dsh-cost-meter": "^1.9.28",
        "dsh-channel-hub": "github:Seraphoenixy/dsh-channel-hub",
        "dsh-plugin-harbor": "link:D:/projects/dsh-plugin-harbor",
        "@deepseek-ai/dsh-base": "0.2.1-rc.5",
      },
      dsh: { profile: { bundles: ["dsh-cost-meter", "dsh-plugin-harbor"] } },
    }),
  );
  // 插件自己的补丁文件：声明条目 id（用于把 profile 补丁行归属给它）
  write(
    "node_modules/dsh-cost-meter/package.json",
    JSON.stringify({
      name: "dsh-cost-meter",
      version: "1.9.46",
      repository: { type: "git", url: "git+https://github.com/Han-1413141/dsh-cost-meter.git" },
      dsh: { bundle: { patch: "./cordis.patch.yml" } },
    }),
  );
  write(
    "node_modules/dsh-cost-meter/cordis.patch.yml",
    ["- insert:", "    - id: cost-meter", "      name: dsh-cost-meter"].join("\n") + "\n",
  );
  write(
    "node_modules/dsh-channel-hub/package.json",
    JSON.stringify({
      name: "dsh-channel-hub",
      version: "0.1.0-alpha.1",
      dsh: { bundle: { patch: "./cordis.patch.yml" } },
    }),
  );
  /**
   * 真实 profile 上踩到的点：`dsh-channel-hub` 的数据目录叫 `channel-hub`（= 它声明的条目
   * id），既不是包名也不是包名尾段。归属必须把「插件自己声明的行 id」算进去，否则离线导出
   * 会把真实数据目录整个略过（本轮实测）。
   */
  write(
    "node_modules/dsh-channel-hub/cordis.patch.yml",
    ["- insert:", "    - id: channel-hub", "      name: dsh-channel-hub"].join("\n") + "\n",
  );
  // profile 补丁：默认行 + 按 id 覆盖的配置行（**不带 name**）+ 认不出归属的行 + !!js 标签
  write(
    "cordis.patch.yml",
    [
      "- insert:",
      "    - id: cost-meter",
      "      name: dsh-cost-meter",
      "      config:",
      "        budgetUsd: 5",
      "        apiToken: sk-live-abcdefghijklmnopqrst",
      "- id: cost-meter",
      "  config:",
      "    budgetUsd: 12",
      "- id: someone-else",
      "  name: dsh-not-exported",
      "  config:",
      "    keep: true",
      "- id: tagged",
      '  disabled: !!js "ctx.get(\'hmr\') === undefined"',
      "",
    ].join("\n"),
  );
  // 插件自己的设置文件：一个要脱敏、一个保留、一个被排除
  write("cost-meter/settings.json", JSON.stringify({ theme: "dark", apiKey: "sk-live-zzzzzzzzzzzzzzzz" }));
  write("cost-meter/notes.txt", "预算说明：每月 5 美元");
  write("cost-meter/state.sqlite", "SQLite format 3\u0000binary");
  write("cost-meter/cache/warm.json", JSON.stringify({ warm: true }));
  write("channel-hub/access.json", JSON.stringify({ channel: "general", token: "ghp_aaaaaaaaaaaaaaaaaaaa" }));
  write("mystery-dir/thing.json", JSON.stringify({ unknown: true }));
  return { home, profile, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** 夹具里那三个插件的已装事实（与 profile 的 dependencies 对应）。 */
const pluginsOf = (): InstalledPlugin[] => [
  makePlugin({
    name: "dsh-cost-meter",
    spec: "^1.9.28",
    version: "1.9.46",
    repo: "Han-1413141/dsh-cost-meter",
  }),
  makePlugin({
    name: "dsh-channel-hub",
    spec: "github:Seraphoenixy/dsh-channel-hub",
    kind: "git",
    version: "0.1.0-alpha.1",
    selected: false,
  }),
  makePlugin({
    name: "dsh-plugin-harbor",
    spec: "link:D:/projects/dsh-plugin-harbor",
    kind: "path",
    selected: true,
  }),
];

const hostEntries = [
  { entryId: "include:cost-meter", moduleName: "dsh-cost-meter", enabled: true },
  { entryId: "include:cost-meter-tools", moduleName: "dsh-cost-meter/tools", enabled: false },
  {
    entryId: "include:channel-hub",
    moduleName: "dsh-channel-hub",
    enabled: false,
    readOnlyReason: "management-required",
  },
];

test("导出：清单、条目、归属到插件的配置行都带上", () => {
  const { profile, cleanup } = fixture();
  try {
    const bundle = buildExport({
      profileName: "desktop",
      profileDir: profile,
      pluginVersion: "0.1.0-alpha.1",
      plugins: pluginsOf(),
      settings,
      entries: hostEntries,
      selfDirName: "plugin-harbor",
      now: 1_700_000_000_000,
    });
    assert.equal(bundle.format, EXPORT_FORMAT);
    assert.equal(bundle.version, 1);
    assert.equal(bundle.profile, "desktop");
    assert.equal(bundle.plugins.length, 3);
    const meter = bundle.plugins.find((plugin) => plugin.name === "dsh-cost-meter")!;
    assert.equal(meter.spec, "^1.9.28");
    assert.equal(meter.version, "1.9.46");
    assert.equal(meter.enabled, true);
    // 条目按模块名归属（含子路径条目）
    assert.deepEqual(
      meter.entries!.map((entry) => entry.entryId),
      ["include:cost-meter", "include:cost-meter-tools"],
    );
    // 配置行：自己声明的 id（默认行）与按 id 覆盖的行都归过来了
    assert.deepEqual(
      meter.config!.map((row) => row.id),
      ["cost-meter", "cost-meter"],
    );
    assert.equal((meter.config![1]!.config as any).budgetUsd, 12);
    // 认不出归属的行留在 unattributed，不丢
    assert.deepEqual(
      bundle.profilePatch!.unattributed.map((row) => row.id),
      ["someone-else", "tagged"],
    );
    assert.match(bundle.warnings.join("\n"), /2 行补丁归属尚未确认/);
  } finally {
    cleanup();
  }
});

test("导出：!!js 标签不会让 profile 补丁解析失败", () => {
  const { profile, cleanup } = fixture();
  try {
    const bundle = buildExport({
      profileName: "desktop",
      profileDir: profile,
      pluginVersion: "x",
      plugins: pluginsOf(),
      settings,
      now: 1,
    });
    assert.equal(bundle.profilePatch!.error, undefined);
    const tagged = bundle.profilePatch!.unattributed.find((row) => row.id === "tagged")!;
    assert.equal(tagged.disabled, "ctx.get('hmr') === undefined", "!!js 表达式按字符串保留，不转布尔");
  } finally {
    cleanup();
  }
});

test("导出：疑似凭据的字段与取值都被脱敏", () => {
  const { profile, cleanup } = fixture();
  try {
    const bundle = buildExport({
      profileName: "desktop",
      profileDir: profile,
      pluginVersion: "x",
      plugins: pluginsOf(),
      settings,
      entries: hostEntries,
      includeData: true,
      selfDirName: "plugin-harbor",
      now: 1,
    });
    const text = serializeExport(bundle);
    assert.doesNotMatch(text, /sk-live-abcdefghijklmnopqrst/);
    assert.doesNotMatch(text, /sk-live-zzzzzzzzzzzzzzzz/);
    assert.doesNotMatch(text, /ghp_aaaaaaaaaaaaaaaaaaaa/);
    // 补丁行里的凭据同样要脱敏（导出文件可能被分享/带出机器）
    const meter = bundle.plugins.find((plugin) => plugin.name === "dsh-cost-meter")!;
    assert.deepEqual(meter.config![0]!.config, { budgetUsd: 5, apiToken: "[已脱敏]" });
    assert.match(bundle.warnings.join("\n"), /疑似凭据/);
    const settingsFile = meter.files!.find((file) => file.path.endsWith("settings.json"))!;
    assert.deepEqual(JSON.parse(settingsFile.content), { theme: "dark", apiKey: "[已脱敏]" });
  } finally {
    cleanup();
  }
});

test("导出：数据库 / 缓存 / 二进制 / 认不出归属的目录都进省略清单并说明原因", () => {
  const { profile, cleanup } = fixture();
  try {
    const bundle = buildExport({
      profileName: "desktop",
      profileDir: profile,
      pluginVersion: "x",
      plugins: pluginsOf(),
      settings,
      entries: hostEntries,
      includeData: true,
      selfDirName: "plugin-harbor",
      now: 1,
    });
    const reasons = bundle.omissions.map((item) => `${item.path}|${item.reason}`).join("\n");
    assert.match(reasons, /cost-meter\/state\.sqlite\|数据库/);
    assert.match(reasons, /mystery-dir\|认不出属于哪个已装插件/);
    const meter = bundle.plugins.find((plugin) => plugin.name === "dsh-cost-meter")!;
    const paths = meter.files!.map((file) => file.path);
    assert.ok(paths.some((path) => path.endsWith("settings.json")), "文本设置要导出");
    assert.ok(paths.some((path) => path.endsWith("notes.txt")), "文本说明要导出");
    assert.ok(!paths.some((path) => path.includes("cache/")), "缓存目录不导出");
    assert.ok(!paths.some((path) => path.endsWith(".sqlite")), "数据库不导出");
    /**
     * 数据目录按「插件自己声明的条目 id」归属：`dsh-channel-hub` 的目录是 `channel-hub`，
     * 不能因为名字不是包名就当成「认不出归属」而略过。
     */
    const hub = bundle.plugins.find((plugin) => plugin.name === "dsh-channel-hub")!;
    assert.deepEqual(
      hub.files!.map((file) => file.path),
      ["channel-hub/access.json"],
    );
    assert.ok(
      !bundle.omissions.some((item) => item.path === "channel-hub"),
      "已归属的目录不该再出现在「认不出归属」里",
    );
    assert.deepEqual(declaredRowIds(profile, "dsh-channel-hub"), ["channel-hub"]);
  } finally {
    cleanup();
  }
});

test("导出：不含插件自己的数据（默认）时不扫目录，也不列数据省略项", () => {
  const { profile, cleanup } = fixture();
  try {
    const bundle = buildExport({
      profileName: "desktop",
      profileDir: profile,
      pluginVersion: "x",
      plugins: pluginsOf(),
      settings,
      now: 1,
    });
    assert.equal(bundle.plugins.every((plugin) => plugin.files === undefined), true);
    assert.equal(bundle.omissions.length, 0);
    assert.equal(bundle.plugins[0]!.entries, undefined, "没有宿主条目就不编条目级信息");
    assert.match(bundle.warnings.join("\n"), /未包含条目级信息/);
  } finally {
    cleanup();
  }
});

test("导出文件能被读回；格式不对的 JSON 一律拒绝而不是当成空清单", () => {
  const { profile, cleanup } = fixture();
  try {
    const bundle = buildExport({
      profileName: "desktop",
      profileDir: profile,
      pluginVersion: "x",
      plugins: pluginsOf(),
      settings,
      now: 1_700_000_000_000,
    });
    const text = serializeExport(bundle);
    const back = readExport(text);
    assert.equal(back.error, undefined);
    assert.equal(back.bundle!.plugins.length, 3);
    assert.equal(back.bundle!.settings?.locale, "zh");

    assert.match(readExport("{ not json").error!, /不是合法 JSON/);
    assert.match(readExport(JSON.stringify({ hello: "world" })).error!, /不是插件港湾的导出文件/);
    assert.match(
      readExport(JSON.stringify({ format: EXPORT_FORMAT, version: 99, plugins: [] })).error!,
      /版本不支持/,
    );
    assert.match(
      readExport(JSON.stringify({ format: EXPORT_FORMAT, version: 1, plugins: [{ name: "" }] }))
        .error!,
      /缺少 name/,
    );
    assert.match(exportFileName("desktop", 1_700_000_000_000), /-desktop\.json$/);
  } finally {
    cleanup();
  }
});

test("归属规则：声明的行 id 取自插件自己的补丁文件", () => {
  const { profile, cleanup } = fixture();
  try {
    assert.deepEqual(declaredRowIds(profile, "dsh-cost-meter"), ["cost-meter"]);
    assert.deepEqual(declaredRowIds(profile, "dsh-unknown"), []);
    assert.equal(isEntryOf("dsh-cost-meter", "dsh-cost-meter"), true);
    assert.equal(isEntryOf("dsh-cost-meter/tools", "dsh-cost-meter"), true);
    assert.equal(isEntryOf("dsh-cost-meter-x", "dsh-cost-meter"), false);
  } finally {
    cleanup();
  }
});

test("预检：安装 / 启停 / 条目开关 / 已一致 / 阻塞各有一步", () => {
  const { profile, cleanup } = fixture();
  try {
    const bundle: ExportBundle = {
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: 1,
      profile: "laptop",
      by: { plugin: "plugin-harbor", version: "x" },
      settings: { ...settings, locale: "en" },
      plugins: [
        // 未装 → 安装（registry 按导出的确切版本）
        { name: "dsh-cost-meter", spec: "^1.9.28", kind: "registry", version: "1.9.46", enabled: true },
        // 已装但导出为停用 → 停用
        { name: "dsh-channel-hub", spec: "github:o/r", kind: "git", enabled: false },
        // 已装且一致 → 跳过
        { name: "dsh-plugin-harbor", spec: "link:D:/projects/dsh-plugin-harbor", kind: "path", enabled: true },
        // 本机路径不存在 → 阻塞
        { name: "dsh-local-only", spec: "file:../nowhere", kind: "path", enabled: true },
        // 条目开关有差异 → entries
        {
          name: "dsh-entries",
          spec: "^2.0.0",
          kind: "registry",
          enabled: true,
          entries: [{ entryId: "include:a", moduleName: "dsh-entries", enabled: false }],
        },
      ],
      omissions: [{ path: "x.sqlite", reason: "数据库" }],
      warnings: [],
    };
    const plan = planImport({
      source: "C:/tmp/export.json",
      bundle,
      profileName: "desktop",
      profileDir: profile,
      settings,
      installed: [
        makePlugin({ name: "dsh-channel-hub", spec: "github:o/r", kind: "git", selected: true }),
        makePlugin({ name: "dsh-plugin-harbor", spec: "link:D:/projects/dsh-plugin-harbor", kind: "path" }),
        makePlugin({ name: "dsh-entries", spec: "^2.0.0", selected: true }),
      ],
      entries: [
        { entryId: "include:a", moduleName: "dsh-entries", enabled: true },
        { entryId: "include:b", moduleName: "dsh-entries", enabled: true },
        { entryId: "include:locked", moduleName: "dsh-entries", enabled: true, readOnlyReason: "management-required" },
      ],
      exists: () => false,
    });
    const byName = new Map(plan.steps.map((step) => [step.name, step]));
    assert.equal(byName.get("dsh-cost-meter")!.action, "install");
    assert.equal(byName.get("dsh-cost-meter")!.spec, "dsh-cost-meter@1.9.46");
    assert.equal(byName.get("dsh-channel-hub")!.action, "disable");
    assert.equal(byName.get("dsh-plugin-harbor")!.action, "skip");
    assert.equal(byName.get("dsh-local-only")!.action, "blocked");
    assert.match(byName.get("dsh-local-only")!.reason!, /目标机器上没有这个路径/);
    assert.equal(byName.get("dsh-entries")!.action, "entries");
    assert.deepEqual(byName.get("dsh-entries")!.entries, [{ entryId: "include:a", enabled: false }]);
    // 本插件自己的设置差异也要报出来
    assert.deepEqual(plan.settings.changed, ["locale"]);
    assert.deepEqual(plan.warnings.filter((line) => line.includes("profile")).length, 1);
    assert.equal(plan.omissions.length, 1);
  } finally {
    cleanup();
  }
});

test("预检：已一致时说清「一致」，不硬造动作", () => {
  const { profile, cleanup } = fixture();
  try {
    const bundle: ExportBundle = {
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: 1,
      profile: "desktop",
      by: { plugin: "plugin-harbor", version: "x" },
      settings,
      plugins: [
        {
          name: "dsh-entries",
          spec: "^2.0.0",
          kind: "registry",
          enabled: true,
          entries: [{ entryId: "include:a", moduleName: "dsh-entries", enabled: true }],
        },
      ],
      omissions: [],
      warnings: [],
    };
    const plan = planImport({
      source: "x.json",
      bundle,
      profileName: "desktop",
      profileDir: profile,
      settings,
      installed: [makePlugin({ name: "dsh-entries", spec: "^2.0.0" })],
      entries: [{ entryId: "include:a", moduleName: "dsh-entries", enabled: true }],
    });
    assert.equal(plan.steps[0]!.action, "skip");
    assert.match(plan.steps[0]!.reason!, /都已一致/);
    assert.deepEqual(plan.settings.changed, []);
    assert.deepEqual(plan.warnings, []);
  } finally {
    cleanup();
  }
});

test("安装地址：registry 用导出的确切版本，git 原样，本地路径不存在就阻塞", () => {
  const meter = installAddressFor(
    { name: "dsh-cost-meter", spec: "^1.9.28", kind: "registry", version: "1.9.46", enabled: true },
    "D:/profiles/desktop",
  );
  assert.equal(meter.spec, "dsh-cost-meter@1.9.46");
  const noVersion = installAddressFor(
    { name: "dsh-x", spec: "^2.0.0", kind: "registry", enabled: true },
    "D:/profiles/desktop",
  );
  assert.equal(noVersion.spec, "dsh-x@^2.0.0");
  const git = installAddressFor(
    { name: "dsh-channel-hub", spec: "github:o/r", kind: "git", enabled: true },
    "D:/profiles/desktop",
  );
  assert.equal(git.spec, "github:o/r");
  const local = installAddressFor(
    { name: "p", spec: "link:D:/gone", kind: "path", enabled: true },
    "D:/profiles/desktop",
    () => false,
  );
  assert.equal(local.spec, undefined);
  assert.match(local.blocked!, /D:\/gone/);
});

test("配置片段：带 config 的行生成可粘贴的 YAML，并写明为什么要人工粘", () => {
  const bundle: ExportBundle = {
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: 1_700_000_000_000,
    profile: "desktop",
    by: { plugin: "plugin-harbor", version: "x" },
    plugins: [
      {
        name: "dsh-cost-meter",
        spec: "^1.9.28",
        kind: "registry",
        enabled: true,
        config: [{ id: "cost-meter", name: "dsh-cost-meter", config: { budgetUsd: 12 } }],
      },
      { name: "dsh-plain", spec: "^1.0.0", kind: "registry", enabled: true },
    ],
    omissions: [],
    warnings: [],
  };
  const snippet = patchSnippet(bundle, "desktop")!;
  assert.match(snippet, /cordis\.patch\.yml/);
  assert.match(snippet, /没有写 config 的接口/);
  assert.match(snippet, /- id: "cost-meter"/);
  assert.match(snippet, /budgetUsd/);
  assert.equal(patchSnippet({ ...bundle, plugins: [bundle.plugins[1]!] }, "desktop"), undefined);
});

test("脱敏：键名与取值两条路径都覆盖", () => {
  const nested = redactValue({
    theme: "dark",
    accessToken: "whatever-value",
    nested: { clientSecret: "s", list: ["ghp_aaaaaaaaaaaaaaaaaaaa", "plain"] },
    authorization: "Bearer abcdefghijklmnop",
  });
  assert.equal((nested.value as any).theme, "dark");
  assert.equal((nested.value as any).accessToken, "[已脱敏]");
  assert.equal((nested.value as any).nested.clientSecret, "[已脱敏]");
  assert.equal((nested.value as any).nested.list[0], "[已脱敏]");
  assert.equal((nested.value as any).nested.list[1], "plain");
  assert.equal((nested.value as any).authorization, "[已脱敏]");
  assert.ok(nested.count >= 4);
  assert.equal(redactText("plain text").count, 0);
  assert.match(redactText("https://user:pass@example.com/x").text, /\[已脱敏\]/);
});
test("嵌套分组归属、内置配置分类与旧快照兼容，不猜测未知条目", async () => {
  const { classifyExport } = await import("../src/core/transfer.ts");
  const { profile, cleanup } = fixture();
  try {
    writeFileSync(join(profile, "node_modules/dsh-channel-hub/cordis.patch.yml"), '- insert:\n  - id: hub-group\n    group: true\n    config:\n    - id: hub-child-group\n      group: true\n      config:\n      - id: hub-nested\n        name: dsh-channel-hub/nested\n  - id: channel-hub\n    name: dsh-channel-hub\n    config:\n    - id: ordinary-config-not-an-entry\n');
    const ids = declaredRowIds(profile, "dsh-channel-hub");
    assert.ok(ids.includes("hub-nested"));
    assert.ok(!ids.includes("ordinary-config-not-an-entry"), "普通配置数组不能误认成条目声明");
    writeFileSync(join(profile, "cordis.patch.yml"), '- id: hub-nested\n  disabled: true\n- id: ui-theme\n  name: "@deepseek-ai/dsh-client-ui-theme"\n  config:\n    theme: dark\n    token: sk-live-abcdefghijklmnopqrst\n- id: mystery\n  disabled: true\n- id: ui-chat\n  name: third-party-not-host\n  config:\n    enabled: true\n');
    const b = buildExport({ profileName: "desktop", profileDir: profile, pluginVersion: "test", plugins: pluginsOf(), settings,
      entries: [{ entryId: "include:hub-nested", moduleName: "dsh-channel-hub/nested", enabled: false }] });
    assert.ok(b.plugins.find(p => p.name === "dsh-channel-hub")!.config!.some(r => r.id === "hub-nested"));
    assert.equal(b.profilePatch!.builtin!.length, 1);
    assert.equal((b.profilePatch!.builtin![0]!.config as any).token, "[已脱敏]");
    assert.deepEqual(b.profilePatch!.unattributed.map(r => r.id), ["mystery", "ui-chat"]);
    assert.ok(b.profilePatch!.unresolved!.every(r => r.reason));
    const old: ExportBundle = structuredClone(b);
    const nested = old.plugins.find(p => p.name === "dsh-channel-hub")!.config!.pop()!;
    old.profilePatch!.unattributed.push(nested, ...old.profilePatch!.builtin!);
    delete old.profilePatch!.builtin; delete old.profilePatch!.unresolved;
    old.warnings = ["有 4 行补丁没归到导出范围内的已装插件，已原样放在 profilePatch.unattributed 里"];
    const fixed = classifyExport(old, profile);
    assert.equal(fixed.profilePatch!.builtin!.length, 1);
    assert.deepEqual(fixed.profilePatch!.unattributed.map(r => r.id), ["mystery", "ui-chat"]);
    assert.equal(classifyExport(fixed, profile).plugins.find(p => p.name === "dsh-channel-hub")!.config!.length, fixed.plugins.find(p => p.name === "dsh-channel-hub")!.config!.length, "重复分类不重复配置");
    assert.match(fixed.warnings[0]!, /2 行补丁归属尚未确认/);
    assert.equal(old.profilePatch!.unattributed.length, 4, "旧文件内容不被修改");
    const plan = planImport({ source: "old.json", bundle: old, profileName: "desktop", profileDir: profile, installed: pluginsOf(), settings });
    assert.equal(plan.builtinRows, 1); assert.equal(plan.unattributedRows, 2);
    assert.equal(plan.unresolved!.length, 2);
  } finally { cleanup(); }
});
