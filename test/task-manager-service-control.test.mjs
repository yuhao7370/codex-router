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

test("healthy Router status skips the slow service probe and unhealthy status falls back", async () => {
  let healthy = true;
  let serviceReads = 0;
  const controller = createRouterServiceController({
    readHealth: async () => ({ ok: healthy }),
    readServiceStatus: async () => {
      serviceReads += 1;
      return { installed: true, loaded: true, state: "running" };
    },
  });

  assert.equal((await controller.snapshot()).state, "running");
  assert.equal(serviceReads, 0);
  healthy = false;
  assert.equal((await controller.snapshot()).state, "unhealthy");
  assert.equal(serviceReads, 1);
});

test("service actions are allowlisted and overlap is rejected", async () => {
  let release;
  let healthReads = 0;
  const running = new Promise((resolve) => { release = resolve; });
  const controller = createRouterServiceController({
    runServiceCommand: async () => running,
    readServiceStatus: async () => ({ installed: true, loaded: true, state: "running" }),
    readHealth: async () => { healthReads += 1; return { ok: true }; },
  });

  const first = controller.perform("restart");
  assert.equal(controller.currentOperation()?.action, "restart");
  assert.equal((await controller.snapshot()).state, "restarting");
  assert.equal(healthReads, 0);
  await assert.rejects(() => controller.perform("stop"), /already running/i);
  await assert.rejects(() => controller.perform("delete"), /unknown router service action/i);
  release();
  assert.equal((await first).state, "running");
  assert.equal(healthReads, 1);
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

test("snapshot uses fixed observation failures without credential-shaped details", async () => {
  const secrets = [
    "test-caller-secret-0123456789abcdef",
    "ctm-token-sentinel-0123456789abcdef",
    "access-token-sentinel-0123456789abcdef",
    "sk-provider-sentinel-0123456789abcdef",
  ];
  const controller = createRouterServiceController({
    readServiceStatus: async () => {
      throw new Error(secrets.join(" "));
    },
    readHealth: async () => { throw new Error(secrets.join(" ")); },
  });

  const result = await controller.snapshot();
  assert.equal(result.state, "failed");
  assert.equal(result.serviceError, "Router service status unavailable.");
  assert.equal(result.healthError, "Router health unavailable.");
  for (const secret of secrets) assert.equal(JSON.stringify(result).includes(secret), false);
});
