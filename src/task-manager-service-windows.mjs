import { execFileSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writePrivateFile } from "./file-security.mjs";
import {
  SOURCE_ROOT,
  STATE_DIR,
  TARGET,
  TASK_MANAGER_CONTROL_PORT,
  TASK_MANAGER_LOG_PATH,
  TASK_MANAGER_PROCESS_STATE_PATH,
  TASK_MANAGER_TASK_NAME,
} from "./paths.mjs";
import {
  clearTaskManagerProcessState,
  readTaskManagerProcessState,
  taskManagerProcessEvidence,
  taskManagerProcessOwns,
  taskManagerProcessStateMatches,
} from "./task-manager-process.mjs";
import {
  assertServiceWriteIsolated,
  skipServiceManagerCall,
} from "./service-write-guard.mjs";

const HOST_MANAGED = process.platform === "win32";
const effectivePlatform = process.env.CODEX_ROUTER_SERVICE_PLATFORM || process.platform;
const MUTATING_COMMANDS = new Set(["install", "uninstall", "start", "stop", "restart"]);
const RENDER_COMMANDS = new Set(["render-wrapper", "render-launcher", "render-task"]);
const COMMANDS = new Set([...MUTATING_COMMANDS, "status", ...RENDER_COMMANDS]);
const HEALTH_TIMEOUT_MS = 3_000;
const TASK_SCHEDULER_QUERY_TIMEOUT_MS = 15_000;
const PROCESS_STOP_TIMEOUT_MS = 15_000;
const PROCESS_STOP_POLL_MS = 250;

function wrapperPathFor(stateDir = STATE_DIR) {
  return path.join(stateDir, "start-codex-router-task-manager.cmd");
}

function launcherPathFor(stateDir = STATE_DIR) {
  return path.join(stateDir, "start-codex-router-task-manager-hidden.vbs");
}

function processStatePathFor(stateDir = STATE_DIR) {
  return stateDir === STATE_DIR
    ? TASK_MANAGER_PROCESS_STATE_PATH
    : path.join(stateDir, "task-manager-process.json");
}

function cmdEscape(value) {
  return String(value).replaceAll("%", "%%").replaceAll('"', '""');
}

function vbsEscape(value) {
  return String(value).replaceAll('"', '""');
}

function normalized(value) {
  return String(value || "").trim().replaceAll("\\", "/").toLowerCase();
}

function guardLauncherWrite(env = process.env) {
  if (env.CODEX_ROUTER_TEST_SKIP_SERVICE_WRITES === "1") {
    throw new Error("Refusing to write Task Manager service artifacts while the test write guard is enabled.");
  }
  assertServiceWriteIsolated(STATE_DIR, {
    env,
    redirected: Boolean(env.MODEL_ROUTER_STATE_DIR || env.CODEX_ROUTER_STATE_DIR),
    label: "Task Manager service launchers",
    override: "MODEL_ROUTER_STATE_DIR",
  });
}

function managerMutationSkipped(env = process.env) {
  if (env.CODEX_ROUTER_TEST_SKIP_SERVICE_WRITES === "1") {
    throw new Error("Refusing to write Task Manager service artifacts while the test write guard is enabled.");
  }
  return skipServiceManagerCall({ hostManaged: HOST_MANAGED, env });
}

export function renderTaskManagerWrapper({
  sourceRoot = SOURCE_ROOT,
  stateDir = STATE_DIR,
  controlPort = TASK_MANAGER_CONTROL_PORT,
  logPath = stateDir === STATE_DIR
    ? TASK_MANAGER_LOG_PATH
    : path.join(stateDir, "task-manager.log"),
  target = TARGET,
  nodePath = process.execPath,
} = {}) {
  const host = path.join(sourceRoot, "src", "task-manager-host.mjs");
  const variables = {
    MODEL_ROUTER_TARGET: target,
    MODEL_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_CONTROL_PORT: String(controlPort),
    CODEX_ROUTER_SOURCE_ROOT: sourceRoot,
    CODEX_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_CONTROL_PORT: String(controlPort),
  };
  return [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    ...Object.entries(variables).map(
      ([name, value]) => `set "${name}=${cmdEscape(value)}"`,
    ),
    `"${cmdEscape(nodePath)}" "${cmdEscape(host)}" >> "${cmdEscape(logPath)}" 2>&1`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
}

export function renderTaskManagerLauncher({ stateDir = STATE_DIR } = {}) {
  const wrapperPath = wrapperPathFor(stateDir);
  return [
    "Option Explicit",
    "",
    "Dim quote, shell, status",
    "quote = Chr(34)",
    'Set shell = CreateObject("WScript.Shell")',
    "On Error Resume Next",
    `status = shell.Run("cmd.exe /D /C " & quote & quote & "${vbsEscape(wrapperPath)}" & quote & quote, 0, True)`,
    "If Err.Number <> 0 Then",
    "  WScript.Quit 1",
    "End If",
    "On Error Goto 0",
    "WScript.Quit status",
    "",
  ].join("\r\n");
}

export function taskAction({ stateDir = STATE_DIR } = {}) {
  return {
    execute: "wscript.exe",
    argument: `//B //NoLogo "${launcherPathFor(stateDir)}"`,
  };
}

export function taskRegistrationScript() {
  const taskName = TASK_MANAGER_TASK_NAME.replaceAll("'", "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    "$action = New-ScheduledTaskAction -Execute $env:CODEX_ROUTER_TASK_EXECUTE -Argument $env:CODEX_ROUTER_TASK_ARGUMENT",
    "$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)",
    "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew",
    "$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited",
    `Register-ScheduledTask -TaskName '${taskName}' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null`,
  ].join("; ");
}

function writeLaunchers() {
  guardLauncherWrite();
  writePrivateFile(wrapperPathFor(), renderTaskManagerWrapper());
  writePrivateFile(
    launcherPathFor(),
    Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(renderTaskManagerLauncher(), "utf16le"),
    ]),
  );
}

function removeLaunchers() {
  guardLauncherWrite();
  for (const target of [wrapperPathFor(), launcherPathFor()]) {
    try {
      unlinkSync(target);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function powershell(script, options = {}) {
  let lastError;
  const timeoutMs = Number.isFinite(options.timeout) && options.timeout > 0
    ? options.timeout
    : undefined;
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  for (const executable of ["powershell.exe", "pwsh.exe"]) {
    if (deadline !== undefined && Date.now() >= deadline) break;
    try {
      return execFileSync(
        executable,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          ...options,
          ...(deadline === undefined
            ? {}
            : { timeout: Math.max(1, deadline - Date.now()) }),
        },
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("PowerShell is unavailable.");
}

function taskQueryScript() {
  const taskName = TASK_MANAGER_TASK_NAME.replaceAll("'", "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    `$task = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq '${taskName}' -and $_.TaskPath -eq '\\' })`,
    "if ($task.Count -eq 0) { [Console]::Out.Write('{\"exists\":false}'); exit 0 }",
    "if ($task.Count -ne 1) { throw 'Task name is ambiguous.' }",
    "$actions = @($task[0].Actions)",
    "$action = if ($actions.Count -gt 0) { $actions[0] } else { $null }",
    "$payload = [ordered]@{ exists = $true; state = $task[0].State.ToString(); actionCount = $actions.Count; action = [ordered]@{ execute = [string]$action.Execute; argument = [string]$action.Arguments } }",
    "[Console]::Out.Write(($payload | ConvertTo-Json -Compress -Depth 3))",
  ].join("; ");
}

export async function queryScheduledTask({ runPowerShell = powershell } = {}) {
  try {
    const output = runPowerShell(taskQueryScript(), {
      timeout: TASK_SCHEDULER_QUERY_TIMEOUT_MS,
    }).trim();
    const task = JSON.parse(output);
    if (task?.exists === false) return { known: true, exists: false };
    if (
      task?.exists !== true
      || typeof task.state !== "string"
      || !task.action
      || typeof task.action.execute !== "string"
      || typeof task.action.argument !== "string"
      || !Number.isSafeInteger(task.actionCount)
    ) {
      return { known: false };
    }
    return {
      known: true,
      exists: true,
      state: task.state.toLowerCase(),
      actionCount: task.actionCount,
      action: task.action,
    };
  } catch {
    return { known: false };
  }
}

export function taskActionIsCanonical(task, { stateDir = STATE_DIR } = {}) {
  if (!task?.exists || !task.action) return false;
  if (task.actionCount !== undefined && task.actionCount !== 1) return false;
  const expected = taskAction({ stateDir });
  return normalized(task.action.execute) === normalized(expected.execute)
    && normalized(task.action.argument) === normalized(expected.argument);
}

function assertTaskReadable(task) {
  if (!task?.known) {
    throw new Error(
      `Task Scheduler could not identify "${TASK_MANAGER_TASK_NAME}"; refusing a destructive service operation.`,
    );
  }
}

function assertTaskCanonical(task, options) {
  assertTaskReadable(task);
  if (task.exists && !taskActionIsCanonical(task, options)) {
    throw new Error(
      `Refusing to replace the unrecognized Scheduled Task "${TASK_MANAGER_TASK_NAME}".`,
    );
  }
}

function registerScheduledTask() {
  if (managerMutationSkipped()) return;
  const action = taskAction();
  powershell(taskRegistrationScript(), {
    env: {
      ...process.env,
      CODEX_ROUTER_TASK_EXECUTE: action.execute,
      CODEX_ROUTER_TASK_ARGUMENT: action.argument,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
}

function schtasks(args, { ignoreFailure = false } = {}) {
  if (managerMutationSkipped()) return;
  try {
    execFileSync("schtasks.exe", args, {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    if (!ignoreFailure) throw error;
  }
}

function startScheduledTask() {
  schtasks(["/Run", "/TN", TASK_MANAGER_TASK_NAME]);
}

function endScheduledTask() {
  schtasks(["/End", "/TN", TASK_MANAGER_TASK_NAME], { ignoreFailure: true });
}

function deleteScheduledTask() {
  schtasks(["/Delete", "/TN", TASK_MANAGER_TASK_NAME, "/F"]);
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function killManagerProcess(pid) {
  execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 5_000,
  });
}

export function stopOwnedManagerProcess({
  skipMutation = managerMutationSkipped,
  readProcessState = readTaskManagerProcessState,
  processEvidence = taskManagerProcessEvidence,
  processStateMatches = taskManagerProcessStateMatches,
  killProcess = killManagerProcess,
  clearProcessState = clearTaskManagerProcessState,
  now = Date.now,
  sleep: wait = sleep,
  timeoutMs = PROCESS_STOP_TIMEOUT_MS,
  pollMs = PROCESS_STOP_POLL_MS,
} = {}) {
  if (skipMutation()) return { skipped: true };
  const recorded = readProcessState();
  if (!recorded) return { state: "gone", cleared: false };

  const clearUnchanged = (state) => {
    if (!processStateMatches(readProcessState(), recorded)) {
      throw new Error("The Task Manager process record changed while stopping; refusing to clear it.");
    }
    clearProcessState();
    return { state, cleared: true };
  };
  const evidenceOptions = { platform: effectivePlatform };
  const initial = processEvidence(recorded, evidenceOptions);
  if (initial === "gone" || initial === "replaced") {
    return clearUnchanged(initial);
  }
  if (initial !== "owned") {
    throw new Error("The Task Manager process identity is unknown; refusing to stop or clear it.");
  }
  if (recorded.pid === process.pid) {
    throw new Error("The Task Manager process record names the current service CLI process; refusing to self-kill.");
  }

  let killFailed = false;
  try {
    killProcess(recorded.pid);
  } catch {
    killFailed = true;
  }

  const interval = Number.isFinite(pollMs) && pollMs > 0
    ? pollMs
    : PROCESS_STOP_POLL_MS;
  const budget = Number.isFinite(timeoutMs) && timeoutMs >= 0
    ? timeoutMs
    : PROCESS_STOP_TIMEOUT_MS;
  const deadline = now() + budget;
  let lastEvidence = "unknown";
  while (true) {
    const current = readProcessState();
    if (!processStateMatches(current, recorded)) {
      throw new Error("The Task Manager process record changed while stopping; refusing to clear it.");
    }
    lastEvidence = processEvidence(current, evidenceOptions);
    if (lastEvidence === "gone" || lastEvidence === "replaced") {
      return clearUnchanged(lastEvidence);
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    wait(Math.min(interval, remaining));
  }
  throw new Error(
    `Task Manager process stop could not confirm it stopped (${lastEvidence}${killFailed ? ", taskkill failed" : ""}); preserving its process record.`,
  );
}

async function readManagerHealth({
  controlPort = TASK_MANAGER_CONTROL_PORT,
  fetchImpl = globalThis.fetch,
} = {}) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${controlPort}/health`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body = await response.json();
    return body && typeof body === "object" ? body : undefined;
  } catch {
    return undefined;
  }
}

export async function taskManagerServiceStatus({
  stateDir = STATE_DIR,
  sourceRoot = SOURCE_ROOT,
  platform = effectivePlatform,
  queryTask = queryScheduledTask,
  readProcessState = readTaskManagerProcessState,
  processOwns = taskManagerProcessOwns,
  readHealth = readManagerHealth,
} = {}) {
  let task;
  try {
    task = await queryTask();
  } catch {
    task = { known: false };
  }
  const known = task?.known === true;
  const installed = known ? task.exists === true : null;
  const schedulerState = installed
    ? String(task.state || "unknown").toLowerCase()
    : installed === false
      ? "stopped"
      : "unknown";
  const canonical = known
    ? taskActionIsCanonical(task, { stateDir })
    : null;
  const loaded = known ? installed && schedulerState === "running" : null;

  const processState = readProcessState(processStatePathFor(stateDir));
  const owned = Boolean(
    processState
    && processOwns(processState, { platform, sourceRoot, stateDir }),
  );
  const pid = owned ? processState.pid : null;
  const health = await readHealth();
  const healthy = Boolean(
    owned
    && health?.ok === true
    && health.service === "codex-router-task-manager"
    && health.mode === "standalone"
    && health.pid === pid,
  );

  return {
    installed,
    loaded,
    state: schedulerState,
    canonical,
    healthy,
    pid,
  };
}

export async function runTaskManagerWindowsCommand(
  command,
  {
    stateDir = STATE_DIR,
    queryTask = queryScheduledTask,
    writeLaunchers: write = writeLaunchers,
    registerTask: register = registerScheduledTask,
    startTask: start = startScheduledTask,
    endTask: end = endScheduledTask,
    deleteTask: removeTask = deleteScheduledTask,
    stopOwnedProcess = stopOwnedManagerProcess,
    removeLaunchers: removeFiles = removeLaunchers,
    readStatus = taskManagerServiceStatus,
  } = {},
) {
  if (!MUTATING_COMMANDS.has(command)) {
    throw new Error(`Unknown Task Manager service command: ${command}`);
  }
  if (process.env.CODEX_ROUTER_TEST_SKIP_SERVICE_WRITES === "1") {
    guardLauncherWrite();
  }

  const task = await queryTask();
  assertTaskCanonical(task, { stateDir });

  if (command === "install") {
    if (task.exists) await end();
    await stopOwnedProcess();
    await write();
    await register();
    await start();
  } else if (command === "uninstall") {
    if (task.exists) await end();
    await stopOwnedProcess();
    if (task.exists) await removeTask();
    await removeFiles();
  } else if (command === "start") {
    if (!task.exists) {
      throw new Error(`Scheduled Task "${TASK_MANAGER_TASK_NAME}" is not installed.`);
    }
    await start();
  } else if (command === "stop") {
    if (task.exists) await end();
    await stopOwnedProcess();
  } else if (command === "restart") {
    if (!task.exists) {
      throw new Error(`Scheduled Task "${TASK_MANAGER_TASK_NAME}" is not installed.`);
    }
    await end();
    await stopOwnedProcess();
    await start();
  }

  return readStatus({ stateDir });
}

function isMain() {
  return Boolean(
    process.argv[1]
    && normalized(path.resolve(process.argv[1])) === normalized(fileURLToPath(import.meta.url)),
  );
}

async function main() {
  const command = process.argv[2] || "status";
  if (!COMMANDS.has(command)) {
    console.error(
      "Usage: task-manager-service-windows.mjs install|uninstall|start|stop|restart|status|render-wrapper|render-launcher|render-task",
    );
    return 2;
  }
  if (effectivePlatform !== "win32" && !RENDER_COMMANDS.has(command)) {
    throw new Error("The Task Manager Task Scheduler service runs on Windows only.");
  }
  if (command === "render-wrapper") {
    process.stdout.write(renderTaskManagerWrapper());
    return 0;
  }
  if (command === "render-launcher") {
    process.stdout.write(renderTaskManagerLauncher());
    return 0;
  }
  if (command === "render-task") {
    process.stdout.write(`${JSON.stringify({
      action: taskAction(),
      registration: taskRegistrationScript(),
    })}\n`);
    return 0;
  }
  const status = command === "status"
    ? await taskManagerServiceStatus()
    : await runTaskManagerWindowsCommand(command);
  process.stdout.write(`${JSON.stringify(status)}\n`);
  return 0;
}

if (isMain()) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
