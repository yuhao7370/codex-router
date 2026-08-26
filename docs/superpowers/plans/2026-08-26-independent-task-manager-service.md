# Independent Task Manager Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the browser Task Manager as a Windows login-started process that remains available while Codex Router is stopped and can safely start, stop, or restart it.

**Architecture:** A separate `Codex Router Task Manager` Scheduled Task owns port 4111 and calls the existing Router service CLI through a fixed action allowlist. Router keeps volatile account/injection state and exposes a caller-authenticated runtime/reload contract; the standalone host owns presentation, durable configuration changes, and service controls. A durable standalone marker makes installed Windows Router processes skip their embedded UI while non-Windows and development starts retain it.

**Tech Stack:** Node.js 24 ESM, built-in `http`/`fetch`/`child_process`, Windows Task Scheduler and PowerShell, existing `proper-lockfile`, HTML/CSS/vanilla JavaScript, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-26-independent-task-manager-service-design.md`

## Global Constraints

- Independent supervision is Windows-only; non-Windows and unmarked development starts keep the embedded Task Manager UI.
- Bind the manager only to `127.0.0.1:4111` unless the existing control-port environment override is set.
- Reuse the existing caller capability; do not add another credential or print a capability-bearing URL by default.
- Router remains login-started, and the manager starts at login without opening a browser.
- Service HTTP input selects only `start`, `stop`, or `restart`; it never supplies an executable, path, task name, environment value, or extra argument.
- Preserve all current CTM bridge, account pool, failover, native/injected Fast, usage, pricing, converter, and local-router model behavior.
- Preserve the installed Electron Control Center and its `Codex Router Tray` task; no task-manager transaction may stop, replace, or uninstall it.
- Add no npm or Python dependency.
- Do not use Computer Use. Verify browser behavior through deterministic HTTP/DOM-source tests; the operator performs visual inspection.
- Do not stage or delete the existing untracked `apps/control-center/.codex-router-install-win32.json` installation fingerprint.
- Do not pop or drop `stash@{0}: pre-upstream-sync: preserve routed debug`.
- Each task ends in one Conventional Commit containing only that task's deliverable.

## Execution Preflight

- [ ] Record `git status --short --branch`, `git stash list`, Router health, manager-service status, and Control Center status before editing.
- [ ] Run `node --test test/native-retry.test.mjs` once and record whether the pre-existing test named `an upstream failure after headers is never retried` still returns the known 502-versus-200 failure. Later full-suite verification may reproduce only this exact baseline failure; any different failure blocks completion.
- [ ] Use an isolated worktree if the selected execution skill requires it. Keep the installed checkout at `C:\Users\yuhaofeng\AppData\Local\codex-router` unchanged until the final deployment step.

## File and Interface Map

### New focused modules

- `src/task-manager-router-api.mjs`: authenticated Router-owned runtime snapshot and reload handler.
- `src/task-manager-runtime-client.mjs`: standalone-host client for the Router runtime/reload contract.
- `src/task-manager-service-control.mjs`: non-blocking Router service status/action controller and lifecycle mapping.
- `src/task-manager-host.mjs`: standalone process entrypoint and shutdown cleanup.
- `src/task-manager-process.mjs`: exact standalone-host process identity record.
- `src/task-manager-service.mjs`: platform dispatcher and manager-operation lock.
- `src/task-manager-service-windows.mjs`: hidden launcher, Scheduled Task lifecycle, health wait, and exact status.
- `src/task-manager-open.mjs`: capability-safe browser opener.
- `src/task-manager-shortcut-windows.mjs`: current-user Start Menu shortcut creation/removal.
- `src/task-manager-standalone-state.mjs`: private durable standalone-mode marker.
- `src/windows-task-snapshot.mjs`: exact Task Scheduler XML/SDDL/running-state snapshot and restoration.
- `src/task-manager-install.mjs`: Windows two-task install/uninstall transaction and rollback.
- `src/task-manager-doctor.mjs`: pure manager topology/privacy/health projection for doctor.
- `bin/task-manager`: POSIX dispatcher for the nested Task Manager command surface.

### Existing modules with bounded changes

- `src/caller-auth.mjs`, `src/paths.mjs`: Task Manager capability leaf, port/task/state constants, and redaction.
- `src/task-manager-bridge.mjs`: authoritative runtime snapshot/reload and cross-process error-log reads.
- `src/router.mjs`: internal Task Manager route and embedded/standalone startup switch.
- `src/task-manager-ui.mjs`: injectable server dependencies, capability routing, mutation checks, runtime merge, and service APIs.
- `src/task-manager-ui.html`, `src/usage.html`, `src/usage-panel.js`, `src/sub2api-converter.html`: relative capability-safe navigation and Router lifecycle controls.
- `src/service-operation-lock.mjs`: named lock support while retaining the existing default lock.
- `src/service-windows.mjs`: persist the standalone flag only when the private marker is enabled.
- `src/control.mjs`, `bin/model-router`, `codex-router.ps1`: nested service/open commands.
- `install.ps1`: call the two-task transaction for Windows Codex installs.
- `src/doctor.mjs`, `src/support-bundle.mjs`: manager health/ownership/privacy diagnostics.
- `AGENTS.md`, `docs/INSTALL.md`, `docs/TROUBLESHOOTING.md`: installation, repair, and recovery contract.

---

### Task 1: Define the capability leaf and standalone paths

**Files:**
- Modify: `src/caller-auth.mjs:54-127`
- Modify: `src/paths.mjs:133-235`
- Modify: `test/caller-auth.test.mjs:14-82`
- Create: `test/task-manager-paths.test.mjs`

**Interfaces:**
- Produces: `taskManagerPath(secret: string): string`
- Produces: `taskManagerUrl(port: number, secret: string): string`
- Produces: `TASK_MANAGER_CONTROL_PORT`, `TASK_MANAGER_TASK_NAME`, `TASK_MANAGER_LOG_PATH`, `TASK_MANAGER_PROCESS_STATE_PATH`, and `TASK_MANAGER_STANDALONE_PATH`
- Preserves: `authenticatedRoute()` returns `/task-manager/...` after validating the existing capability.

- [ ] **Step 1: Write failing capability and path tests**

Add imports and assertions to `test/caller-auth.test.mjs`:

```js
import { taskManagerPath, taskManagerUrl } from "../src/caller-auth.mjs";

test("the task manager leaf reuses and redacts the caller capability", () => {
  const url = taskManagerUrl(4111, CALLER_KEY);
  assert.equal(url, `http://127.0.0.1:4111/_codex-router/${CALLER_KEY}/task-manager/`);
  assert.equal(authenticatedRoute(new URL(url).pathname, CALLER_KEY), "/task-manager/");
  assert.equal(
    redactCallerUrl(`${url}api/router/status`),
    "http://127.0.0.1:4111/_codex-router/[REDACTED]/task-manager/api/router/status",
  );
});
```

Create `test/task-manager-paths.test.mjs`:

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("task manager paths use a dedicated task and state files", () => {
  const script = `import * as p from ${JSON.stringify(path.resolve("src/paths.mjs"))}; console.log(JSON.stringify({port:p.TASK_MANAGER_CONTROL_PORT,task:p.TASK_MANAGER_TASK_NAME,log:p.TASK_MANAGER_LOG_PATH,process:p.TASK_MANAGER_PROCESS_STATE_PATH,standalone:p.TASK_MANAGER_STANDALONE_PATH}))`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, MODEL_ROUTER_CONTROL_PORT: "43111", MODEL_ROUTER_STATE_DIR: path.resolve(".tmp-task-manager-paths") },
  });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.port, 43111);
  assert.equal(value.task, "Codex Router Task Manager");
  assert.match(value.log, /task-manager\.log$/);
  assert.match(value.process, /task-manager-process\.json$/);
  assert.match(value.standalone, /task-manager-standalone\.json$/);
});
```

- [ ] **Step 2: Run the focused tests and verify the missing exports fail**

Run:

```powershell
node --test test/caller-auth.test.mjs test/task-manager-paths.test.mjs
```

Expected: FAIL because `taskManagerPath`, `taskManagerUrl`, and the Task Manager path constants are not exported.

- [ ] **Step 3: Implement the leaf, redaction, and path constants**

Add to `src/caller-auth.mjs`:

```js
export function taskManagerPath(secret) {
  return `${CALLER_PATH_PREFIX}/${assertCallerSecret(secret)}/task-manager/`;
}

export function taskManagerUrl(port, secret) {
  return `http://127.0.0.1:${port}${taskManagerPath(secret)}`;
}
```

Extend the redaction lookahead from `v1|panel|gemini` to
`v1|panel|gemini|task-manager`.

Add to `src/paths.mjs`, placing the port export after the existing `port()` helper:

```js
export const TASK_MANAGER_TASK_NAME = "Codex Router Task Manager";
export const TASK_MANAGER_LOG_PATH = path.join(STATE_DIR, "task-manager.log");
export const TASK_MANAGER_PROCESS_STATE_PATH = path.join(STATE_DIR, "task-manager-process.json");
export const TASK_MANAGER_STANDALONE_PATH = path.join(STATE_DIR, "task-manager-standalone.json");
export const TASK_MANAGER_CONTROL_PORT = port(
  "MODEL_ROUTER_CONTROL_PORT",
  process.env.CODEX_ROUTER_CONTROL_PORT || 4111,
);
```

- [ ] **Step 4: Run focused tests and syntax checks**

Run:

```powershell
node --test test/caller-auth.test.mjs test/panel.test.mjs test/task-manager-paths.test.mjs
npm run check
```

Expected: all tests and checks PASS; redaction tests prove the new leaf never prints the key.

- [ ] **Step 5: Commit the capability contract**

```powershell
git add src/caller-auth.mjs src/paths.mjs test/caller-auth.test.mjs test/task-manager-paths.test.mjs
git commit -m "feat(task-manager): define standalone capability paths"
```

---

### Task 2: Expose Router-owned Task Manager runtime state

**Files:**
- Modify: `src/task-manager-bridge.mjs:81-100,350-365,430-488,700-853`
- Create: `src/task-manager-router-api.mjs`
- Modify: `src/router.mjs:150-170,3898-3955`
- Modify: `test/task-manager-bridge.test.mjs`
- Create: `test/task-manager-router-api.test.mjs`
- Modify: `test/routing.test.mjs`

**Interfaces:**
- Produces: `taskManagerRuntimeSnapshot(): TaskManagerRuntimeSnapshot`
- Produces: `reloadTaskManagerRuntime(): Promise<TaskManagerRuntimeSnapshot>`
- Produces: `isTaskManagerRouterRoute(route: string): boolean`
- Produces: `handleTaskManagerRouterRequest(request, response, route, { writeJson }): Promise<boolean>`
- `TaskManagerRuntimeSnapshot` contains `account`, `pool`, `failover`, `errors`, and `injections` only; it never contains an access token.

- [ ] **Step 1: Write failing bridge snapshot and cross-process log tests**

Extend `test/task-manager-bridge.test.mjs`:

```js
test("runtime snapshots omit credentials and reread the shared error log", async () => {
  writeFileSync(
    path.join(dir, "task-manager-errors.jsonl"),
    `${JSON.stringify({ at: "2026-08-26T00:00:00.000Z", type: "capacity", message: "full" })}\n`,
  );
  const snapshot = bridge.taskManagerRuntimeSnapshot();
  assert.equal(snapshot.errors[0].message, "full");
  assert.equal(JSON.stringify(snapshot).includes("accessToken"), false);
  assert.equal(JSON.stringify(snapshot).includes("access_token"), false);
});
```

Create `test/task-manager-router-api.test.mjs` with in-memory request/response doubles:

```js
test("runtime is read-only and reload accepts POST only", async () => {
  assert.equal(isTaskManagerRouterRoute("/task-manager/runtime"), true);
  assert.equal(isTaskManagerRouterRoute("/task-manager/reload"), true);
  assert.equal(isTaskManagerRouterRoute("/task-manager/unknown"), false);
  assert.deepEqual(await invoke("GET", "/task-manager/runtime"), { status: 200, body: runtime });
  assert.equal((await invoke("GET", "/task-manager/reload")).status, 405);
  assert.equal((await invoke("POST", "/task-manager/reload")).status, 200);
});
```

- [ ] **Step 2: Run the tests and verify the new contract is absent**

Run:

```powershell
node --test test/task-manager-bridge.test.mjs test/task-manager-router-api.test.mjs
```

Expected: FAIL because the runtime snapshot/reload exports and handler do not exist.

- [ ] **Step 3: Implement credential-free runtime snapshot and reload**

Add to `src/task-manager-bridge.mjs`:

```js
export function taskManagerRuntimeSnapshot() {
  const account = activeAccount();
  return {
    account: account
      ? {
          accountId: account.accountId,
          email: account.email || "",
          plan: account.plan || "",
          remainingPercent: account.remainingPercent ?? null,
          fetchedAt: account.fetchedAt ?? null,
        }
      : null,
    pool: poolStatus(),
    failover: failoverStatus(),
    errors: errorLog(),
    injections: injectionStats(),
  };
}

export async function reloadTaskManagerRuntime() {
  await refreshActiveAccount();
  await refreshPool();
  return taskManagerRuntimeSnapshot();
}
```

Change `errorLog()` to return `loadErrorLog()` so a clear/write performed by the standalone process is visible immediately in Router.

- [ ] **Step 4: Implement the authenticated Router handler**

Create `src/task-manager-router-api.mjs`:

```js
import {
  reloadTaskManagerRuntime,
  taskManagerRuntimeSnapshot,
} from "./task-manager-bridge.mjs";

const ROUTES = new Set(["/task-manager/runtime", "/task-manager/reload"]);

export function isTaskManagerRouterRoute(route) {
  return ROUTES.has(route);
}

export async function handleTaskManagerRouterRequest(
  request,
  response,
  route,
  { writeJson },
) {
  if (!isTaskManagerRouterRoute(route)) return false;
  if (route === "/task-manager/runtime" && request.method === "GET") {
    writeJson(response, 200, taskManagerRuntimeSnapshot());
    return true;
  }
  if (route === "/task-manager/reload" && request.method === "POST") {
    writeJson(response, 200, await reloadTaskManagerRuntime());
    return true;
  }
  writeJson(response, 405, { error: { type: "invalid_request", message: "Method not allowed." } });
  return true;
}
```

Import it in `src/router.mjs` and call it immediately after `authenticatedRoute()` and before panel/models routing:

```js
if (
  isTaskManagerRouterRoute(route) &&
  (await handleTaskManagerRouterRequest(request, response, route, { writeJson }))
) return;
```

- [ ] **Step 5: Add an end-to-end capability regression**

In `test/routing.test.mjs`, start the existing test Router and assert:

```js
const runtime = await fetch(`${taskManagerUrl(routerPort, CALLER_KEY)}runtime`);
assert.equal(runtime.status, 200);
const unauthenticated = await fetch(`http://127.0.0.1:${routerPort}/_codex-router/wrong-caller-capability-with-sufficient-length/task-manager/runtime`);
assert.equal(unauthenticated.status, 401);
```

- [ ] **Step 6: Run focused Router tests**

Run:

```powershell
node --test test/task-manager-bridge.test.mjs test/task-manager-router-api.test.mjs
node --test --test-name-pattern="task manager runtime" test/routing.test.mjs
npm run check
```

Expected: all commands PASS and the response body contains no credential field.

- [ ] **Step 7: Commit the Router runtime contract**

```powershell
git add src/task-manager-bridge.mjs src/task-manager-router-api.mjs src/router.mjs test/task-manager-bridge.test.mjs test/task-manager-router-api.test.mjs test/routing.test.mjs
git commit -m "feat(task-manager): expose router runtime state"
```

---

### Task 3: Build the non-blocking Router service controller

**Files:**
- Create: `src/task-manager-service-control.mjs`
- Create: `test/task-manager-service-control.test.mjs`

**Interfaces:**
- Produces: `routerServiceLifecycle({ service, health, operation }): RouterLifecycleState`
- Produces: `createRouterServiceController(options): { snapshot, perform, currentOperation }`
- `snapshot(): Promise<{ state, service, health, operation }>`
- `perform(action: "start"|"stop"|"restart"): Promise<RouterServiceSnapshot>`
- Consumes: existing `src/service.mjs` and `readControlHealth()`; does not acquire the service lock itself because `service.mjs` owns it.

- [ ] **Step 1: Write lifecycle, allowlist, serialization, and recovery tests**

Create `test/task-manager-service-control.test.mjs`:

```js
test("lifecycle distinguishes stopped, running, and unhealthy", () => {
  assert.equal(routerServiceLifecycle({ service: { installed: true, loaded: false }, health: { ok: false } }), "stopped");
  assert.equal(routerServiceLifecycle({ service: { installed: true, loaded: true }, health: { ok: true } }), "running");
  assert.equal(routerServiceLifecycle({ service: { installed: true, loaded: true }, health: { ok: false } }), "unhealthy");
  assert.equal(routerServiceLifecycle({ operation: { action: "restart" } }), "restarting");
  assert.equal(routerServiceLifecycle({ serviceError: "scheduler unavailable", health: { ok: false } }), "failed");
});

test("service actions are allowlisted and overlap is rejected", async () => {
  let release;
  const running = new Promise((resolve) => { release = resolve; });
  const controller = createRouterServiceController({
    runServiceCommand: async () => running,
    readServiceStatus: async () => ({ installed: true, loaded: true, state: "running" }),
    readHealth: async () => ({ ok: true }),
  });
  const first = controller.perform("restart");
  await assert.rejects(() => controller.perform("stop"), /already running/i);
  await assert.rejects(() => controller.perform("delete"), /unknown router service action/i);
  release();
  await first;
  assert.equal(controller.currentOperation(), null);
});
```

- [ ] **Step 2: Run the controller test and verify it fails**

Run:

```powershell
node --test test/task-manager-service-control.test.mjs
```

Expected: FAIL because the controller module is missing.

- [ ] **Step 3: Implement async child execution and state mapping**

Create `src/task-manager-service-control.mjs`. Define the default child functions before the controller:

```js
const SERVICE_SCRIPT = path.join(SOURCE_ROOT, "src", "service.mjs");

function runServiceProcess(action) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVICE_SCRIPT, action], {
      cwd: SOURCE_ROOT,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-8192); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8192); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(redactCallerUrl(stderr.trim() || `Router service exited ${code ?? signal}.`)));
    });
  });
}

async function defaultReadServiceStatus() {
  const { stdout } = await runServiceProcess("status");
  return JSON.parse(stdout);
}

async function defaultRunServiceCommand(action) {
  await runServiceProcess(action);
}
```

Then add these exports:

```js
const ACTIONS = new Set(["start", "stop", "restart"]);

export function routerServiceLifecycle({ service, health, operation, serviceError } = {}) {
  if (operation?.action === "start") return "starting";
  if (operation?.action === "stop") return "stopping";
  if (operation?.action === "restart") return "restarting";
  if (serviceError) return "failed";
  if (health?.ok) return "running";
  if (service?.loaded) return "unhealthy";
  if (service?.installed === false || service?.loaded === false) return "stopped";
  return "failed";
}

export function createRouterServiceController({
  runServiceCommand = defaultRunServiceCommand,
  readServiceStatus = defaultReadServiceStatus,
  readHealth = readControlHealth,
} = {}) {
  let operation = null;
  const snapshot = async () => {
    const [serviceResult, healthResult] = await Promise.allSettled([readServiceStatus(), readHealth()]);
    const service = serviceResult.status === "fulfilled" ? serviceResult.value : undefined;
    const health = healthResult.status === "fulfilled" ? healthResult.value : { ok: false };
    const serviceError = serviceResult.status === "rejected" ? redactCallerUrl(String(serviceResult.reason?.message || serviceResult.reason)).slice(0, 500) : undefined;
    const healthError = healthResult.status === "rejected" ? redactCallerUrl(String(healthResult.reason?.message || healthResult.reason)).slice(0, 500) : undefined;
    const state = routerServiceLifecycle({ service, health, operation, serviceError, healthError });
    return { state, service, health, operation, serviceError, healthError };
  };
  return {
    snapshot,
    currentOperation: () => operation,
    async perform(action) {
      if (!ACTIONS.has(action)) throw new Error(`Unknown Router service action: ${action}`);
      if (operation) throw new Error("Another Router service operation is already running.");
      operation = { action, startedAt: Date.now() };
      try {
        await runServiceCommand(action);
        return await snapshot();
      } finally {
        operation = null;
      }
    },
  };
}
```

The asynchronous child keeps the manager HTTP loop responsive during the Router's five-minute readiness budget. Its bounded stderr passes through `redactCallerUrl()` before becoming an error.

- [ ] **Step 4: Run focused controller and service-lock tests**

Run:

```powershell
node --test test/task-manager-service-control.test.mjs test/service-operation-lock.test.mjs test/control-health.test.mjs
npm run check
```

Expected: PASS; the overlap test proves the manager rejects a second action while the first is pending.

- [ ] **Step 5: Commit the service controller**

```powershell
git add src/task-manager-service-control.mjs test/task-manager-service-control.test.mjs
git commit -m "feat(task-manager): add router service controller"
```

---

### Task 4: Refactor the UI server and add the standalone host

**Files:**
- Create: `src/task-manager-runtime-client.mjs`
- Create: `src/task-manager-host.mjs`
- Modify: `src/task-manager-ui.mjs:1-345`
- Modify: `src/router.mjs:198-210,4068-4076`
- Create: `test/task-manager-runtime-client.test.mjs`
- Create: `test/task-manager-ui-server.test.mjs`
- Create: `test/task-manager-host.test.mjs`
- Modify: `test/native-retry.test.mjs:130-170`

**Interfaces:**
- Produces: `createTaskManagerRuntimeClient({ fetchImpl, routerPort, callerSecret })` with `snapshot()` and `reload()` methods.
- Changes: `startTaskManagerUi({ mode, port, callerSecret, runtimeClient, serviceController, restartRouter })` returns the HTTP server.
- Standalone health: unauthenticated `GET /health` returns only `{ ok, service: "codex-router-task-manager", mode, pid }`.
- Standalone private routes: `taskManagerUrl(port, secret)` and descendants.
- Embedded mode: root routes and existing `startTaskManagerUi()` call remain compatible.

- [ ] **Step 1: Write runtime-client and capability-routing tests**

Create `test/task-manager-runtime-client.test.mjs`:

```js
test("runtime client uses only the protected task-manager leaf", async () => {
  const seen = [];
  const client = createTaskManagerRuntimeClient({
    routerPort: 4202,
    callerSecret: CALLER_KEY,
    fetchImpl: async (url, options) => {
      seen.push({ url: String(url), method: options?.method || "GET" });
      return new Response(JSON.stringify({ account: null }), { status: 200 });
    },
  });
  await client.snapshot();
  await client.reload();
  assert.deepEqual(seen.map((entry) => entry.method), ["GET", "POST"]);
  assert.ok(seen.every((entry) => entry.url.includes(`/_codex-router/${CALLER_KEY}/task-manager/`)));
});
```

Create `test/task-manager-ui-server.test.mjs` cases that start the server on an ephemeral port and assert:

```js
assert.equal((await fetch(`${origin}/health`)).status, 200);
assert.equal((await fetch(`${origin}/`)).status, 401);
assert.equal((await fetch(`${origin}${taskManagerPath(CALLER_KEY)}`)).status, 200);
assert.equal((await fetch(`${origin}${taskManagerPath("wrong-caller-capability-with-sufficient-length")}`)).status, 401);
```

Add a POST case with `origin: https://example.invalid` and JSON content; expect 403 and zero service-controller calls.

Create `test/task-manager-host.test.mjs` with a temporary state directory, a valid `caller-secret`, and an ephemeral `MODEL_ROUTER_CONTROL_PORT`. Spawn `src/task-manager-host.mjs`, wait until `GET /health` returns 200, assert the body reports `service: "codex-router-task-manager"` and `mode: "standalone"`, then terminate the child cleanly.

- [ ] **Step 2: Run the tests and verify the host contract is missing**

Run:

```powershell
node --test test/task-manager-runtime-client.test.mjs test/task-manager-ui-server.test.mjs test/task-manager-host.test.mjs
```

Expected: FAIL because the runtime client/host do not exist and `startTaskManagerUi()` does not accept standalone dependencies.

- [ ] **Step 3: Implement the runtime client**

Create `src/task-manager-runtime-client.mjs`:

```js
import { taskManagerUrl } from "./caller-auth.mjs";
import { PORTS } from "./paths.mjs";

export function createTaskManagerRuntimeClient({
  fetchImpl = fetch,
  routerPort = PORTS.router,
  callerSecret,
} = {}) {
  const base = taskManagerUrl(routerPort, callerSecret);
  const request = async (leaf, method = "GET") => {
    const response = await fetchImpl(new URL(leaf, base), {
      method,
      headers: method === "POST" ? { "content-type": "application/json" } : undefined,
      body: method === "POST" ? "{}" : undefined,
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message || `Router returned HTTP ${response.status}.`);
    return body;
  };
  return { snapshot: () => request("runtime"), reload: () => request("reload", "POST") };
}
```

- [ ] **Step 4: Parameterize the UI server without duplicating its endpoints**

Refactor `src/task-manager-ui.mjs` so `startTaskManagerUi()` accepts the interface above. In standalone mode:

```js
const authenticated = authenticatedRoute(url.pathname, callerSecret);
const route = authenticated?.startsWith("/task-manager")
  ? authenticated.slice("/task-manager".length) || "/"
  : undefined;
```

Return 401 when `route` is absent. Before every POST, reject when:

```js
const expectedOrigin = `http://${request.headers.host}`;
if (request.headers.origin && request.headers.origin !== expectedOrigin) return sendJson(response, 403, { error: "cross-origin mutation refused" });
if (request.headers["sec-fetch-site"] === "cross-site") return sendJson(response, 403, { error: "cross-site mutation refused" });
if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) return sendJson(response, 415, { error: "application/json required" });
```

Define one bounded redactor in `src/task-manager-ui.mjs`:

```js
function safeError(error) {
  return redactCallerUrl(error instanceof Error ? error.message : String(error)).slice(0, 500);
}
```

Make `statusPayload()` async. In standalone mode, merge `await runtimeClient.snapshot()` into durable configuration; on fetch failure set `routerRuntime: { available: false }`, `account: null`, and empty volatile fields. After online account/pool/enable/import/select mutations, call `runtimeClient.reload()` and include `runtimeRefresh: { ok: true }`; if reload fails after persistence, return `runtimeRefresh: { ok: false, error: safeError(error) }` without reverting the saved file.

Add these exact service routes in standalone mode:

```js
if (request.method === "GET" && route === "/api/router/status") {
  return sendJson(response, 200, await serviceController.snapshot());
}
for (const action of ["start", "stop", "restart"]) {
  if (request.method === "POST" && route === `/api/router/${action}`) {
    return sendJson(response, 200, await serviceController.perform(action));
  }
}
```

Return 404 for those routes in embedded mode, where the Router cannot safely invoke its own service lifecycle from the same process.

Apply these headers to every standalone HTML, JavaScript, and JSON response:

```js
{
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
}
```

For catalog sync/prune, call the injected `restartRouter()` after sending the response. The embedded default remains `setTimeout(() => process.exit(0), 500)`; standalone schedules this after 500 ms and never exits itself:

```js
Promise.resolve(serviceController.perform("restart")).catch((error) => {
  console.error(`[codex-router] task-manager restart failed: ${safeError(error)}`);
});
```

- [ ] **Step 5: Add the standalone entrypoint and embedded switch**

Create `src/task-manager-host.mjs`:

```js
import { readFileSync } from "node:fs";
import { assertCallerSecret } from "./caller-auth.mjs";
import { CALLER_SECRET_PATH, TASK_MANAGER_CONTROL_PORT } from "./paths.mjs";
import { createRouterServiceController } from "./task-manager-service-control.mjs";
import { createTaskManagerRuntimeClient } from "./task-manager-runtime-client.mjs";
import { startTaskManagerUi } from "./task-manager-ui.mjs";

const callerSecret = assertCallerSecret(readFileSync(CALLER_SECRET_PATH, "utf8").trim());
const serviceController = createRouterServiceController();
const server = startTaskManagerUi({
  mode: "standalone",
  port: TASK_MANAGER_CONTROL_PORT,
  callerSecret,
  runtimeClient: createTaskManagerRuntimeClient({ callerSecret }),
  serviceController,
  restartRouter: () => serviceController.perform("restart"),
});
for (const signal of ["SIGINT", "SIGTERM"]) signal && process.on(signal, () => server.close(() => process.exit(0)));
```

In `src/router.mjs`, preserve `startTaskManagerPoller()` and gate only the UI listener:

```js
startTaskManagerPoller();
if (process.env.CODEX_ROUTER_TASK_MANAGER_STANDALONE !== "1") startTaskManagerUi();
```

Add `taskManagerMode: process.env.CODEX_ROUTER_TASK_MANAGER_STANDALONE === "1" ? "standalone" : "embedded"` to the protected health payload returned after capability authentication. Keep the public `/health` projection unchanged.

- [ ] **Step 6: Run host, security, embedded-compatibility, and routing tests**

Run:

```powershell
node --test test/task-manager-runtime-client.test.mjs test/task-manager-ui-server.test.mjs test/task-manager-host.test.mjs
node --test --test-name-pattern="task manager|account failure" test/native-retry.test.mjs
node --test --test-name-pattern="task manager runtime" test/routing.test.mjs
npm run check
```

Expected: PASS; the standalone server rejects bare/wrong capability routes while embedded-mode tests still reach the root UI.

- [ ] **Step 7: Commit the standalone HTTP host**

```powershell
git add src/task-manager-runtime-client.mjs src/task-manager-host.mjs src/task-manager-ui.mjs src/router.mjs test/task-manager-runtime-client.test.mjs test/task-manager-ui-server.test.mjs test/task-manager-host.test.mjs test/native-retry.test.mjs
git commit -m "feat(task-manager): add standalone manager host"
```

---

### Task 5: Add Router lifecycle controls to the browser UI

**Files:**
- Modify: `src/task-manager-ui.html:240-405,405-953`
- Modify: `src/usage.html:1-45`
- Modify: `src/usage-panel.js:1-290`
- Modify: `src/sub2api-converter.html:180-205`
- Create: `test/task-manager-ui-client.test.mjs`

**Interfaces:**
- Consumes: `GET api/router/status`
- Consumes: `POST api/router/start`, `POST api/router/stop`, `POST api/router/restart`
- Uses only relative URLs so embedded root and capability-prefixed standalone mode share one HTML bundle.

- [ ] **Step 1: Write failing static/UI contract tests**

Create `test/task-manager-ui-client.test.mjs`:

```js
test("task manager UI uses relative routes and exposes all lifecycle controls", () => {
  const html = readFileSync(path.join(root, "src", "task-manager-ui.html"), "utf8");
  for (const id of ["router-start-btn", "router-stop-btn", "router-restart-btn", "router-service-state", "router-operation-result"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.doesNotMatch(html, /(?:href|src)=["']\//);
  assert.doesNotMatch(html, /api\(["']\//);
  assert.match(html, /confirm\([^)]*停止/);
  assert.match(html, /confirm\([^)]*重启/);
});

test("usage and converter assets remain under document.baseURI", () => {
  for (const file of ["usage.html", "usage-panel.js", "sub2api-converter.html"]) {
    const source = readFileSync(path.join(root, "src", file), "utf8");
    assert.doesNotMatch(source, /(?:href|src)=["']\//);
    assert.doesNotMatch(source, /fetch\(["']\//);
  }
});
```

- [ ] **Step 2: Run the UI contract test and verify absolute paths/buttons fail**

Run:

```powershell
node --test test/task-manager-ui-client.test.mjs
```

Expected: FAIL because buttons are absent and current navigation/API paths begin with `/`.

- [ ] **Step 3: Convert assets and API calls to capability-safe relative URLs**

Change navigation to `href="usage"`, `href="converter"`, `href="./"`, and `src="usage-panel.js"`. Normalize every UI API call through:

```js
function endpoint(path) {
  return new URL(String(path).replace(/^\/+/, ""), document.baseURI);
}

async function api(path, options) {
  const request = { ...(options || {}) };
  if (request.method === "POST") {
    request.headers = { "Content-Type": "application/json", ...(request.headers || {}) };
    if (request.body === undefined) request.body = "{}";
  }
  const response = await fetch(endpoint(path), request);
  let body = null;
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    throw new Error(body && body.error ? body.error : `HTTP ${response.status}`);
  }
  return body;
}
```

Use `api("api/status")`, `api("api/usage")`, and equivalent relative strings everywhere.

- [ ] **Step 4: Add the Router service card and button state machine**

Add a stat card containing the five IDs asserted above. Implement:

```js
let routerOperationPending = false;

function renderRouterService(snapshot) {
  const state = snapshot?.state || "failed";
  el("router-service-state").textContent = ({
    stopped: "已停止", starting: "启动中", running: "运行正常",
    unhealthy: "运行但不健康", stopping: "停止中",
    restarting: "重启中", failed: "状态异常",
  })[state] || "状态异常";
  const busy = routerOperationPending || ["starting", "stopping", "restarting"].includes(state);
  el("router-start-btn").disabled = busy || state !== "stopped";
  el("router-stop-btn").disabled = busy || !["running", "unhealthy"].includes(state);
  el("router-restart-btn").disabled = busy || !["running", "unhealthy"].includes(state);
}
```

Implement one `runRouterAction(action)` that confirms Stop/Restart, sets pending state, calls `POST api/router/${action}`, renders the returned snapshot, reports a bounded error, and clears pending in `finally`. The Stop confirmation says active Codex requests will disconnect; the Restart confirmation says active requests may be interrupted. Poll `api/router/status` with the existing log interval so a Task Scheduler recovery appears without a page refresh.

- [ ] **Step 5: Run UI and server tests**

Run:

```powershell
node --test test/task-manager-ui-client.test.mjs test/task-manager-ui-server.test.mjs
npm run check
```

Expected: PASS; no static asset or API request escapes the capability base path.

- [ ] **Step 6: Commit the lifecycle UI**

```powershell
git add src/task-manager-ui.html src/usage.html src/usage-panel.js src/sub2api-converter.html test/task-manager-ui-client.test.mjs
git commit -m "feat(task-manager-ui): add router lifecycle controls"
```

---

### Task 6: Supervise the standalone manager with Windows Task Scheduler

**Files:**
- Modify: `src/service-operation-lock.mjs:8-49`
- Create: `src/task-manager-process.mjs`
- Create: `src/task-manager-service.mjs`
- Create: `src/task-manager-service-windows.mjs`
- Create: `test/task-manager-process.test.mjs`
- Create: `test/task-manager-service-windows.test.mjs`
- Modify: `test/task-manager-host.test.mjs`
- Modify: `test/service-operation-lock.test.mjs`

**Interfaces:**
- Changes: `withServiceOperationLock(operation, { lockName = "service-operation", ... })`
- Produces: `writeTaskManagerProcessState()`, `readTaskManagerProcessState()`, `clearTaskManagerProcessState()`, `taskManagerProcessOwns(state)`
- Produces CLI: `node src/task-manager-service.mjs install|uninstall|start|stop|restart|status`
- Windows status: `{ installed, loaded, state, canonical, healthy, pid }`

- [ ] **Step 1: Write failing named-lock and process-identity tests**

Extend `test/service-operation-lock.test.mjs` with two concurrent operations using `lockName: "router"` and `lockName: "task-manager"`; assert both enter simultaneously while two `"router"` operations still conflict.

Create `test/task-manager-process.test.mjs`:

```js
test("manager process ownership requires this checkout and host entrypoint", () => {
  const state = buildTaskManagerProcessState({
    pid: 42,
    sourceRoot: "C:/router",
    stateDir: "C:/state",
    identity: () => "ticks|node.exe",
    commandLine: () => 'node.exe "C:/router/src/task-manager-host.mjs"',
  });
  assert.equal(taskManagerProcessOwns(state, {
    sourceRoot: "C:/router",
    stateDir: "C:/state",
    identity: () => "ticks|node.exe",
    commandLine: () => 'node.exe "C:/router/src/task-manager-host.mjs"',
  }), true);
  assert.equal(taskManagerProcessOwns(state, { sourceRoot: "C:/other", identity: () => "ticks|node.exe", commandLine: () => state.commandLine }), false);
});
```

- [ ] **Step 2: Write failing Windows render and mutation-guard tests**

Create `test/task-manager-service-windows.test.mjs` that runs `render-wrapper`, `render-launcher`, and `render-task` with `CODEX_ROUTER_SERVICE_PLATFORM=win32` and a temporary state directory. Parse `render-task` as `{ action, registration }` and assert:

```js
assert.match(wrapper, /task-manager-host\.mjs/);
assert.match(wrapper, /task-manager\.log/);
assert.match(launcher, /shell\.Run\([\s\S]*, 0, True\)/);
assert.deepEqual(task.action, {
  execute: "wscript.exe",
  argument: `//B //NoLogo "${expectedLauncher}"`,
});
assert.match(task.registration, /RestartCount 999/);
assert.match(task.registration, /MultipleInstances IgnoreNew/);
assert.match(task.registration, /RunLevel Limited/);
```

Also run `install` with `CODEX_ROUTER_TEST_SKIP_SERVICE_WRITES=1` and an unredirected state directory; expect non-zero and no created launcher.

- [ ] **Step 3: Run the focused tests and verify the modules/options are missing**

Run:

```powershell
node --test test/service-operation-lock.test.mjs test/task-manager-process.test.mjs test/task-manager-service-windows.test.mjs
```

Expected: FAIL on the missing `lockName` behavior and missing manager service/process modules.

- [ ] **Step 4: Implement named locks and exact process state**

Change the lock target in `src/service-operation-lock.mjs` to:

```js
const target = path.join(stateDir, lockName);
```

with `lockName = "service-operation"` in the options object.

Implement `src/task-manager-process.mjs` using `processStartIdentity`, `processCommandLine`, `writePrivateJson`, and the fixed entrypoint `src/task-manager-host.mjs`. Require matching PID identity, live command line, source root, state directory, and entrypoint before returning true.

- [ ] **Step 5: Implement the Windows manager service**

`src/task-manager-service-windows.mjs` must render and atomically protect:

- `start-codex-router-task-manager.cmd`, which sets target/state/control-port environment and runs `task-manager-host.mjs >> task-manager.log 2>&1`;
- `start-codex-router-task-manager-hidden.vbs`, which runs the CMD wrapper hidden and propagates its exit status;
- a current-user, limited, AtLogOn Scheduled Task named exactly `Codex Router Task Manager` with `RestartCount 999`, one-minute restart interval, and `MultipleInstances IgnoreNew`.

Its `render-task` command writes `{ action: taskAction(), registration: taskRegistrationScript() }` as JSON so the settings and action are testable without touching Task Scheduler.

Before replacing a task with the same name, read its exact action and refuse unless it matches this checkout's recognized launcher. `status` must combine task existence, canonical action, exact process-state ownership, and `GET /health` service identity. It must report a scheduler query failure as `state: "unknown"`, not `stopped`.

`src/task-manager-service.mjs` dispatches Windows to that module, returns supported=false status on other platforms, and wraps mutating commands with:

```js
withServiceOperationLock(runCommand, { lockName: "task-manager-service-operation" })
```

- [ ] **Step 6: Make the host write and clear its identity record**

In `src/task-manager-host.mjs`, call `writeTaskManagerProcessState()` before listening. On `SIGINT`, `SIGTERM`, server close, and startup failure, call `clearTaskManagerProcessState()` only when the current record still names this PID.

Extend `test/task-manager-host.test.mjs` to assert the process record exists with the spawned PID after health becomes ready and is removed after the child exits.

- [ ] **Step 7: Run service render, identity, and existing service tests**

Run:

```powershell
node --test test/service-operation-lock.test.mjs test/task-manager-process.test.mjs test/task-manager-service-windows.test.mjs
node --test test/service-render.test.mjs test/windows-task-state.test.mjs test/service-readiness.test.mjs
npm run check
```

Expected: PASS; render tests make no real Task Scheduler mutation.

- [ ] **Step 8: Commit Windows supervision**

```powershell
git add src/service-operation-lock.mjs src/task-manager-process.mjs src/task-manager-service.mjs src/task-manager-service-windows.mjs src/task-manager-host.mjs test/service-operation-lock.test.mjs test/task-manager-process.test.mjs test/task-manager-service-windows.test.mjs test/task-manager-host.test.mjs
git commit -m "feat(task-manager): supervise standalone manager on Windows"
```

---

### Task 7: Add CLI access and a capability-safe Start Menu shortcut

**Files:**
- Create: `src/task-manager-open.mjs`
- Create: `src/task-manager-shortcut-windows.mjs`
- Create: `bin/task-manager`
- Modify: `src/control.mjs:2728-2777,2870-2875`
- Modify: `bin/model-router:19-68`
- Modify: `codex-router.ps1:15-20,849-925`
- Create: `test/task-manager-open.test.mjs`
- Create: `test/task-manager-shortcut-windows.test.mjs`
- Modify: `test/model-router-cli.test.mjs`
- Modify: `test/control.test.mjs`

**Interfaces:**
- CLI in this task: `task-manager service status|start|stop|restart`
- CLI: `task-manager open [--print]`
- Produces: `openTaskManager({ fetchImpl, openBrowser, printOnly, readCallerSecret, controlPort }): Promise<{ url, mode }>`
- Produces: `taskManagerShortcutPath()`, `installTaskManagerShortcut()`, `uninstallTaskManagerShortcut()`
- Shortcut invokes the open command at click time and never stores the caller capability.

- [ ] **Step 1: Write failing CLI/open/shortcut tests**

Create `test/task-manager-open.test.mjs` against exported `openTaskManager()`, injecting `fetchImpl`, `openBrowser`, and `readCallerSecret`. Assert standalone health opens `taskManagerUrl()`, embedded health opens `http://127.0.0.1:<port>/`, stopped health rejects before `openBrowser` is called, and normal CLI output contains only a redacted URL.

Create `test/task-manager-shortcut-windows.test.mjs` using the render command:

```js
const rendered = JSON.parse(execFileSync(process.execPath, [shortcutScript, "render"], { encoding: "utf8", env }));
assert.match(rendered.target, /powershell\.exe$/i);
assert.match(rendered.arguments, /codex-router\.ps1.+task-manager.+open/i);
assert.equal(rendered.arguments.includes(CALLER_KEY), false);
assert.match(rendered.path, /Start Menu[\\/]Programs[\\/]Codex Router Task Manager\.lnk$/i);
```

Extend `test/model-router-cli.test.mjs` to assert both dispatchers accept `task-manager`. Extend `test/control.test.mjs` source assertions so `task-manager service` dispatches to `src/task-manager-service.mjs` and existing `task-manager status` still calls the bridge.

- [ ] **Step 2: Run the focused tests and verify dispatch is absent**

Run:

```powershell
node --test test/task-manager-open.test.mjs test/task-manager-shortcut-windows.test.mjs test/model-router-cli.test.mjs test/control.test.mjs
```

Expected: FAIL because the opener, shortcut, wrapper, and nested service command are missing.

- [ ] **Step 3: Implement the opener**

Create `src/task-manager-open.mjs` by extracting the safe browser-launch behavior from `panel.mjs`. It reads `CALLER_SECRET_PATH`, probes `GET http://127.0.0.1:${TASK_MANAGER_CONTROL_PORT}/health`, and selects:

```js
const url = health.mode === "standalone"
  ? taskManagerUrl(TASK_MANAGER_CONTROL_PORT, callerSecret)
  : `http://127.0.0.1:${TASK_MANAGER_CONTROL_PORT}/`;
```

Normal mode opens the browser and prints `redactCallerUrl(url)`. `--print` prints the full URL only after the same password-like warning used by `panel.mjs`.

- [ ] **Step 4: Implement nested CLI dispatch**

Change the signature to `handleTaskManager(action, value, rest = [])`, preserve every existing action, and add:

```js
if (action === "service") {
  runTaskManagerService(value || "status");
  return;
}
if (action === "open") {
  runTaskManagerOpen([value, ...rest].filter((item) => item !== undefined));
  return;
}
```

Call it from the dispatcher as `handleTaskManager(args[1], args[2], args.slice(3))`. Validate the nested service action against `status|start|stop|restart` before spawning. Create `bin/task-manager` to execute `src/control.mjs task-manager "$@"`, add the command to `bin/model-router`, and add the matching PowerShell dispatch to `codex-router.ps1`. Task 8 adds transactional `install|uninstall` only after their implementation exists.

Mark the POSIX wrapper executable before committing:

```powershell
git update-index --add --chmod=+x bin/task-manager
```

- [ ] **Step 5: Implement the current-user shortcut**

`src/task-manager-shortcut-windows.mjs` supports `render|install|uninstall|status`. Use `WScript.Shell.CreateShortcut()` through non-interactive PowerShell. Set:

```js
{
  target: "powershell.exe",
  arguments: `-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${path.join(SOURCE_ROOT, "codex-router.ps1")}" task-manager open`,
  workingDirectory: SOURCE_ROOT,
  path: path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Codex Router Task Manager.lnk"),
}
```

Honor `skipServiceManagerCall()` for mutating test runs, support `CODEX_ROUTER_START_MENU_DIR` as a test-only directory override, and delete only that exact shortcut path.

- [ ] **Step 6: Run CLI and security tests**

Run:

```powershell
node --test test/task-manager-open.test.mjs test/task-manager-shortcut-windows.test.mjs test/model-router-cli.test.mjs test/control.test.mjs test/caller-auth.test.mjs
npm run check
```

Expected: PASS; test output and rendered shortcut contain no caller capability.

- [ ] **Step 7: Commit the CLI and shortcut**

```powershell
git add src/task-manager-open.mjs src/task-manager-shortcut-windows.mjs bin/task-manager src/control.mjs bin/model-router codex-router.ps1 test/task-manager-open.test.mjs test/task-manager-shortcut-windows.test.mjs test/model-router-cli.test.mjs test/control.test.mjs
git commit -m "feat(task-manager): add service CLI and shortcut"
```

---

### Task 8: Make installation, rollback, and embedded restoration transactional

**Files:**
- Create: `src/task-manager-standalone-state.mjs`
- Create: `src/windows-task-snapshot.mjs`
- Create: `src/task-manager-install.mjs`
- Modify: `src/service-windows.mjs:67-107`
- Modify: `src/control.mjs:2728-2777`
- Modify: `install.ps1:242-535`
- Modify: `codex-router.ps1:849-875`
- Create: `test/task-manager-standalone-state.test.mjs`
- Create: `test/windows-task-snapshot.test.mjs`
- Create: `test/task-manager-install.test.mjs`
- Modify: `test/service-render.test.mjs`
- Modify: `test/installer-scripts.test.mjs`
- Modify: `test/windows-operations.test.mjs`
- Modify: `test/control.test.mjs`

**Interfaces:**
- Produces: `taskManagerStandaloneEnabled()`, `setTaskManagerStandaloneEnabled(enabled)`
- Produces: `snapshotWindowsTask({ taskName, files }): WindowsTaskSnapshot`, `restoreWindowsTask(snapshot)`, `discardWindowsTaskSnapshot(snapshot)`
- CLI: `node src/task-manager-install.mjs install|uninstall|purge|status`
- `install`: install manager, enable marker, reinstall/start Router, verify both.
- `uninstall`: remove manager/shortcut, disable marker, reinstall/start embedded Router, verify both.
- `purge`: remove manager/shortcut/marker for full product uninstall without restarting Router.

- [ ] **Step 1: Write failing marker and task-snapshot tests**

Create `test/task-manager-standalone-state.test.mjs` using a temporary state directory. Assert the default is false, enabling writes a current-user-private versioned file, and disabling removes only that file.

Create `test/windows-task-snapshot.test.mjs` with injected command runners. Assert a snapshot records exact XML, SDDL, existence, running state, and byte-for-byte copies of the supplied launcher/shortcut files; restore recreates those files and their ACLs, recreates XML, reapplies SDDL, and starts only when `running === true`; a missing snapshot deletes only the named task and the explicitly supplied files.

- [ ] **Step 2: Write failing transaction/rollback tests**

Create `test/task-manager-install.test.mjs` around exported `runTaskManagerInstall(command, deps)`. Record calls and assert the success order:

```js
assert.deepEqual(calls, [
  "port-owner-check", "snapshot-router", "snapshot-manager", "service-stop", "manager-install", "manager-health",
  "shortcut-install", "marker-enable", "service-install", "router-health",
  "router-snapshot-discard", "manager-snapshot-discard",
]);
```

Inject a failure at `service-install` and assert rollback restores the previous marker value, manager task/launchers/shortcut, Router task/launchers, starts the restored Router, and verifies Router health. Add a failure where port 4111 belongs to an unknown process; assert snapshots, stop, delete, and PID termination are never called.

- [ ] **Step 3: Run transaction tests and verify modules are absent**

Run:

```powershell
node --test test/task-manager-standalone-state.test.mjs test/windows-task-snapshot.test.mjs test/task-manager-install.test.mjs
```

Expected: FAIL because marker, snapshot, and transaction modules do not exist.

- [ ] **Step 4: Implement the private marker and Router launcher flag**

`src/task-manager-standalone-state.mjs` writes `{ "version": 1, "enabled": true }` with `writePrivateJson()` and reads false for missing/malformed files.

In `src/service-windows.mjs`, import the reader and add this variable only when enabled:

```js
...(taskManagerStandaloneEnabled()
  ? { CODEX_ROUTER_TASK_MANAGER_STANDALONE: "1" }
  : {}),
```

Extend `test/service-render.test.mjs` with redirected marker-on and marker-off render cases; assert only marker-on includes the environment variable.

- [ ] **Step 5: Implement exact Windows task snapshot/restore**

`src/windows-task-snapshot.mjs` uses `schtasks /Query /TN <name> /XML` for definition and Task Scheduler COM for SDDL. Store snapshots only under the private state directory with a random filename. Copy only the explicit launcher/shortcut paths passed by the transaction and record whether each existed. `restoreWindowsTask()` validates the snapshot task name exactly, atomically restores those files with their private ACLs, recreates with `/Create /TN <name> /XML <file> /F`, reapplies SDDL, and restores the prior running state. `discardWindowsTaskSnapshot()` removes the private snapshot directory after commit.

Never construct a delete/end target from HTTP or a snapshot body; the caller passes the constant `TASK_MANAGER_TASK_NAME` and the module rejects a different recorded name.

- [ ] **Step 6: Implement the two-task transaction**

Export `runTaskManagerInstall(command, deps)` for deterministic tests, then call it from the CLI main. The install body follows this exact control flow:

```js
const previousStandalone = deps.standaloneEnabled();
const routerSnapshot = await deps.snapshotRouterTaskAndLaunchers();
const managerSnapshot = await deps.snapshotManagerTaskLaunchersAndShortcut();
try {
  await deps.stopRouterService();
  await deps.installManagerService();
  await deps.waitForManagerHealth();
  await deps.installShortcut();
  deps.setStandaloneEnabled(true);
  await deps.installRouterService();
  await deps.waitForRouterHealth();
  await deps.discardSnapshot(routerSnapshot);
  await deps.discardSnapshot(managerSnapshot);
} catch (error) {
  deps.setStandaloneEnabled(previousStandalone);
  await deps.restoreManagerTaskLaunchersAndShortcut(managerSnapshot);
  await deps.restoreRouterTaskAndLaunchers(routerSnapshot);
  await deps.startRestoredRouterTask();
  await deps.waitForRouterHealth();
  throw error;
}
```

Before taking snapshots or stopping Router, probe port 4111. Continue only when it is absent, the current embedded Task Manager, or the exact recognized standalone manager. Refuse an unknown responder/listener and do not terminate it.

`uninstall` stops/removes the manager and shortcut, disables the marker, reinstalls Router, and waits for embedded port 4111 plus Router health. `purge` removes manager, shortcut, and marker without starting Router; use it only from full Router uninstall.

- [ ] **Step 7: Wire Windows install and uninstall entrypoints**

In `install.ps1`, replace the Windows Codex `node src/service.mjs install` step with `node src/task-manager-install.mjs install`; retain `service.mjs install` for other targets. Track whether this run newly installed the manager and call `task-manager-install.mjs purge` from rollback only for artifacts created by this run.

In `codex-router.ps1`, make full `disable`/`uninstall` run `task-manager-install.mjs purge` before `service.mjs uninstall`. Keep `task-manager service uninstall` mapped to the restoring `uninstall` command.

In `src/control.mjs`, extend the public nested allowlist so `task-manager service install|uninstall` spawn `src/task-manager-install.mjs`, while `status|start|stop|restart` continue spawning `src/task-manager-service.mjs`. Extend `test/control.test.mjs` to assert the two fixed dispatch targets and reject every other action.

Update static installer tests to assert the manager transaction precedes success output and that rollback always contains an embedded Router health restoration.

- [ ] **Step 8: Run transaction, Windows, installer, and compatibility tests**

Run:

```powershell
node --test test/task-manager-standalone-state.test.mjs test/windows-task-snapshot.test.mjs test/task-manager-install.test.mjs
node --test test/service-render.test.mjs test/installer-scripts.test.mjs test/windows-operations.test.mjs test/service-readiness.test.mjs test/control.test.mjs
node --test test/task-manager-ui-server.test.mjs test/task-manager-service-windows.test.mjs
npm run check
```

Expected: PASS; all Task Scheduler mutations remain injected/rendered and do not alter the real host.

- [ ] **Step 9: Commit the transaction**

```powershell
git add src/task-manager-standalone-state.mjs src/windows-task-snapshot.mjs src/task-manager-install.mjs src/service-windows.mjs src/control.mjs install.ps1 codex-router.ps1 test/task-manager-standalone-state.test.mjs test/windows-task-snapshot.test.mjs test/task-manager-install.test.mjs test/service-render.test.mjs test/installer-scripts.test.mjs test/windows-operations.test.mjs test/control.test.mjs
git commit -m "feat(installer): transact independent task manager"
```

---

### Task 9: Add doctor coverage, support diagnostics, documentation, and final deployment

**Files:**
- Create: `src/task-manager-doctor.mjs`
- Modify: `src/doctor.mjs:1098-1155`
- Modify: `src/support-bundle.mjs:180-215`
- Modify: `AGENTS.md` in the Windows Codex install/doctor procedure
- Modify: `docs/INSTALL.md` Windows service section
- Modify: `docs/TROUBLESHOOTING.md` service recovery section
- Create: `test/doctor-task-manager.test.mjs`
- Modify: `test/support-bundle.test.mjs`
- Modify: `test/installer-scripts.test.mjs`

**Interfaces:**
- Produces: `taskManagerDoctorRows({ platform, standalone, service, health, privateState, routerMode }): DoctorRow[]`
- Doctor rows: `Task Manager service`, `Task Manager health`, `Task Manager privacy`, `Task Manager topology`
- Support bundle adds only redacted `taskManagerService` status; no capability URL or private state contents.

- [ ] **Step 1: Write failing doctor and support-bundle tests**

Create `test/doctor-task-manager.test.mjs` against `taskManagerDoctorRows()` with explicit fixtures. Assert:

```js
function assertRow(rows, label, status) {
  const row = rows.find((entry) => entry.label === label);
  assert.ok(row, `missing doctor row: ${label}`);
  assert.equal(row.status, status);
}

assertRow(rows, "Task Manager service", "ok");
assertRow(rows, "Task Manager health", "ok");
assertRow(rows, "Task Manager privacy", "ok");
assertRow(rows, "Task Manager topology", "ok");
```

Add negative fixtures for marker enabled/task missing, task running/Router still embedding 4111, wrong manager process identity, and non-private state. Each must be FAIL with the exact repair command `task-manager service install` or `doctor --fix` and must not include the caller key.

Extend `test/support-bundle.test.mjs` to assert the new status object contains only `installed`, `loaded`, `state`, `canonical`, and `healthy` and that a seeded caller key does not occur anywhere in the bundle.

- [ ] **Step 2: Run doctor/support tests and verify rows are absent**

Run:

```powershell
node --test test/doctor-task-manager.test.mjs test/support-bundle.test.mjs
```

Expected: FAIL because doctor and the support bundle do not inspect the manager service.

- [ ] **Step 3: Implement doctor and support diagnostics**

Implement `src/task-manager-doctor.mjs` as a pure row projector. Return `[]` when `platform !== "win32"` or `standalone !== true`; otherwise return exactly four rows whose status derives from recognized service ownership, manager health, all private-file checks, and `routerMode === "standalone"`.

On Windows with standalone marker enabled, `doctor.mjs` reads `task-manager-service.mjs status`, verifies manager health identity, checks `privateFileIsProtected()` for the reused caller key/standalone/process files, reads `taskManagerMode` from the Router's protected health payload, passes those values into `taskManagerDoctorRows()`, and appends its rows. On non-Windows or marker-disabled development mode, the projector returns no rows rather than warnings.

Add to `src/support-bundle.mjs`:

```js
taskManagerService: runJson("task-manager-service.mjs", ["status"]),
```

Project only the five public status fields before writing the bundle.

- [ ] **Step 4: Document installation and recovery behavior**

Document these exact operator actions:

```text
Open:       .\codex-router.ps1 task-manager open
Status:     .\codex-router.ps1 task-manager service status
Repair:     .\codex-router.ps1 task-manager service install
Restore UI: .\codex-router.ps1 task-manager service uninstall
```

State that `Codex Router Task Manager` and `Codex Router` are separate login tasks, stopping Router leaves the manager available, the manager never opens a browser at login, and unknown port-4111 ownership is refused. Update AGENTS.md so Windows doctor requires both manager and Router core rows to be OK after installation.

- [ ] **Step 5: Run expanded deterministic verification**

Run:

```powershell
npm run check
node --test --test-concurrency=1 test/*.test.mjs
npm --prefix apps/control-center run check
node --test test/control-center-electron.test.mjs test/control-center-harness.test.mjs
git diff --check
```

Expected: all affected and newly added tests PASS. The serialized full suite may reproduce only the exact preflight baseline failure `an upstream failure after headers is never retried`; record it separately. Any additional failure blocks completion. Do not run the Control Center renderer interaction suite because this task does not change Control Center and repository policy leaves visual interaction to the operator.

- [ ] **Step 6: Run the final repository-maintainer audit**

Run:

```powershell
.\.venv\Scripts\python.exe .agents\skills\repo-maintainer\scripts\repo_maintainer.py analyze --repo . --format markdown
git status --short
git diff --stat b36dd0c..HEAD
```

Review every changed hunk. Confirm the only unrelated work remains the untracked Control Center installation fingerprint and the preserved debug stash.

- [ ] **Step 7: Commit doctor and documentation**

```powershell
git add src/task-manager-doctor.mjs src/doctor.mjs src/support-bundle.mjs AGENTS.md docs/INSTALL.md docs/TROUBLESHOOTING.md test/doctor-task-manager.test.mjs test/support-bundle.test.mjs test/installer-scripts.test.mjs
git commit -m "feat(task-manager): verify standalone manager health"
```

- [ ] **Step 8: Perform the controlled local deployment**

Record current identities first:

```powershell
node src/service.mjs status
node src/tray-service.mjs status
Get-NetTCPConnection -State Listen | Where-Object LocalPort -In 4111,4200,4202
```

Install the manager transaction:

```powershell
node src/task-manager-install.mjs install
```

This command must not return until manager and Router health pass or rollback has restored embedded Router health.

- [ ] **Step 9: Verify live topology without stopping the active Codex turn**

Run:

```powershell
node src/task-manager-service.mjs status
node src/service.mjs status
node src/tray-service.mjs status
node src/doctor.mjs
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4111/health
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4200/health/liveliness
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4202/health
```

Expected:

- manager task installed/loaded/canonical/healthy;
- Router task installed/loaded/running;
- Control Center task still installed/running;
- manager health 200 with `service=codex-router-task-manager` and `mode=standalone`;
- gateway and Router health 200;
- exactly one recognized process owns port 4111;
- no legacy 4100/4101/4102/4103/4108 listener;
- doctor exits 0 apart from warnings for unselected providers.

Do not press the real Stop button inside this active turn. Ask the operator to exercise Stop and Start after the final response; isolated integration tests already prove the manager remains alive across that transition.
