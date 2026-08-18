import { PROVIDERS } from "./model-registry.mjs";
import { providerAccountUsageSnapshot } from "./provider-account-usage.mjs";
import { readProviderSelection } from "./provider-selection.mjs";
import { recentUsageEvents } from "./usage-events.mjs";
import { usageSummarySnapshot } from "./usage-summary.mjs";
import {
  computeUsageCost,
  findModelPricing,
  loadPricingIndex,
  pricingSyncState,
} from "./model-pricing.mjs";

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

export function aggregateProviderUsage(events, { days = 90, now = Date.now() } = {}) {
  const cutoff = now - days * 24 * 60 * 60 * 1_000;
  // Protocol variants never appear as usage rows: their events, quota
  // headers, and activity are all folded into the canonical family provider.
  const byProvider = new Map(
    [NATIVE_OPENAI, ...[...PROVIDERS.values()].filter((provider) => !provider.variantOf)].map((provider) => [
      provider.id,
      {
        id: provider.id,
        displayName: provider.displayName,
        credentialType: provider.kind === "oauth" ? "oauth" : "api",
        scope: "local-router",
        requests: 0,
        successfulRequests: 0,
        meteredRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 0,
        daily: new Map(),
        models: new Map(),
      },
    ]),
  );

  for (const event of events) {
    const at = Date.parse(event?.at);
    const provider = byProvider.get(event?.provider);
    if (!provider || !Number.isFinite(at) || at < cutoff || at > now) continue;
    if (
      event.meteringVersion !== 1 &&
      event.totalTokens === undefined &&
      event.inputTokens === undefined &&
      event.outputTokens === undefined
    ) continue;
    provider.requests += 1;
    if (event.status >= 200 && event.status < 400) provider.successfulRequests += 1;
    const inputTokens = nonnegative(event.inputTokens);
    const outputTokens = nonnegative(event.outputTokens);
    const totalTokens = nonnegative(
      event.totalTokens ?? (event.inputTokens !== undefined || event.outputTokens !== undefined
        ? inputTokens + outputTokens
        : 0),
    );
    if (
      event.totalTokens !== undefined ||
      event.inputTokens !== undefined ||
      event.outputTokens !== undefined
    ) {
      provider.meteredRequests += 1;
    }
    provider.inputTokens += inputTokens;
    provider.outputTokens += outputTokens;
    provider.cachedInputTokens += nonnegative(event.cachedInputTokens);
    provider.totalTokens += totalTokens;
    const day = dateKey(at);
    const bucket = provider.daily.get(day) || { startDate: day, tokens: 0, requests: 0 };
    bucket.tokens += totalTokens;
    bucket.requests += 1;
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
    provider.models.set(slug, model);
  }

  return {
    fetchedAt: new Date(now).toISOString(),
    scope: "local-router",
    providers: [...byProvider.values()].map(({ daily, models, ...provider }) => ({
      ...provider,
      dailyUsageBuckets: [...daily.values()].sort((left, right) =>
        left.startDate.localeCompare(right.startDate),
      ),
      models: [...models.values()].sort(
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
  const snapshot = aggregateProviderUsage(
    recentUsageEvents({ sinceMs: days * 24 * 60 * 60 * 1_000, limit: 100_000 }),
    { ...options, days },
  );
  const accounts = await providerAccountUsageSnapshot({
    ...options,
    providerIds: readProviderSelection(),
  });
  return {
    ...snapshot,
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
