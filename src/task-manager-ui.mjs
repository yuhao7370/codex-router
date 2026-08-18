import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  setTaskManagerFailover,
  setTaskManagerEnabled,
  setTaskManagerIntervals,
  setTaskManagerPort,
  setTaskManagerPool,
  setTaskManagerToken,
  setUsagePanelVisible,
  testTaskManagerConnection,
} from "./task-manager-bridge.mjs";
import { panelUsageSnapshot } from "./provider-usage.mjs";
import { pricingSyncState, syncModelsDevPricing } from "./model-pricing.mjs";

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


function statusPayload() {
  const config = readTaskManagerConfig();
  const account = activeAccount();
  return {
    enabled: config.enabled,
    errors: errorLog(),
    failover: failoverStatus(),
    logIntervalMs: config.logIntervalMs,
    accountsIntervalMs: config.accountsIntervalMs,
    usageIntervalMs: config.usageIntervalMs,
    showUsagePanel: config.showUsagePanel,
    pool: poolStatus(),
    port: config.port,
    token: config.token ? "set" : "auto",
    account: account
      ? {
          accountId: account.accountId,
          hasToken: Boolean(account.accessToken),
          plan: account.plan || "",
          remainingPercent: account.remainingPercent ?? null,
          fetchedAt: account.fetchedAt ?? null,
        }
      : null,
    injections: injectionStats(),
  };
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

export function startTaskManagerUi() {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${HOST}:${PORT}`);
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return sendHtml(response, readPage());
      }
      if (request.method === "GET" && url.pathname === "/converter") {
        return sendHtml(response, readConverter());
      }
      if (request.method === "GET" && url.pathname === "/usage") {
        return sendHtml(response, readUsagePage());
      }
      if (request.method === "GET" && url.pathname === "/usage-panel.js") {
        return sendJs(response, readUsagePanelJs());
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        return sendJson(response, 200, statusPayload());
      }
      if (request.method === "GET" && url.pathname === "/api/usage") {
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
            for (const key of [account.account_id, account.id]) {
              if (!key) continue;
              const id = String(key);
              accountMeta.set(id, meta);
              validIds.add(id);
            }
          }
        } catch {
          // CTM may be stopped or unauthenticated; the account list stays
          // usable keyed by its raw id without names.
        }
        const accounts = (snapshot.accounts || [])
          .filter((account) => !ctmReachable || validIds.has(account.accountId))
          .map((account) => {
            const meta = accountMeta.get(account.accountId);
            return {
              ...account,
              email: meta?.email || "",
              plan: meta?.plan || "",
            };
          });
        return sendJson(response, 200, { ...snapshot, accounts });
      }
      if (request.method === "POST" && url.pathname === "/api/usage/sync") {
        const result = await syncModelsDevPricing();
        return sendJson(response, 200, { ...result, pricing: pricingSyncState() });
      }
      if (request.method === "POST" && url.pathname === "/api/usage-panel") {
        const body = await readJsonBody(request);
        const config = setUsagePanelVisible(body.visible);
        return sendJson(response, 200, { showUsagePanel: config.showUsagePanel });
      }
      if (request.method === "POST" && url.pathname === "/api/enable") {
        setTaskManagerEnabled(true);
        await refreshActiveAccount();
        return sendJson(response, 200, statusPayload());
      }
      if (request.method === "POST" && url.pathname === "/api/disable") {
        setTaskManagerEnabled(false);
        return sendJson(response, 200, statusPayload());
      }
      if (request.method === "POST" && url.pathname === "/api/failover") {
        const body = await readJsonBody(request);
        setTaskManagerFailover(Boolean(body.enabled));
        return sendJson(response, 200, statusPayload());
      }
      if (request.method === "POST" && url.pathname === "/api/pool") {
        const body = await readJsonBody(request);
        setTaskManagerPool(body.ids || []);
        return sendJson(response, 200, statusPayload());
      }
      if (request.method === "POST" && url.pathname === "/api/unblock") {
        const body = await readJsonBody(request);
        clearBlockedAccount(body.id);
        return sendJson(response, 200, statusPayload());
      }
      if (request.method === "POST" && url.pathname === "/api/errors/clear") {
        clearErrorLog();
        return sendJson(response, 200, statusPayload());
      }
      if (request.method === "POST" && url.pathname === "/api/intervals") {
        const body = await readJsonBody(request);
        setTaskManagerIntervals(body);
        return sendJson(response, 200, statusPayload());
      }
      if (request.method === "POST" && url.pathname === "/api/test") {
        return sendJson(response, 200, await testTaskManagerConnection());
      }
      if (request.method === "GET" && url.pathname === "/api/accounts") {
        return sendJson(response, 200, await listTaskManagerAccounts());
      }
      if (request.method === "POST" && url.pathname === "/api/select") {
        const body = await readJsonBody(request);
        await selectTaskManagerAccount(body.id);
        return sendJson(response, 200, statusPayload());
      }
      if (request.method === "POST" && url.pathname === "/api/import") {
        const body = await readJsonBody(request);
        const account = await importTaskManagerAccount(body);
        return sendJson(response, 200, account);
      }
      if (request.method === "POST" && url.pathname === "/api/port") {
        const body = await readJsonBody(request);
        setTaskManagerPort(body.port);
        await refreshActiveAccount();
        return sendJson(response, 200, statusPayload());
      }
      if (request.method === "POST" && url.pathname === "/api/token") {
        const body = await readJsonBody(request);
        setTaskManagerToken(body.token || "");
        await refreshActiveAccount();
        return sendJson(response, 200, statusPayload());
      }
      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.listen(PORT, HOST, () => {
    console.error(`[codex-router] task-manager UI at http://127.0.0.1:${PORT}`);
  });

  // Refresh the models.dev price snapshot in the background without delaying
  // startup. The panel keeps working on seed prices while this is in flight.
  setTimeout(() => {
    syncModelsDevPricing()
      .then((result) => {
        if (result.ok) {
          console.error(`[codex-router] models.dev pricing synced (${result.modelCount} models)`);
        } else {
          console.error(`[codex-router] models.dev pricing sync failed: ${result.error}`);
        }
      })
      .catch(() => {});
  }, 5_000);

  return server;
}
