import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// Isolate the bridge's state directory before it computes STATE_DIR.
const dir = mkdtempSync(path.join(os.tmpdir(), "cr-task-manager-"));
process.env.CODEX_ROUTER_STATE_DIR = dir;
process.env.CODEX_HOME = dir;

const bridge = await import("../src/task-manager-bridge.mjs");

test("task manager defaults to disabled on port 6000", () => {
  const config = bridge.readTaskManagerConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.port, 6000);
  assert.equal(config.token, "");
});

test("task manager port setter validates its range", () => {
  assert.throws(() => bridge.setTaskManagerPort(0));
  assert.throws(() => bridge.setTaskManagerPort(70_000));
  bridge.setTaskManagerPort(6001);
  assert.equal(bridge.readTaskManagerConfig().port, 6001);
});

test("task manager enable persists", () => {
  bridge.setTaskManagerEnabled(true);
  assert.equal(bridge.readTaskManagerConfig().enabled, true);
  bridge.setTaskManagerEnabled(false);
  assert.equal(bridge.readTaskManagerConfig().enabled, false);
});

test("task manager failover toggle persists and defaults off", () => {
  assert.equal(bridge.readTaskManagerConfig().failover, false);
  assert.equal(bridge.failoverStatus().enabled, false);
  bridge.setTaskManagerFailover(true);
  assert.equal(bridge.readTaskManagerConfig().failover, true);
  assert.equal(bridge.failoverStatus().enabled, true);
  bridge.setTaskManagerFailover(false);
  assert.equal(bridge.readTaskManagerConfig().failover, false);
});

test("notifyAccountFailure ignores non-trigger statuses", () => {
  bridge.setTaskManagerFailover(true);
  // A 200/500 must not queue a failover; it just returns without throwing.
  bridge.notifyAccountFailure(200);
  bridge.notifyAccountFailure(500);
  bridge.setTaskManagerFailover(false);
});

test("task manager pool persists and defaults empty", () => {
  assert.deepEqual(bridge.readTaskManagerConfig().pool, []);
  assert.deepEqual(bridge.poolStatus().ids, []);
  bridge.setTaskManagerPool(["a", "b"]);
  assert.deepEqual(bridge.readTaskManagerConfig().pool, ["a", "b"]);
  assert.deepEqual(bridge.poolStatus().ids, ["a", "b"]);
  bridge.setTaskManagerPool([]);
  assert.deepEqual(bridge.readTaskManagerConfig().pool, []);
});

test("blocked accounts default empty and can be cleared", () => {
  assert.deepEqual(bridge.readTaskManagerConfig().blocked, {});
  assert.deepEqual(bridge.poolStatus().blocked, {});
  bridge.clearBlockedAccount("some-id");
  assert.deepEqual(bridge.readTaskManagerConfig().blocked, {});
});

test("error log defaults empty and clears", () => {
  assert.deepEqual(bridge.errorLog(), []);
  bridge.clearErrorLog();
  assert.deepEqual(bridge.errorLog(), []);
});

test("failure attribution accepts the request's injected account", () => {
  bridge.setTaskManagerEnabled(true);
  bridge.notifyAccountFailure(429, false, false, "seat-from-request");
  assert.equal(bridge.errorLog()[0].accountId, "seat-from-request");
  bridge.clearErrorLog();
  bridge.setTaskManagerEnabled(false);
});

test("runtime snapshots omit credentials and reread the shared error log", async () => {
  const server = http.createServer((_request, response) => {
    const body = JSON.stringify({
      account_id: "account-1",
      email: "account@example.com",
      access_token: "upstream-secret",
      usage: {
        plan: "pro",
        weekly_used_percent: 25,
        fetched_at: 1_777_000_000,
      },
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    assert.ok(typeof address === "object" && address);
    bridge.setTaskManagerPort(address.port);
    bridge.setTaskManagerToken("manager-secret");
    bridge.setTaskManagerEnabled(true);
    await bridge.refreshActiveAccount();
    writeFileSync(
      path.join(dir, "task-manager-errors.jsonl"),
      `${JSON.stringify({ at: "2026-08-26T00:00:00.000Z", type: "capacity", message: "full" })}\n`,
    );

    const snapshot = bridge.taskManagerRuntimeSnapshot();
    assert.deepEqual(snapshot.account, {
      accountId: "account-1",
      email: "account@example.com",
      plan: "pro",
      remainingPercent: 75,
      fetchedAt: 1_777_000_000,
    });
    assert.equal(snapshot.errors[0].message, "full");
    assert.equal(JSON.stringify(snapshot).includes("accessToken"), false);
    assert.equal(JSON.stringify(snapshot).includes("access_token"), false);
    assert.equal(JSON.stringify(snapshot).includes("upstream-secret"), false);
    assert.equal(JSON.stringify(snapshot).includes("manager-secret"), false);
  } finally {
    bridge.setTaskManagerEnabled(false);
    bridge.setTaskManagerToken("");
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runtime mutation suppression leaves host caches untouched until Router reload", async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    let body;
    if (request.url === "/api/auth/current") {
      body = {
        id: "current-id",
        account_id: "current-account",
        email: "current@example.com",
        access_token: "current-secret",
        usage: { plan: "pro", weekly_used_percent: 20 },
      };
    } else if (request.url === "/api/auth/credentials") {
      body = {
        accounts: [{
          id: "pool-1",
          account_id: "pool-account",
          email: "pool@example.com",
          access_token: "pool-secret",
          usage: { plan: "pro", weekly_used_percent: 10 },
        }],
      };
    } else {
      body = { ok: true, id: "mutated-account" };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(typeof address === "object" && address);
  const noRuntime = { updateRuntime: false };

  try {
    bridge.setTaskManagerPort(address.port, noRuntime);
    bridge.setTaskManagerToken("manager-secret", noRuntime);
    bridge.setTaskManagerEnabled(true, noRuntime);
    bridge.setTaskManagerPool(["pool-1"], noRuntime);
    bridge.setTaskManagerFailover(true, noRuntime);
    assert.deepEqual(
      {
        enabled: bridge.readTaskManagerConfig().enabled,
        token: bridge.readTaskManagerConfig().token,
        pool: bridge.readTaskManagerConfig().pool,
      },
      { enabled: true, token: "manager-secret", pool: ["pool-1"] },
    );
    await bridge.reloadTaskManagerRuntime();
    assert.equal(bridge.activeAccount().id, "current-id");
    assert.equal(bridge.poolStatus().accounts[0].accountId, "pool-1");

    requests.length = 0;
    await bridge.selectTaskManagerAccount("selected", noRuntime);
    assert.equal(bridge.activeAccount()?.id, "current-id", "suppressed select cleared cache");
    await bridge.importTaskManagerAccount({ tokens: {} }, noRuntime);
    assert.deepEqual(requests, [
      "/api/auth/switch?id=selected",
      "/api/auth/import",
    ]);
    assert.equal(bridge.activeAccount()?.id, "current-id", "suppressed import cleared cache");

    requests.length = 0;
    await bridge.selectTaskManagerAccount("selected");
    await bridge.importTaskManagerAccount({ tokens: {} });
    assert.deepEqual(requests, [
      "/api/auth/switch?id=selected",
      "/api/auth/current",
      "/api/auth/import",
      "/api/auth/current",
    ]);

    bridge.setTaskManagerPort(address.port);
    assert.equal(bridge.activeAccount(), null, "embedded setter must retain runtime effects");
    await bridge.reloadTaskManagerRuntime();

    assert.equal(bridge.nextInjectionAccount().id, "pool-1");
    bridge.notifyAccountFailure(429, false, false, "pool-1");
    assert.equal(bridge.nextInjectionAccount().id, "current-id");
    bridge.setTaskManagerFailover(false, noRuntime);
    assert.equal(bridge.nextInjectionAccount().id, "current-id");
    await bridge.reloadTaskManagerRuntime();
    assert.equal(
      bridge.nextInjectionAccount().id,
      "pool-1",
      "Router reload must clear disabled failover failure memory",
    );

    const beforeSuppressedWrites = requests.length;
    bridge.setTaskManagerEnabled(false, noRuntime);
    bridge.setTaskManagerPool([], noRuntime);
    bridge.setTaskManagerPort(address.port, noRuntime);
    bridge.setTaskManagerToken("manager-secret", noRuntime);
    assert.equal(requests.length, beforeSuppressedWrites);
    assert.equal(bridge.activeAccount().id, "current-id");
    assert.equal(bridge.poolStatus().accounts[0].accountId, "pool-1");

    await bridge.reloadTaskManagerRuntime();
    assert.equal(bridge.activeAccount(), null);
    assert.deepEqual(bridge.poolStatus().accounts, []);
  } finally {
    bridge.setTaskManagerEnabled(false);
    bridge.setTaskManagerPool([]);
    bridge.setTaskManagerFailover(false);
    bridge.setTaskManagerToken("");
    bridge.clearErrorLog();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("poll intervals default, persist, and clamp", () => {
  assert.equal(bridge.readTaskManagerConfig().logIntervalMs, 2000);
  assert.equal(bridge.readTaskManagerConfig().accountsIntervalMs, 15000);
  bridge.setTaskManagerIntervals({ logIntervalMs: 3000, accountsIntervalMs: 10000 });
  assert.equal(bridge.readTaskManagerConfig().logIntervalMs, 3000);
  assert.equal(bridge.readTaskManagerConfig().accountsIntervalMs, 10000);
  // Out-of-range values are clamped.
  bridge.setTaskManagerIntervals({ logIntervalMs: 10, accountsIntervalMs: 999999 });
  assert.equal(bridge.readTaskManagerConfig().logIntervalMs, 500);
  assert.equal(bridge.readTaskManagerConfig().accountsIntervalMs, 60000);
  bridge.setTaskManagerIntervals({ logIntervalMs: 2000, accountsIntervalMs: 15000 });
});
