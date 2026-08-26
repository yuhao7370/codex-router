import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PORTS,
  SOURCE_ROOT,
  STATE_DIR,
  TASK_MANAGER_CONTROL_PORT,
  TASK_MANAGER_TASK_NAME,
  loopback,
} from "./paths.mjs";
import { waitForRouterHealth as pollRouterHealth } from "./router-health.mjs";
import { withServiceOperationLock } from "./service-operation-lock.mjs";
import {
  setTaskManagerStandaloneEnabled,
  taskManagerStandaloneEnabled,
} from "./task-manager-standalone-state.mjs";
import { taskManagerServiceStatus } from "./task-manager-service-windows.mjs";
import {
  installTaskManagerShortcut,
  taskManagerShortcutPath,
  uninstallTaskManagerShortcut,
} from "./task-manager-shortcut-windows.mjs";
import {
  discardWindowsTaskSnapshot,
  restoreWindowsTask,
  snapshotWindowsTask,
} from "./windows-task-snapshot.mjs";

const COMMANDS = new Set(["install", "uninstall", "purge", "status"]);
const RECOGNIZED_PORT_OWNERS = new Set(["absent", "embedded", "standalone"]);
const ROUTER_TASK_NAME = "Codex Router";
const PROBE_TIMEOUT_MS = 3_000;
const HEALTH_TIMEOUT_MS = 300_000;
const MANAGER_HEALTH_TIMEOUT_MS = 30_000;
const POLL_MS = 250;
const MAX_HTTP_BODY_BYTES = 64 * 1024;

function routerFiles() {
  return [
    path.join(STATE_DIR, "start-codex-router.cmd"),
    path.join(STATE_DIR, "start-codex-router-hidden.vbs"),
  ];
}

function managerFiles() {
  return [
    path.join(STATE_DIR, "start-codex-router-task-manager.cmd"),
    path.join(STATE_DIR, "start-codex-router-task-manager-hidden.vbs"),
    taskManagerShortcutPath(),
  ];
}

function childError(script, command, result) {
  const detail = String(result.stderr || result.stdout || "").trim();
  return new Error(
    detail || `${script} ${command} exited with status ${result.status ?? result.signal ?? "unknown"}.`,
  );
}

function runNodeCommand(script, command) {
  const result = spawnSync(
    process.execPath,
    [path.join(SOURCE_ROOT, "src", script), command],
    {
      cwd: SOURCE_ROOT,
      encoding: "utf8",
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw childError(script, command, result);
  const output = String(result.stdout || "").trim();
  if (!output) return undefined;
  try {
    return JSON.parse(output.split(/\r?\n/).at(-1));
  } catch {
    return output;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function tcpListenerState({
  port = TASK_MANAGER_CONTROL_PORT,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (state) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(timeoutMs, () => finish("unknown"));
    socket.once("connect", () => finish("listening"));
    socket.once("error", (error) => {
      finish(error?.code === "ECONNREFUSED" ? "absent" : "unknown");
    });
  });
}

async function boundedJson(response, maxBytes = MAX_HTTP_BODY_BYTES) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new Error("health response is too large");
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("health response is too large");
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size).toString("utf8");
  return JSON.parse(body);
}

async function fetchHealth(url, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = await boundedJson(response);
    return body && typeof body === "object" && !Array.isArray(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

async function inspectPortOwner({
  listenerState = tcpListenerState,
  fetchImpl = globalThis.fetch,
  readManagerStatus = taskManagerServiceStatus,
} = {}) {
  const listener = await listenerState();
  if (listener !== "listening") return listener;

  const [managerHealth, routerHealth] = await Promise.all([
    fetchHealth(loopback(TASK_MANAGER_CONTROL_PORT, "/health"), fetchImpl),
    fetchHealth(loopback(PORTS.router, "/health"), fetchImpl),
  ]);
  if (
    managerHealth?.ok === true
    && managerHealth.service === "codex-router-task-manager"
    && managerHealth.mode === "standalone"
    && Number.isSafeInteger(managerHealth.pid)
    && managerHealth.pid > 0
  ) {
    const status = await readManagerStatus();
    if (
      status?.installed === true
      && status.canonical === true
      && status.healthy === true
      && status.pid === managerHealth.pid
    ) {
      return "standalone";
    }
    return "unknown";
  }
  if (
    routerHealth?.service === "codex-router"
    && routerHealth.taskManagerMode === "embedded"
  ) {
    return "embedded";
  }
  return "unknown";
}

async function waitForManagerHealth({
  readStatus = taskManagerServiceStatus,
  timeoutMs = MANAGER_HEALTH_TIMEOUT_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  do {
    last = await readStatus();
    if (
      last?.installed === true
      && last.canonical === true
      && last.healthy === true
    ) {
      return last;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(POLL_MS, remaining));
  } while (Date.now() <= deadline);
  throw new Error(`The standalone Task Manager did not become healthy (${last?.state || "unknown"}).`);
}

async function waitForEmbeddedTaskManager({
  inspect = inspectPortOwner,
  timeoutMs = MANAGER_HEALTH_TIMEOUT_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = "unknown";
  do {
    last = await inspect();
    if (last === "embedded") return { ok: true, mode: "embedded" };
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(POLL_MS, remaining));
  } while (Date.now() <= deadline);
  throw new Error(`The embedded Task Manager did not reclaim port ${TASK_MANAGER_CONTROL_PORT} (${last}).`);
}

async function waitForExpectedRouterHealth() {
  const health = await pollRouterHealth({ timeoutMs: HEALTH_TIMEOUT_MS });
  if (!health?.ok) throw new Error(health?.error || "The Router did not become healthy.");
  const expectedMode = taskManagerStandaloneEnabled() ? "standalone" : "embedded";
  if (health.payload?.taskManagerMode !== expectedMode) {
    throw new Error(
      `Router health reported Task Manager mode ${health.payload?.taskManagerMode || "unknown"}; expected ${expectedMode}.`,
    );
  }
  return health;
}

function defaultStatus() {
  const platform = process.env.CODEX_ROUTER_SERVICE_PLATFORM || process.platform;
  if (platform !== "win32") {
    return {
      supported: false,
      standalone: false,
      manager: { installed: false, loaded: false, state: "unsupported" },
      shortcut: { installed: false },
    };
  }
  const shortcutPath = taskManagerShortcutPath();
  return Promise.resolve(taskManagerServiceStatus()).then((manager) => ({
    supported: true,
    standalone: taskManagerStandaloneEnabled(),
    manager,
    shortcut: { installed: existsSync(shortcutPath), path: shortcutPath },
  }));
}

function defaultDependencies() {
  return {
    checkPortOwner: inspectPortOwner,
    standaloneEnabled: taskManagerStandaloneEnabled,
    setStandaloneEnabled: setTaskManagerStandaloneEnabled,
    snapshotRouterTaskAndLaunchers: () => snapshotWindowsTask({
      taskName: ROUTER_TASK_NAME,
      files: routerFiles(),
    }),
    snapshotManagerTaskLaunchersAndShortcut: () => snapshotWindowsTask({
      taskName: TASK_MANAGER_TASK_NAME,
      files: managerFiles(),
    }),
    stopRouterService: () => runNodeCommand("service.mjs", "stop"),
    installManagerService: () => runNodeCommand("task-manager-service.mjs", "install"),
    uninstallManagerService: () => runNodeCommand("task-manager-service.mjs", "uninstall"),
    waitForManagerHealth,
    installShortcut: () => installTaskManagerShortcut(),
    uninstallShortcut: () => uninstallTaskManagerShortcut(),
    installRouterService: () => runNodeCommand("service.mjs", "install"),
    waitForRouterHealth: waitForExpectedRouterHealth,
    waitForEmbeddedTaskManager,
    discardSnapshot: discardWindowsTaskSnapshot,
    restoreManagerTaskLaunchersAndShortcut: async (snapshot) => {
      // Task Scheduler can report an ended task while its node descendant still
      // owns port 4111. Reuse the exact process-state stop before replacing the
      // launchers; the snapshot module then restores the byte-exact task.
      runNodeCommand("task-manager-service.mjs", "stop");
      return restoreWindowsTask(snapshot);
    },
    restoreRouterTaskAndLaunchers: async (snapshot) => {
      // The Router low-level stop also drains its verified process tree, which
      // prevents a running wscript/cmd launcher from locking the files being
      // restored and prevents the old listener racing the restored task.
      runNodeCommand("service.mjs", "stop");
      return restoreWindowsTask(snapshot);
    },
    startRestoredRouterTask: () => runNodeCommand("service.mjs", "start"),
    readStatus: defaultStatus,
  };
}

function asError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

function rollbackFailure(operationError, rollbackError) {
  return new AggregateError(
    [asError(operationError), asError(rollbackError)],
    "Task Manager installation failed and its previous Router state could not be fully restored.",
    { cause: asError(operationError) },
  );
}

async function assertRecognizedPortOwner(deps) {
  const owner = await deps.checkPortOwner();
  if (!RECOGNIZED_PORT_OWNERS.has(owner)) {
    throw new Error(
      `An unrecognized listener owns Task Manager port ${TASK_MANAGER_CONTROL_PORT}; refusing to stop, replace, delete, or terminate it.`,
    );
  }
  return owner;
}

async function rollbackInstall(deps, previousStandalone, routerSnapshot, managerSnapshot) {
  deps.setStandaloneEnabled(previousStandalone);
  await deps.restoreManagerTaskLaunchersAndShortcut(managerSnapshot);
  await deps.restoreRouterTaskAndLaunchers(routerSnapshot);
  await deps.startRestoredRouterTask();
  await deps.waitForRouterHealth();
}

async function commitSnapshots(deps, routerSnapshot, managerSnapshot) {
  await deps.discardSnapshot(routerSnapshot);
  await deps.discardSnapshot(managerSnapshot);
}

async function install(deps) {
  await assertRecognizedPortOwner(deps);
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
    await commitSnapshots(deps, routerSnapshot, managerSnapshot);
    return { command: "install", standalone: true };
  } catch (operationError) {
    try {
      await rollbackInstall(deps, previousStandalone, routerSnapshot, managerSnapshot);
    } catch (rollbackError) {
      throw rollbackFailure(operationError, rollbackError);
    }
    throw operationError;
  }
}

async function uninstall(deps) {
  await assertRecognizedPortOwner(deps);
  const previousStandalone = deps.standaloneEnabled();
  const routerSnapshot = await deps.snapshotRouterTaskAndLaunchers();
  const managerSnapshot = await deps.snapshotManagerTaskLaunchersAndShortcut();
  try {
    await deps.uninstallManagerService();
    await deps.uninstallShortcut();
    deps.setStandaloneEnabled(false);
    await deps.installRouterService();
    await deps.waitForEmbeddedTaskManager();
    await deps.waitForRouterHealth();
    await commitSnapshots(deps, routerSnapshot, managerSnapshot);
    return { command: "uninstall", standalone: false };
  } catch (operationError) {
    try {
      await rollbackInstall(deps, previousStandalone, routerSnapshot, managerSnapshot);
    } catch (rollbackError) {
      throw rollbackFailure(operationError, rollbackError);
    }
    throw operationError;
  }
}

async function purge(deps) {
  await assertRecognizedPortOwner(deps);
  await deps.uninstallManagerService();
  await deps.uninstallShortcut();
  deps.setStandaloneEnabled(false);
  return { command: "purge", standalone: false };
}

export async function runTaskManagerInstall(command, dependencies) {
  if (!COMMANDS.has(command)) {
    throw new Error("Usage: task-manager-install.mjs install|uninstall|purge|status");
  }
  const deps = dependencies || defaultDependencies();
  if (command === "status") return deps.readStatus();
  if (command === "install") return install(deps);
  if (command === "uninstall") return uninstall(deps);
  return purge(deps);
}

function isMain() {
  return Boolean(
    process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)),
  );
}

async function main() {
  const command = process.argv[2];
  if (!COMMANDS.has(command) || process.argv.length !== 3) {
    process.stderr.write("Usage: task-manager-install.mjs install|uninstall|purge|status\n");
    return 2;
  }
  const platform = process.env.CODEX_ROUTER_SERVICE_PLATFORM || process.platform;
  if (platform !== "win32" && command !== "status") {
    throw new Error("The independent Task Manager installation transaction is supported on Windows only.");
  }
  const run = () => runTaskManagerInstall(command);
  const result = command === "status"
    ? await run()
    : await withServiceOperationLock(run, {
        lockName: "task-manager-install-transaction",
      });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (isMain()) {
  try {
    process.exitCode = await main();
  } catch (error) {
    if (error instanceof AggregateError) {
      process.stderr.write(`${error.message}\n`);
      for (const cause of error.errors) {
        process.stderr.write(`- ${cause instanceof Error ? cause.message : String(cause)}\n`);
      }
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  }
}
