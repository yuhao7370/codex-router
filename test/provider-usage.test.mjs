import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateAccountUsage,
  aggregateProviderUsage,
  attachAccountCosts,
  attachUsageCosts,
  mergeDeletedAccounts,
} from "../src/provider-usage.mjs";

test("protocol variants never appear as separate usage providers", () => {
  const snapshot = aggregateProviderUsage([], { now: Date.parse("2026-07-21T18:00:00Z") });
  const ids = snapshot.providers.map((provider) => provider.id);
  assert.ok(ids.includes("opencode-go"));
  assert.ok(!ids.includes("opencode-go-messages"));
  assert.ok(!ids.includes("opencode-go-responses"));
  assert.ok(ids.includes("commandcode"));
  assert.ok(!ids.includes("commandcode-messages"));
});

test("aggregates tokens and calls independently for each provider", () => {
  const now = Date.parse("2026-07-21T18:00:00Z");
  const snapshot = aggregateProviderUsage(
    [
      {
        meteringVersion: 1,
        at: "2026-07-20T12:00:00Z",
        provider: "grok-oauth",
        status: 200,
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
      },
      {
        meteringVersion: 1,
        at: "2026-07-21T12:00:00Z",
        provider: "grok-oauth",
        status: 500,
      },
      {
        meteringVersion: 1,
        at: "2026-07-21T13:00:00Z",
        provider: "deepseek",
        status: 200,
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
      },
      {
        at: "2026-07-21T14:00:00Z",
        provider: "kimi-api",
        status: 200,
      },
    ],
    { days: 7, now },
  );
  const byId = Object.fromEntries(snapshot.providers.map((provider) => [provider.id, provider]));

  assert.equal(byId["grok-oauth"].credentialType, "oauth");
  assert.equal(byId["grok-oauth"].requests, 2);
  assert.equal(byId["grok-oauth"].successfulRequests, 1);
  assert.equal(byId["grok-oauth"].meteredRequests, 1);
  assert.equal(byId["grok-oauth"].totalTokens, 140);
  assert.deepEqual(byId["grok-oauth"].dailyUsageBuckets, [
    { startDate: "2026-07-20", tokens: 140, requests: 1 },
    { startDate: "2026-07-21", tokens: 0, requests: 1 },
  ]);
  assert.equal(byId.deepseek.credentialType, "api");
  assert.equal(byId.deepseek.totalTokens, 100);
  assert.equal(byId["kimi-api"].requests, 0);
  assert.equal(snapshot.scope, "local-router");
});

test("breaks provider usage down by model, heaviest first", () => {
  const now = Date.parse("2026-07-21T18:00:00Z");
  const snapshot = aggregateProviderUsage(
    [
      {
        meteringVersion: 1,
        at: "2026-07-20T12:00:00Z",
        provider: "deepseek",
        model: "deepseek/deepseek-v4-flash",
        status: 200,
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
      },
      {
        meteringVersion: 1,
        at: "2026-07-21T09:00:00Z",
        provider: "deepseek",
        model: "deepseek/deepseek-v4-pro",
        status: 200,
        inputTokens: 900,
        outputTokens: 100,
        totalTokens: 1_000,
      },
      {
        meteringVersion: 1,
        at: "2026-07-21T12:00:00Z",
        provider: "deepseek",
        model: "deepseek/deepseek-v4-flash",
        status: 500,
        inputTokens: 10,
        outputTokens: 0,
        totalTokens: 10,
      },
    ],
    { days: 7, now },
  );
  const deepseek = snapshot.providers.find((provider) => provider.id === "deepseek");

  assert.deepEqual(
    deepseek.models.map((model) => model.slug),
    ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"],
  );

  const flash = deepseek.models.find((model) => model.slug === "deepseek/deepseek-v4-flash");
  assert.equal(flash.displayName, "deepseek-v4-flash");
  assert.equal(flash.requests, 2);
  assert.equal(flash.successfulRequests, 1);
  assert.equal(flash.totalTokens, 150);
  assert.equal(flash.inputTokens, 110);
  assert.equal(flash.lastUsedAt, "2026-07-21T12:00:00.000Z");

  // Per-model totals must reconcile with the provider rollup they came from.
  const summed = deepseek.models.reduce((total, model) => total + model.totalTokens, 0);
  assert.equal(summed, deepseek.totalTokens);
});

test("keeps unlabeled model traffic visible instead of dropping it", () => {
  const now = Date.parse("2026-07-21T18:00:00Z");
  const snapshot = aggregateProviderUsage(
    [
      {
        meteringVersion: 1,
        at: "2026-07-21T12:00:00Z",
        provider: "grok-oauth",
        status: 200,
        totalTokens: 25,
      },
    ],
    { days: 7, now },
  );
  const grok = snapshot.providers.find((provider) => provider.id === "grok-oauth");

  assert.deepEqual(grok.models.map((model) => model.slug), ["unknown"]);
  assert.equal(grok.models[0].totalTokens, 25);
});

test("attaches per-model and provider cost from a pricing index", () => {
  const now = Date.parse("2026-07-21T18:00:00Z");
  const snapshot = aggregateProviderUsage(
    [
      {
        meteringVersion: 1,
        at: "2026-07-20T12:00:00Z",
        provider: "deepseek",
        model: "deepseek/deepseek-v4-flash",
        status: 200,
        inputTokens: 1000,
        outputTokens: 500,
        cachedInputTokens: 200,
        totalTokens: 1500,
      },
      {
        meteringVersion: 1,
        at: "2026-07-20T12:00:00Z",
        provider: "meta",
        model: "meta/muse-spark-1.1",
        status: 200,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      },
    ],
    { days: 7, now },
  );
  const index = new Map([
    [
      "deepseek-v4-flash",
      { modelId: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
    ],
  ]);
  const enriched = attachUsageCosts(snapshot, index);

  const deepseek = enriched.providers.find((provider) => provider.id === "deepseek");
  assert.equal(deepseek.totalCost, 0.00182);
  const flash = deepseek.models.find((model) => model.slug === "deepseek/deepseek-v4-flash");
  assert.equal(flash.priced, true);
  assert.equal(flash.inputCost, 0.0008);

  const meta = enriched.providers.find((provider) => provider.id === "meta");
  assert.equal(meta.totalCost, 0);
  assert.equal(meta.models[0].priced, false);
});

test("groups native traffic by CTM account and drops unattributed rows", () => {
  const now = Date.parse("2026-07-21T18:00:00Z");
  const accounts = aggregateAccountUsage(
    [
      {
        meteringVersion: 1,
        at: "2026-07-20T12:00:00Z",
        provider: "openai",
        accountId: "acct-a",
        model: "gpt-5.6-sol",
        status: 200,
        inputTokens: 100,
        outputTokens: 40,
        cachedInputTokens: 10,
        totalTokens: 140,
      },
      {
        meteringVersion: 1,
        at: "2026-07-20T13:00:00Z",
        provider: "openai",
        accountId: "acct-a",
        model: "gpt-5.6-luna",
        status: 200,
        inputTokens: 300,
        outputTokens: 50,
        totalTokens: 350,
      },
      {
        meteringVersion: 1,
        at: "2026-07-20T14:00:00Z",
        provider: "openai",
        accountId: "acct-b",
        model: "gpt-5.6-sol",
        status: 200,
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
      },
      {
        meteringVersion: 1,
        at: "2026-07-20T15:00:00Z",
        provider: "openai",
        model: "gpt-5.6-sol",
        status: 200,
        inputTokens: 999,
        outputTokens: 999,
        totalTokens: 1998,
      },
    ],
    { days: 7, now },
  );

  const byId = Object.fromEntries(accounts.map((account) => [account.accountId, account]));
  assert.equal(accounts.length, 2);
  assert.equal(byId["acct-a"].totalTokens, 490);
  assert.equal(byId["acct-a"].cachedInputTokens, 10);
  assert.equal(byId["acct-a"].models.length, 2);
  assert.equal(byId["acct-b"].totalTokens, 30);
  assert.equal(byId["unattributed"], undefined);
});

test("attaches account cost from a pricing index", () => {
  const accounts = [
    {
      accountId: "acct-a",
      requests: 1,
      successfulRequests: 1,
      meteredRequests: 1,
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 200,
      totalTokens: 1500,
      models: [
        {
          slug: "gpt-5.6-sol",
          displayName: "gpt-5.6-sol",
          inputTokens: 1000,
          outputTokens: 500,
          cachedInputTokens: 200,
          totalTokens: 1500,
        },
      ],
    },
  ];
  const index = new Map([
    [
      "gpt-5.6-sol",
      { modelId: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    ],
  ]);
  const enriched = attachAccountCosts(accounts, index);
  // billable input 800 * 5/M = 0.004; output 500 * 30/M = 0.015; cache 200 * 0.5/M = 0.0001.
  assert.equal(enriched[0].totalCost, 0.0191);
  assert.equal(enriched[0].models[0].priced, true);
});

test("deleted accounts fold into one kept 已删除 bucket", () => {
  const accounts = [
    {
      accountId: "acct-a",
      requests: 2,
      successfulRequests: 2,
      meteredRequests: 2,
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 10,
      totalTokens: 150,
      totalCost: 0.1,
      pricedModels: 1,
      models: [
        {
          slug: "gpt-5.6-sol",
          displayName: "gpt-5.6-sol",
          requests: 2,
          successfulRequests: 2,
          meteredRequests: 2,
          inputTokens: 100,
          outputTokens: 40,
          cachedInputTokens: 10,
          totalTokens: 150,
          lastUsedAt: "2026-07-20T12:00:00.000Z",
          inputCost: 0.05,
          outputCost: 0.05,
          cacheReadCost: 0,
          totalCost: 0.1,
          priced: true,
        },
      ],
    },
    {
      accountId: "acct-b",
      requests: 1,
      successfulRequests: 1,
      meteredRequests: 1,
      inputTokens: 50,
      outputTokens: 20,
      cachedInputTokens: 0,
      totalTokens: 70,
      totalCost: 0.03,
      pricedModels: 1,
      models: [
        {
          slug: "gpt-5.6-sol",
          displayName: "gpt-5.6-sol",
          requests: 1,
          successfulRequests: 1,
          meteredRequests: 1,
          inputTokens: 50,
          outputTokens: 20,
          cachedInputTokens: 0,
          totalTokens: 70,
          lastUsedAt: "2026-07-21T12:00:00.000Z",
          inputCost: 0.02,
          outputCost: 0.01,
          cacheReadCost: 0,
          totalCost: 0.03,
          priced: true,
        },
      ],
    },
  ];

  const merged = mergeDeletedAccounts(accounts, new Set(["acct-a"]));

  assert.equal(merged.length, 2);
  assert.equal(merged[0].accountId, "acct-a");
  assert.equal(merged[1].accountId, "__deleted__");
  assert.equal(merged[1].email, "已删除");
  assert.equal(merged[1].totalTokens, 70);
  assert.equal(merged[1].requests, 1);
  assert.equal(merged[1].totalCost, 0.03);
  assert.equal(merged[1].models.length, 1);
  assert.equal(merged[1].models[0].slug, "gpt-5.6-sol");
  assert.equal(merged[1].models[0].totalTokens, 70);
});

test("mergeDeletedAccounts keeps everything when every account is still valid", () => {
  const accounts = [{ accountId: "acct-a", totalTokens: 10, models: [] }];
  const merged = mergeDeletedAccounts(accounts, new Set(["acct-a"]));
  assert.deepEqual(merged, accounts);
});
