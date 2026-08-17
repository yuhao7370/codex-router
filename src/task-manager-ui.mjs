import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  activeAccount,
  failoverStatus,
  importTaskManagerAccount,
  injectionStats,
  listTaskManagerAccounts,
  readTaskManagerConfig,
  refreshActiveAccount,
  selectTaskManagerAccount,
  setTaskManagerFailover,
  setTaskManagerEnabled,
  setTaskManagerPort,
  setTaskManagerToken,
  testTaskManagerConnection,
} from "./task-manager-bridge.mjs";

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

function readPage() {
  return readFileSync(PAGE_PATH, "utf8");
}

function readConverter() {
  return readFileSync(CONVERTER_PATH, "utf8");
}


function statusPayload() {
  const config = readTaskManagerConfig();
  const account = activeAccount();
  return {
    enabled: config.enabled,
    failover: failoverStatus(),
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
      if (request.method === "GET" && url.pathname === "/api/status") {
        return sendJson(response, 200, statusPayload());
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
  return server;
}
