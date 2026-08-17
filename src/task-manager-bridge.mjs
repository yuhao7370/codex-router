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
import { nativeProxyFetch } from "./native-proxy.mjs";
import { STATE_DIR } from "./paths.mjs";

const VERSION = 1;
const DEFAULT_PORT = 6000;
const REQUEST_TIMEOUT_MS = 3_000;
const QUOTA_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 15_000;
const STATE_PATH = path.join(STATE_DIR, "task-manager.json");
const fetchNative = nativeProxyFetch();

const MAX_INJECTION_EVENTS = 100;

// The active account fetched from Codex_Task_Manager. `null` means the bridge
// has no usable account right now, which makes the native path fall back to
// the app's own authorization.
let cached = null;
let injectionCount = 0;
const injectionEvents = [];

function defaults() {
  return { version: VERSION, enabled: false, port: DEFAULT_PORT, token: "" };
}

export function readTaskManagerConfig() {
  if (!existsSync(STATE_PATH)) return defaults();
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    const state = { ...defaults(), ...parsed };
    state.enabled = Boolean(state.enabled);
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

function requestJson(port, token, pathname, method = "GET") {
  // Use node:http rather than fetch: the WHATWG fetch spec blocks port 6000
  // (X11), which is Codex_Task_Manager's default. The raw HTTP client has no
  // such allow-list restriction.
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
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
    request.end();
  });
}

async function fetchAccountQuota(accessToken, accountId) {
  try {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "codex-router/task-manager",
    };
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;
    const response = await fetchNative(
      "https://chatgpt.com/backend-api/wham/usage",
      { headers, signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS) },
    );
    if (!response.ok) return null;
    const body = await response.json();
    const windows = [
      body?.rate_limit?.primary_window,
      body?.rate_limit?.secondary_window,
    ].filter((window) => window && typeof window.used_percent === "number");
    const weekly =
      windows.find(
        (window) => Math.abs((window.limit_window_seconds || 0) - 604_800) <= 60_480,
      ) || windows[0];
    const used = weekly?.used_percent;
    return {
      plan: typeof body?.plan_type === "string" ? body.plan_type : "",
      remainingPercent:
        typeof used === "number" ? Math.max(0, Math.min(100, 100 - used)) : null,
    };
  } catch {
    return null;
  }
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

export async function refreshActiveAccount() {
  const state = readTaskManagerConfig();
  if (!state.enabled) {
    cached = null;
    return null;
  }
  const token = tokenFor(state);
  if (!token) {
    cached = null;
    return null;
  }
  try {
    const { status, body } = await requestJson(state.port, token, "/api/auth/current");
    if (status === 200 && body && typeof body.access_token === "string" && body.access_token) {
      const quota = await fetchAccountQuota(body.access_token, body.account_id);
      cached = {
        accountId: typeof body.account_id === "string" ? body.account_id : "",
        accessToken: body.access_token,
        plan: quota?.plan || "",
        remainingPercent: quota?.remainingPercent ?? null,
      };
      return cached;
    }
  } catch {
    // Fall through: a failed request must fall back to native auth.
  }
  cached = null;
  return null;
}

export function activeAccount() {
  return cached;
}

export function startTaskManagerPoller() {
  const tick = () => {
    const state = readTaskManagerConfig();
    if (!state.enabled) {
      cached = null;
      return;
    }
    refreshActiveAccount().catch(() => {
      cached = null;
    });
  };

  tick();
  const timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref?.();
}
