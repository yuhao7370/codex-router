import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { taskManagerPath } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";

const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";
const stateDir = mkdtempSync(path.join(os.tmpdir(), "task-manager-ui-server-"));
const isolatedLegacyPort = await openPort();
process.env.CODEX_HOME = stateDir;
process.env.CODEX_ROUTER_STATE_DIR = stateDir;
process.env.CODEX_ROUTER_CONTROL_PORT = String(isolatedLegacyPort);
process.env.LOCALAPPDATA = stateDir;

const { startTaskManagerUi } = await import("../src/task-manager-ui.mjs");

test.after(() => rmSync(stateDir, { recursive: true, force: true }));

function dependencies(overrides = {}) {
  const calls = [];
  const runtime = {
    account: null,
    pool: { ids: [], accounts: [], blocked: {} },
    failover: { enabled: false, lastFailoverAt: null, lastFailover: null },
    errors: [],
    injections: { count: 0, recent: [] },
  };
  return {
    calls,
    runtime,
    runtimeClient: {
      snapshot: async () => runtime,
      reload: async () => runtime,
      ...overrides.runtimeClient,
    },
    serviceController: {
      snapshot: async () => ({ state: "running" }),
      perform: async (action) => {
        calls.push(action);
        return { state: action === "stop" ? "stopped" : "running" };
      },
      ...overrides.serviceController,
    },
  };
}

async function start(options) {
  const server = startTaskManagerUi({ port: 0, ...options });
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  assert.ok(typeof address === "object" && address);
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

test("standalone routes require the caller capability and send hardened responses", async () => {
  const deps = dependencies();
  const { server, origin } = await start({
    mode: "standalone",
    callerSecret: CALLER_KEY,
    ...deps,
  });

  try {
    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true,
      service: "codex-router-task-manager",
      mode: "standalone",
      pid: process.pid,
    });
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.match(health.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(health.headers.get("referrer-policy"), "no-referrer");
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");
    assert.equal(health.headers.get("access-control-allow-origin"), null);

    assert.equal((await fetch(`${origin}/`)).status, 401);
    const capabilityUrl = `${origin}${taskManagerPath(CALLER_KEY)}`;
    const page = await fetch(capabilityUrl);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    const pageHtml = await page.text();
    for (const match of pageHtml.matchAll(/(?:href|src)=["']([^"']+)["']/g)) {
      const asset = new URL(match[1], capabilityUrl);
      assert.ok(asset.pathname.startsWith(taskManagerPath(CALLER_KEY)), asset.pathname);
      assert.equal((await fetch(asset)).status, 200, asset.pathname);
    }
    assert.equal(
      (
        await fetch(
          `${origin}${taskManagerPath("wrong-caller-capability-with-sufficient-length")}`,
        )
      ).status,
      401,
    );
  } finally {
    await close(server);
  }
});

test("standalone POST routes require same-origin JSON before service control", async () => {
  const deps = dependencies();
  const { server, origin } = await start({
    mode: "standalone",
    callerSecret: CALLER_KEY,
    ...deps,
  });
  const restartUrl = `${origin}${taskManagerPath(CALLER_KEY)}api/router/restart`;

  try {
    assert.equal(
      (
        await fetch(restartUrl, {
          method: "POST",
          headers: { origin: "https://example.invalid", "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(deps.calls.length, 0);

    assert.equal(
      (
        await fetch(restartUrl, {
          method: "POST",
          headers: { "sec-fetch-site": "cross-site", "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(deps.calls.length, 0);

    assert.equal((await fetch(restartUrl, { method: "POST", body: "{}" })).status, 415);
    assert.equal(deps.calls.length, 0);

    const accepted = await fetch(restartUrl, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(deps.calls, ["restart"]);
  } finally {
    await close(server);
  }
});

test("standalone status uses Router runtime and reports it unavailable when offline", async () => {
  let online = true;
  let reloads = 0;
  const deps = dependencies({
    runtimeClient: {
      snapshot: async () => {
        if (!online) throw new Error("Router stopped");
        return {
          account: { accountId: "router-account" },
          pool: { ids: ["router-account"], accounts: [], blocked: {} },
          failover: { enabled: true },
          errors: [{ message: "router error" }],
          injections: { count: 3, recent: [] },
        };
      },
      reload: async () => {
        reloads += 1;
      },
    },
  });
  const { server, origin } = await start({
    mode: "standalone",
    callerSecret: CALLER_KEY,
    ...deps,
  });
  const apiBase = `${origin}${taskManagerPath(CALLER_KEY)}api/`;

  try {
    const onlineStatus = await fetch(`${apiBase}status`).then((response) => response.json());
    assert.deepEqual(onlineStatus.routerRuntime, { available: true });
    assert.equal(onlineStatus.account.accountId, "router-account");
    assert.equal(onlineStatus.injections.count, 3);

    const mutation = await fetch(`${apiBase}disable`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then((response) => response.json());
    assert.deepEqual(mutation.runtimeRefresh, { ok: true });
    assert.equal(reloads, 1);

    online = false;
    const offlineStatus = await fetch(`${apiBase}status`).then((response) => response.json());
    assert.deepEqual(offlineStatus.routerRuntime, { available: false });
    assert.equal(offlineStatus.account, null);
    assert.deepEqual(offlineStatus.errors, []);
    assert.equal(offlineStatus.injections.count, 0);
    assert.deepEqual(offlineStatus.pool.ids, []);

    deps.runtimeClient.reload = async () => {
      throw new Error(
        `Router at http://127.0.0.1/_codex-router/${CALLER_KEY}/task-manager/reload stopped`,
      );
    };
    const savedOffline = await fetch(`${apiBase}pool`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ["saved-while-offline"] }),
    }).then((response) => response.json());
    assert.equal(savedOffline.runtimeRefresh.ok, false);
    assert.doesNotMatch(savedOffline.runtimeRefresh.error, new RegExp(CALLER_KEY));
    assert.match(savedOffline.runtimeRefresh.error, /\[REDACTED\]/);
    assert.deepEqual(savedOffline.pool.ids, ["saved-while-offline"]);
  } finally {
    await close(server);
  }
});

test("standalone configuration mutations never refresh the host bridge runtime", async () => {
  const requests = [];
  const ctm = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ account_id: "host-cache", access_token: "must-not-load" }));
  });
  await new Promise((resolve, reject) => {
    ctm.once("error", reject);
    ctm.listen(0, "127.0.0.1", resolve);
  });
  const address = ctm.address();
  assert.ok(typeof address === "object" && address);
  let reloads = 0;
  const deps = dependencies({
    runtimeClient: { reload: async () => { reloads += 1; } },
  });
  const { server, origin } = await start({
    mode: "standalone",
    callerSecret: CALLER_KEY,
    ...deps,
  });
  const apiBase = `${origin}${taskManagerPath(CALLER_KEY)}api/`;
  const post = (leaf, body = {}) => fetch(`${apiBase}${leaf}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  try {
    assert.equal((await post("disable")).status, 200);
    assert.equal((await post("port", { port: address.port })).status, 200);
    assert.equal((await post("token", { token: "manager-secret" })).status, 200);
    assert.equal((await post("enable")).status, 200);
    assert.deepEqual(requests, []);
    assert.equal(reloads, 4);

    assert.equal((await post("failover", { enabled: false })).status, 200);
    assert.equal(reloads, 5, "standalone failover changes must reload Router memory");
  } finally {
    await post("disable").catch(() => {});
    await close(server);
    await close(ctm);
  }
});

test("embedded mode keeps root routes and hides Router lifecycle routes", async () => {
  const deps = dependencies();
  const { server, origin } = await start({ mode: "embedded", ...deps });

  try {
    assert.equal((await fetch(`${origin}/`)).status, 200);
    assert.equal((await fetch(`${origin}/api/router/status`)).status, 404);
    assert.equal(deps.calls.length, 0);
  } finally {
    await close(server);
  }
});
