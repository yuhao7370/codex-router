import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dir = mkdtempSync(path.join(os.tmpdir(), "cr-task-manager-router-api-"));
process.env.CODEX_ROUTER_STATE_DIR = dir;
process.env.CODEX_HOME = dir;

const {
  handleTaskManagerRouterRequest,
  isTaskManagerRouterRoute,
} = await import("../src/task-manager-router-api.mjs");

const runtime = {
  account: null,
  pool: { ids: [], accounts: [], blocked: {} },
  failover: { enabled: false, lastFailoverAt: null, lastFailover: null },
  errors: [],
  injections: { count: 0, recent: [] },
};

async function invoke(method, route) {
  const request = { method };
  const response = {};
  const handled = await handleTaskManagerRouterRequest(request, response, route, {
    writeJson(target, status, body) {
      target.status = status;
      target.body = body;
    },
  });
  return { handled, ...response };
}

test("runtime is read-only and reload accepts POST only", async () => {
  assert.equal(isTaskManagerRouterRoute("/task-manager/runtime"), true);
  assert.equal(isTaskManagerRouterRoute("/task-manager/reload"), true);
  assert.equal(isTaskManagerRouterRoute("/task-manager/unknown"), false);
  assert.deepEqual(await invoke("GET", "/task-manager/runtime"), {
    handled: true,
    status: 200,
    body: runtime,
  });
  assert.equal((await invoke("GET", "/task-manager/reload")).status, 405);
  assert.deepEqual(await invoke("POST", "/task-manager/reload"), {
    handled: true,
    status: 200,
    body: runtime,
  });
});
