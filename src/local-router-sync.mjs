import { spawnSync } from "node:child_process";
import path from "node:path";

import { discoverProviderModels } from "./model-discovery.mjs";
import { SOURCE_ROOT } from "./paths.mjs";
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
  const additions = (Array.isArray(unregistered) ? unregistered : [])
    .map((id) => String(id))
    .filter((id) => id && !curated.has(id));

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

export async function syncLocalRouterModels() {
  const discovery = await discoverProviderModels("local-router");
  const merged = mergeLocalRouterModels({
    existing: readUserModels(),
    unregistered: discovery.unregistered,
    metadataById: discovery.metadataById,
  });
  if (merged.added.length > 0) {
    writeUserModels(merged.models);
  }
  return {
    discovered: discovery.discovered.length,
    added: merged.added,
    total: merged.total,
    unavailable: discovery.unavailable,
  };
}

// Rebuild merged-models.json (what Codex's picker reads) without re-capturing
// the native catalog. The router reloads the registry on its next start, so a
// fresh model is both listed in Codex and routable once the process restarts.
export function rebuildCatalog() {
  const result = spawnSync(
    process.execPath,
    [path.join(SOURCE_ROOT, "src", "catalog.mjs")],
    {
      cwd: SOURCE_ROOT,
      env: { ...process.env, MODEL_ROUTER_TARGET: "codex" },
      encoding: "utf8",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || "Codex model catalog could not be refreshed.").trim(),
    );
  }
  return result.stdout || "";
}
