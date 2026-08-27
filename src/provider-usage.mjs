import { PROVIDERS } from "./model-registry.mjs";
import { providerAccountUsageSnapshot } from "./provider-account-usage.mjs";
import { usageSummarySnapshot } from "./usage-summary.mjs";
import {
  computeUsageCost,
  findModelPricing,
  loadPricingIndex,
  pricingSyncState,
} from "./model-pricing.mjs";
import { canonicalProviderId, readProviderSelection } from "./provider-selection.mjs";
import { allUsageEvents } from "./usage-events.mjs";

function dateKey(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Fastest published serving rates are a few hundred tokens per second; this
// is set well above them so a genuinely fast model is never discarded.
const MAX_PLAUSIBLE_TOKENS_PER_SECOND = 500;
const ROLLING_24H_MS = 24 * 60 * 60 * 1_000;

function nonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function optionalNonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
}

function hasMeteredUsage(event) {
  return event?.totalTokens !== undefined
    || event?.inputTokens !== undefined
    || event?.outputTokens !== undefined
    || event?.billedInputTokens !== undefined
    || event?.billedOutputTokens !== undefined;
}

// Routed slugs are provider-qualified (`kimi-oauth/k3`); native ones are bare
// (`gpt-5.6-sol`). The tray groups under a provider already, so drop the prefix.
function modelDisplayName(slug) {
  const slash = slug.lastIndexOf("/");
  return slash === -1 ? slug : slug.slice(slash + 1) || slug;
}

// Native OpenAI traffic never routes through a registry provider, so seed a
// bucket for it; otherwise the busiest models on the box are dropped outright.
// This is router-observed traffic only — subscription quota still comes from
// the separate Codex account-usage path.
const NATIVE_OPENAI = {
  id: "openai",
  displayName: "ChatGPT (native)",
  kind: "oauth",
};

function providerUsageRecord(provider) {
  return {
    id: provider.id,
    displayName: provider.displayName,
    credentialType: provider.kind === "oauth"
      ? "oauth"
      : provider.authMode === "anonymous"
        ? "anonymous"
        : provider.authMode === "per-model"
          ? "per-model"
          : "api",
    scope: "local-router",
    requests: 0,
    successfulRequests: 0,
    meteredRequests: 0,
    inputTokens: 0,
    regularInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    last24hInputTokens: 0,
    last24hRegularInputTokens: 0,
    last24hCachedInputTokens: 0,
    last24hOutputTokens: 0,
    last24hTokens: 0,
    last24hRequests: 0,
    last24hMeteredRequests: 0,
    daily: new Map(),
    models: new Map(),
  };
}

export function aggregateProviderUsage(events, { days = 90, now = Date.now() } = {}) {
  const cutoff = now - days * 24 * 60 * 60 * 1_000;
  const rolling24hCutoff = now - ROLLING_24H_MS;
  // Prefix-cache telemetry is orthogonal to provider totals: a cache hit is
  // still part of the prompt the provider billed, but it is useful on its own
  // as an indication of how much context was reused. Keep the aggregate here
  // so the Electron dashboard does not have to reconstruct it from its short
  // 24-hour probe (which is capped and can omit older rows on a busy install).
  let cacheTelemetrySeen = false;
  let last24hCachedInputTokens = 0;
  const dailyCachedInputTokens = new Map();
  // Protocol variants never appear as usage rows: their events, quota
  // headers, and activity are all folded into the canonical family provider.
  const byProvider = new Map(
    [NATIVE_OPENAI, ...[...PROVIDERS.values()].filter((provider) => !provider.variantOf)].map((provider) => [
      provider.id,
      providerUsageRecord(provider),
    ]),
  );

  for (const event of events) {
    const at = Date.parse(event?.at);
    if (!Number.isFinite(at) || at < cutoff || at > now) continue;
    const rawProvider = typeof event?.provider === "string" && event.provider.trim()
      ? event.provider.trim()
      : "unknown";
    const providerId = canonicalProviderId(rawProvider);
    let provider = byProvider.get(providerId);
    if (!provider) {
      // Rows can outlive a registry entry after a provider is removed or
      // renamed. Keep a clearly marked historical bucket so "All router
      // traffic" remains an accounting identity instead of silently dropping
      // the request and its tokens.
      provider = providerUsageRecord({
        id: providerId,
        displayName: providerId === "unknown"
          ? "Unknown provider"
          : `Historical provider (${providerId})`,
        kind: "openai-compatible",
      });
      provider.credentialType = "unknown";
      byProvider.set(providerId, provider);
    }
    if (event.meteringVersion !== 1 && !hasMeteredUsage(event)) continue;
    provider.requests += 1;
    if (event.status >= 200 && event.status < 400) provider.successfulRequests += 1;
    const selectedOutputTokens = nonnegative(event.outputTokens);
    const inputTokens = nonnegative(event.billedInputTokens ?? event.inputTokens);
    const outputTokens = nonnegative(event.billedOutputTokens ?? event.outputTokens);
    const totalTokens = nonnegative(
      event.billedInputTokens !== undefined || event.billedOutputTokens !== undefined
        ? inputTokens + outputTokens
        : event.totalTokens ?? (event.inputTokens !== undefined || event.outputTokens !== undefined
          ? inputTokens + outputTokens
          : 0),
    );
    if (hasMeteredUsage(event)) {
      provider.meteredRequests += 1;
    }
    provider.inputTokens += inputTokens;
    provider.outputTokens += outputTokens;
    provider.totalTokens += totalTokens;
    const day = dateKey(at);
    const cachedInputTokens = optionalNonnegative(event.cachedInputTokens);
    // Cache hits are a subset of prompt input, not an extra token stream. Keep
    // the reported input total intact and expose the non-cached remainder as a
    // separate series for the UI. A partial row that reports cache telemetry
    // without its prompt total cannot establish how many input tokens were
    // billed, so never let it inflate cache above measured input.
    const measuredCached = cachedInputTokens === undefined
      ? 0
      : Math.min(cachedInputTokens, inputTokens);
    const regularInput = Math.max(0, inputTokens - measuredCached);
    provider.cachedInputTokens += measuredCached;
    provider.regularInputTokens += regularInput;
    if (cachedInputTokens !== undefined) {
      cacheTelemetrySeen = true;
      if (at >= rolling24hCutoff) last24hCachedInputTokens += measuredCached;
      const cachedDay = dailyCachedInputTokens.get(day) || 0;
      dailyCachedInputTokens.set(day, cachedDay + measuredCached);
    }
    if (at >= rolling24hCutoff) {
      provider.last24hInputTokens += inputTokens;
      provider.last24hRegularInputTokens += regularInput;
      provider.last24hCachedInputTokens += measuredCached;
      provider.last24hOutputTokens += outputTokens;
      provider.last24hTokens += totalTokens;
      provider.last24hRequests += 1;
      if (hasMeteredUsage(event)) {
        provider.last24hMeteredRequests += 1;
      }
    }
    const bucket = provider.daily.get(day) || {
      startDate: day,
      tokens: 0,
      requests: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    };
    bucket.tokens += totalTokens;
    bucket.requests += 1;
    bucket.inputTokens += inputTokens;
    bucket.cachedInputTokens += measuredCached;
    bucket.outputTokens += outputTokens;
    provider.daily.set(day, bucket);

    const slug = typeof event.model === "string" && event.model ? event.model : "unknown";
    const model = provider.models.get(slug) || {
      slug,
      displayName: modelDisplayName(slug),
      requests: 0,
      successfulRequests: 0,
      meteredRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 0,
      speedSamples: [],
      firstTokenSamples: [],
      lastUsedAt: new Date(at).toISOString(),
    };
    model.requests += 1;
    if (event.status >= 200 && event.status < 400) model.successfulRequests += 1;
    if (hasMeteredUsage(event)) {
      model.meteredRequests += 1;
    }
    model.inputTokens += inputTokens;
    model.outputTokens += outputTokens;
    model.cachedInputTokens += measuredCached;
    model.totalTokens += totalTokens;
    const durationMs = nonnegative(event.durationMs);
    const responseStartMs = optionalNonnegative(event.responseStartMs);
    // Output tokens per second is defined as the rate *after* the first token,
    // with the wait before it reported separately as time-to-first-token --
    // that is how every published benchmark states it, and it is the only
    // split that does not change with reply length. Dividing by the time since
    // the response headers instead buries a reasoning model's silent thinking
    // in the denominator, which made a 31-token reply read at 12 tok/s and a
    // 426-token one at 69 on the same model.
    const firstTokenMs = optionalNonnegative(event.firstTokenMs);
    const generationDurationMs = durationMs - (firstTokenMs ?? durationMs);
    // A long Codex turn can trip the empty-completion hold budget and still
    // finish as a normal 200 with streamed tokens. That flag means "we
    // stopped waiting to classify emptiness", not "this rate is unusable".
    // Keep those replies; drop only empty/retried/canceled ones.
    const measurable =
      event.status >= 200 &&
      event.status < 400 &&
      !event.retries &&
      event.emptyCompletion !== true &&
      event.emptyCompletionRetried !== true &&
      event.progressOnlyRetried !== true;
    // Detection can fail on a converted stream -- the first token is noticed
    // near the end, so thousands of tokens appear to arrive in milliseconds.
    // No served model streams anywhere near this fast, so treat it as a broken
    // sample rather than a record-breaking one.
    const impossibleRate =
      (selectedOutputTokens * 1_000) / generationDurationMs >
      MAX_PLAUSIBLE_TOKENS_PER_SECOND;
    if (
      measurable &&
      selectedOutputTokens > 0 &&
      firstTokenMs !== undefined &&
      generationDurationMs > 0 &&
      !impossibleRate
    ) {
      model.speedSamples.push({ outputTokens: selectedOutputTokens, generationDurationMs });
      // Keep the displayed rate current instead of averaging the model's
      // entire 90-day usage history. Twenty replies smooth one-off bursts
      // without letting old sessions dominate the result.
      if (model.speedSamples.length > 20) model.speedSamples.shift();
    }
    // Time-to-first-token stands on its own: it is the pause the operator
    // actually feels before anything appears, and on a reasoning model it is
    // roughly half the request. Sampled from the same events, so a turn that
    // is unfit for a rate is unfit for this too.
    if (measurable && firstTokenMs !== undefined && firstTokenMs > 0 && firstTokenMs <= durationMs) {
      model.firstTokenSamples.push(firstTokenMs);
      if (model.firstTokenSamples.length > 20) model.firstTokenSamples.shift();
    }
    if (at >= Date.parse(model.lastUsedAt)) model.lastUsedAt = new Date(at).toISOString();
    provider.models.set(slug, model);
  }

  return {
    fetchedAt: new Date(now).toISOString(),
    scope: "local-router",
    ...(cacheTelemetrySeen
      ? {
          contextEfficiency: {
            last24hCachedInputTokens,
            dailyCachedInputTokens: [...dailyCachedInputTokens.entries()]
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([startDate, cachedInputTokens]) => ({ startDate, cachedInputTokens })),
          },
        }
      : {}),
    providers: [...byProvider.values()].map(({ daily, models, ...provider }) => ({
      ...provider,
      dailyUsageBuckets: [...daily.values()].sort((left, right) =>
        left.startDate.localeCompare(right.startDate),
      ),
      models: [...models.values()]
        .map(({ speedSamples, firstTokenSamples, ...model }) => {
          // Median of per-reply rates, not total tokens over total time. A
          // pooled ratio lets one bad sample carry the answer: a stream whose
          // first token is detected late reports thousands of tokens across a
          // fraction of a second, and summing puts that straight into the
          // numerator. Observed live -- one provider produced 11,656 tok/s
          // this way and dragged a 20-sample window to 711 while every sane
          // reply in it sat near 114. A median cannot be moved by a minority
          // of impossible samples, and needs no threshold to tune.
          const rates = speedSamples
            .map((sample) => (sample.outputTokens * 1_000) / sample.generationDurationMs)
            .sort((left, right) => left - right);
          return {
            ...model,
            speedSampleCount: speedSamples.length,
            // Median, not mean: one cold start or one queued request would
            // drag an average far more than it reflects a typical turn.
            observedFirstTokenMs: firstTokenSamples.length
              ? [...firstTokenSamples].sort((left, right) => left - right)[
                  Math.floor(firstTokenSamples.length / 2)
                ]
              : null,
            observedTokensPerSecond: rates.length
              ? Math.round(rates[Math.floor(rates.length / 2)] * 10) / 10
              : null,
          };
        })
        .sort(
          (left, right) => right.totalTokens - left.totalTokens || right.requests - left.requests,
        ),
    })),
  };
}

// Attach USD cost estimates to a token-aggregated snapshot. Pricing is looked
// up per model, so a provider's cost is the sum of its priced models; models
// without a known price keep their token counts and report `priced: false`.
export function attachUsageCosts(snapshot, index = loadPricingIndex()) {
  const providers = snapshot.providers.map((provider) => {
    let totalCost = 0;
    let pricedModels = 0;
    const models = provider.models.map((model) => {
      const pricing = findModelPricing(model.slug, index);
      if (!pricing) {
        return {
          ...model,
          inputCost: 0,
          outputCost: 0,
          cacheReadCost: 0,
          totalCost: 0,
          priced: false,
        };
      }
      const cost = computeUsageCost(pricing, model);
      totalCost += cost.totalCost;
      pricedModels += 1;
      return {
        ...model,
        inputCost: cost.inputCost,
        outputCost: cost.outputCost,
        cacheReadCost: cost.cacheReadCost,
        totalCost: cost.totalCost,
        priced: true,
      };
    });
    return {
      ...provider,
      models,
      totalCost: Math.round(totalCost * 1e6) / 1e6,
      pricedModels,
    };
  });
  return {
    ...snapshot,
    providers,
    pricing: pricingSyncState(),
  };
}

// Aggregate native traffic by the Codex Task Manager account that injected
// it. Rows without an `accountId` (recorded before account attribution
// existed, or relayed under the caller's own auth) are intentionally dropped:
// they cannot be assigned to a subscription after the fact.
export function aggregateAccountUsage(events, { days = 90, now = Date.now() } = {}) {
  const cutoff = now - days * 24 * 60 * 60 * 1_000;
  const byAccount = new Map();
  for (const event of events) {
    const accountId =
      typeof event?.accountId === "string" && event.accountId
        ? event.accountId
        : undefined;
    if (!accountId) continue;
    const at = Date.parse(event?.at);
    if (!Number.isFinite(at) || at < cutoff || at > now) continue;
    if (
      event.meteringVersion !== 1 &&
      event.totalTokens === undefined &&
      event.inputTokens === undefined &&
      event.outputTokens === undefined
    ) continue;

    let account = byAccount.get(accountId);
    if (!account) {
      account = {
        accountId,
        requests: 0,
        successfulRequests: 0,
        meteredRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 0,
        models: new Map(),
      };
      byAccount.set(accountId, account);
    }
    account.requests += 1;
    if (event.status >= 200 && event.status < 400) account.successfulRequests += 1;
    const inputTokens = nonnegative(event.inputTokens);
    const outputTokens = nonnegative(event.outputTokens);
    const totalTokens = nonnegative(
      event.totalTokens ??
        (event.inputTokens !== undefined || event.outputTokens !== undefined
          ? inputTokens + outputTokens
          : 0),
    );
    if (
      event.totalTokens !== undefined ||
      event.inputTokens !== undefined ||
      event.outputTokens !== undefined
    ) {
      account.meteredRequests += 1;
    }
    account.inputTokens += inputTokens;
    account.outputTokens += outputTokens;
    account.cachedInputTokens += nonnegative(event.cachedInputTokens);
    account.totalTokens += totalTokens;

    const slug = typeof event.model === "string" && event.model ? event.model : "unknown";
    const model = account.models.get(slug) || {
      slug,
      displayName: modelDisplayName(slug),
      requests: 0,
      successfulRequests: 0,
      meteredRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 0,
      lastUsedAt: new Date(at).toISOString(),
    };
    model.requests += 1;
    if (event.status >= 200 && event.status < 400) model.successfulRequests += 1;
    if (
      event.totalTokens !== undefined ||
      event.inputTokens !== undefined ||
      event.outputTokens !== undefined
    ) {
      model.meteredRequests += 1;
    }
    model.inputTokens += inputTokens;
    model.outputTokens += outputTokens;
    model.cachedInputTokens += nonnegative(event.cachedInputTokens);
    model.totalTokens += totalTokens;
    if (at >= Date.parse(model.lastUsedAt)) model.lastUsedAt = new Date(at).toISOString();
    account.models.set(slug, model);
  }

  return [...byAccount.values()]
    .map(({ models, ...account }) => ({
      ...account,
      models: [...models.values()].sort(
        (left, right) =>
          right.totalTokens - left.totalTokens || right.requests - left.requests,
      ),
    }))
    .sort(
      (left, right) =>
        right.totalTokens - left.totalTokens || right.requests - left.requests,
    );
}

export function attachAccountCosts(accounts, index = loadPricingIndex()) {
  return accounts.map((account) => {
    let totalCost = 0;
    let pricedModels = 0;
    const models = account.models.map((model) => {
      const pricing = findModelPricing(model.slug, index);
      if (!pricing) {
        return {
          ...model,
          inputCost: 0,
          outputCost: 0,
          cacheReadCost: 0,
          totalCost: 0,
          priced: false,
        };
      }
      const cost = computeUsageCost(pricing, model);
      totalCost += cost.totalCost;
      pricedModels += 1;
      return {
        ...model,
        inputCost: cost.inputCost,
        outputCost: cost.outputCost,
        cacheReadCost: cost.cacheReadCost,
        totalCost: cost.totalCost,
        priced: true,
      };
    });
    return {
      ...account,
      models,
      totalCost: Math.round(totalCost * 1e6) / 1e6,
      pricedModels,
    };
  });
}

// CTM exposes both its own record id and ChatGPT's account id. Usage can carry
// either one, so canonicalize both before deciding that an account was deleted.
export function mergeDeletedAccounts(accounts, currentAccounts = []) {
  const aliases = new Map();
  for (const account of currentAccounts) {
    const canonicalId = String(account?.id || account?.account_id || "");
    if (!canonicalId) continue;
    aliases.set(canonicalId, canonicalId);
    if (account.id) aliases.set(String(account.id), canonicalId);
    if (account.account_id) aliases.set(String(account.account_id), canonicalId);
  }

  const kept = new Map();
  const deleted = [];
  for (const account of accounts) {
    const canonicalId = aliases.get(String(account.accountId || ""));
    if (!canonicalId) {
      deleted.push(account);
      continue;
    }
    const normalized = canonicalId === account.accountId
      ? account
      : { ...account, accountId: canonicalId };
    const existing = kept.get(canonicalId);
    kept.set(
      canonicalId,
      existing
        ? foldAccounts([existing, normalized], { accountId: canonicalId, email: "", plan: "" })
        : normalized,
    );
  }
  const merged = [...kept.values()];
  if (deleted.length > 0) merged.push(foldAccounts(deleted));
  return merged;
}

function foldAccounts(
  accounts,
  { accountId = "__deleted__", email = "已删除", plan = "" } = {},
) {
  const models = new Map();
  let requests = 0;
  let successfulRequests = 0;
  let meteredRequests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let totalTokens = 0;
  let totalCost = 0;

  for (const account of accounts) {
    requests += account.requests || 0;
    successfulRequests += account.successfulRequests || 0;
    meteredRequests += account.meteredRequests || 0;
    inputTokens += account.inputTokens || 0;
    outputTokens += account.outputTokens || 0;
    cachedInputTokens += account.cachedInputTokens || 0;
    totalTokens += account.totalTokens || 0;
    totalCost += account.totalCost || 0;
    for (const model of Array.isArray(account.models) ? account.models : []) {
      const existing = models.get(model.slug);
      if (!existing) {
        models.set(model.slug, {
          ...model,
          inputCost: model.inputCost || 0,
          outputCost: model.outputCost || 0,
          cacheReadCost: model.cacheReadCost || 0,
          totalCost: model.totalCost || 0,
          priced: Boolean(model.priced),
        });
        continue;
      }
      existing.requests += model.requests || 0;
      existing.successfulRequests += model.successfulRequests || 0;
      existing.meteredRequests += model.meteredRequests || 0;
      existing.inputTokens += model.inputTokens || 0;
      existing.outputTokens += model.outputTokens || 0;
      existing.cachedInputTokens += model.cachedInputTokens || 0;
      existing.totalTokens += model.totalTokens || 0;
      existing.inputCost += model.inputCost || 0;
      existing.outputCost += model.outputCost || 0;
      existing.cacheReadCost += model.cacheReadCost || 0;
      existing.totalCost += model.totalCost || 0;
      existing.priced = existing.priced || Boolean(model.priced);
      if (
        model.lastUsedAt &&
        (!existing.lastUsedAt || model.lastUsedAt > existing.lastUsedAt)
      ) {
        existing.lastUsedAt = model.lastUsedAt;
      }
    }
  }

  const mergedModels = [...models.values()].sort(
    (left, right) => right.totalTokens - left.totalTokens || right.requests - left.requests,
  );

  return {
    accountId,
    email,
    plan,
    requests,
    successfulRequests,
    meteredRequests,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens,
    totalCost: Math.round(totalCost * 1e6) / 1e6,
    pricedModels: mergedModels.filter((model) => model.priced).length,
    models: mergedModels,
  };
}

// The panel path reads only local usage events and pricing; unlike
// `providerUsageSnapshot` it never calls provider account APIs, so a dashboard
// refresh stays fast and failure-tolerant.
export function panelUsageSnapshot({ range = "90d", now = Date.now() } = {}) {
  const snapshot = usageSummarySnapshot({ range, now });
  const withProviderCosts = attachUsageCosts({ providers: snapshot.providers });
  return {
    fetchedAt: snapshot.fetchedAt,
    scope: snapshot.scope,
    ...withProviderCosts,
    accounts: attachAccountCosts(snapshot.accounts),
  };
}

export async function providerUsageSnapshot(options = {}) {
  const days = options.days || 90;
  const now = options.now ?? Date.now();
  // The retained view already requires one complete parse. Derive the bounded
  // rolling view from that sanitized result instead of parsing the same
  // append-only ledger a second time in this short-lived control process.
  const retainedEvents = allUsageEvents();
  const cutoff = now - days * 24 * 60 * 60 * 1_000;
  const recentEvents = retainedEvents
    .filter((event) => Date.parse(event.at) >= cutoff)
    .slice(-100_000);
  const snapshot = aggregateProviderUsage(
    recentEvents,
    { ...options, days, now },
  );
  // Keep the bounded snapshot for fast rolling/status views, but also expose
  // the complete append-only ledger so the control center can answer the
  // user's natural question: "how much has this router burned so far?" This
  // is deliberately a separate scope; it is not the OpenAI account rollup.
  const retained = aggregateProviderUsage(retainedEvents, {
    ...options,
    days: Number.POSITIVE_INFINITY,
    now,
  });
  let retainedFrom = Number.POSITIVE_INFINITY;
  let retainedTo = Number.NEGATIVE_INFINITY;
  for (const event of retainedEvents) {
    const at = Date.parse(event.at);
    if (!Number.isFinite(at) || at > now) continue;
    retainedFrom = Math.min(retainedFrom, at);
    retainedTo = Math.max(retainedTo, at);
  }
  const accounts = await providerAccountUsageSnapshot({
    ...options,
    providerIds: readProviderSelection(),
  });
  return {
    ...snapshot,
    retained: {
      fetchedAt: retained.fetchedAt,
      scope: "local-router-retained",
      from: Number.isFinite(retainedFrom) ? new Date(retainedFrom).toISOString() : null,
      to: Number.isFinite(retainedTo) ? new Date(retainedTo).toISOString() : null,
      providers: retained.providers,
    },
    providers: snapshot.providers.map((provider) => ({
      ...provider,
      // Consumers decode `account` as a required field, so never leave it unset
      // for providers the account layer does not cover (native OpenAI).
      account: accounts[provider.id] || {
        status: "local-only",
        source: "local-router",
        metrics: [],
        message: "Router-observed traffic; subscription quota is tracked separately.",
      },
    })),
  };
}
