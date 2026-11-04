import test from "node:test";
import assert from "node:assert/strict";
import {
  safeConfigPatch,
  mergeConfig,
  planConfigs,
  applyConfig,
  type ConfigEditorLike,
  type ConfigEntry,
} from "../src/git-sync/config.ts";
import type { ExportBundle } from "../src/core/transfer.ts";
const source = (config: unknown): ExportBundle => ({
  format: "dsh-plugin-harbor/export",
  version: 1,
  exportedAt: 0,
  profile: "shared",
  by: { plugin: "plugin-harbor", version: "1" },
  plugins: [
    {
      name: "example",
      kind: "registry",
      spec: "1.0.0",
      enabled: true,
      config: [{ id: "example", name: "example", config }],
    },
  ],
  warnings: [],
  omissions: [],
});
const entry = (): ConfigEntry => ({
  options: {
    id: "example",
    name: "example",
    config: {
      theme: "light",
      token: "local-credential",
      nested: { keep: 1 },
      dataPath: "D:/local",
    },
  },
  fiber: { state: 2 },
});
const editorFor = (e: ConfigEntry): ConfigEditorLike => ({
  entries: () => [e],
  edit: async (_entry, change) => {
    e.options.config = change(structuredClone(e.options.config), {});
  },
});

test("portable config preserves credentials/paths and rejects expressions/prototype/unsafe arrays", () => {
  const raw = JSON.parse(
    '{"theme":"dark","nested":{"size":2,"api_key":"[已脱敏]"},"token":"[已脱敏]","dataPath":"D:/other","directory":"/tmp/other","location":"file:../other","expr":{"__jsExpr":"process.exit()"},"items":[{"token":"[已脱敏]","label":"x"}],"__proto__":{"polluted":true},"clear":null}',
  );
  const safe = safeConfigPatch(raw);
  assert.deepEqual(safe.patch, { theme: "dark", nested: { size: 2 } });
  const current = entry().options.config as any;
  const { next, paths } = mergeConfig(current, safe.patch);
  assert.deepEqual(paths, ["theme", "nested.size"]);
  assert.equal(next.token, "local-credential");
  assert.equal(next.dataPath, "D:/local");
  assert.deepEqual(next.nested, { keep: 1, size: 2 });
  assert.equal(({} as any).polluted, undefined);
  assert.equal(current.theme, "light");
  assert.throws(() => mergeConfig({ nested: 3 }, { nested: { size: 2 } }));
  assert.throws(() =>
    mergeConfig({ items: [{ token: "local" }] }, { items: ["new"] }),
  );
});

test("config plan is bound to ownership/activity and current config, and only host edit applies it", async () => {
  const e = entry();
  const editor = editorFor(e);
  const plans = planConfigs(
    source({ theme: "dark", token: "[已脱敏]" }),
    editor,
  );
  assert.equal(plans[0]!.action, "apply");
  assert.deepEqual(plans[0]!.paths, ["theme"]);
  assert.doesNotMatch(JSON.stringify(plans), /local-credential|D:\/local/);
  await applyConfig(plans[0]!, editor);
  assert.equal((e.options.config as any).theme, "dark");
  assert.equal((e.options.config as any).token, "local-credential");
  assert.equal(
    planConfigs(source({ theme: "dark" }), editor)[0]!.action,
    "skip",
  );
  await assert.rejects(applyConfig(plans[0]!, editor), /已变化/);
  assert.equal(
    planConfigs(source({ theme: "dark" }), undefined)[0]!.action,
    "manual",
  );
  e.options.name = "unrelated";
  assert.equal(
    planConfigs(source({ theme: "dark" }), editor)[0]!.action,
    "manual",
  );
  e.options.name = "example";
  e.fiber!.state = 0;
  assert.equal(
    planConfigs(source({ theme: "dark" }), editor)[0]!.action,
    "manual",
  );
  e.fiber!.state = 2;
  const duplicate = { ...editor, entries: () => [e, e] };
  assert.equal(
    planConfigs(source({ theme: "dark" }), duplicate)[0]!.action,
    "manual",
  );
  const local = source({ theme: "dark" });
  local.plugins[0]!.kind = "path";
  assert.equal(planConfigs(local, editor).length, 0);
});

test("host validation failures propagate without applying a patch", async () => {
  const e = entry();
  const editor = editorFor(e);
  const plan = planConfigs(source({ theme: "dark" }), editor)[0]!;
  editor.edit = async () => {
    throw Error("schema rejected");
  };
  await assert.rejects(applyConfig(plan, editor), /schema rejected/);
  assert.equal((e.options.config as any).theme, "light");
});

test("protected-only config never requires manual recovery even without an active host entry", () => {
  for (const config of [
    { token: "[已脱敏]" },
    { dataPath: "D:/source" },
    { expression: { __jsExpr: "ctx.get('service')" } },
    {},
  ]) {
    for (const editor of [
      undefined,
      { entries: () => [], edit: async () => {} },
    ]) {
      const plan = planConfigs(source(config), editor)[0]!;
      assert.equal(plan.action, "skip");
      assert.match(plan.reason!, /无需恢复/);
      assert.equal(plan.patch, undefined);
    }
  }
  assert.equal(
    planConfigs(source("unsupported scalar config"), undefined)[0]!.action,
    "manual",
  );
  assert.equal(
    planConfigs(source({ theme: "dark" }), undefined)[0]!.action,
    "manual",
    "真正缺少配置服务时仍如实列明原因",
  );
});
