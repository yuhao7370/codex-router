import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { STATE_DIR } from "./paths.mjs";
import { nativeProxyFetch } from "./native-proxy.mjs";

// Official list prices in USD per 1,000,000 tokens, keyed by a normalized
// model id. This is the fallback source; the persisted models.dev snapshot
// below overrides it when present. Prices follow the official vendor pages
// and the same audit cc-switch ships in its seed table.
const SEED_PRICING = [
  // Anthropic Claude
  ["claude-fable-5", "Claude Fable 5", 10, 50, 1.0, 12.5],
  ["claude-mythos-5", "Claude Mythos 5", 10, 50, 1.0, 12.5],
  ["claude-opus-5", "Claude Opus 5", 5, 25, 0.5, 6.25],
  ["claude-opus-4-8", "Claude Opus 4.8", 5, 25, 0.5, 6.25],
  ["claude-opus-4-7", "Claude Opus 4.7", 5, 25, 0.5, 6.25],
  ["claude-opus-4-6", "Claude Opus 4.6", 5, 25, 0.5, 6.25],
  ["claude-opus-4-6-20260206", "Claude Opus 4.6", 5, 25, 0.5, 6.25],
  ["claude-sonnet-5", "Claude Sonnet 5", 3, 15, 0.3, 3.75],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6", 3, 15, 0.3, 3.75],
  ["claude-sonnet-4-6-20260217", "Claude Sonnet 4.6", 3, 15, 0.3, 3.75],
  ["claude-sonnet-4-5-20250929", "Claude Sonnet 4.5", 3, 15, 0.3, 3.75],
  ["claude-haiku-4-5", "Claude Haiku 4.5", 1, 5, 0.1, 1.25],
  ["claude-haiku-4-5-20251001", "Claude Haiku 4.5", 1, 5, 0.1, 1.25],
  ["claude-opus-4-5-20251101", "Claude Opus 4.5", 5, 25, 0.5, 6.25],
  ["claude-opus-4-20250514", "Claude Opus 4", 15, 75, 1.5, 18.75],
  ["claude-opus-4-1-20250805", "Claude Opus 4.1", 15, 75, 1.5, 18.75],
  ["claude-sonnet-4-20250514", "Claude Sonnet 4", 3, 15, 0.3, 3.75],
  ["claude-3-5-haiku-20241022", "Claude 3.5 Haiku", 0.8, 4, 0.08, 1],
  ["claude-3-5-sonnet-20241022", "Claude 3.5 Sonnet", 3, 15, 0.3, 3.75],

  // OpenAI GPT
  ["gpt-5.6-sol", "GPT-5.6 Sol", 5, 30, 0.5, 6.25],
  ["gpt-5.6-terra", "GPT-5.6 Terra", 2, 12, 0.2, 2.5],
  ["gpt-5.6-luna", "GPT-5.6 Luna", 0.2, 1.2, 0.02, 0.25],
  ["gpt-5.6", "GPT-5.6 Sol", 5, 30, 0.5, 6.25],
  ["gpt-5.6-low", "GPT-5.6 Sol", 5, 30, 0.5, 6.25],
  ["gpt-5.6-medium", "GPT-5.6 Sol", 5, 30, 0.5, 6.25],
  ["gpt-5.6-high", "GPT-5.6 Sol", 5, 30, 0.5, 6.25],
  ["gpt-5.6-xhigh", "GPT-5.6 Sol", 5, 30, 0.5, 6.25],
  ["gpt-5.6-minimal", "GPT-5.6 Sol", 5, 30, 0.5, 6.25],
  ["gpt-5.5", "GPT-5.5", 5, 30, 0.5, 0],
  ["gpt-5.5-low", "GPT-5.5", 5, 30, 0.5, 0],
  ["gpt-5.5-medium", "GPT-5.5", 5, 30, 0.5, 0],
  ["gpt-5.5-high", "GPT-5.5", 5, 30, 0.5, 0],
  ["gpt-5.5-xhigh", "GPT-5.5", 5, 30, 0.5, 0],
  ["gpt-5.5-minimal", "GPT-5.5", 5, 30, 0.5, 0],
  ["gpt-5.4", "GPT-5.4", 2.5, 15, 0.25, 0],
  ["gpt-5.4-mini", "GPT-5.4 Mini", 0.75, 4.5, 0.075, 0],
  ["gpt-5.4-nano", "GPT-5.4 Nano", 0.2, 1.25, 0.02, 0],
  ["gpt-5.2", "GPT-5.2", 1.75, 14, 0.175, 0],
  ["gpt-5.2-codex", "GPT-5.2 Codex", 1.75, 14, 0.175, 0],
  ["gpt-5.2-codex-low", "GPT-5.2 Codex", 1.75, 14, 0.175, 0],
  ["gpt-5.2-codex-medium", "GPT-5.2 Codex", 1.75, 14, 0.175, 0],
  ["gpt-5.2-codex-high", "GPT-5.2 Codex", 1.75, 14, 0.175, 0],
  ["gpt-5.2-codex-xhigh", "GPT-5.2 Codex", 1.75, 14, 0.175, 0],
  ["gpt-5.3-codex", "GPT-5.3 Codex", 1.75, 14, 0.175, 0],
  ["gpt-5.3-codex-spark", "GPT-5.3 Codex Spark", 1.75, 14, 0.175, 0],
  ["gpt-5.1", "GPT-5.1", 1.25, 10, 0.125, 0],
  ["gpt-5.1-codex", "GPT-5.1 Codex", 1.25, 10, 0.125, 0],
  ["gpt-5.1-codex-max", "GPT-5.1 Codex Max", 1.25, 10, 0.125, 0],
  ["gpt-5", "GPT-5", 1.25, 10, 0.125, 0],
  ["gpt-5-codex", "GPT-5 Codex", 1.25, 10, 0.125, 0],
  ["gpt-5-mini", "GPT-5 Mini", 0.25, 2, 0.025, 0],
  ["gpt-5-nano", "GPT-5 Nano", 0.05, 0.4, 0.005, 0],
  ["gpt-4.1", "GPT-4.1", 2, 8, 0.5, 0],
  ["gpt-4.1-mini", "GPT-4.1 Mini", 0.4, 1.6, 0.1, 0],
  ["gpt-4.1-nano", "GPT-4.1 Nano", 0.1, 0.4, 0.025, 0],
  ["o3", "OpenAI o3", 2, 8, 0.5, 0],
  ["o4-mini", "OpenAI o4-mini", 1.1, 4.4, 0.275, 0],
  ["o3-pro", "OpenAI o3-pro", 20, 80, 0, 0],
  ["o3-mini", "OpenAI o3-mini", 0.55, 2.2, 0.55, 0],
  ["o1", "OpenAI o1", 15, 60, 7.5, 0],
  ["o1-mini", "OpenAI o1-mini", 0.55, 2.2, 0.55, 0],
  ["codex-mini", "Codex Mini", 0.75, 3, 0.025, 0],

  // Google Gemini
  ["gemini-3.6-flash", "Gemini 3.6 Flash", 1.5, 7.5, 0.15, 0],
  ["gemini-3.5-flash", "Gemini 3.5 Flash", 1.5, 9, 0.15, 0],
  ["gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", 0.3, 2.5, 0.03, 0],
  ["gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview", 2, 12, 0.2, 0],
  ["gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", 0.25, 1.5, 0.025, 0],
  ["gemini-3.1-flash-lite-preview", "Gemini 3.1 Flash Lite Preview", 0.25, 1.5, 0.025, 0],
  ["gemini-3-pro-preview", "Gemini 3 Pro Preview", 2, 12, 0.2, 0],
  ["gemini-3-flash-preview", "Gemini 3 Flash Preview", 0.5, 3, 0.05, 0],
  ["gemini-2.5-pro", "Gemini 2.5 Pro", 1.25, 10, 0.125, 0],
  ["gemini-2.5-flash", "Gemini 2.5 Flash", 0.3, 2.5, 0.03, 0],
  ["gemini-2.5-flash-lite", "Gemini 2.5 Flash Lite", 0.1, 0.4, 0.01, 0],
  ["gemini-2.0-flash", "Gemini 2.0 Flash", 0.1, 0.4, 0.025, 0],

  // xAI Grok
  ["grok-4.6", "Grok 4.6", 2, 6, 0.5, 0],
  ["grok-4.5", "Grok 4.5", 2, 6, 0.3, 0],
  ["grok-4.5-build", "Grok 4.5 Build", 2, 6, 0.3, 0],
  ["grok-4.3", "Grok 4.3", 1.25, 2.5, 0.2, 0],
  ["grok-4", "Grok 4", 3, 15, 0.75, 0],
  ["grok-3", "Grok 3", 3, 15, 0.75, 0],
  ["grok-3-mini", "Grok 3 Mini", 0.25, 0.5, 0.075, 0],

  // DeepSeek
  ["deepseek-v3.2", "DeepSeek V3.2", 0.28, 0.42, 0.028, 0],
  ["deepseek-v3.1", "DeepSeek V3.1", 0.55, 1.67, 0.055, 0],
  ["deepseek-v3", "DeepSeek V3", 0.28, 1.11, 0.028, 0],
  ["deepseek-chat", "DeepSeek Chat", 0.14, 0.28, 0.0028, 0],
  ["deepseek-reasoner", "DeepSeek Reasoner", 0.14, 0.28, 0.0028, 0],
  ["deepseek-v4-flash", "DeepSeek V4 Flash", 0.14, 0.28, 0.0028, 0],
  ["deepseek-v4-flash-0731", "DeepSeek V4 Flash", 0.14, 0.28, 0.0028, 0],
  ["deepseek-v4-pro", "DeepSeek V4 Pro", 0.435, 0.87, 0.003625, 0],

  // Kimi (Moonshot)
  ["kimi-k2-thinking", "Kimi K2 Thinking", 0.55, 2.2, 0.1, 0],
  ["kimi-k2-0905", "Kimi K2", 0.55, 2.2, 0.1, 0],
  ["kimi-k2-turbo", "Kimi K2 Turbo", 1.11, 8.06, 0.14, 0],
  ["kimi-k2.5", "Kimi K2.5", 0.6, 3, 0.1, 0],
  ["kimi-k2.6", "Kimi K2.6", 0.95, 4, 0.16, 0],
  ["kimi-k2.7-code", "Kimi K2.7 Code", 0.95, 4, 0.19, 0],
  ["kimi-k2.7-code-highspeed", "Kimi K2.7 Code HighSpeed", 1.9, 8, 0.38, 0],
  ["kimi-k3", "Kimi K3", 3, 15, 0.3, 0],
  ["k3", "Kimi K3", 3, 15, 0.3, 0],

  // Tencent Hunyuan
  ["hunyuan-hy3", "Hunyuan Hy3", 0.14, 0.56, 0.035, 0],
  ["hy3", "Hunyuan Hy3", 0.14, 0.56, 0.035, 0],

  // MiniMax
  ["minimax-m2.1", "MiniMax M2.1", 0.27, 0.95, 0.03, 0],
  ["minimax-m2.1-lightning", "MiniMax M2.1 Lightning", 0.27, 2.33, 0.03, 0],
  ["minimax-m2", "MiniMax M2", 0.27, 0.95, 0.03, 0],
  ["minimax-m2.5", "MiniMax M2.5", 0.15, 0.95, 0.03, 0],
  ["minimax-m2.5-lightning", "MiniMax M2.5 Lightning", 0.3, 2.4, 0.03, 0],
  ["minimax-m2.7", "MiniMax M2.7", 0.3, 1.2, 0.06, 0.375],
  ["minimax-m2.7-highspeed", "MiniMax M2.7 Highspeed", 0.6, 2.4, 0.06, 0.375],
  ["minimax-m3", "MiniMax M3", 0.3, 1.2, 0.06, 0],

  // GLM (Zhipu / Z.ai)
  ["glm-4.7", "GLM-4.7", 0.6, 2.2, 0.11, 0],
  ["glm-4.6", "GLM-4.6", 0.6, 2.2, 0.11, 0],
  ["glm-5", "GLM-5", 1, 3.2, 0.2, 0],
  ["glm-5.1", "GLM-5.1", 1.4, 4.4, 0.26, 0],
  ["glm-5.2", "GLM-5.2", 1.4, 4.4, 0.26, 0],
  ["glm-5-turbo", "GLM-5-Turbo", 1.2, 4, 0.24, 0],
  ["glm-5v-turbo", "GLM-5V-Turbo", 1.2, 4, 0.24, 0],

  // MiMo (Xiaomi)
  ["mimo-v2-flash", "MiMo V2 Flash", 0.09, 0.29, 0.009, 0],
  ["mimo-v2-pro", "MiMo V2 Pro", 0.435, 0.87, 0.0036, 0],
  ["mimo-v2.5", "MiMo V2.5", 0.14, 0.29, 0.0028, 0],
  ["mimo-v2.5-pro", "MiMo V2.5 Pro", 0.435, 0.87, 0.0036, 0],

  // Qwen (Alibaba)
  ["qwen3.8-max", "Qwen3.8 Max", 2, 6, 0.25, 2.5],
  ["qwen3.8-max-preview", "Qwen3.8 Max", 2, 6, 0.25, 2.5],
  ["qwen3.7-max", "Qwen3.7 Max", 2.5, 7.5, 0.25, 0],
  ["qwen3.7-plus", "Qwen3.7 Plus", 0.4, 1.6, 0.08, 0],
  ["qwen3.6-plus", "Qwen3.6 Plus", 0.325, 1.95, 0.065, 0],
  ["qwen3.6-flash", "Qwen3.6 Flash", 0.1875, 1.125, 0.0375, 0],
  ["qwen3.5-plus", "Qwen3.5 Plus", 0.26, 1.56, 0.052, 0],
  ["qwen3-max", "Qwen3 Max", 0.78, 3.9, 0, 0],

  // StepFun
  ["step-3.7-flash", "Step 3.7 Flash", 0.19, 1.13, 0.04, 0],
  ["step-3.5-flash", "Step 3.5 Flash", 0.1, 0.3, 0.02, 0],
  ["step-3.5-flash-2603", "Step 3.5 Flash 2603", 0.1, 0.3, 0.02, 0],
];

export const MODEL_PRICING_PATH = path.join(STATE_DIR, "model-pricing.json");
const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_FETCH_TIMEOUT_MS = 15_000;
const FILE_VERSION = 1;

function buildSeedIndex() {
  const index = new Map();
  for (const [modelId, displayName, input, output, cacheRead, cacheWrite] of SEED_PRICING) {
    index.set(modelId, { modelId, displayName, input, output, cacheRead, cacheWrite });
  }
  return index;
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function normalizePersistedEntry(entry) {
  return {
    input: numberValue(entry?.input),
    output: numberValue(entry?.output),
    cacheRead: numberValue(entry?.cacheRead ?? entry?.cache_read),
    cacheWrite: numberValue(entry?.cacheWrite ?? entry?.cache_write),
  };
}

// Reads the persisted models.dev snapshot without throwing. A corrupt or
// missing file simply leaves the seed prices in place, so pricing can never
// take the router down.
function readPersistedPricing() {
  if (!existsSync(MODEL_PRICING_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(MODEL_PRICING_PATH, "utf8"));
    if (parsed?.version !== FILE_VERSION || !parsed?.models) return undefined;
    const models = new Map();
    for (const [modelId, entry] of Object.entries(parsed.models)) {
      if (!modelId || !entry) continue;
      models.set(modelId, normalizePersistedEntry(entry));
    }
    return {
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      source: typeof parsed.source === "string" ? parsed.source : "models.dev",
      modelCount: models.size,
      models,
    };
  } catch {
    return undefined;
  }
}

// Merged index: seed first, then persisted overrides win per model id. Values
// are USD per million tokens.
export function loadPricingIndex() {
  const index = buildSeedIndex();
  const persisted = readPersistedPricing();
  if (persisted) {
    for (const [modelId, entry] of persisted.models) {
      const seed = index.get(modelId);
      index.set(modelId, {
        modelId,
        displayName: seed?.displayName || modelId,
        input: entry.input,
        output: entry.output,
        cacheRead: entry.cacheRead,
        cacheWrite: entry.cacheWrite,
      });
    }
  }
  return index;
}

export function pricingSyncState() {
  const persisted = readPersistedPricing();
  return persisted
    ? {
        source: persisted.source,
        updatedAt: persisted.updatedAt,
        modelCount: persisted.modelCount,
      }
    : { source: "seed", updatedAt: null, modelCount: SEED_PRICING.length };
}

// Normalize a usage model id for pricing: drop the provider prefix, colon
// suffix, casing, and `@` separators. Mirrors cc-switch's
// `clean_model_id_for_pricing` so the same wire name resolves to the same row.
export function normalizeModelIdForPricing(modelId) {
  const value = String(modelId ?? "");
  let normalized = value.slice(value.lastIndexOf("/") + 1);
  normalized = normalized.split(":")[0] || "";
  normalized = normalized.trim().replace(/@/g, "-").toLowerCase();
  if (normalized.endsWith("[1m]")) {
    normalized = normalized.slice(0, -"[1m]".length).trim();
  }
  return normalized;
}

function stripReasoningEffortSuffix(modelId) {
  for (const suffix of ["-minimal", "-low", "-medium", "-high", "-xhigh"]) {
    if (modelId.endsWith(suffix)) return modelId.slice(0, -suffix.length);
  }
  return undefined;
}

function stripDateSuffix(modelId) {
  const match = modelId.match(/-(\d{8}|\d{6})$/);
  if (!match) return undefined;
  const suffix = match[1];
  if (suffix.length === 8) {
    // YYYYMMDD — treat any 8-digit tail as a date/version suffix.
    return modelId.slice(0, -(suffix.length + 1));
  }
  // 6-digit YYMMDD: only strip when month and day are plausible.
  const month = Number(suffix.slice(2, 4));
  const day = Number(suffix.slice(4, 6));
  if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
    return modelId.slice(0, -(suffix.length + 1));
  }
  return undefined;
}

// Generates the fallback candidates for a normalized id, shortest variants
// first, so dated/effort-suffixed names resolve to their bare pricing row.
export function modelPricingCandidates(modelId) {
  const cleaned = normalizeModelIdForPricing(modelId);
  if (!cleaned) return [];
  const candidates = [];
  const seen = new Set();
  const push = (candidate) => {
    if (candidate && !seen.has(candidate)) {
      seen.add(candidate);
      candidates.push(candidate);
    }
  };

  let current = cleaned;
  for (let guard = 0; guard < 8; guard += 1) {
    push(current);
    const next =
      stripReasoningEffortSuffix(current) || stripDateSuffix(current);
    if (!next || next === current) break;
    current = next;
  }
  return candidates;
}

function prefixMatches(index, candidate) {
  const prefix = `${candidate}-`;
  let best;
  for (const key of index.keys()) {
    if (!key.startsWith(prefix)) continue;
    if (!best || key.length < best.length) best = key;
  }
  return best ? index.get(best) : undefined;
}

// Resolves pricing for an arbitrary model id. Exact candidates are tried
// first, then a shortest-prefix fallback so `claude-opus-4-8-20260206` lands
// on `claude-opus-4-8`.
export function findModelPricing(modelId, index = loadPricingIndex()) {
  for (const candidate of modelPricingCandidates(modelId)) {
    const exact = index.get(candidate);
    if (exact) return exact;
  }
  for (const candidate of modelPricingCandidates(modelId)) {
    const prefix = prefixMatches(index, candidate);
    if (prefix) return prefix;
  }
  return undefined;
}

const MILLION = 1_000_000;

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

// Computes the USD cost for one accumulated usage bucket. `inputTokens`
// already excludes the cached portion for Anthropic-style sources, and
// includes it for OpenAI-style sources; subtracting `cachedInputTokens`
// recovers the billable fresh input in both cases (the cache count is 0 on
// sources that report fresh input).
export function computeUsageCost(pricing, usage) {
  const cached = Math.max(0, Math.round(Number(usage?.cachedInputTokens) || 0));
  const input = Math.max(0, Math.round(Number(usage?.inputTokens) || 0));
  const output = Math.max(0, Math.round(Number(usage?.outputTokens) || 0));
  const billableInput = Math.max(0, input - cached);
  const inputCost = (billableInput * (pricing?.input || 0)) / MILLION;
  const outputCost = (output * (pricing?.output || 0)) / MILLION;
  const cacheReadCost = (cached * (pricing?.cacheRead || 0)) / MILLION;
  const totalCost = inputCost + outputCost + cacheReadCost;
  return {
    inputCost: round6(inputCost),
    outputCost: round6(outputCost),
    cacheReadCost: round6(cacheReadCost),
    cacheWriteCost: 0,
    totalCost: round6(totalCost),
  };
}

// Flatten models.dev's per-provider model catalog into a normalized pricing
// map, dropping non-text models. Mirrors cc-switch's models.dev import.
export function flattenModelsDevPricing(payload) {
  const byId = new Map();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return byId;
  const markers = [
    "audio",
    "deprecated",
    "embedding",
    "image",
    "moderation",
    "realtime",
    "transcribe",
    "tts",
    "video",
  ];
  const nonTextOutput = new Set(["audio", "image", "video"]);
  for (const provider of Object.values(payload)) {
    if (!provider || typeof provider !== "object") continue;
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      if (!model || typeof model !== "object") continue;
      const searchable = `${modelId} ${model.name ?? ""}`.toLowerCase();
      if (String(model.status ?? "").toLowerCase() === "deprecated") continue;
      if (markers.some((marker) => searchable.includes(marker))) continue;
      const outputModalities = Array.isArray(model.modalities?.output)
        ? model.modalities.output
            .filter((modality) => typeof modality === "string")
            .map((modality) => modality.toLowerCase())
        : [];
      if (
        outputModalities.length > 0 &&
        (!outputModalities.includes("text") ||
          outputModalities.some((modality) => nonTextOutput.has(modality)))
      ) {
        continue;
      }
      const cost = model.cost;
      if (!cost || typeof cost !== "object") continue;
      const input = numberValue(cost.input);
      const output = numberValue(cost.output);
      if (input === 0 && output === 0) continue;
      const normalizedId = normalizeModelIdForPricing(modelId);
      if (!normalizedId) continue;
      if (byId.has(normalizedId)) continue;
      byId.set(normalizedId, {
        input,
        output,
        cacheRead: numberValue(cost.cache_read),
        cacheWrite: numberValue(cost.cache_write),
      });
    }
  }
  return byId;
}

export function savePricingOverrides(models) {
  const payload = {
    version: FILE_VERSION,
    updatedAt: new Date().toISOString(),
    source: "models.dev",
    modelCount: models.size,
    models: Object.fromEntries(models),
  };
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(MODEL_PRICING_PATH, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

// Fetches and persists the models.dev catalog. Failures are returned, not
// thrown, so callers can surface the message without breaking a request path.
export async function syncModelsDevPricing({ fetchImpl = nativeProxyFetch() } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODELS_DEV_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(MODELS_DEV_URL, { signal: controller.signal });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const payload = await response.json();
    const models = flattenModelsDevPricing(payload);
    if (models.size === 0) {
      return { ok: false, error: "models.dev returned no usable text models" };
    }
    savePricingOverrides(models);
    return { ok: true, modelCount: models.size, updatedAt: pricingSyncState().updatedAt };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}
