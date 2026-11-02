import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  assertProfileName,
  dshHome,
  resolveProfile,
} from "../src/core/paths.ts";

test("profile name must be a single plain path segment", () => {
  assert.equal(assertProfileName("desktop"), "desktop");
  assert.equal(assertProfileName("web-2.local"), "web-2.local");
  for (const bad of ["../escape", "a/b", "a\\b", "", "with space", "."])
    assert.throws(
      () => assertProfileName(bad),
      /Invalid DSH profile name/,
      "must reject " + JSON.stringify(bad),
    );
});

test("resolves the plugin data directory under the active profile", () => {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join("C:", "tmp", "dsh-home");
  try {
    assert.equal(dshHome(), join("C:", "tmp", "dsh-home"));
    const fromContext = resolveProfile({
      get: () => ({ name: "headless" }),
    });
    assert.equal(fromContext.name, "headless");
    assert.equal(
      fromContext.dataDir,
      join("C:", "tmp", "dsh-home", "profiles", "headless", "plugin-harbor"),
    );
    assert.equal(
      fromContext.dbPath,
      join(fromContext.dataDir, "catalog.sqlite"),
    );
    assert.equal(resolveProfile({ get: () => undefined }).name, "desktop");
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test("refuses a profile name that could escape the profiles directory", () => {
  assert.throws(
    () => resolveProfile({ get: () => ({ name: "../../etc" }) }),
    /Invalid DSH profile name/,
  );
});