import assert from "node:assert/strict";
import test from "node:test";

import { createTaskManagerRuntimeClient } from "../src/task-manager-runtime-client.mjs";

const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";

test("runtime client uses only the protected task-manager leaf", async () => {
  const seen = [];
  const client = createTaskManagerRuntimeClient({
    routerPort: 4202,
    callerSecret: CALLER_KEY,
    fetchImpl: async (url, options) => {
      seen.push({ url: String(url), method: options?.method || "GET", options });
      return new Response(JSON.stringify({ account: null }), { status: 200 });
    },
  });

  await client.snapshot();
  await client.reload();

  assert.deepEqual(seen.map((entry) => entry.method), ["GET", "POST"]);
  assert.ok(
    seen.every((entry) =>
      entry.url.includes(`/_codex-router/${CALLER_KEY}/task-manager/`),
    ),
  );
  assert.equal(seen[1].options.headers["content-type"], "application/json");
  assert.equal(seen[1].options.body, "{}");
});

test("runtime client surfaces the Router error response", async () => {
  const client = createTaskManagerRuntimeClient({
    callerSecret: CALLER_KEY,
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { message: "runtime unavailable" } }), {
        status: 503,
      }),
  });

  await assert.rejects(client.snapshot(), /runtime unavailable/);
});
