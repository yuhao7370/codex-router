import { readFileSync } from "node:fs";

import { USAGE_EVENTS_PATH } from "./paths.mjs";
import { PROVIDERS } from "./model-registry.mjs";
import { canonicalProviderId } from "./provider-selection.mjs";

// This module keeps an in-memory rollup of every usage event so the panel can
// read an already-summed result instead of re-parsing the whole JSONL on every
// poll. `recordUsageEvent` feeds it incrementally; the raw log is only replayed
// once, lazily, on the first read after process start.
const REBUILD_LINE_LIMIT = 100_000;

const NATIVE_OPENAI = {
  id: "openai",
  displayName: "ChatGPT (native)",
  kind: "oauth",
};

function modelDisplayName(slug) {
  const slash = slug.lastIndexOf("/");
  return slash === -1 ? slug : slug.slice(slash + 1) || slug;
}

function dateKey(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function nonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

// Per-day, per-model totals are the smallest unit that supports a sliding
// 90-day window: the snapshot sums only days inside the window, so old events
// drop out without a periodic full re-read.
function emptyDayBucket() {
  return {
    requests: 0,
    successfulRequests: 0,
    meteredRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    lastUsedAt: "",
  };
}

function newEntry() {
  return { models: new Map() };
}

let summary = null;

function buildSummary() {
  const target = { providers: new Map(), accounts: new Map() };
  let raw = "";
  try {
    raw = readFileSync(USAGE_EVENTS_PATH, "utf8");
  } catch {
    return target;
  }
  const tail = raw.split("\n").slice(-Math.max(1, REBUILD_LINE_LIMIT));
  for (const line of tail) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    mergeEvent(target, event);
  }
  return target;
}

function ensureSummary() {
  if (summary === null) summary = buildSummary();
  return summary;
}

function mergeEvent(target, event) {
  if (
    event?.meteringVersion !== 1 &&
    event?.totalTokens === undefined &&
    event?.inputTokens === undefined &&
    event?.outputTokens === undefined
  ) {
    return;
  }
  const at = Date.parse(event?.at);
  if (!Number.isFinite(at)) return;

  const providerId = canonicalProviderId(
    typeof event.provider === "string" && event.provider ? event.provider : "unknown",
  );
  let provider = target.providers.get(providerId);
  if (!provider) {
    provider = newEntry();
    target.providers.set(providerId, provider);
  }
  mergeEntry(provider, event, at);

  const accountId =
    typeof event.accountId === "string" && event.accountId ? event.accountId : "";
  if (accountId) {
    let account = target.accounts.get(accountId);
    if (!account) {
      account = newEntry();
      target.accounts.set(accountId, account);
    }
    mergeEntry(account, event, at);
  }
}

function mergeEntry(entry, event, at) {
  const day = dateKey(at);
  const slug = typeof event.model === "string" && event.model ? event.model : "unknown";
  const inputTokens = nonnegative(event.inputTokens);
  const outputTokens = nonnegative(event.outputTokens);
  const hasTokenField =
    event.totalTokens !== undefined ||
    event.inputTokens !== undefined ||
    event.outputTokens !== undefined;
  const totalTokens = nonnegative(
    event.totalTokens ?? (hasTokenField ? inputTokens + outputTokens : 0),
  );
  const successful =
    Number.isInteger(event.status) && event.status >= 200 && event.status < 400;

  let model = entry.models.get(slug);
  if (!model) {
    model = new Map();
    entry.models.set(slug, model);
  }
  let bucket = model.get(day);
  if (!bucket) {
    bucket = emptyDayBucket();
    model.set(day, bucket);
  }
  bucket.requests += 1;
  if (successful) bucket.successfulRequests += 1;
  if (hasTokenField) bucket.meteredRequests += 1;
  bucket.inputTokens += inputTokens;
  bucket.outputTokens += outputTokens;
  bucket.cachedInputTokens += nonnegative(event.cachedInputTokens);
  bucket.totalTokens += totalTokens;
  const isoAt = new Date(at).toISOString();
  if (!bucket.lastUsedAt || at >= Date.parse(bucket.lastUsedAt)) {
    bucket.lastUsedAt = isoAt;
  }
}

function rollUp(entry, cutoffDay, nowDay) {
  const out = {
    requests: 0,
    successfulRequests: 0,
    meteredRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    daily: new Map(),
    models: new Map(),
  };
  if (!entry) return out;
  for (const [slug, days] of entry.models) {
    const model = {
      slug,
      displayName: modelDisplayName(slug),
      requests: 0,
      successfulRequests: 0,
      meteredRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 0,
      lastUsedAt: "",
    };
    let visible = false;
    for (const [day, bucket] of days) {
      if (day < cutoffDay || day > nowDay) continue;
      visible = true;
      model.requests += bucket.requests;
      model.successfulRequests += bucket.successfulRequests;
      model.meteredRequests += bucket.meteredRequests;
      model.inputTokens += bucket.inputTokens;
      model.outputTokens += bucket.outputTokens;
      model.cachedInputTokens += bucket.cachedInputTokens;
      model.totalTokens += bucket.totalTokens;
      if (
        bucket.lastUsedAt &&
        (!model.lastUsedAt || Date.parse(bucket.lastUsedAt) > Date.parse(model.lastUsedAt))
      ) {
        model.lastUsedAt = bucket.lastUsedAt;
      }
      const daily = out.daily.get(day) || { startDate: day, tokens: 0, requests: 0 };
      daily.tokens += bucket.totalTokens;
      daily.requests += bucket.requests;
      out.daily.set(day, daily);
    }
    if (!visible) continue;
    out.models.set(slug, model);
    out.requests += model.requests;
    out.successfulRequests += model.successfulRequests;
    out.meteredRequests += model.meteredRequests;
    out.inputTokens += model.inputTokens;
    out.outputTokens += model.outputTokens;
    out.cachedInputTokens += model.cachedInputTokens;
    out.totalTokens += model.totalTokens;
  }
  return out;
}

export function recordUsageSummaryEvent(event) {
  mergeEvent(ensureSummary(), event);
}

export function usageSummarySnapshot({ days = 90, now = Date.now() } = {}) {
  const target = ensureSummary();
  const cutoff = now - days * 24 * 60 * 60 * 1_000;
  const cutoffDay = dateKey(cutoff);
  const nowDay = dateKey(now);

  const seed = new Map(
    [NATIVE_OPENAI, ...[...PROVIDERS.values()].filter((provider) => !provider.variantOf)].map(
      (provider) => [provider.id, provider],
    ),
  );
  const providers = [...seed.values()].map((provider) => {
    const rollup = rollUp(target.providers.get(provider.id), cutoffDay, nowDay);
    return {
      id: provider.id,
      displayName: provider.displayName,
      credentialType: provider.kind === "oauth" ? "oauth" : "api",
      scope: "local-router",
      requests: rollup.requests,
      successfulRequests: rollup.successfulRequests,
      meteredRequests: rollup.meteredRequests,
      inputTokens: rollup.inputTokens,
      outputTokens: rollup.outputTokens,
      cachedInputTokens: rollup.cachedInputTokens,
      totalTokens: rollup.totalTokens,
      dailyUsageBuckets: [...rollup.daily.values()].sort((left, right) =>
        left.startDate.localeCompare(right.startDate),
      ),
      models: [...rollup.models.values()].sort(
        (left, right) => right.totalTokens - left.totalTokens || right.requests - left.requests,
      ),
    };
  });

  const accounts = [...target.accounts.entries()]
    .map(([accountId, entry]) => {
      const rollup = rollUp(entry, cutoffDay, nowDay);
      return {
        accountId,
        requests: rollup.requests,
        successfulRequests: rollup.successfulRequests,
        meteredRequests: rollup.meteredRequests,
        inputTokens: rollup.inputTokens,
        outputTokens: rollup.outputTokens,
        cachedInputTokens: rollup.cachedInputTokens,
        totalTokens: rollup.totalTokens,
        models: [...rollup.models.values()].sort(
          (left, right) => right.totalTokens - left.totalTokens || right.requests - left.requests,
        ),
      };
    })
    .sort(
      (left, right) => right.totalTokens - left.totalTokens || right.requests - left.requests,
    );

  return {
    fetchedAt: new Date(now).toISOString(),
    scope: "local-router",
    providers,
    accounts,
  };
}
