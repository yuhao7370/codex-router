import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { protectPrivateFile } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

const VERSION = 1;
const DEFAULT_PORT = 6000;
const REQUEST_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 15_000;
const FAILOVER_COOLDOWN_MS = 30_000;
const FAILURE_MEMORY_MS = 5 * 60 * 1000;
const FAILOVER_TRIGGER_STATUSES = new Set([401, 403, 429]);
const STATE_PATH = path.join(STATE_DIR, "task-manager.json");

const MAX_INJECTION_EVENTS = 100;

// The active account fetched from Codex_Task_Manager. `null` means the bridge
// has no usable account right now, which makes the native path fall back to
// the app's own authorization.
let cached = null;
let injectionCount = 0;
const injectionEvents = [];
let lastRefreshFailure = null;
let lastFailoverAt = 0;
let lastFailover = null;
let failoverPending = false;
let failoverScheduled = false;
const accountFailureMemory = new Map();
let poolCredentials = [];
let poolCursor = 0;
let lastInjectedId = null;

function defaults() {
  return {
    version: VERSION,
    enabled: false,
    failover: false,
    pool: [],
    port: DEFAULT_PORT,
    token: "",
  };
}

export function readTaskManagerConfig() {
  if (!existsSync(STATE_PATH)) return defaults();
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    const state = { ...defaults(), ...parsed };
    state.enabled = Boolean(state.enabled);
    state.failover = Boolean(state.failover);
    state.pool = Array.isArray(state.pool)
      ? state.pool.map((id) => String(id)).filter(Boolean)
      : [];
    state.port = Number.isInteger(state.port) ? state.port : DEFAULT_PORT;
    if (state.port < 1 || state.port > 65_535) state.port = DEFAULT_PORT;
    state.token = String(state.token || "").trim();
    return state;
  } catch {
    return defaults();
  }
}

function writeTaskManagerConfig(next) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const state = { ...readTaskManagerConfig(), ...next, version: VERSION };
  const temporary = `${STATE_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    protectPrivateFile(temporary);
    renameSync(temporary, STATE_PATH);
    protectPrivateFile(STATE_PATH);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  return state;
}

export function setTaskManagerEnabled(enabled) {
  const state = writeTaskManagerConfig({ enabled: Boolean(enabled) });
  if (state.enabled) {
    refreshActiveAccount().catch(() => {});
  } else {
    cached = null;
  }
  return state;
}

export function setTaskManagerPort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("Port must be an integer between 1 and 65535.");
  }
  cached = null;
  return writeTaskManagerConfig({ port: value });
}

export function setTaskManagerToken(token) {
  const value = String(token || "").trim();
  cached = null;
  return writeTaskManagerConfig({ token: value });
}

export function setTaskManagerFailover(failover) {
  const state = writeTaskManagerConfig({ failover: Boolean(failover) });
  if (!state.failover) {
    failoverPending = false;
    accountFailureMemory.clear();
  }
  return state;
}

export function setTaskManagerPool(ids) {
  const value = (Array.isArray(ids) ? ids : [])
    .map((id) => String(id))
    .filter(Boolean);
  poolCredentials = [];
  poolCursor = 0;
  const state = writeTaskManagerConfig({ pool: value });
  if (state.enabled && value.length) {
    refreshPool().catch(() => {});
  }
  return state;
}

function defaultTokenPath() {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "Codex Limits", "auth-api-token");
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Codex Limits",
      "auth-api-token",
    );
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "codex-limits", "auth-api-token");
}

function tokenFor(state) {
  if (state.token) return state.token;
  try {
    const discovered = readFileSync(defaultTokenPath(), "utf8").trim();
    if (discovered) return discovered;
  } catch {
    // Not configured; the bridge stays disabled in practice.
  }
  return "";
}

function requestJson(port, token, pathname, method = "GET", body) {
  // Use node:http rather than fetch: the WHATWG fetch spec blocks port 6000
  // (X11), which is Codex_Task_Manager's default. The raw HTTP client has no
  // such allow-list restriction.
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload = null;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers,
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          let body = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            // Non-JSON or empty body.
          }
          resolve({ status: response.statusCode || 0, body });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("request timed out")));
    request.on("error", reject);
    if (payload !== null) request.write(payload);
    request.end();
  });
}

export function recordInjection(accountId, pathname) {
  injectionCount += 1;
  injectionEvents.unshift({
    at: new Date().toISOString(),
    accountId,
    path: pathname || "",
  });
  if (injectionEvents.length > MAX_INJECTION_EVENTS) {
    injectionEvents.length = MAX_INJECTION_EVENTS;
  }
}

export function injectionStats() {
  return { count: injectionCount, recent: injectionEvents.slice(0, 20) };
}

export async function testTaskManagerConnection() {
  const state = readTaskManagerConfig();
  try {
    const { status, body } = await requestJson(state.port, tokenFor(state), "/health");
    return { ok: status === 200, status, body };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function listTaskManagerAccounts() {
  const state = readTaskManagerConfig();
  const { status, body } = await requestJson(
    state.port,
    tokenFor(state),
    "/api/auth/accounts",
  );
  if (status !== 200) {
    throw new Error(
      `Codex_Task_Manager returned HTTP ${status}: ${body?.error || "unknown error"}`,
    );
  }
  return body;
}

export async function selectTaskManagerAccount(id) {
  const state = readTaskManagerConfig();
  const { status, body } = await requestJson(
    state.port,
    tokenFor(state),
    `/api/auth/switch?id=${encodeURIComponent(String(id))}`,
    "POST",
  );
  if (status !== 200) {
    throw new Error(
      `Select account failed: ${body?.error || `HTTP ${status}`}`,
    );
  }
  await refreshActiveAccount();
  return body;
}

export async function importTaskManagerAccount(authJson) {
  const state = readTaskManagerConfig();
  const { status, body } = await requestJson(
    state.port,
    tokenFor(state),
    "/api/auth/import",
    "POST",
    authJson,
  );
  if (status !== 200) {
    throw new Error(body?.error || `Codex_Task_Manager returned HTTP ${status}`);
  }
  await refreshActiveAccount();
  return body;
}

export async function refreshActiveAccount() {
  const state = readTaskManagerConfig();
  if (!state.enabled) {
    cached = null;
    lastRefreshFailure = null;
    return null;
  }
  const token = tokenFor(state);
  if (!token) {
    cached = null;
    lastRefreshFailure = null;
    return null;
  }
  try {
    const { status, body } = await requestJson(state.port, token, "/api/auth/current");
    if (status === 200 && body && typeof body.access_token === "string" && body.access_token) {
      lastRefreshFailure = null;
      // Codex_Task_Manager is the single source of truth for quota. Read the
      // cached usage it exposes instead of hitting OpenAI again, so this value
      // can never drift from what the CTM dashboard shows.
      const usage = body.usage || null;
      const used =
        usage && typeof usage.weekly_used_percent === "number"
          ? usage.weekly_used_percent
          : null;
      cached = {
        accountId: typeof body.account_id === "string" ? body.account_id : "",
        accessToken: body.access_token,
        plan: usage && typeof usage.plan === "string" ? usage.plan : "",
        remainingPercent:
          used === null ? null : Math.max(0, Math.min(100, 100 - used)),
        fetchedAt: usage && typeof usage.fetched_at === "number" ? usage.fetched_at : null,
      };
      return cached;
    }
    // CTM answered but the account is unavailable (e.g. its refresh token was
    // revoked), which the auth API reports as a 409 Conflict.
    lastRefreshFailure = {
      kind: status === 409 ? "account" : "network",
      status,
      error: body?.error || null,
    };
  } catch (error) {
    lastRefreshFailure = {
      kind: "network",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  cached = null;
  return null;
}

export function activeAccount() {
  return cached;
}

async function chooseFallbackAccount() {
  const { accounts = [], default_account_id: defaultId } =
    await listTaskManagerAccounts();
  const now = Date.now();
  const recentlyFailed = (id) => {
    if (!id) return false;
    const timestamp = accountFailureMemory.get(id);
    return timestamp !== undefined && now - timestamp < FAILURE_MEMORY_MS;
  };
  const candidates = accounts.filter((account) => {
    if (account.valid === false) return false;
    if (account.id === defaultId) return false;
    if (recentlyFailed(account.id) || recentlyFailed(account.account_id)) {
      return false;
    }
    return true;
  });
  const usedOf = (account) => account.usage?.weekly_used_percent;
  const withQuota = candidates.filter((account) => {
    const used = usedOf(account);
    return typeof used === "number" && used < 100;
  });
  // Prefer accounts that still have quota. Only fall back to accounts with no
  // usage data yet; never bounce onto an account already known to be spent.
  const unknownQuota = candidates.filter(
    (account) => typeof usedOf(account) !== "number",
  );
  const pool = withQuota.length ? withQuota : unknownQuota;
  if (!pool.length) return null;
  return [...pool].sort((left, right) => {
    const l = usedOf(left);
    const r = usedOf(right);
    return (typeof l === "number" ? l : 101) - (typeof r === "number" ? r : 101);
  })[0];
}

export async function failoverIfNeeded(reason = "poll") {
  const state = readTaskManagerConfig();
  if (!state.enabled || !state.failover) return false;
  if (Date.now() - lastFailoverAt < FAILOVER_COOLDOWN_MS) return false;

  const current = cached;
  const exhausted =
    current &&
    current.remainingPercent !== null &&
    current.remainingPercent <= 0;
  const unavailable = !current && lastRefreshFailure?.kind === "account";
  if (!exhausted && !unavailable && !failoverPending) return false;

  failoverPending = false;
  let fallback = null;
  try {
    fallback = await chooseFallbackAccount();
  } catch {
    return false;
  }
  if (!fallback) return false;

  if (current?.accountId) {
    accountFailureMemory.set(current.accountId, Date.now());
  }
  try {
    await selectTaskManagerAccount(fallback.id);
  } catch {
    return false;
  }

  lastFailoverAt = Date.now();
  lastFailover = {
    at: new Date().toISOString(),
    from: current?.accountId || null,
    to: fallback.account_id || fallback.id,
    reason,
  };
  return true;
}

export function notifyAccountFailure(status) {
  if (!FAILOVER_TRIGGER_STATUSES.has(status)) return;
  const state = readTaskManagerConfig();
  if (!state.enabled) return;
  const accountId = lastInjectedId || (cached && cached.accountId);
  if (accountId) {
    accountFailureMemory.set(accountId, Date.now());
  }
  // Pool mode handles the failed account by skipping it on the next rotation.
  if (Array.isArray(state.pool) && state.pool.length > 0) return;
  if (!state.failover) return;
  failoverPending = true;
  scheduleImmediateFailover();
}

function scheduleImmediateFailover() {
  if (failoverScheduled) return;
  failoverScheduled = true;
  setTimeout(async () => {
    failoverScheduled = false;
    await refreshActiveAccount();
    await failoverIfNeeded("failure");
  }, 500);
}

export async function refreshPool() {
  const state = readTaskManagerConfig();
  if (!state.enabled || !Array.isArray(state.pool) || state.pool.length === 0) {
    poolCredentials = [];
    return poolCredentials;
  }
  const token = tokenFor(state);
  if (!token) {
    poolCredentials = [];
    return poolCredentials;
  }
  const { status, body } = await requestJson(
    state.port,
    token,
    "/api/auth/credentials",
    "POST",
    { ids: state.pool },
  );
  if (status !== 200) {
    throw new Error(body?.error || `Codex_Task_Manager returned HTTP ${status}`);
  }
  poolCredentials = (body.accounts || [])
    .map((account) => {
      const used = account.usage?.weekly_used_percent;
      return {
        accountId:
          typeof account.account_id === "string"
            ? account.account_id
            : account.id || "",
        accessToken:
          typeof account.access_token === "string" ? account.access_token : "",
        email: account.email || "",
        plan:
          account.usage && typeof account.usage.plan === "string"
            ? account.usage.plan
            : "",
        remainingPercent:
          typeof used === "number"
            ? Math.max(0, Math.min(100, 100 - used))
            : null,
      };
    })
    .filter((account) => account.accessToken);
  poolCursor = 0;
  return poolCredentials;
}

export function nextInjectionAccount() {
  const state = readTaskManagerConfig();
  if (
    state.enabled &&
    Array.isArray(state.pool) &&
    state.pool.length > 0 &&
    poolCredentials.length > 0
  ) {
    const now = Date.now();
    let candidate = null;
    for (let step = 0; step < poolCredentials.length; step += 1) {
      const account =
        poolCredentials[(poolCursor + step) % poolCredentials.length];
      const failedAt = accountFailureMemory.get(account.accountId);
      if (failedAt === undefined || now - failedAt >= FAILURE_MEMORY_MS) {
        candidate = account;
        poolCursor = (poolCursor + step + 1) % poolCredentials.length;
        break;
      }
    }
    if (!candidate) {
      candidate = poolCredentials[poolCursor % poolCredentials.length];
      poolCursor = (poolCursor + 1) % poolCredentials.length;
    }
    lastInjectedId = candidate.accountId;
    return candidate;
  }
  const account = cached;
  lastInjectedId = account ? account.accountId : null;
  return account;
}

export function poolStatus() {
  const state = readTaskManagerConfig();
  return {
    ids: Array.isArray(state.pool) ? state.pool : [],
    accounts: poolCredentials.map((account) => ({
      accountId: account.accountId,
      email: account.email,
      plan: account.plan,
      remainingPercent: account.remainingPercent,
    })),
  };
}

export function failoverStatus() {
  const state = readTaskManagerConfig();
  return {
    enabled: state.failover,
    lastFailoverAt: lastFailoverAt || null,
    lastFailover,
  };
}

export function startTaskManagerPoller() {
  const tick = () => {
    const state = readTaskManagerConfig();
    if (!state.enabled) {
      cached = null;
      poolCredentials = [];
      return;
    }
    refreshActiveAccount()
      .then(() => failoverIfNeeded("poll"))
      .catch(() => {
        cached = null;
      });
    refreshPool().catch(() => {});
  };

  tick();
  const timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref?.();
}
