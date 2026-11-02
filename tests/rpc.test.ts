import test from "node:test";
import assert from "node:assert/strict";
import {
  createDispatcher,
  readEnvelope,
  redact,
  RPC_METHOD,
} from "../src/core/dispatch.ts";

const envelope = (payload: any = {}) => ({
  type: "client-request",
  method: RPC_METHOD,
  rpcId: "r1",
  payload: { version: 1, method: "status", payload },
});

const rpcContext: any = {
  profile: { name: "desktop" },
  store: { call: async () => ({}) },
  log: () => {},
};

test("accepts a well-formed versioned envelope", () => {
  const parsed = readEnvelope(envelope({ a: 1 }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.envelope.rpcId, "r1");
  assert.equal(parsed.envelope.method, "status");
  assert.deepEqual(parsed.envelope.payload, { a: 1 });
});

test("rejects a foreign or malformed envelope", () => {
  const cases: any[] = [
    { ...envelope(), type: "server-response" },
    { ...envelope(), method: "other-plugin" },
    { ...envelope(), payload: { version: 2, method: "status" } },
    { ...envelope(), payload: { version: 1 } },
    {},
  ];
  for (const message of cases) {
    const parsed = readEnvelope(message);
    assert.equal(parsed.ok, false, "must reject " + JSON.stringify(message));
    if (!parsed.ok)
      assert.equal(parsed.reason, "Invalid versioned RPC envelope");
  }
});

test("keeps a readable rpcId so the client is never left hanging", () => {
  const withId = readEnvelope({ rpcId: "abc" });
  assert.equal(withId.ok, false);
  if (!withId.ok) assert.equal(withId.rpcId, "abc");
  const withoutId = readEnvelope({});
  assert.equal(withoutId.ok, false);
  if (!withoutId.ok) assert.equal(withoutId.rpcId, "invalid");
});

test("dispatcher separates unknown methods, successes and failures", async () => {
  const dispatch = createDispatcher({
    ok: () => ({ fine: true }),
    boom: () => {
      throw Error("token=abcd1234 rejected");
    },
  });
  assert.deepEqual(await dispatch("ok", {}, rpcContext), {
    ok: true,
    value: { fine: true },
  });
  const unknown = await dispatch("nope", {}, rpcContext);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error?.code, "plugin-harbor/unknown-method");
  const failed = await dispatch("boom", {}, rpcContext);
  assert.equal(failed.ok, false);
  assert.equal(failed.error?.code, "plugin-harbor/error");
  assert.match(String(failed.error?.message), /redacted/);
  assert.doesNotMatch(String(failed.error?.message), /abcd1234/);
});

test("redact strips secrets and bounds the message", () => {
  assert.equal(redact(Error("cookie=xyz failed")), "cookie=[redacted] failed");
  assert.equal(redact("Authorization: Bearer abc"), "Authorization: [redacted] abc");
  assert.equal(redact("x".repeat(500)).length, 200);
});