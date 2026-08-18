import test from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
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
