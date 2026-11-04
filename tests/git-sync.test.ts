import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  GitSync,
  validateConfig,
  snapshot,
  parseSnapshot,
} from "../src/git-sync/service.ts";
import type { ExportBundle } from "../src/core/transfer.ts";
const bundle = (): ExportBundle => ({
  format: "dsh-plugin-harbor/export",
  version: 1,
  exportedAt: 100,
  profile: "test",
  by: { plugin: "plugin-harbor", version: "1" },
  plugins: [
    {
      name: "example",
      kind: "registry",
      spec: "1.0.0",
      version: "1.0.0",
      enabled: true,
    },
  ],
  omissions: [],
  warnings: [],
});
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

test("sync config rejects credentials, command/protocol injection and environment traversal", () => {
  for (const remote of [
    "--upload-pack=x",
    "ext::bad",
    "http://host/repo",
    "https://token@host/repo",
    "https://host/repo?token=x",
    "ssh://user:secret@host/repo",
    "https://host/repo\n",
  ])
    assert.throws(() => validateConfig({ remote, environment: "default" }));
  for (const environment of ["../x", "-bad", "a/b", "", "x".repeat(65)])
    assert.throws(() =>
      validateConfig({
        remote: "https://github.com/you/repo.git",
        environment,
      }),
    );
  assert.equal(
    validateConfig({
      remote: "git@github.com:you/repo.git",
      environment: "desktop",
    }).environment,
    "desktop",
  );
});
test("snapshots are stable and malformed/unsafe remote payloads fail closed", () => {
  const a = bundle();
  const b = bundle();
  b.exportedAt = 200;
  assert.equal(snapshot(a), snapshot(b));
  assert.equal(parseSnapshot(snapshot(a)).plugins.length, 1);
  for (const mutate of [
    (b: any) => b.plugins.push(b.plugins[0]),
    (b: any) => (b.plugins[0].enabled = "yes"),
    (b: any) => (b.plugins[0].spec = "https://token@host/archive.tgz"),
    (b: any) => (b.plugins[0].entries = [{}]),
    (b: any) => (b.omissions = {}),
  ]) {
    const b = bundle();
    mutate(b);
    assert.throws(() => parseSnapshot(JSON.stringify(b)));
  }
});

test("two offline mirrors share remote safely: branch isolation, stable commits, conflicts, cancel, repository switch", async () => {
  const root = mkdtempSync(join(tmpdir(), "harbor-sync-test-"));
  try {
    const remote = join(root, "remote.git");
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    const a = new GitSync(join(root, "a"));
    const b = new GitSync(join(root, "b"));
    a.configure({ remote, environment: "desktop" });
    b.configure({ remote, environment: "desktop" });
    assert.equal((await a.locked(() => a.inspect())).commit, null);
    const first = await a.locked(() => a.publish(snapshot(bundle()), null));
    // Mnemon 分支含独立内容，港湾始终不改它。
    git(remote, "update-ref", "refs/heads/mnemon-sync", first.commit);
    assert.equal((await b.locked(() => b.inspect())).commit, first.commit);
    assert.equal(
      (await a.locked(() => a.publish(snapshot(bundle()), first.commit)))
        .unchanged,
      true,
    );
    const changed = bundle();
    changed.plugins[0]!.enabled = false;
    const second = await b.locked(() =>
      b.publish(snapshot(changed), first.commit),
    );
    await assert.rejects(
      a.locked(() => a.publish(snapshot(bundle()), first.commit)),
      /远端已变化/,
    );
    assert.equal(
      git(remote, "rev-parse", "refs/heads/mnemon-sync"),
      first.commit,
    );
    assert.equal(
      git(remote, "rev-parse", "refs/heads/harbor-sync"),
      second.commit,
    );
    assert.equal(
      parseSnapshot((await a.locked(() => a.inspect())).text!).plugins[0]!
        .enabled,
      false,
    );
    assert.equal((await a.locked(() => a.inspect())).history.length, 2);
    // 同分支不同环境不会覆盖彼此。
    b.configure({ remote, environment: "laptop" });
    await b.locked(() => b.publish(snapshot(bundle()), second.commit));
    assert.equal(
      parseSnapshot((await a.locked(() => a.inspect())).text!).plugins[0]!
        .enabled,
      false,
    );
    await assert.rejects(
      a.locked(async () => {
        await a.locked(() => a.inspect());
      }),
      /正在运行/,
    );
    await assert.rejects(
      a.locked(async () => {
        a.cancel();
        return a.inspect();
      }),
      /取消/,
    );
    const other = join(root, "other.git");
    execFileSync("git", ["init", "--bare", other], { stdio: "ignore" });
    a.configure({ remote: other, environment: "desktop" });
    assert.equal((await a.locked(() => a.inspect())).text, null);
    assert.equal(
      git(remote, "rev-parse", "refs/heads/mnemon-sync"),
      first.commit,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git sync excludes local development paths and protects same-name local installs", async () => {
  const { portableBundle, publicationBundle } = await import(
    "../src/git-sync/service.ts"
  );
  const local = bundle();
  local.plugins.push({
    name: "dev-plugin",
    kind: "path",
    spec: "link:D:/private/dev-plugin",
    enabled: false,
    config: [{ id: "dev", config: { theme: "local" } }],
    entries: [{ entryId: "dev", moduleName: "dev-plugin", enabled: false }],
  });
  local.profilePatch = {
    attributed: ["dev"],
    unattributed: [{ id: "dev", config: { theme: "local" } }],
  };
  const exported = portableBundle(local);
  assert.deepEqual(
    exported.plugins.map((p) => p.name),
    ["example"],
  );
  assert.deepEqual(exported.profilePatch!.unattributed, []);
  assert.ok(exported.omissions.some((x) => x.path === "plugins/dev-plugin"));
  assert.doesNotMatch(snapshot(exported), /D:\/private|theme/);
  const remote = bundle();
  remote.plugins[0]!.enabled = false;
  remote.plugins[0]!.config = [{ id: "example", config: { theme: "remote" } }];
  const installed = [
    { name: "example", kind: "path", spec: "link:../example" },
  ];
  const incoming = portableBundle(remote, installed);
  assert.equal(
    incoming.plugins.length,
    0,
    "远端 registry 插件不能改变本机同名开发插件",
  );
  assert.ok(incoming.omissions.some((x) => /保留本机路径/.test(x.reason)));
  const outgoing = publicationBundle(exported, remote, installed);
  assert.equal(
    outgoing.plugins.find((p) => p.name === "example")!.enabled,
    false,
    "开发机发布应保留远端记录",
  );
  assert.deepEqual(
    outgoing.plugins.find((p) => p.name === "example")!.config,
    remote.plugins[0]!.config,
  );
  assert.equal(local.plugins.length, 2, "过滤不能改变本机导出对象");
  for (const spec of [
    "file:../plugin",
    "link:../plugin",
    "D:\\dev\\plugin",
    "/home/dev/plugin",
    "file:../plugin.tgz",
  ]) {
    const b = bundle();
    b.plugins[0]!.spec = spec;
    b.plugins[0]!.kind = spec.endsWith(".tgz") ? "tarball" : "path";
    assert.equal(portableBundle(b).plugins.length, 0);
  }
});
