import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const now = Date.parse("2026-07-21T18:00:00Z");
const events = [
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
    billedInputTokens: 450,
    billedOutputTokens: 90,
  },
  {
    meteringVersion: 1,
    at: "2026-07-20T14:00:00Z",
    provider: "openai",
    accountId: "acct-b",
    model: "gpt-5.6-sol",
    status: 500,
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
  {
    meteringVersion: 1,
    at: "2026-07-19T12:00:00Z",
    provider: "deepseek",
    model: "deepseek/deepseek-v4-flash",
    status: 200,
    inputTokens: 80,
    outputTokens: 20,
    totalTokens: 100,
  },
  {
    meteringVersion: 1,
    at: "2026-07-19T13:00:00Z",
    provider: "retired-provider",
    model: "retired/model",
    status: 200,
    inputTokens: 12,
    outputTokens: 3,
    totalTokens: 15,
  },
];

// `paths.mjs` computes STATE_DIR once and caches it for the whole process, so
// a single temp dir is shared by every test here. Each test gets a fresh
// summary module via a query-busted dynamic import and clears the raw log so
// it starts from a known-empty store.
const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-summary-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;
const eventsPath = path.join(stateDir, "usage-events.jsonl");

test.after(() => rmSync(stateDir, { recursive: true, force: true }));

let tagCounter = 0;

function resetRawLog() {
  rmSync(eventsPath, { force: true });
}

async function loadModules() {
  const tag = `${Date.now()}-${tagCounter++}`;
  const usage = await import(`../src/provider-usage.mjs?agg=${tag}`);
  const summary = await import(`../src/usage-summary.mjs?sum=${tag}`);
  return {
    aggregateAccountUsage: usage.aggregateAccountUsage,
    aggregateProviderUsage: usage.aggregateProviderUsage,
    summary,
  };
}

test("incremental summary matches the event-level aggregators", async () => {
  resetRawLog();
  const { aggregateAccountUsage, aggregateProviderUsage, summary } =
    await loadModules();
  for (const event of events) summary.recordUsageSummaryEvent(event);
  const snapshot = summary.usageSummarySnapshot({ range: "7d", now });

  assert.deepEqual(
    snapshot.accounts,
    aggregateAccountUsage(events, { days: 7, now }),
  );
  assert.deepEqual(
    snapshot.providers,
    aggregateProviderUsage(events, { days: 7, now }).providers,
  );
});

test("summary rebuilds from the raw event log", async () => {
  resetRawLog();
  for (const event of events) {
    appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
  }
  const { aggregateAccountUsage, summary } = await loadModules();
  const snapshot = summary.usageSummarySnapshot({ range: "7d", now });

  assert.deepEqual(
    snapshot.accounts,
    aggregateAccountUsage(events, { days: 7, now }),
  );
  assert.equal(
    snapshot.providers.find((provider) => provider.id === "openai").totalTokens,
    2708,
  );
});

test("summary ingests events appended after its initial snapshot", async () => {
  resetRawLog();
  const { summary } = await loadModules();
  assert.equal(summary.usageSummarySnapshot({ range: "7d", now }).accounts.length, 0);

  appendFileSync(eventsPath, `${JSON.stringify(events[0])}\n`, "utf8");
  const account = summary
    .usageSummarySnapshot({ range: "7d", now })
    .accounts.find((entry) => entry.accountId === "acct-a");
  assert.equal(account.totalTokens, 140);
});

test("a locally recorded persisted event is not counted again from disk", async () => {
  resetRawLog();
  const { summary } = await loadModules();
  const line = `${JSON.stringify(events[0])}\n`;
  summary.recordUsageSummaryEvent(events[0]);
  appendFileSync(eventsPath, line, "utf8");
  summary.markUsageSummaryEventPersisted(Buffer.byteLength(line));

  const account = summary
    .usageSummarySnapshot({ range: "7d", now })
    .accounts.find((entry) => entry.accountId === "acct-a");
  assert.equal(account.totalTokens, 140);
});

test("summary rebuilds when the usage log is replaced", async () => {
  resetRawLog();
  appendFileSync(eventsPath, `${JSON.stringify(events[0])}\n`, "utf8");
  const { summary } = await loadModules();
  assert.equal(
    summary.usageSummarySnapshot({ range: "7d", now }).accounts[0].totalTokens,
    140,
  );

  rmSync(eventsPath, { force: true });
  writeFileSync(eventsPath, `${JSON.stringify(events[2])}\n`, "utf8");
  const snapshot = summary.usageSummarySnapshot({ range: "7d", now });
  assert.equal(snapshot.accounts.length, 1);
  assert.equal(snapshot.accounts[0].accountId, "acct-b");
  assert.equal(snapshot.accounts[0].totalTokens, 30);
});

test("summary drops days outside the requested window", async () => {
  resetRawLog();
  const { summary } = await loadModules();
  summary.recordUsageSummaryEvent({
    meteringVersion: 1,
    at: "2026-06-01T12:00:00Z",
    provider: "openai",
    accountId: "acct-a",
    model: "gpt-5.6-sol",
    status: 200,
    inputTokens: 10_000,
    outputTokens: 10_000,
    totalTokens: 20_000,
  });
  summary.recordUsageSummaryEvent({
    meteringVersion: 1,
    at: "2026-07-21T12:00:00Z",
    provider: "openai",
    accountId: "acct-a",
    model: "gpt-5.6-sol",
    status: 200,
    inputTokens: 100,
    outputTokens: 100,
    totalTokens: 200,
  });
  const snapshot = summary.usageSummarySnapshot({ range: "7d", now });
  const account = snapshot.accounts.find((entry) => entry.accountId === "acct-a");

  assert.equal(account.totalTokens, 200);
  assert.equal(account.models.length, 1);
  assert.equal(account.models[0].totalTokens, 200);
});

test("today and yesterday use local calendar days", async () => {
  resetRawLog();
  const { summary } = await loadModules();
  const todayNoon = new Date();
  todayNoon.setHours(12, 0, 0, 0);
  const yesterdayNoon = new Date(todayNoon);
  yesterdayNoon.setDate(yesterdayNoon.getDate() - 1);
  const dayBefore = new Date(todayNoon);
  dayBefore.setDate(dayBefore.getDate() - 2);

  const record = (at, tokens) =>
    summary.recordUsageSummaryEvent({
      meteringVersion: 1,
      at: at.toISOString(),
      provider: "openai",
      accountId: "acct-a",
      model: "gpt-5.6-sol",
      status: 200,
      inputTokens: tokens,
      outputTokens: 0,
      totalTokens: tokens,
    });

  record(todayNoon, 100);
  record(yesterdayNoon, 10);
  record(dayBefore, 1);

  const now = todayNoon.getTime();
  const account = (snapshot) =>
    snapshot.accounts.find((entry) => entry.accountId === "acct-a");

  assert.equal(
    account(summary.usageSummarySnapshot({ range: "today", now })).totalTokens,
    100,
  );
  assert.equal(
    account(summary.usageSummarySnapshot({ range: "yesterday", now })).totalTokens,
    10,
  );
});
