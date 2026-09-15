import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate STATE_DIR before the pricing module (and its paths dependency) is
// first imported, so loadPricingIndex never reads the operator's real state.
const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-pricing-test-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;
process.env.CODEX_HOME = path.join(stateDir, "codex");

const pricing = await import(`../src/model-pricing.mjs?test=${Date.now()}`);

test.after(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

test("normalizes provider-qualified and decorated model ids", () => {
  assert.equal(
    pricing.normalizeModelIdForPricing("deepseek/deepseek-v4-flash"),
    "deepseek-v4-flash",
  );
  assert.equal(
    pricing.normalizeModelIdForPricing("OPENAI/GPT-5.5@HIGH"),
    "gpt-5.5-high",
  );
  assert.equal(
    pricing.normalizeModelIdForPricing("moonshotai/Kimi-K3"),
    "kimi-k3",
  );
  assert.equal(
    pricing.normalizeModelIdForPricing("deepseek-v4-flash:cloud"),
    "deepseek-v4-flash",
  );
  assert.equal(
    pricing.normalizeModelIdForPricing("gpt-5.6-sol"),
    "gpt-5.6-sol",
  );
});

test("generates dated and effort fallback candidates", () => {
  assert.ok(pricing.modelPricingCandidates("claude-opus-4-8-20260206").includes("claude-opus-4-8"));
  assert.ok(pricing.modelPricingCandidates("gpt-5.5-high").includes("gpt-5.5"));
});

test("resolves seeded official prices across name shapes", () => {
  const index = pricing.loadPricingIndex();

  const flash = pricing.findModelPricing("deepseek/deepseek-v4-flash", index);
  assert.equal(flash.input, 0.14);
  assert.equal(flash.output, 0.28);

  const luna = pricing.findModelPricing("commandcode/gpt-5.6-luna", index);
  assert.equal(luna.input, 0.2);
  assert.equal(luna.output, 1.2);

  const k3 = pricing.findModelPricing("kimi-oauth/k3", index);
  assert.equal(k3.input, 3);
  assert.equal(k3.output, 15);

  const datedOpus = pricing.findModelPricing("claude-opus-4-8-20260206", index);
  assert.equal(datedOpus.input, 5);
  assert.equal(datedOpus.output, 25);

  assert.equal(pricing.findModelPricing("unknown-model-123", index), undefined);
});

test("computes cost by subtracting cached input and applying per-million rates", () => {
  const cost = pricing.computeUsageCost(
    { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
    { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 200 },
  );
  // billable input = 800 -> 0.0008; output 500 -> 0.001; cache 200 -> 0.00002.
  assert.equal(cost.inputCost, 0.0008);
  assert.equal(cost.outputCost, 0.001);
  assert.equal(cost.cacheReadCost, 0.00002);
  assert.equal(cost.totalCost, 0.00182);
});

test("flattens models.dev payloads into normalized text-model pricing", () => {
  const flat = pricing.flattenModelsDevPricing({
    anthropic: {
      models: {
        "claude-opus-4-8": {
          name: "Claude Opus 4.8",
          cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
          modalities: { output: ["text"] },
        },
        "whisper-1": {
          name: "Whisper",
          cost: { input: 0.006, output: 0.006 },
          modalities: { output: ["audio"] },
        },
      },
    },
  });
  assert.equal(flat.get("claude-opus-4-8").input, 5);
  assert.equal(flat.has("whisper-1"), false);
});

test("persisted models.dev overrides win over seed while seed stays as fallback", () => {
  writeFileSync(
    pricing.MODEL_PRICING_PATH,
    JSON.stringify({
      version: 1,
      updatedAt: "2026-08-18T00:00:00.000Z",
      source: "models.dev",
      modelCount: 1,
      models: {
        "deepseek-v4-flash": { input: 999, output: 888, cacheRead: 0, cacheWrite: 0 },
      },
    }),
    "utf8",
  );

  const index = pricing.loadPricingIndex();
  assert.equal(index.get("deepseek-v4-flash").input, 999);
  assert.equal(index.get("claude-opus-4-8").input, 5);
  assert.equal(pricing.pricingSyncState().source, "models.dev");
});

test("Daybreak Blue uses Sol rates and costs across native and routed names", () => {
  const index = pricing.loadPricingIndex();
  const sol = pricing.findModelPricing("gpt-5.6-sol", index);
  const usage = { inputTokens: 2_000_000, outputTokens: 1_000_000, cachedInputTokens: 1_000_000 };
  for (const name of ["gpt-daybreak-blue-latest", "openai/gpt-daybreak-blue-latest", "local-router/anthropic/gpt-daybreak-blue-latest@high"]) {
    const blue = pricing.findModelPricing(name, index);
    assert.ok(blue, `missing price for ${name}`);
    assert.equal(blue.modelId, "gpt-daybreak-blue-latest");
    assert.equal(blue.displayName, "Daybreak Blue");
    assert.equal(blue.cacheWrite, sol.cacheWrite);
    assert.deepEqual(pricing.computeUsageCost(blue, usage), pricing.computeUsageCost(sol, usage));
  }
  assert.equal(pricing.findModelPricing("gpt-daybreak-red-latest", index), undefined);
});

test("Daybreak fallback follows synced Sol prices without replacing an explicit Daybreak price", () => {
  const sol = { input: 7, output: 21, cacheRead: 0.4, cacheWrite: 2 };
  const snapshot = (models) => writeFileSync(pricing.MODEL_PRICING_PATH, JSON.stringify({ version: 1, models }));
  snapshot({ "gpt-5.6-sol": sol });
  let blue = pricing.findModelPricing("gpt-daybreak-blue-latest");
  assert.ok(blue);
  for (const key of Object.keys(sol)) assert.equal(blue[key], sol[key]);
  snapshot({ "gpt-5.6-sol": sol, "gpt-daybreak-blue-latest": { ...sol, input: 11 } });
  blue = pricing.findModelPricing("gpt-daybreak-blue-latest");
  assert.equal(blue.input, 11);
  assert.equal(pricing.findModelPricing("gpt-5.6-sol").input, 7);
});
