import { spawn as spawnProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoveryDisabled } from "./discovery-mode.mjs";
import { writePrivateJson } from "./file-security.mjs";
import { discoverProviderModels } from "./model-discovery.mjs";
import { CHECKED_IN_MODELS } from "./model-registry.mjs";
import { withModelOverlayLock } from "./model-overlay-lock.mjs";
import { applyModelOverlayPublication } from "./model-overlay-publication.mjs";
import { modelPickerSnapshot } from "./model-picker-state.mjs";
import { syncLocalRouterModels } from "./local-router-sync.mjs";
import { PROVIDER_SELECTION_PATH, SOURCE_ROOT, STATE_DIR } from "./paths.mjs";
import { readProviderSelectionDetail } from "./provider-selection.mjs";
import { readUserModels } from "./user-models.mjs";

const SELF = fileURLToPath(import.meta.url);
const INTERVAL_MS = 5 * 60_000;
const STATE_PATH = path.join(STATE_DIR, "local-router-auto-sync.json");

export function localRouterAutoSyncEnabled({
  disabled = discoveryDisabled,
  selectionExists = () => existsSync(PROVIDER_SELECTION_PATH),
  selection = readProviderSelectionDetail,
} = {}) {
  if (disabled() || !selectionExists()) return false;
  const selected = selection();
  // A missing or malformed selection falls back to all providers for legacy
  // request handling. It is not consent to start a background network probe.
  return !selected.degraded && selected.providers.includes("local-router");
}

function publicationFingerprint() {
  const models = [...CHECKED_IN_MODELS, ...readUserModels()]
    .filter((model) => model.provider === "local-router");
  if (models.length === 0) return undefined;
  const slugs = new Set(models.map((model) => model.slug));
  const { hidden, visible } = modelPickerSnapshot();
  return createHash("sha256").update(JSON.stringify({
    models,
    hidden: hidden.filter((slug) => slugs.has(slug)),
    visible: visible.filter((slug) => slugs.has(slug)),
  })).digest("hex");
}

export async function autoSyncLocalRouterModels({
  enabled = localRouterAutoSyncEnabled,
  discover = discoverProviderModels,
  publish = applyModelOverlayPublication,
  statePath = STATE_PATH,
} = {}) {
  if (!enabled()) return { skipped: true };
  // Discovery already has a 30-second HTTP deadline; it must not hold up an
  // unrelated manual model edit while waiting for the local service.
  const discovery = await discover("local-router", { refresh: true });
  return withModelOverlayLock(async () => {
    if (!enabled()) return { skipped: true };
    const result = await syncLocalRouterModels({
      discover: async () => discovery,
      lock: (operation) => operation(),
    });
    const fingerprint = publicationFingerprint();
    let previous;
    try { previous = JSON.parse(readFileSync(statePath, "utf8")).fingerprint; } catch {}
    if (!fingerprint || fingerprint === previous) return { ...result, published: false };
    // The installed service reads its model registry once. Publication in a
    // fresh child and a service reload are both required before recording
    // success. A failed run leaves its old fingerprint, so the next worker
    // retries even though all discovered IDs now exist in user-models.json.
    await publish({ restart: true });
    writePrivateJson(statePath, { version: 1, fingerprint });
    return { ...result, published: true };
  });
}

export function startLocalRouterAutoSync({
  enabled = localRouterAutoSyncEnabled,
  spawn = spawnProcess,
  setInterval = globalThis.setInterval,
  clearInterval = globalThis.clearInterval,
  onError = () => {},
} = {}) {
  let worker;
  let stopped = false;
  const tick = () => {
    if (stopped || worker || !enabled()) return;
    try {
      // The independent Task Manager host owns this monitor on Windows: a
      // router child would be killed by taskkill /T during its own reload,
      // even with detached:true. Keep the worker hidden and outside the
      // host's ordinary shutdown cancellation path as well.
      const child = spawn(process.execPath, [SELF, "--worker"], {
        cwd: SOURCE_ROOT,
        env: { ...process.env, MODEL_ROUTER_TARGET: "codex" },
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      });
      worker = child;
      child.once("error", (error) => { if (worker === child) worker = undefined; onError(error); });
      child.once("exit", (code) => {
        if (worker === child) worker = undefined;
        if (code !== 0) onError(new Error("Local model discovery worker did not finish; it will retry."));
      });
      child.unref();
    } catch (error) { worker = undefined; onError(error); }
  };
  tick();
  const timer = setInterval(tick, INTERVAL_MS);
  timer.unref?.();
  return { stop() { stopped = true; clearInterval(timer); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF && process.argv.includes("--worker")) {
  autoSyncLocalRouterModels().catch(() => { process.exitCode = 1; });
}
