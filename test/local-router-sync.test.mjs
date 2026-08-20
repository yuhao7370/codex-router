import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dir = mkdtempSync(path.join(os.tmpdir(), "cr-local-router-sync-"));
process.env.CODEX_ROUTER_STATE_DIR = dir;

const { mergeLocalRouterModels, planLocalRouterRemovals } = await import(
  "../src/local-router-sync.mjs"
);

test("folds new local-router models into user models and keeps others", () => {
  const existing = [
    {
      slug: "local-router/glm-5.2",
      upstreamModel: "glm-5.2",
      provider: "local-router",
      listed: true,
      gatewayModel: "local-router-glm-5-2",
      displayName: "glm-5.2 (curated)",
      description: "curated",
      priority: 100,
      defaultEffort: "high",
      reasoningLevels: [{ effort: "high", description: "Deep reasoning" }],
      contextWindow: 1000000,
      autoCompact: 850000,
      inputModalities: ["text"],
      compHash: "local-router-glm-5-2-user-v1",
    },
    {
      slug: "deepseek/deepseek-v4-flash",
      upstreamModel: "deepseek-v4-flash",
      provider: "deepseek",
      listed: true,
      gatewayModel: "deepseek-deepseek-v4-flash",
      displayName: "deepseek-v4-flash",
      description: "deepseek",
      priority: 50,
      defaultEffort: "high",
      reasoningLevels: [{ effort: "high", description: "Deep reasoning" }],
      contextWindow: 128000,
      autoCompact: 100000,
      inputModalities: ["text"],
      compHash: "deepseek-deepseek-v4-flash-v1",
    },
  ];

  const result = mergeLocalRouterModels({
    existing,
    unregistered: ["glm-5.3", "glm-5.2"],
    metadataById: {
      "glm-5.3": {
        contextWindow: 1000000,
        autoCompact: 850000,
        inputModalities: ["text", "image"],
        reasoningLevels: [{ effort: "high", description: "Deep reasoning" }],
        defaultEffort: "high",
      },
    },
  });

  assert.deepEqual(result.added, ["glm-5.3"], "glm-5.2 is already curated");
  assert.equal(result.total, 2, "one existing local-router model plus the new one");
  assert.equal(result.models.length, 3, "local-router models plus the deepseek one");

  const added = result.models.find((model) => model.upstreamModel === "glm-5.3");
  assert.ok(added, "glm-5.3 was added");
  assert.equal(added.slug, "local-router/glm-5.3");
  assert.equal(added.gatewayModel, "local-router-glm-5-3");
  assert.equal(added.provider, "local-router");
  assert.deepEqual(added.inputModalities, ["text", "image"]);
  assert.equal(added.contextWindow, 1000000);

  const kept = result.models.find((model) => model.upstreamModel === "deepseek-v4-flash");
  assert.ok(kept, "non-local-router models are preserved");
});

test("no-op when every discovered model is already curated", () => {
  const existing = [
    {
      slug: "local-router/glm-5.2",
      upstreamModel: "glm-5.2",
      provider: "local-router",
      listed: true,
      gatewayModel: "local-router-glm-5-2",
      displayName: "glm-5.2 (curated)",
      description: "curated",
      priority: 100,
      defaultEffort: "high",
      reasoningLevels: [{ effort: "high", description: "Deep reasoning" }],
      contextWindow: 1000000,
      autoCompact: 850000,
      inputModalities: ["text"],
      compHash: "local-router-glm-5-2-user-v1",
    },
  ];

  const result = mergeLocalRouterModels({
    existing,
    unregistered: ["glm-5.2"],
    metadataById: {},
  });

  assert.deepEqual(result.added, []);
  assert.equal(result.models.length, 1);
});

test("prunes local-router models the service no longer advertises", () => {
  const existing = [
    {
      slug: "local-router/glm-5.1",
      upstreamModel: "glm-5.1",
      provider: "local-router",
      listed: true,
      gatewayModel: "local-router-glm-5-1",
      displayName: "glm-5.1 (curated)",
      description: "curated",
      priority: 100,
      defaultEffort: "high",
      reasoningLevels: [{ effort: "high", description: "Deep reasoning" }],
      contextWindow: 1000000,
      autoCompact: 850000,
      inputModalities: ["text"],
      compHash: "local-router-glm-5-1-user-v1",
    },
    {
      slug: "local-router/glm-5.3",
      upstreamModel: "glm-5.3",
      provider: "local-router",
      listed: true,
      gatewayModel: "local-router-glm-5-3",
      displayName: "glm-5.3 (curated)",
      description: "curated",
      priority: 101,
      defaultEffort: "high",
      reasoningLevels: [{ effort: "high", description: "Deep reasoning" }],
      contextWindow: 1000000,
      autoCompact: 850000,
      inputModalities: ["text"],
      compHash: "local-router-glm-5-3-user-v1",
    },
    {
      slug: "deepseek/deepseek-v4-flash",
      upstreamModel: "deepseek-v4-flash",
      provider: "deepseek",
      listed: true,
      gatewayModel: "deepseek-deepseek-v4-flash",
      displayName: "deepseek-v4-flash",
      description: "deepseek",
      priority: 50,
      defaultEffort: "high",
      reasoningLevels: [{ effort: "high", description: "Deep reasoning" }],
      contextWindow: 128000,
      autoCompact: 100000,
      inputModalities: ["text"],
      compHash: "deepseek-deepseek-v4-flash-v1",
    },
  ];

  const result = planLocalRouterRemovals({
    existing,
    available: ["glm-5.3"],
  });

  assert.deepEqual(result.removed, ["glm-5.1"]);
  assert.equal(result.total, 1);
  assert.equal(result.models.length, 2, "glm-5.1 removed, glm-5.3 + deepseek kept");
  assert.ok(
    result.models.every((model) => model.upstreamModel !== "glm-5.1"),
    "delisted model is gone",
  );
  assert.ok(
    result.models.some((model) => model.provider === "deepseek"),
    "non-local-router models are preserved",
  );
});
