import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";

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

function daysAgoKey(days, now) {
  const date = new Date(now);
  date.setDate(date.getDate() - days);
  return dateKey(date);
}

function resolveRangeDays(range, now) {
  const toDay = dateKey(now);
  if (range === "today") return { fromDay: toDay, toDay };
  if (range === "yesterday") {
    const yesterday = daysAgoKey(1, now);
    return { fromDay: yesterday, toDay: yesterday };
  }
  const days = { "7d": 7, "30d": 30, "90d": 90 }[range];
  if (days) return { fromDay: dateKey(now - days * 86_400_000), toDay };
  return { fromDay: dateKey(now - 90 * 86_400_000), toDay };
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
let summaryOffset = 0;
let summaryFileId;

function fileId(stats) {
  return `${stats.dev}:${stats.ino}`;
}

function buildSummary() {
  const target = { providers: new Map(), accounts: new Map() };
  let raw;
  try {
    const stats = statSync(USAGE_EVENTS_PATH);
    raw = readFileSync(USAGE_EVENTS_PATH);
    summaryOffset = raw.length;
    summaryFileId = fileId(stats);
  } catch {
    summaryOffset = 0;
    summaryFileId = undefined;
    return target;
  }
  const tail = raw.toString("utf8").split("\n").slice(-Math.max(1, REBUILD_LINE_LIMIT));
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

function readAppendedBytes(start, length) {
  const descriptor = openSync(USAGE_EVENTS_PATH, "r");
  const buffer = Buffer.allocUnsafe(length);
  let total = 0;
  try {
    while (total < length) {
      const count = readSync(descriptor, buffer, total, length - total, start + total);
      if (count === 0) break;
      total += count;
    }
  } finally {
    closeSync(descriptor);
  }
  return buffer.subarray(0, total);
}

function refreshSummaryFromDisk() {
  let target = ensureSummary();
  let stats;
  try {
    stats = statSync(USAGE_EVENTS_PATH);
  } catch (error) {
    if (error?.code === "ENOENT" && (summaryFileId !== undefined || summaryOffset !== 0)) {
      summary = null;
      target = ensureSummary();
    }
    return target;
  }

  if (fileId(stats) !== summaryFileId || stats.size < summaryOffset) {
    summary = null;
    return ensureSummary();
  }
  if (stats.size === summaryOffset) return target;

  let appended;
  try {
    appended = readAppendedBytes(summaryOffset, stats.size - summaryOffset);
  } catch {
    return target;
  }
  const newline = appended.lastIndexOf(0x0a);
  if (newline < 0) return target;
  const complete = appended.subarray(0, newline + 1);
  summaryOffset += complete.length;
  for (const line of complete.toString("utf8").split(/\r?\n/)) {
    if (!line) continue;
    try {
      mergeEvent(target, JSON.parse(line));
    } catch {
      // A malformed telemetry row is skipped exactly as it is during rebuild.
    }
  }
  return target;
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
  mergeEntry(provider, event, at, { billed: true });

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

function mergeEntry(entry, event, at, { billed = false } = {}) {
  const day = dateKey(at);
  const slug = typeof event.model === "string" && event.model ? event.model : "unknown";
  const inputTokens = nonnegative(billed ? event.billedInputTokens ?? event.inputTokens : event.inputTokens);
  const outputTokens = nonnegative(billed ? event.billedOutputTokens ?? event.outputTokens : event.outputTokens);
  const cachedInputTokens = Math.min(nonnegative(event.cachedInputTokens), inputTokens);
  const hasTokenField =
    (billed && event.billedInputTokens !== undefined) ||
    (billed && event.billedOutputTokens !== undefined) ||
    event.totalTokens !== undefined ||
    event.inputTokens !== undefined ||
    event.outputTokens !== undefined;
  const totalTokens = nonnegative(
    billed && (event.billedInputTokens !== undefined || event.billedOutputTokens !== undefined)
      ? inputTokens + outputTokens
      : event.totalTokens ?? (hasTokenField ? inputTokens + outputTokens : 0),
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
  bucket.cachedInputTokens += cachedInputTokens;
  bucket.totalTokens += totalTokens;
  const isoAt = new Date(at).toISOString();
  if (!bucket.lastUsedAt || at >= Date.parse(bucket.lastUsedAt)) {
    bucket.lastUsedAt = isoAt;
  }
}

function rollUp(entry, fromDay, toDay) {
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
      if (day < fromDay || day > toDay) continue;
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
      const daily = out.daily.get(day) || {
        startDate: day,
        tokens: 0,
        requests: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      };
      daily.tokens += bucket.totalTokens;
      daily.requests += bucket.requests;
      daily.inputTokens += bucket.inputTokens;
      daily.cachedInputTokens += bucket.cachedInputTokens;
      daily.outputTokens += bucket.outputTokens;
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

export function markUsageSummaryEventPersisted(byteLength) {
  const bytes = Number(byteLength);
  if (summary === null || !Number.isSafeInteger(bytes) || bytes <= 0) return;
  summaryOffset += bytes;
}

export function usageSummarySnapshot({ range = "90d", now = Date.now() } = {}) {
  const target = refreshSummaryFromDisk();
  const { fromDay, toDay } = resolveRangeDays(range, now);

  const seed = new Map(
    [NATIVE_OPENAI, ...[...PROVIDERS.values()].filter((provider) => !provider.variantOf)].map(
      (provider) => [provider.id, provider],
    ),
  );
  for (const providerId of target.providers.keys()) {
    if (!seed.has(providerId)) {
      seed.set(providerId, {
        id: providerId,
        displayName: `Historical provider (${providerId})`,
        credentialType: "unknown",
      });
    }
  }
  const providers = [...seed.values()].map((provider) => {
    const rollup = rollUp(target.providers.get(provider.id), fromDay, toDay);
    return {
      id: provider.id,
      displayName: provider.displayName,
      credentialType: provider.credentialType || (provider.kind === "oauth"
        ? "oauth"
        : provider.authMode === "anonymous"
          ? "anonymous"
          : provider.authMode === "per-model"
            ? "per-model"
            : "api"),
      scope: "local-router",
      requests: rollup.requests,
      successfulRequests: rollup.successfulRequests,
      meteredRequests: rollup.meteredRequests,
      inputTokens: rollup.inputTokens,
      regularInputTokens: Math.max(0, rollup.inputTokens - rollup.cachedInputTokens),
      outputTokens: rollup.outputTokens,
      cachedInputTokens: rollup.cachedInputTokens,
      totalTokens: rollup.totalTokens,
      last24hInputTokens: 0,
      last24hRegularInputTokens: 0,
      last24hCachedInputTokens: 0,
      last24hOutputTokens: 0,
      last24hTokens: 0,
      last24hRequests: 0,
      last24hMeteredRequests: 0,
      dailyUsageBuckets: [...rollup.daily.values()].sort((left, right) =>
        left.startDate.localeCompare(right.startDate),
      ),
      models: [...rollup.models.values()]
        .map((model) => ({
          ...model,
          observedTokensPerSecond: null,
          observedFirstTokenMs: null,
          speedSampleCount: 0,
        }))
        .sort(
          (left, right) => right.totalTokens - left.totalTokens || right.requests - left.requests,
        ),
    };
  });

  const accounts = [...target.accounts.entries()]
    .map(([accountId, entry]) => {
      const rollup = rollUp(entry, fromDay, toDay);
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
