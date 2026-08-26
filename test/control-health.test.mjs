import assert from "node:assert/strict";
import test from "node:test";

import { readControlHealth } from "../src/control-health.mjs";

const CALLER_SECRET = "test-caller-secret-0123456789abcdef";

test("control health preserves the safe UI contract without returning capability data", async () => {
  const requests = [];
  const result = await readControlHealth({
    routerPort: 43210,
    readCallerSecret: () => `${CALLER_SECRET}\n`,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          service: "codex-router",
          version: "test-version",
          router: "ready",
          taskManagerMode: "standalone",
          degraded: ["gateway"],
          activity: { state: "generating", activeCount: 1, active: [{ model: "test/model" }] },
          gateway: { reachable: false, enabled: true, credential: CALLER_SECRET },
          oauth: { reachable: true, session: CALLER_SECRET },
          api: { reachable: true },
          grokOauth: { reachable: true, enabled: false },
          credential: CALLER_SECRET,
          callerUrl: `http://127.0.0.1:43210/${CALLER_SECRET}`,
          pid: 4321,
          sourceRoot: `C:/private/${CALLER_SECRET}`,
        }),
      };
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `http://127.0.0.1:43210/_codex-router/${CALLER_SECRET}/v1/health`);
  assert.deepEqual(requests[0].options.headers, { Accept: "application/json" });
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  assert.deepEqual(result, {
    ok: true,
    status: 200,
    service: "codex-router",
    version: "test-version",
    router: "ready",
    taskManagerMode: "standalone",
    degraded: ["gateway"],
    activity: { state: "generating", activeCount: 1, active: [{ model: "test/model" }] },
    gateway: { reachable: false, enabled: true },
    oauth: { reachable: true },
    api: { reachable: true },
    grokOauth: { reachable: true, enabled: false },
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(CALLER_SECRET));
  assert.equal("pid" in result, false);
  assert.equal("sourceRoot" in result, false);
});

test("control health projects only recognized Task Manager topology modes", async () => {
  for (const [taskManagerMode, expected] of [
    ["standalone", "standalone"],
    ["embedded", "embedded"],
    ["unknown", undefined],
    [CALLER_SECRET, undefined],
    [null, undefined],
  ]) {
    const result = await readControlHealth({
      readCallerSecret: () => CALLER_SECRET,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ service: "codex-router", taskManagerMode }),
      }),
    });
    assert.equal(result.taskManagerMode, expected);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(CALLER_SECRET));
  }
});

test("control health fails closed before fetch when the caller capability is unavailable", async () => {
  let fetches = 0;
  const result = await readControlHealth({
    readCallerSecret: () => "invalid",
    fetchImpl: async () => {
      fetches += 1;
      throw new Error("fetch must not run");
    },
  });

  assert.equal(fetches, 0);
  assert.deepEqual(result, {
    ok: false,
    status: 0,
    error: "The local router caller key is unavailable.",
    activity: { state: "offline", active: [], activeCount: 0 },
  });
});

test("control health preserves unreachable and timeout projections", async () => {
  const unreachable = await readControlHealth({
    readCallerSecret: () => CALLER_SECRET,
    fetchImpl: async () => { throw new Error("planned transport failure"); },
  });
  const timeout = await readControlHealth({
    readCallerSecret: () => CALLER_SECRET,
    fetchImpl: async () => { throw Object.assign(new Error("planned timeout"), { name: "TimeoutError" }); },
  });

  assert.equal(unreachable.error, "Router is unreachable.");
  assert.equal(timeout.error, "Health check timed out.");
  assert.deepEqual(unreachable.activity, { state: "offline", active: [], activeCount: 0 });
  assert.deepEqual(timeout.activity, { state: "offline", active: [], activeCount: 0 });
});
