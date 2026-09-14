import { discoverProviderModels } from "./model-discovery.mjs";
import { CHECKED_IN_MODELS } from "./model-registry.mjs";
import { withModelOverlayLock } from "./model-overlay-lock.mjs";
import { seedModelsVisible } from "./model-picker-state.mjs";
import { readUserModels, userModelEntry, writeUserModels } from "./user-models.mjs";

// The local-router provider fronts an OpenAI-compatible service running on this
// machine. Its model list changes when that service adds or removes a model
// (for example a freshly released GLM), but the router only lists models that
// are either in the checked-in registry or curated into user-models.json. This
// folds the live list into user models so a one-click sync can surface the new
// models without touching the checked-in config/ tree.
export function mergeLocalRouterModels({ existing, unregistered, metadataById = {} }) {
  const mine = existing.filter((model) => model.provider === "local-router");
  const others = existing.filter((model) => model.provider !== "local-router");
  const curated = new Set(mine.map((model) => model.upstreamModel));
  const additions = [...new Set((Array.isArray(unregistered) ? unregistered : [])
    .map((id) => String(id))
    .filter((id) => id && !curated.has(id)))];

  const nextMine = [...mine];
  for (let index = 0; index < additions.length; index += 1) {
    const id = additions[index];
    const discovered = metadataById[id] || {};
    nextMine.push(
      userModelEntry({
        providerId: "local-router",
        upstreamId: id,
        priority: 100 + mine.length + index,
        metadata: Object.keys(discovered).length > 0 ? discovered : undefined,
      }),
    );
  }

  return {
    models: [...others, ...nextMine],
    added: additions,
    total: nextMine.length,
  };
}

export async function syncLocalRouterModels({
  discover = discoverProviderModels,
  lock = withModelOverlayLock,
} = {}) {
  const discovery = await discover("local-router", { refresh: true });
  return lock(() => {
    // The process registry predates other writers' edits. Re-read the durable
    // overlay under the shared lock and compare the live list only to shipped
    // entries; discovery.unregistered can otherwise omit a deleted user model.
    const shipped = CHECKED_IN_MODELS.filter((model) => model.provider === "local-router");
    const shippedIds = new Set(shipped.map((model) => model.upstreamModel));
    const merged = mergeLocalRouterModels({
      existing: readUserModels(),
      unregistered: discovery.discovered.filter((id) => !shippedIds.has(id)),
      metadataById: discovery.metadataById,
    });
    if (merged.added.length > 0) writeUserModels(merged.models);
    seedModelsVisible([...shipped, ...merged.models]
      .filter((model) => model.provider === "local-router")
      .map((model) => model.slug));
    return {
      discovered: discovery.discovered.length,
      added: merged.added,
      total: merged.total,
      unavailable: discovery.unavailable,
    };
  });
}

// Remove local-router user models the live service no longer advertises. Only
// the curated local-router entries are touched; other providers are preserved.
export function planLocalRouterRemovals({ existing, available }) {
  const mine = existing.filter((model) => model.provider === "local-router");
  const others = existing.filter((model) => model.provider !== "local-router");
  const availableSet = new Set(
    (Array.isArray(available) ? available : []).map((id) => String(id)),
  );
  const removed = mine
    .map((model) => model.upstreamModel)
    .filter((id) => !availableSet.has(id));
  const kept = mine.filter((model) => availableSet.has(model.upstreamModel));
  return {
    models: [...others, ...kept],
    removed,
    total: kept.length,
  };
}

export async function cleanLocalRouterModels({ discover = discoverProviderModels } = {}) {
  const discovery = await discover("local-router", { refresh: true });
  return withModelOverlayLock(() => {
    const merged = planLocalRouterRemovals({
      existing: readUserModels(),
      available: discovery.discovered,
    });
    if (merged.removed.length > 0) writeUserModels(merged.models);
    return {
      removed: merged.removed,
      total: merged.total,
      discovered: discovery.discovered.length,
    };
  });
}

// Always publish the gateway and every installed client from fresh process state.
export { publishModelOverlayFresh as rebuildCatalog } from "./model-overlay-publication.mjs";
