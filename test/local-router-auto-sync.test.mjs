import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.CODEX_ROUTER_STATE_DIR = mkdtempSync(path.join(os.tmpdir(), "cr-local-auto-"));
process.env.CODEX_HOME = path.join(process.env.CODEX_ROUTER_STATE_DIR, "codex");
const { autoSyncLocalRouterModels, startLocalRouterAutoSync, localRouterAutoSyncEnabled } =
  await import("../src/local-router-auto-sync.mjs");
const { readUserModels } = await import("../src/user-models.mjs");

const discovery = (ids) => async () => ({ discovered: ids, unregistered: [], metadataById: {}, unavailable: [] });

test("automatic sync makes no request when disabled or unselected", async () => {
  assert.equal(localRouterAutoSyncEnabled({ disabled: () => true, selectionExists: () => true,
    selection: () => ({ providers: ["local-router"] }) }), false);
  assert.equal(localRouterAutoSyncEnabled({ disabled: () => false, selectionExists: () => false,
    selection: () => ({ providers: ["local-router"] }) }), false);
  assert.equal(localRouterAutoSyncEnabled({ disabled: () => false, selectionExists: () => true,
    selection: () => ({ providers: ["deepseek"] }) }), false);
  assert.equal(localRouterAutoSyncEnabled({ disabled: () => false, selectionExists: () => true,
    selection: () => ({ providers: ["local-router"], degraded: "invalid selection" }) }), false);
  const result = await autoSyncLocalRouterModels({ enabled: () => false,
    discover: () => assert.fail("must not discover"), publish: () => assert.fail("must not publish") });
  assert.equal(result.skipped, true);
});

test("failed publication retries the persisted models on the next fresh worker run", async () => {
  const statePath = path.join(process.env.CODEX_ROUTER_STATE_DIR, "retry.json");
  const options = { enabled: () => true, statePath, discover: discovery(["auto-first", "auto-second"]) };
  await assert.rejects(autoSyncLocalRouterModels({ ...options, publish: async () => { throw new Error("publication failed"); } }), /publication failed/);
  assert.ok(readUserModels().some((model) => model.upstreamModel === "auto-first"));
  assert.equal(existsSync(statePath), false);
  let publications = 0;
  const publish = async (request) => { publications += 1; assert.equal(request.restart, true); };
  await autoSyncLocalRouterModels({ ...options, publish });
  assert.equal(publications, 1);
  assert.ok(existsSync(statePath));
  await autoSyncLocalRouterModels({ ...options, publish });
  assert.equal(publications, 1, "unchanged successfully published model set is a no-op");
});

test("monitor runs immediately then every five minutes, has one detached hidden worker, and stops cleanly", async () => {
  const children = [];
  let tick;
  let cleared = false;
  let enabled = true;
  const monitor = startLocalRouterAutoSync({ enabled: () => enabled,
    spawn: (executable, args, options) => {
      assert.equal(options.detached, true);
      assert.equal(options.windowsHide, true);
      assert.equal(options.stdio, "ignore");
      assert.ok(args.includes("--worker"));
      const child = new EventEmitter(); child.unref = () => {}; children.push(child); return child;
    },
    setInterval: (callback, ms) => { assert.equal(ms, 300000); tick = callback; return { unref() {} }; },
    clearInterval: () => { cleared = true; },
  });
  assert.equal(children.length, 1);
  tick(); assert.equal(children.length, 1, "no concurrent workers");
  children[0].emit("exit", 0);
  enabled = false; tick(); assert.equal(children.length, 1);
  enabled = true; tick(); assert.equal(children.length, 2);
  monitor.stop(); assert.ok(cleared);
  children[1].emit("exit", 0); tick(); assert.equal(children.length, 2);
});

test("failed service reload also retries and a later discovery preserves hidden choices", async () => {
  const { setModelVisible, readHiddenModels } = await import("../src/model-picker-state.mjs");
  const statePath = path.join(process.env.CODEX_ROUTER_STATE_DIR, "reload-retry.json");
  const options = { enabled: () => true, statePath, discover: discovery(["auto-hidden"]) };
  await assert.rejects(autoSyncLocalRouterModels({ ...options, publish: async () => { throw new Error("reload failed"); } }), /reload failed/);
  setModelVisible("local-router/auto-hidden", false);
  let publications = 0;
  const publish = async () => { publications += 1; };
  await autoSyncLocalRouterModels({ ...options, publish });
  await autoSyncLocalRouterModels({ ...options, discover: discovery([]), publish });
  await autoSyncLocalRouterModels({ ...options, publish });
  assert.equal(publications, 1);
  assert.ok(readHiddenModels().has("local-router/auto-hidden"));
});

test("selection is checked again after discovery before writing or publishing", async () => {
  let checks = 0;
  const result = await autoSyncLocalRouterModels({
    enabled: () => ++checks === 1,
    discover: discovery(["must-not-write-after-deselect"]),
    publish: () => assert.fail("must not publish after deselection"),
  });
  assert.equal(result.skipped, true);
  assert.ok(!readUserModels().some((model) => model.upstreamModel === "must-not-write-after-deselect"));
});
