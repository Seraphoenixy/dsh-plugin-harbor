/**
 * 设置持久化回归（真实文件 IO，走临时目录）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySettingsPatch,
  defaultSettings,
  MAX_TTL_MS,
  MIN_TTL_MS,
  normalizeSettings,
  readSettingsFile,
  settingsPath,
  writeSettingsFile,
  type CenterSettingsFile,
} from "../src/core/settings.ts";

const defaults: CenterSettingsFile = {
  version: 1,
  locale: "zh",
  syncTtlMs: 86_400_000,
  siteBase: "https://dsh-plugin.org",
  apiBase: "https://api.dsh-plugin.org",
  registry: "",
  proxy: "",
};

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pcenter-settings-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("缺文件时用默认值且不报 noise", () => {
  withDir((dir) => {
    const { settings, notes } = readSettingsFile(dir, defaults);
    assert.deepEqual(settings, defaults);
    assert.deepEqual(notes, []);
  });
});

test("坏文件 / 坏字段逐项退回默认值并说明原因", () => {
  withDir((dir) => {
    writeFileSync(settingsPath(dir), "{ not json", "utf8");
    const broken = readSettingsFile(dir, defaults);
    assert.deepEqual(broken.settings, defaults);
    assert.match(broken.notes[0]!, /无法解析/);

    writeFileSync(
      settingsPath(dir),
      JSON.stringify({
        locale: "fr",
        syncTtlMs: 10,
        siteBase: "not-a-url",
        apiBase: "https://mirror.example.com/",
        registry: "ftp://x",
        proxy: "x".repeat(300),
      }),
      "utf8",
    );
    const mixed = readSettingsFile(dir, defaults);
    // 合法的那一项要保留，非法的逐项退回
    assert.equal(mixed.settings.apiBase, "https://mirror.example.com");
    assert.equal(mixed.settings.locale, defaults.locale);
    assert.equal(mixed.settings.syncTtlMs, defaults.syncTtlMs);
    assert.equal(mixed.settings.siteBase, defaults.siteBase);
    assert.equal(mixed.settings.registry, defaults.registry);
    assert.equal(mixed.settings.proxy, defaults.proxy);
    assert.equal(mixed.notes.length, 5, "五个坏字段各给一条说明");
  });
});

test("非对象设置文件退回默认值", () => {
  const { settings, notes } = normalizeSettings([1, 2, 3], defaults);
  assert.deepEqual(settings, defaults);
  assert.match(notes.join("\n"), /不是对象/);
});

test("同步间隔按区间收口，越界退回默认而不是静默夹取", () => {
  assert.equal(
    normalizeSettings({ syncTtlMs: MIN_TTL_MS }, defaults).settings.syncTtlMs,
    MIN_TTL_MS,
  );
  assert.equal(
    normalizeSettings({ syncTtlMs: MAX_TTL_MS }, defaults).settings.syncTtlMs,
    MAX_TTL_MS,
  );
  const tooSmall = normalizeSettings({ syncTtlMs: MIN_TTL_MS - 1 }, defaults);
  assert.equal(tooSmall.settings.syncTtlMs, defaults.syncTtlMs);
  assert.match(tooSmall.notes.join("\n"), /超出允许区间/);
  const notNumber = normalizeSettings({ syncTtlMs: "24h" }, defaults);
  assert.equal(notNumber.settings.syncTtlMs, defaults.syncTtlMs);
  assert.match(notNumber.notes.join("\n"), /不是数字/);
});

test("写读往返：原子写且内容可读回", () => {
  withDir((dir) => {
    const next = { ...defaults, locale: "en" as const, syncTtlMs: 3_600_000, registry: "https://registry.npmmirror.com" };
    writeSettingsFile(dir, next);
    const raw = readFileSync(settingsPath(dir), "utf8");
    assert.match(raw, /"locale": "en"/);
    assert.ok(!raw.includes(".tmp"), "临时文件不该留在正文里");
    const back = readSettingsFile(dir, defaults);
    assert.deepEqual(back.settings, next);
    assert.deepEqual(back.notes, []);
  });
});

test("补丁合并：合法值生效，非法值报错且不改动那一项", () => {
  const ok = applySettingsPatch(defaults, {
    locale: "en",
    syncTtlMs: 1_800_000,
    registry: "https://registry.npmmirror.com/",
  });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.settings.locale, "en");
  assert.equal(ok.settings.syncTtlMs, 1_800_000);
  assert.equal(ok.settings.registry, "https://registry.npmmirror.com", "尾部斜杠被去掉");

  const bad = applySettingsPatch(defaults, {
    locale: "fr",
    syncTtlMs: -5,
    siteBase: "javascript:alert(1)",
    registry: "ftp://x",
    proxy: 42,
  });
  assert.equal(bad.problems.length, 5);
  assert.deepEqual(
    { ...bad.settings },
    defaults,
    "非法补丁不得改动任何一项",
  );
  assert.match(bad.problems.join("\n"), /locale 只能是/);
  assert.match(bad.problems.join("\n"), /syncTtlMs 必须是/);
  assert.match(bad.problems.join("\n"), /siteBase 必须是/);
});

test("默认值可由环境变量给出（自建镜像 / 离线验收）", () => {
  const previous = process.env.PLUGIN_HARBOR_SITE;
  process.env.PLUGIN_HARBOR_SITE = "http://127.0.0.1:1234";
  try {
    assert.equal(defaultSettings().siteBase, "http://127.0.0.1:1234");
  } finally {
    if (previous === undefined) delete process.env.PLUGIN_HARBOR_SITE;
    else process.env.PLUGIN_HARBOR_SITE = previous;
  }
});