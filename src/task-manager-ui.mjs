import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MIMEType } from "node:util";

import { authenticatedRoute } from "./caller-auth.mjs";
import {
  activeAccount,
  clearBlockedAccount,
  clearErrorLog,
  errorLog,
  failoverStatus,
  importTaskManagerAccount,
  injectionStats,
  listTaskManagerAccounts,
  poolStatus,
  readTaskManagerConfig,
  refreshActiveAccount,
  selectTaskManagerAccount,
  setCapacityRetry,
  setTaskManagerFailover,
  setFastAccounts,
  setTaskManagerEnabled,
  setTaskManagerIntervals,
  setTaskManagerPort,
  setTaskManagerPool,
  setTaskManagerToken,
  setUsagePanelVisible,
  testTaskManagerConnection,
} from "./task-manager-bridge.mjs";
import { mergeDeletedAccounts, panelUsageSnapshot } from "./provider-usage.mjs";
import { pricingSyncState, syncModelsDevPricing } from "./model-pricing.mjs";
import {
  cleanLocalRouterModels,
  rebuildCatalog,
  syncLocalRouterModels,
} from "./local-router-sync.mjs";

const HOST = "127.0.0.1";
const PORT = Number(
  process.env.CODEX_ROUTER_CONTROL_PORT ||
    process.env.MODEL_ROUTER_CONTROL_PORT ||
    4111,
);
const PAGE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "task-manager-ui.html");
const CONVERTER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "sub2api-converter.html",
);
const USAGE_PAGE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "usage.html");
const USAGE_PANEL_JS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "usage-panel.js",
);
const STANDALONE_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

function readPage() {
  return readFileSync(PAGE_PATH, "utf8");
}

function readConverter() {
  return readFileSync(CONVERTER_PATH, "utf8");
}

function readUsagePage() {
  return readFileSync(USAGE_PAGE_PATH, "utf8");
}

function readUsagePanelJs() {
  return readFileSync(USAGE_PANEL_JS_PATH, "utf8");
}


function durableStatusPayload(config) {
  return {
    enabled: config.enabled,
    logIntervalMs: config.logIntervalMs,
    accountsIntervalMs: config.accountsIntervalMs,
    usageIntervalMs: config.usageIntervalMs,
    showUsagePanel: config.showUsagePanel,
    fastAccounts: config.fastAccounts,
    capacityRetry: config.capacityRetry,
    capacityRetryAttempts: config.capacityRetryAttempts,
    port: config.port,
    token: config.token ? "set" : "auto",
  };
}

async function statusPayload({ standalone, runtimeClient }) {
  const config = readTaskManagerConfig();
  const durable = durableStatusPayload(config);
  if (standalone) {
    try {
      return {
        ...durable,
        ...(await runtimeClient.snapshot()),
        routerRuntime: { available: true },
      };
    } catch {
      return {
        ...durable,
        routerRuntime: { available: false },
        account: null,
        pool: { ids: config.pool, accounts: [], blocked: config.blocked },
        failover: {
          enabled: config.failover,
          lastFailoverAt: null,
          lastFailover: null,
        },
        errors: [],
        injections: { count: 0, recent: [] },
      };
    }
  }

  const account = activeAccount();
  return {
    ...durable,
    errors: errorLog(),
    failover: failoverStatus(),
    pool: poolStatus(),
    account: account
      ? {
          accountId: account.accountId,
          email: account.email || "",
          hasToken: Boolean(account.accessToken),
          plan: account.plan || "",
          remainingPercent: account.remainingPercent ?? null,
          fetchedAt: account.fetchedAt ?? null,
        }
      : null,
    injections: injectionStats(),
  };
}

function safeError(error) {
  const status = Number(error?.status);
  return Number.isSafeInteger(status) && status >= 100 && status <= 599
    ? `Task Manager request failed (HTTP ${status}).`
    : "Task Manager request failed.";
}

function isJsonMediaType(value) {
  const raw = String(value || "");
  const parameters = raw.split(";").slice(1);
  if (parameters.some((parameter) => !parameter.trim() || !parameter.includes("="))) {
    return false;
  }
  try {
    return new MIMEType(raw).essence.toLowerCase() === "application/json";
  } catch {
    return false;
  }
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  response.end(text);
}

function sendHtml(response, body) {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendJs(response, body) {
  response.writeHead(200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

export function startTaskManagerUi({
  mode = "embedded",
  port = PORT,
  callerSecret,
  runtimeClient,
  serviceController,
  restartRouter,
  quiet = false,
  syncPricing = syncModelsDevPricing,
  pricingSyncDelayMs = 5_000,
  writeDiagnostic = (message) => console.error(message),
} = {}) {
  const standalone = mode === "standalone";
  const mutationOptions = standalone ? { updateRuntime: false } : undefined;
  const performRouterRestart =
    restartRouter ||
    (standalone
      ? () => serviceController.perform("restart")
      : () => process.exit(0));
  const readStatus = () => statusPayload({ standalone, runtimeClient });
  const refreshRuntime = async () => {
    if (!standalone) return undefined;
    try {
      await runtimeClient.reload();
      return { ok: true };
    } catch {
      return { ok: false, error: "Router runtime refresh failed." };
    }
  };
  const refreshedStatus = async () => {
    const runtimeRefresh = await refreshRuntime();
    const status = await readStatus();
    return runtimeRefresh ? { ...status, runtimeRefresh } : status;
  };
  const scheduleRouterRestart = () => {
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(performRouterRestart)
        .catch(() => {
          writeDiagnostic("[codex-router] task-manager restart failed");
        });
    }, 500);
    timer.unref();
  };

  const server = http.createServer(async (request, response) => {
    try {
      if (standalone) {
        for (const [name, value] of Object.entries(STANDALONE_HEADERS)) {
          response.setHeader(name, value);
        }
      }
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      const expectedHost = `${HOST}:${boundPort}`;
      const expectedOrigin = `http://${expectedHost}`;
      const url = new URL(request.url, expectedOrigin);
      if (standalone && request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, {
          ok: true,
          service: "codex-router-task-manager",
          mode,
          pid: process.pid,
        });
      }
      const authenticated = standalone
        ? authenticatedRoute(url.pathname, callerSecret)
        : url.pathname;
      const route = standalone
        ? authenticated?.startsWith("/task-manager")
          ? authenticated.slice("/task-manager".length) || "/"
          : undefined
        : authenticated;
      if (route === undefined) {
        return sendJson(response, 401, { error: "caller capability required" });
      }
      if (standalone && request.method === "POST") {
        if (
          request.headers.host !== expectedHost
          || request.headers.origin !== expectedOrigin
          || request.headers["sec-fetch-site"] !== "same-origin"
        ) {
          return sendJson(response, 403, { error: "cross-site mutation refused" });
        }
        if (!isJsonMediaType(request.headers["content-type"])) {
          return sendJson(response, 415, { error: "application/json required" });
        }
      }
      if (standalone && request.method === "GET" && route === "/api/router/status") {
        return sendJson(response, 200, await serviceController.snapshot());
      }
      if (standalone) {
        for (const action of ["start", "stop", "restart"]) {
          if (request.method === "POST" && route === `/api/router/${action}`) {
            return sendJson(response, 200, await serviceController.perform(action));
          }
        }
      }
      if (request.method === "GET" && (route === "/" || route === "/index.html")) {
        return sendHtml(response, readPage());
      }
      if (request.method === "GET" && route === "/converter") {
        return sendHtml(response, readConverter());
      }
      if (request.method === "GET" && route === "/usage") {
        return sendHtml(response, readUsagePage());
      }
      if (request.method === "GET" && route === "/usage-panel.js") {
        return sendJs(response, readUsagePanelJs());
      }
      if (request.method === "GET" && route === "/api/status") {
        return sendJson(response, 200, await readStatus());
      }
      if (request.method === "GET" && route === "/api/usage") {
        const range = url.searchParams.get("range") || "90d";
        const snapshot = panelUsageSnapshot({ range });
        const accountMeta = new Map();
        const validIds = new Set();
        let ctmReachable = false;
        try {
          const accounts = await listTaskManagerAccounts();
          ctmReachable = true;
          for (const account of Array.isArray(accounts?.accounts) ? accounts.accounts : []) {
            const meta = {
              email: typeof account.email === "string" ? account.email : "",
              plan:
                account.usage && typeof account.usage.plan === "string"
                  ? account.usage.plan
                  : "",
            };
            const id = account.id || account.account_id;
            if (id) {
              accountMeta.set(String(id), meta);
              validIds.add(String(id));
            }
          }
        } catch {
          // CTM may be stopped or unauthenticated; the account list stays
          // usable keyed by its raw id without names.
        }
        const snapshotAccounts = Array.isArray(snapshot.accounts)
          ? snapshot.accounts
          : [];
        const accounts = !ctmReachable
          ? snapshotAccounts.map((account) => ({ ...account, email: "", plan: "" }))
          : mergeDeletedAccounts(snapshotAccounts, validIds).map((account) => {
              const meta = accountMeta.get(account.accountId);
              return {
                ...account,
                email: meta?.email || account.email || "",
                plan: meta?.plan || "",
              };
            });
        return sendJson(response, 200, { ...snapshot, accounts });
      }
      if (request.method === "POST" && route === "/api/usage/sync") {
        const result = await syncModelsDevPricing();
        return sendJson(response, 200, { ...result, pricing: pricingSyncState() });
      }
      if (request.method === "POST" && route === "/api/local-router/models/sync") {
        const result = await syncLocalRouterModels();
        let catalogRebuilt = false;
        if (result.added.length > 0) {
          rebuildCatalog();
          catalogRebuilt = true;
        }
        sendJson(response, 200, {
          ok: true,
          ...result,
          catalogRebuilt,
          message: result.added.length
            ? `已添加 ${result.added.length} 个模型，正在重启路由以生效；请完全退出并重新打开 Codex。`
            : "模型列表已是最新，没有新增模型。",
        });
        if (result.added.length > 0) {
          scheduleRouterRestart();
        }
        return;
      }
      if (request.method === "POST" && route === "/api/local-router/models/prune") {
        const result = await cleanLocalRouterModels();
        let catalogRebuilt = false;
        if (result.removed.length > 0) {
          rebuildCatalog();
          catalogRebuilt = true;
        }
        sendJson(response, 200, {
          ok: true,
          ...result,
          catalogRebuilt,
          message: result.removed.length
            ? `已清理 ${result.removed.length} 个下架模型：${result.removed.join(", ")}；正在重启路由以生效。`
            : "没有下架的模型，无需清理。",
        });
        if (result.removed.length > 0) {
          scheduleRouterRestart();
        }
        return;
      }
      if (request.method === "POST" && route === "/api/usage-panel") {
        const body = await readJsonBody(request);
        const config = setUsagePanelVisible(body.visible);
        return sendJson(response, 200, { showUsagePanel: config.showUsagePanel });
      }
      if (request.method === "POST" && route === "/api/fast-accounts") {
        const body = await readJsonBody(request);
        const config = setFastAccounts(body.ids || []);
        return sendJson(response, 200, { fastAccounts: config.fastAccounts });
      }
      if (request.method === "POST" && route === "/api/capacity-retry") {
        const body = await readJsonBody(request);
        const config = setCapacityRetry(body.enabled, body.attempts);
        return sendJson(response, 200, {
          capacityRetry: config.capacityRetry,
          capacityRetryAttempts: config.capacityRetryAttempts,
        });
      }
      if (request.method === "POST" && route === "/api/enable") {
        setTaskManagerEnabled(true, mutationOptions);
        if (!standalone) await refreshActiveAccount();
        return sendJson(response, 200, await refreshedStatus());
      }
      if (request.method === "POST" && route === "/api/disable") {
        setTaskManagerEnabled(false, mutationOptions);
        return sendJson(response, 200, await refreshedStatus());
      }
      if (request.method === "POST" && route === "/api/failover") {
        const body = await readJsonBody(request);
        setTaskManagerFailover(Boolean(body.enabled), mutationOptions);
        return sendJson(response, 200, await refreshedStatus());
      }
      if (request.method === "POST" && route === "/api/pool") {
        const body = await readJsonBody(request);
        setTaskManagerPool(body.ids || [], mutationOptions);
        return sendJson(response, 200, await refreshedStatus());
      }
      if (request.method === "POST" && route === "/api/unblock") {
        const body = await readJsonBody(request);
        clearBlockedAccount(body.id);
        return sendJson(response, 200, await readStatus());
      }
      if (request.method === "POST" && route === "/api/errors/clear") {
        clearErrorLog();
        return sendJson(response, 200, await readStatus());
      }
      if (request.method === "POST" && route === "/api/intervals") {
        const body = await readJsonBody(request);
        setTaskManagerIntervals(body);
        return sendJson(response, 200, await readStatus());
      }
      if (request.method === "POST" && route === "/api/test") {
        return sendJson(response, 200, await testTaskManagerConnection());
      }
      if (request.method === "GET" && route === "/api/accounts") {
        return sendJson(response, 200, await listTaskManagerAccounts());
      }
      if (request.method === "POST" && route === "/api/select") {
        const body = await readJsonBody(request);
        await selectTaskManagerAccount(body.id, mutationOptions);
        return sendJson(response, 200, await refreshedStatus());
      }
      if (request.method === "POST" && route === "/api/import") {
        const body = await readJsonBody(request);
        const account = await importTaskManagerAccount(body, mutationOptions);
        const runtimeRefresh = await refreshRuntime();
        return sendJson(
          response,
          200,
          runtimeRefresh ? { ...account, runtimeRefresh } : account,
        );
      }
      if (request.method === "POST" && route === "/api/port") {
        const body = await readJsonBody(request);
        setTaskManagerPort(body.port, mutationOptions);
        if (!standalone) await refreshActiveAccount();
        return sendJson(response, 200, await refreshedStatus());
      }
      if (request.method === "POST" && route === "/api/token") {
        const body = await readJsonBody(request);
        setTaskManagerToken(body.token || "", mutationOptions);
        if (!standalone) await refreshActiveAccount();
        return sendJson(response, 200, await refreshedStatus());
      }
      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      sendJson(response, 500, {
        error: safeError(error),
      });
    }
  });

  server.listen(port, HOST, () => {
    const address = server.address();
    const boundPort = typeof address === "object" && address ? address.port : port;
    if (!quiet) {
      writeDiagnostic(`[codex-router] task-manager UI at http://127.0.0.1:${boundPort}`);
    }
  });

  // Refresh the models.dev price snapshot in the background without delaying
  // startup. The panel keeps working on seed prices while this is in flight.
  const pricingTimer = quiet ? undefined : setTimeout(() => {
    syncPricing()
      .then((result) => {
        if (result.ok) {
          writeDiagnostic(`[codex-router] models.dev pricing synced (${result.modelCount} models)`);
        } else {
          writeDiagnostic("[codex-router] models.dev pricing sync failed");
        }
      })
      .catch(() => {});
  }, Math.max(0, Number(pricingSyncDelayMs) || 0));
  pricingTimer?.unref();
  server.once("close", () => {
    if (pricingTimer) clearTimeout(pricingTimer);
  });

  return server;
}
