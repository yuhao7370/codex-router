import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertCallerSecret, callerBaseUrl } from "./caller-auth.mjs";
import {
  CALLER_SECRET_PATH,
  PORTS,
  SOURCE_ROOT,
  STATE_DIR,
  TASK_MANAGER_CONTROL_PORT,
  TASK_MANAGER_PROCESS_STATE_PATH,
  TASK_MANAGER_TASK_NAME,
  loopback,
} from "./paths.mjs";
import { processCommandLine } from "./process-identity.mjs";
import { withServiceOperationLock } from "./service-operation-lock.mjs";
import {
  setTaskManagerStandaloneEnabled,
  taskManagerStandaloneEnabled,
  taskManagerStandaloneState,
} from "./task-manager-standalone-state.mjs";
import {
  purgeTaskManagerCreatedServiceComponents,
  queryScheduledTask,
  stopOwnedManagerProcess,
  taskActionIsCanonical,
  scheduledTaskDefinitionIsCanonical,
  taskManagerServiceComponentsStatus,
  taskManagerServiceStatus,
} from "./task-manager-service-windows.mjs";
import {
  readTaskManagerProcessState,
  taskManagerProcessOwns,
} from "./task-manager-process.mjs";
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
import { windowsLoopbackPortOwner } from "./windows-listener-owner.mjs";

const COMMANDS = new Set(["install", "uninstall", "purge", "purge-created", "status"]);
const RECOGNIZED_PORT_OWNERS = new Set(["absent", "embedded", "standalone"]);
const ROUTER_TASK_NAME = "Codex Router";
const PROBE_TIMEOUT_MS = 3_000;
const HEALTH_TIMEOUT_MS = 300_000;
const MANAGER_HEALTH_TIMEOUT_MS = 30_000;
const POLL_MS = 250;
const MAX_HTTP_BODY_BYTES = 64 * 1024;
const CREATED_COMPONENT_KEYS = Object.freeze([
  "task",
  "wrapper",
  "launcher",
  "shortcut",
  "marker",
]);

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

export const windowsTaskManagerPortOwner = windowsLoopbackPortOwner;

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

export async function readProtectedTaskManagerRouterHealth({
  fetchImpl = globalThis.fetch,
  readCallerSecret = () => readFileSync(CALLER_SECRET_PATH, "utf8"),
} = {}) {
  try {
    const secret = assertCallerSecret(readCallerSecret().trim());
    return fetchHealth(`${callerBaseUrl(PORTS.router, secret)}/health`, fetchImpl);
  } catch {
    return undefined;
  }
}

function normalized(value) {
  return String(value || "").replaceAll("\\", "/").toLowerCase();
}

function commandLineHasExactEntrypoint(commandLine, entrypoint) {
  const expected = normalized(path.resolve(entrypoint));
  const tokens = String(commandLine || "").match(/"[^"]*"|'[^']*'|[^\s]+/g) || [];
  const unquoted = tokens.map((token) => {
    const value = token.length > 1 && (
      (token.startsWith('"') && token.endsWith('"'))
      || (token.startsWith("'") && token.endsWith("'"))
    ) ? token.slice(1, -1) : token;
    return value;
  });
  const executable = normalized(unquoted[0]).split("/").at(-1);
  const entrypointIndex = unquoted.findIndex((token) => normalized(token) === expected);
  return (executable === "node" || executable === "node.exe")
    && entrypointIndex > 0
    && unquoted.slice(1, entrypointIndex).every((token) => token.startsWith("-"));
}

export async function classifyTaskManagerPortOwner({
  readPortOwner = windowsTaskManagerPortOwner,
  readManagerHealth = () => fetchHealth(loopback(TASK_MANAGER_CONTROL_PORT, "/health")),
  readProcessCommandLine = (pid) => processCommandLine(pid, { platform: "win32" }),
  readManagerProcessState = readTaskManagerProcessState,
  managerProcessOwns = taskManagerProcessOwns,
  readManagerTask = () => queryScheduledTask({ taskName: TASK_MANAGER_TASK_NAME }),
  readRouterTask = () => queryScheduledTask({ taskName: ROUTER_TASK_NAME }),
  sourceRoot = SOURCE_ROOT,
  stateDir = STATE_DIR,
  controlPort = TASK_MANAGER_CONTROL_PORT,
  allowDevelopmentEmbedded = false,
} = {}) {
  const owner = await readPortOwner({ port: controlPort, platform: "win32" });
  if (owner?.known !== true) return "unknown";
  if (owner.pid === null) return "absent";
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) return "unknown";

  const [managerHealth, managerTask, routerTask] = await Promise.all([
    readManagerHealth(),
    readManagerTask(),
    readRouterTask(),
  ]);
  if (
    managerHealth?.ok === true
    && managerHealth.service === "codex-router-task-manager"
    && managerHealth.mode === "standalone"
    && managerHealth.pid === owner.pid
    && managerTask?.known === true
    && managerTask.state === "running"
    && taskActionIsCanonical(managerTask, { stateDir })
  ) {
    const state = readManagerProcessState();
    if (
      state?.pid === owner.pid
      && managerProcessOwns(state, { platform: "win32", sourceRoot, stateDir })
    ) {
      return "standalone";
    }
    return "unknown";
  }
  const routerEntrypointMatches = commandLineHasExactEntrypoint(
    readProcessCommandLine(owner.pid),
    path.join(sourceRoot, "src", "router.mjs"),
  );
  if (
    routerTask?.known === true
    && scheduledTaskDefinitionIsCanonical(routerTask, routerTaskAction({ stateDir }))
    && routerEntrypointMatches
  ) {
    return "embedded";
  }
  if (
    allowDevelopmentEmbedded
    && managerTask?.known === true
    && managerTask.exists === false
    && routerTask?.known === true
    && routerTask.exists === false
    && !(
      managerHealth?.service === "codex-router-task-manager"
      && managerHealth.mode === "standalone"
    )
    && routerEntrypointMatches
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

export async function embeddedTaskManagerPageContract(fetchImpl = globalThis.fetch) {
  try {
    const origin = loopback(TASK_MANAGER_CONTROL_PORT);
    const [health, root] = await Promise.all([
      fetchImpl(`${origin}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }),
      fetchImpl(`${origin}/`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }),
    ]);
    return health.status === 404
      && root.ok
      && String(root.headers.get("content-type") || "").toLowerCase().startsWith("text/html");
  } catch {
    return false;
  }
}

export async function verifyEmbeddedTaskManager({
  classifyOwner = classifyTaskManagerPortOwner,
  readPageContract = embeddedTaskManagerPageContract,
  timeoutMs = MANAGER_HEALTH_TIMEOUT_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = "unknown";
  do {
    last = await classifyOwner();
    if (last === "embedded" && await readPageContract()) {
      return { ok: true, mode: "embedded" };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(POLL_MS, remaining));
  } while (Date.now() <= deadline);
  throw new Error(`The embedded Task Manager did not reclaim port ${TASK_MANAGER_CONTROL_PORT} (${last}).`);
}

async function waitForExpectedRouterHealth({
  readHealth = readProtectedTaskManagerRouterHealth,
  expectedMode = taskManagerStandaloneEnabled() ? "standalone" : "embedded",
  timeoutMs = HEALTH_TIMEOUT_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let health;
  do {
    health = await readHealth();
    if (
      health?.ok === true
      && health.service === "codex-router"
      && health.taskManagerMode === expectedMode
    ) return health;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(POLL_MS, remaining));
  } while (Date.now() <= deadline);
  throw new Error(
    `The protected Router health did not report Task Manager mode ${expectedMode} (${health?.taskManagerMode || "unknown"}).`,
  );
}

function pathPresence(target) {
  try {
    const stats = lstatSync(target);
    return stats.isFile() && !stats.isSymbolicLink()
      ? { known: true, present: true }
      : { known: false, present: null };
  } catch (error) {
    return error?.code === "ENOENT"
      ? { known: true, present: false }
      : { known: false, present: null };
  }
}

export async function taskManagerInstallStatus({
  platform = process.env.CODEX_ROUTER_SERVICE_PLATFORM || process.platform,
  readManagerStatus = taskManagerServiceStatus,
  readServiceComponents = taskManagerServiceComponentsStatus,
  readMarkerState = taskManagerStandaloneState,
  resolveShortcutPath = taskManagerShortcutPath,
  readPath = pathPresence,
} = {}) {
  if (platform !== "win32") {
    return {
      supported: false,
      standalone: false,
      manager: { installed: false, loaded: false, state: "unsupported" },
      shortcut: { installed: false },
      components: Object.fromEntries(
        [...CREATED_COMPONENT_KEYS, "process"].map((key) => [key, { known: false, present: null }]),
      ),
    };
  }
  const shortcutPath = resolveShortcutPath();
  const [manager, serviceComponents] = await Promise.all([
    readManagerStatus(),
    readServiceComponents(),
  ]);
  const marker = readMarkerState();
  const shortcut = readPath(shortcutPath);
  const processState = readPath(TASK_MANAGER_PROCESS_STATE_PATH);
  return {
    supported: true,
    standalone: marker.enabled,
    marker,
    manager,
    shortcut: { installed: shortcut.present, path: shortcutPath },
    components: {
      ...serviceComponents,
      shortcut,
      marker: { known: marker.known, present: marker.exists },
      process: processState,
    },
  };
}

export async function assertManagerTaskReplaceable({
  queryTask = queryScheduledTask,
  stateDir = STATE_DIR,
} = {}) {
  const task = await queryTask();
  if (task?.known !== true) {
    throw new Error(
      `Task Scheduler could not identify "${TASK_MANAGER_TASK_NAME}"; refusing to stop Router.`,
    );
  }
  if (task.exists && !taskActionIsCanonical(task, { stateDir })) {
    throw new Error(
      `Refusing to replace the noncanonical Scheduled Task "${TASK_MANAGER_TASK_NAME}" before stopping Router.`,
    );
  }
  return task;
}

function routerTaskAction({ stateDir = STATE_DIR } = {}) {
  return {
    execute: "wscript.exe",
    argument: `//B //NoLogo "${path.join(stateDir, "start-codex-router-hidden.vbs")}"`,
  };
}

export async function assertRouterTaskReplaceable({
  queryTask = queryScheduledTask,
  stateDir = STATE_DIR,
} = {}) {
  const task = await queryTask({ taskName: ROUTER_TASK_NAME });
  if (task?.known !== true) {
    throw new Error(`Task Scheduler could not identify "${ROUTER_TASK_NAME}"; refusing before snapshots.`);
  }
  if (task.exists && !scheduledTaskDefinitionIsCanonical(task, routerTaskAction({ stateDir }))) {
    throw new Error(`Refusing to adopt or replace the noncanonical Scheduled Task "${ROUTER_TASK_NAME}".`);
  }
  return task;
}

export function parseCreatedTaskManagerComponents(value) {
  if (!value) return undefined;
  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch (error) {
    throw new Error("Created Task Manager component state is malformed.", { cause: error });
  }
  if (
    parsed?.version !== 1
    || Object.keys(parsed).length !== CREATED_COMPONENT_KEYS.length + 1
    || CREATED_COMPONENT_KEYS.some((key) => typeof parsed[key] !== "boolean")
  ) {
    throw new Error("Created Task Manager component state must be version 1 with exact boolean fields.");
  }
  return Object.freeze({
    version: 1,
    ...Object.fromEntries(CREATED_COMPONENT_KEYS.map((key) => [key, parsed[key]])),
  });
}

function defaultDependencies() {
  return {
    checkPortOwner: classifyTaskManagerPortOwner,
    preflightManagerTask: assertManagerTaskReplaceable,
    preflightRouterTask: assertRouterTaskReplaceable,
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
    startManagerService: () => runNodeCommand("task-manager-service.mjs", "start"),
    uninstallManagerService: () => runNodeCommand("task-manager-service.mjs", "uninstall"),
    purgeManagerServiceComponents: purgeTaskManagerCreatedServiceComponents,
    waitForManagerHealth,
    verifyRestoredStandaloneManager: waitForManagerHealth,
    installShortcut: () => installTaskManagerShortcut(),
    uninstallShortcut: () => uninstallTaskManagerShortcut(),
    installRouterService: () => runNodeCommand("service.mjs", "install"),
    waitForRouterHealth: waitForExpectedRouterHealth,
    waitForEmbeddedTaskManager: verifyEmbeddedTaskManager,
    discardSnapshot: discardWindowsTaskSnapshot,
    restoreManagerTaskLaunchersAndShortcut: async (snapshot) => {
      // Trusted rollback cannot depend on the low-level install gate: that gate
      // rejects a noncanonical current task before the exact snapshot can put
      // the previous definition back. Stop only the exact recorded process;
      // restoreWindowsTask derives every task target from its trusted handle.
      const errors = [];
      try { stopOwnedManagerProcess(); } catch (error) { errors.push(asError(error)); }
      try { await restoreWindowsTask(snapshot); } catch (error) { errors.push(asError(error)); }
      if (errors.length) {
        throw new AggregateError(errors, "Manager stop/restore could not be completed fully.");
      }
      return snapshot;
    },
    restoreRouterTaskAndLaunchers: async (snapshot) => {
      // The Router low-level stop also drains its verified process tree, which
      // prevents a running wscript/cmd launcher from locking the files being
      // restored and prevents the old listener racing the restored task.
      const errors = [];
      try { runNodeCommand("service.mjs", "stop"); } catch (error) { errors.push(asError(error)); }
      try { await restoreWindowsTask(snapshot); } catch (error) { errors.push(asError(error)); }
      if (errors.length) {
        throw new AggregateError(errors, "Router stop/restore could not be completed fully.");
      }
      return snapshot;
    },
    startRestoredRouterTask: () => runNodeCommand("service.mjs", "start"),
    readStatus: taskManagerInstallStatus,
    createdComponents: () => parseCreatedTaskManagerComponents(
      process.env.CODEX_ROUTER_TASK_MANAGER_CREATED_COMPONENTS,
    ),
  };
}

function asError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

function rollbackFailure(operationError, rollbackErrors) {
  return new AggregateError(
    [asError(operationError), ...rollbackErrors.map(asError)],
    "Task Manager installation failed and its previous Router state could not be fully restored.",
    { cause: asError(operationError) },
  );
}

function recoveryError(label, error) {
  return new Error(`${label}: ${asError(error).message}`, { cause: asError(error) });
}

function recoveryErrors(label, error) {
  const errors = error instanceof AggregateError ? error.errors : [error];
  return errors.map((item) => recoveryError(label, item));
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

async function discardSnapshots(deps, routerSnapshot, managerSnapshot) {
  const errors = [];
  // Manager first keeps the Router snapshot -- the artifact needed to recover
  // availability -- until the final cleanup attempt. Each attempt is
  // independent, so a failed manager discard cannot leak both snapshots.
  for (const [label, snapshot] of [
    ["manager snapshot cleanup failed", managerSnapshot],
    ["Router snapshot cleanup failed", routerSnapshot],
  ]) {
    if (!snapshot) continue;
    try {
      await deps.discardSnapshot(snapshot);
    } catch (error) {
      errors.push(recoveryError(label, error));
    }
  }
  return errors;
}

async function captureSnapshots(deps) {
  const routerSnapshot = await deps.snapshotRouterTaskAndLaunchers();
  try {
    const managerSnapshot = await deps.snapshotManagerTaskLaunchersAndShortcut();
    return { routerSnapshot, managerSnapshot };
  } catch (operationError) {
    let cleanupError;
    try {
      await deps.discardSnapshot(routerSnapshot);
    } catch (error) {
      cleanupError = recoveryError("partial Router snapshot cleanup failed", error);
    }
    if (cleanupError) throw rollbackFailure(operationError, [cleanupError]);
    throw operationError;
  }
}

async function rollbackInstall(deps, previousStandalone, routerSnapshot, managerSnapshot) {
  const errors = [];
  const attempt = async (label, operation) => {
    try {
      await operation();
    } catch (error) {
      errors.push(...recoveryErrors(label, error));
    }
  };
  await attempt("standalone marker restore failed", () =>
    deps.setStandaloneEnabled(previousStandalone));
  await attempt("manager task/launcher/shortcut restore failed", () =>
    deps.restoreManagerTaskLaunchersAndShortcut(managerSnapshot));
  // These three are deliberately unconditional. Router recovery is the
  // non-skippable outcome even when marker or manager restoration failed.
  await attempt("Router task/launcher restore failed", () =>
    deps.restoreRouterTaskAndLaunchers(routerSnapshot));
  await attempt("restored Router start failed", () => deps.startRestoredRouterTask());
  await attempt("restored Router health failed", () => deps.waitForRouterHealth());
  if (previousStandalone) {
    await attempt(
      "restored standalone Task Manager health failed",
      () => deps.verifyRestoredStandaloneManager(),
    );
  } else {
    await attempt(
      "restored embedded Task Manager topology failed",
      () => deps.waitForEmbeddedTaskManager(),
    );
  }
  if (errors.length) return errors;
  return discardSnapshots(deps, routerSnapshot, managerSnapshot);
}

async function install(deps) {
  await assertRecognizedPortOwner(deps);
  await deps.preflightManagerTask();
  await deps.preflightRouterTask();
  const previousStandalone = deps.standaloneEnabled();
  const { routerSnapshot, managerSnapshot } = await captureSnapshots(deps);
  try {
    await deps.stopRouterService();
    await deps.installManagerService();
    await deps.waitForManagerHealth();
    await deps.installShortcut();
    deps.setStandaloneEnabled(true);
    await deps.installRouterService();
    await deps.waitForRouterHealth();
  } catch (operationError) {
    const rollbackErrors = await rollbackInstall(
      deps, previousStandalone, routerSnapshot, managerSnapshot,
    );
    if (rollbackErrors.length) throw rollbackFailure(operationError, rollbackErrors);
    throw operationError;
  }
  // Health is the commit point. Cleanup failure is reported but can never
  // consume a partially discarded snapshot by rolling back a healthy live
  // generation.
  const cleanupErrors = await discardSnapshots(deps, routerSnapshot, managerSnapshot);
  return {
    command: "install",
    standalone: true,
    cleanupErrors: cleanupErrors.map(({ message }) => message),
  };
}

async function uninstall(deps) {
  await assertRecognizedPortOwner(deps);
  await deps.preflightManagerTask();
  await deps.preflightRouterTask();
  const previousStandalone = deps.standaloneEnabled();
  const { routerSnapshot, managerSnapshot } = await captureSnapshots(deps);
  try {
    await deps.uninstallManagerService();
    await deps.uninstallShortcut();
    deps.setStandaloneEnabled(false);
    await deps.installRouterService();
    await deps.waitForEmbeddedTaskManager();
    await deps.waitForRouterHealth();
  } catch (operationError) {
    const rollbackErrors = await rollbackInstall(
      deps, previousStandalone, routerSnapshot, managerSnapshot,
    );
    if (rollbackErrors.length) throw rollbackFailure(operationError, rollbackErrors);
    throw operationError;
  }
  const cleanupErrors = await discardSnapshots(deps, routerSnapshot, managerSnapshot);
  return {
    command: "uninstall",
    standalone: false,
    cleanupErrors: cleanupErrors.map(({ message }) => message),
  };
}

async function purge(deps, { createdOnly = false } = {}) {
  await assertRecognizedPortOwner(deps);
  if (createdOnly) {
    const created = typeof deps.createdComponents === "function"
      ? deps.createdComponents()
      : deps.createdComponents;
    if (!created) {
      throw new Error("purge-created requires the fixed created-component environment contract.");
    }
    const components = parseCreatedTaskManagerComponents(created);
    await deps.purgeManagerServiceComponents({
      task: components.task,
      wrapper: components.wrapper,
      launcher: components.launcher,
    });
    if (components.shortcut) await deps.uninstallShortcut();
    if (components.marker) deps.setStandaloneEnabled(false);
    if (
      !components.marker
      && !components.task
      && !components.wrapper
      && !components.launcher
    ) {
      await deps.startManagerService();
    }
    return { command: "purge", standalone: deps.standaloneEnabled?.() === true };
  }
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
  return purge(deps, { createdOnly: command === "purge-created" });
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
  if (
    command === "status"
    && process.env.CODEX_ROUTER_TASK_MANAGER_REQUIRE_EMBEDDED === "1"
  ) {
    await verifyEmbeddedTaskManager();
    await waitForExpectedRouterHealth({ expectedMode: "embedded" });
    result.embeddedVerified = true;
  }
  for (const warning of result?.cleanupErrors || []) {
    process.stderr.write(`Warning: ${warning}\n`);
  }
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
