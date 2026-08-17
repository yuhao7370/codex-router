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
