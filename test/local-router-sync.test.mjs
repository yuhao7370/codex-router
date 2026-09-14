import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dir = mkdtempSync(path.join(os.tmpdir(), "cr-local-router-sync-"));
process.env.CODEX_ROUTER_STATE_DIR = dir;

process.env.CODEX_HOME = path.join(process.env.CODEX_ROUTER_STATE_DIR, "codex");
const {
  cleanLocalRouterModels,
  mergeLocalRouterModels,
  planLocalRouterRemovals,
  syncLocalRouterModels,
} = await import(
  "../src/local-router-sync.mjs"
);

test("sync and cleanup bypass the provider catalog cache", async () => {
  const calls = [];
  const discover = async (...args) => {
    calls.push(args);
    return { discovered: [], metadataById: {}, unavailable: [], unregistered: [] };
  };

  await syncLocalRouterModels({ discover });
  await cleanLocalRouterModels({ discover });

  assert.deepEqual(calls, [
    ["local-router", { refresh: true }],
    ["local-router", { refresh: true }],
  ]);
});

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

test("sync uses fresh discovery IDs rather than the process registry's stale unregistered list", async () => {
  const { readUserModels, writeUserModels, userModelEntry } = await import("../src/user-models.mjs");
  const tuned = userModelEntry({ providerId: "local-router", upstreamId: "test-tuned", priority: 100,
    metadata: { contextWindow: 999999, displayName: "My tuned model" } });
  writeUserModels([tuned]);
  const result = await syncLocalRouterModels({ discover: async () => ({
    discovered: ["test-tuned", "test-fresh-a", "test-fresh-b", "test-fresh-a"],
    unregistered: [], metadataById: {}, unavailable: [],
  }) });
  assert.deepEqual(result.added, ["test-fresh-a", "test-fresh-b"]);
  assert.deepEqual(readUserModels().find((model) => model.upstreamModel === "test-tuned"), tuned);
});

test("sync makes new discoveries visible and retains a subsequent explicit hide", async () => {
  const { readVisibleModels, readHiddenModels, setModelVisible } = await import("../src/model-picker-state.mjs");
  const discover = async () => ({ discovered: ["test-default-visible"], unregistered: [], metadataById: {}, unavailable: [] });
  await syncLocalRouterModels({ discover });
  assert.ok(readVisibleModels().has("local-router/test-default-visible"));
  setModelVisible("local-router/test-default-visible", false);
  await syncLocalRouterModels({ discover });
  assert.ok(readHiddenModels().has("local-router/test-default-visible"));
  assert.ok(!readVisibleModels().has("local-router/test-default-visible"));
});

test("sync never prunes temporarily absent user models", async () => {
  const { readUserModels, writeUserModels, userModelEntry } = await import("../src/user-models.mjs");
  const absent = userModelEntry({ providerId: "local-router", upstreamId: "test-temporarily-offline", priority: 100 });
  writeUserModels([absent]);
  await syncLocalRouterModels({ discover: async () => ({
    discovered: [], unregistered: [], metadataById: {}, unavailable: [],
  }) });
  assert.deepEqual(readUserModels(), [absent]);
});

test("sync re-reads user edits after acquiring the shared overlay lock", async () => {
  const { withModelOverlayLock } = await import("../src/model-overlay-lock.mjs");
  const { readUserModels, writeUserModels, userModelEntry } = await import("../src/user-models.mjs");
  let release;
  let entered;
  const acquired = new Promise((resolve) => { entered = resolve; });
  const held = withModelOverlayLock(async () => {
    entered();
    await new Promise((resolve) => { release = resolve; });
    writeUserModels([userModelEntry({ providerId: "deepseek", upstreamId: "concurrent-edit", priority: 100 })]);
  });
  await acquired;
  const syncing = syncLocalRouterModels({ discover: async () => ({
    discovered: ["concurrent-discovery"], unregistered: [], metadataById: {}, unavailable: [],
  }) });
  release();
  await Promise.all([held, syncing]);
  assert.deepEqual(readUserModels().map((model) => model.upstreamModel), ["concurrent-edit", "concurrent-discovery"]);
});
