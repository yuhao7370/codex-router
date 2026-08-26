import assert from "node:assert/strict";
import test from "node:test";

import {
  createRouterServiceController,
  routerServiceLifecycle,
} from "../src/task-manager-service-control.mjs";

test("lifecycle distinguishes stopped, running, and unhealthy", () => {
  assert.equal(routerServiceLifecycle({ service: { installed: true, loaded: false }, health: { ok: false } }), "stopped");
  assert.equal(routerServiceLifecycle({ service: { installed: true, loaded: true }, health: { ok: true } }), "running");
  assert.equal(routerServiceLifecycle({ service: { installed: true, loaded: true }, health: { ok: false } }), "unhealthy");
  assert.equal(routerServiceLifecycle({ operation: { action: "restart" } }), "restarting");
  assert.equal(routerServiceLifecycle({ serviceError: "scheduler unavailable", health: { ok: false } }), "failed");
});

test("service actions are allowlisted and overlap is rejected", async () => {
  let release;
  const running = new Promise((resolve) => { release = resolve; });
  const controller = createRouterServiceController({
    runServiceCommand: async () => running,
    readServiceStatus: async () => ({ installed: true, loaded: true, state: "running" }),
    readHealth: async () => ({ ok: true }),
  });

  const first = controller.perform("restart");
  assert.equal(controller.currentOperation()?.action, "restart");
  assert.equal((await controller.snapshot()).state, "restarting");
  await assert.rejects(() => controller.perform("stop"), /already running/i);
  await assert.rejects(() => controller.perform("delete"), /unknown router service action/i);
  release();
  assert.equal((await first).state, "running");
  assert.equal(controller.currentOperation(), null);
});

test("failed operations release the controller for a later action", async () => {
  let attempts = 0;
  const controller = createRouterServiceController({
    runServiceCommand: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("planned failure");
    },
    readServiceStatus: async () => ({ installed: true, loaded: false }),
    readHealth: async () => ({ ok: false }),
  });

  await assert.rejects(() => controller.perform("start"), /planned failure/);
  assert.equal(controller.currentOperation(), null);
  assert.equal((await controller.perform("start")).state, "stopped");
});

test("snapshot redacts caller URLs in observation failures", async () => {
  const secret = "test-caller-secret-0123456789abcdef";
  const controller = createRouterServiceController({
    readServiceStatus: async () => {
      throw new Error(`status failed at http://127.0.0.1:4202/_codex-router/${secret}/v1/status`);
    },
    readHealth: async () => ({ ok: false }),
  });

  const result = await controller.snapshot();
  assert.equal(result.state, "failed");
  assert.doesNotMatch(result.serviceError, new RegExp(secret));
  assert.match(result.serviceError, /\[REDACTED\]/);
});
