import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("usage events persist only bounded request metadata in a private file", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?test=${Date.now()}`);
    usage.recordUsageEvent({
      model: "grok-oauth/grok-4.5",
      provider: "grok-oauth",
      status: 200,
      durationMs: 321,
      inputTokens: 120,
      cachedInputTokens: 90,
      outputTokens: 35,
      totalTokens: 155,
      prompt: "never persisted",
    });
    assert.deepEqual(usage.recentUsageEvents(), [
      {
        meteringVersion: 1,
        at: usage.recentUsageEvents()[0].at,
        model: "grok-oauth/grok-4.5",
        provider: "grok-oauth",
        status: 200,
        durationMs: 321,
        inputTokens: 120,
        cachedInputTokens: 90,
        outputTokens: 35,
        totalTokens: 155,
      },
    ]);
    if (process.platform !== "win32") {
      assert.equal(statSync(usage.USAGE_EVENTS_PATH).mode & 0o777, 0o600);
    }
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("reading usage events folds protocol variants into their canonical provider", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?variant=${Date.now()}`);
    // Historical events recorded before canonicalization carry the variant id.
    usage.recordUsageEvent({
      model: "opencode-go-messages/minimax-m3",
      provider: "opencode-go-messages",
      status: 200,
      durationMs: 50,
    });
    assert.equal(usage.recentUsageEvents()[0].provider, "opencode-go");
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("an aborted stream persists its marker and reads back", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?aborted=1&ts=${Date.now()}`);
    usage.recordUsageEvent({
      model: "opencode-go/deepseek-v4-flash",
      provider: "opencode-go",
      status: 502,
      durationMs: 90,
      streamAborted: true,
    });
    const [event] = usage
      .recentUsageEvents()
      .filter((candidate) => candidate.status === 502);
    assert.equal(event.status, 502);
    assert.equal(event.streamAborted, true);
    // An ordinary turn never carries the marker, so historical rows keep
    // their exact shape and old dashboards are unaffected.
    usage.recordUsageEvent({
      model: "opencode-go/deepseek-v4-flash",
      provider: "opencode-go",
      status: 200,
      durationMs: 40,
    });
    const [ordinary] = usage
      .recentUsageEvents()
      .filter((candidate) => candidate.status === 200);
    assert.equal("streamAborted" in ordinary, false);
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("an attributed native turn persists its CTM account id", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?account=1&ts=${Date.now()}`);
    usage.recordUsageEvent({
      model: "gpt-5.6-sol",
      provider: "openai",
      accountId: "acct-123",
      status: 200,
      durationMs: 50,
      inputTokens: 10,
      outputTokens: 5,
    });
    const [event] = usage
      .recentUsageEvents()
      .filter((candidate) => candidate.accountId === "acct-123");
    assert.equal(event.accountId, "acct-123");

    // Routed turns and unattributed native turns omit the field entirely.
    usage.recordUsageEvent({
      model: "deepseek/deepseek-v4-flash",
      provider: "deepseek",
      status: 200,
      durationMs: 40,
    });
    const unattributed = usage
      .recentUsageEvents()
      .find((candidate) => candidate.provider === "deepseek");
    assert.equal("accountId" in unattributed, false);
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a guard budget release persists its marker and reads back", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?guard=1&ts=${Date.now()}`);
    usage.recordUsageEvent({
      model: "opencode-go/deepseek-v4-flash",
      provider: "opencode-go",
      status: 200,
      durationMs: 40_100,
      emptyCompletionGuardReleased: true,
    });
    const [event] = usage
      .recentUsageEvents()
      .filter((candidate) => candidate.emptyCompletionGuardReleased === true);
    assert.equal(event.status, 200);
    assert.equal(event.durationMs, 40_100);
    // An ordinary turn never carries the marker, so the release path stays
    // distinguishable from a healthy turn of the same duration.
    usage.recordUsageEvent({
      model: "opencode-go/deepseek-v4-flash",
      provider: "opencode-go",
      status: 200,
      durationMs: 40_100,
    });
    const [ordinary] = usage
      .recentUsageEvents()
      .filter((candidate) => candidate.emptyCompletionGuardReleased !== true);
    assert.equal("emptyCompletionGuardReleased" in ordinary, false);
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});
