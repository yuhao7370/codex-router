import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  purgeTaskManagerCreatedServiceComponents,
  queryScheduledTask,
  runTaskManagerWindowsCommand,
  stopOwnedManagerProcess,
  taskManagerServiceStatus,
  taskAction,
  taskActionIsCanonical,
} from "../src/task-manager-service-windows.mjs";

const root = path.resolve(".");
const serviceScript = path.join(root, "src", "task-manager-service-windows.mjs");
const dispatcherScript = path.join(root, "src", "task-manager-service.mjs");

function canonicalTask(action, overrides = {}) {
  const currentUser = "EXAMPLE\\operator";
  return {
    known: true,
    exists: true,
    state: "running",
    actionCount: 1,
    action,
    currentUser,
    computerName: "EXAMPLE",
    principal: { userId: currentUser, logonType: "interactive", runLevel: "limited" },
    triggerCount: 1,
    trigger: { type: "MSFT_TaskLogonTrigger", userId: currentUser, enabled: true },
    settings: {
      restartCount: 999,
      restartInterval: "PT1M",
      executionTimeLimit: "PT0S",
      disallowStartIfOnBatteries: false,
      stopIfGoingOnBatteries: false,
      multipleInstances: "ignorenew",
    },
    ...overrides,
  };
}

function run(command, stateDir, extraEnv = {}) {
  return spawnSync(process.execPath, [serviceScript, command], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_ROUTER_SERVICE_PLATFORM: "win32",
      CODEX_ROUTER_SOURCE_ROOT: root,
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_CONTROL_PORT: "43111",
      ...extraEnv,
    },
  });
}

test("renders a hidden restartable current-user Task Manager task", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-manager-render-"));
  try {
    const wrapperResult = run("render-wrapper", stateDir);
    const launcherResult = run("render-launcher", stateDir);
    const taskResult = run("render-task", stateDir);
    assert.equal(wrapperResult.status, 0, wrapperResult.stderr);
    assert.equal(launcherResult.status, 0, launcherResult.stderr);
    assert.equal(taskResult.status, 0, taskResult.stderr);

    const wrapper = wrapperResult.stdout;
    const launcher = launcherResult.stdout;
    const task = JSON.parse(taskResult.stdout);
    const expectedLauncher = path.join(
      stateDir,
      "start-codex-router-task-manager-hidden.vbs",
    );

    assert.match(wrapper, /task-manager-host\.mjs/);
    assert.match(wrapper, /task-manager\.log/);
    assert.match(wrapper, /MODEL_ROUTER_CONTROL_PORT=43111/);
    assert.doesNotMatch(wrapper, /caller.secret|caller-secret|capability/i);
    assert.match(launcher, /shell\.Run\([\s\S]*, 0, True\)/);
    assert.match(launcher, /WScript\.Quit status/);
    assert.deepEqual(task.action, {
      execute: "wscript.exe",
      argument: `//B //NoLogo "${expectedLauncher}"`,
    });
    assert.match(task.registration, /AtLogOn/);
    assert.match(task.registration, /RestartCount 999/);
    assert.match(task.registration, /RestartInterval \(New-TimeSpan -Minutes 1\)/);
    assert.match(task.registration, /MultipleInstances IgnoreNew/);
    assert.match(task.registration, /RunLevel Limited/);
    assert.match(task.registration, /Codex Router Task Manager/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("an explicit test write guard refuses install before creating launchers", () => {
  const testHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-manager-guard-"));
  const expectedLauncher = path.join(
    testHome,
    "codex-router",
    "start-codex-router-task-manager-hidden.vbs",
  );
  try {
    const result = run("install", "", {
      CODEX_HOME: testHome,
      MODEL_ROUTER_STATE_DIR: "",
      CODEX_ROUTER_STATE_DIR: "",
      CODEX_ROUTER_TEST_SKIP_SERVICE_WRITES: "1",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to write/i);
    assert.equal(existsSync(expectedLauncher), false);
  } finally {
    rmSync(testHome, { recursive: true, force: true });
  }
});

test("install refuses an unrecognized same-name task before any mutation", async () => {
  const calls = [];
  await assert.rejects(
    runTaskManagerWindowsCommand("install", {
      queryTask: async () => ({
        known: true,
        exists: true,
        state: "ready",
        action: { execute: "cmd.exe", argument: "/c something-else.cmd" },
      }),
      writeLaunchers: () => calls.push("write"),
      registerTask: () => calls.push("register"),
      startTask: () => calls.push("start"),
    }),
    /unrecognized.*Codex Router Task Manager/i,
  );
  assert.deepEqual(calls, []);
});

test("a scheduler query failure refuses mutation before any write or command", async () => {
  const calls = [];
  await assert.rejects(
    runTaskManagerWindowsCommand("install", {
      queryTask: async () => ({ known: false }),
      writeLaunchers: () => calls.push("write"),
      registerTask: () => calls.push("register"),
      startTask: () => calls.push("start"),
      stopOwnedProcess: () => calls.push("stop-process"),
    }),
    /could not identify.*refusing/i,
  );
  assert.deepEqual(calls, []);
});

test("scheduler query uses a bounded UTF-8 PowerShell boundary", async () => {
  let invocation;
  const result = await queryScheduledTask({
    runPowerShell: (script, options) => {
      invocation = { script, options };
      return '{"exists":false}';
    },
  });
  assert.deepEqual(result, { known: true, exists: false });
  assert.equal(invocation.options.timeout, 15_000);
  assert.match(
    invocation.script,
    /\[Console\]::OutputEncoding = \[Text\.Encoding\]::UTF8/,
  );
  assert.match(invocation.script, /\[Environment\]::MachineName/);
});

test("scheduler query timeout stays unknown", async () => {
  assert.deepEqual(
    await queryScheduledTask({
      runPowerShell: () => {
        throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
      },
    }),
    { known: false },
  );
});

test("scheduler query preserves the local computer identity proof", async () => {
  const task = canonicalTask(taskAction({ stateDir: "C:/state" }));
  const result = await queryScheduledTask({
    runPowerShell: () => JSON.stringify(task),
  });
  assert.equal(result.computerName, "EXAMPLE");
});

test("status keeps a scheduler query failure unknown", async () => {
  const status = await taskManagerServiceStatus({
    queryTask: async () => ({ known: false }),
    readProcessState: () => undefined,
    readHealth: async () => undefined,
    readPortOwner: async () => ({ known: false, pid: null }),
  });
  assert.deepEqual(status, {
    installed: null,
    loaded: null,
    state: "unknown",
    canonical: null,
    healthy: false,
    pid: null,
    listener: "unknown",
  });
});

test("status requires canonical task, owned process, and exact health identity", async () => {
  const processState = { pid: 42 };
  const expectedAction = {
    execute: "wscript.exe",
    argument: `//B //NoLogo "${path.join("C:/state", "start-codex-router-task-manager-hidden.vbs")}"`,
  };
  const status = await taskManagerServiceStatus({
    stateDir: "C:/state",
    queryTask: async () => canonicalTask(expectedAction),
    readProcessState: () => processState,
    processOwns: (state) => state === processState,
    readPortOwner: async () => ({ known: true, pid: 42 }),
    readHealth: async () => ({
      ok: true,
      service: "codex-router-task-manager",
      mode: "standalone",
      pid: 42,
    }),
  });
  assert.deepEqual(status, {
    installed: true,
    loaded: true,
    state: "running",
    canonical: true,
    healthy: true,
    pid: 42,
    listener: "owned",
  });

  const wrongIdentity = await taskManagerServiceStatus({
    stateDir: "C:/state",
    queryTask: async () => canonicalTask(expectedAction),
    readProcessState: () => processState,
    processOwns: () => true,
    readPortOwner: async () => ({ known: true, pid: 42 }),
    readHealth: async () => ({
      ok: true,
      service: "codex-router-task-manager",
      mode: "standalone",
      pid: 99,
    }),
  });
  assert.equal(wrongIdentity.healthy, false);
  assert.equal(wrongIdentity.pid, 42);
});

test("task canonicality covers principal, login trigger, recovery, power, and instance policy", () => {
  const action = taskAction({ stateDir: "C:/state" });
  const task = canonicalTask(action);
  assert.equal(taskActionIsCanonical(task, { stateDir: "C:/state" }), true);

  const drifts = [
    { principal: { ...task.principal, userId: "EXAMPLE\\other" } },
    { principal: { ...task.principal, logonType: "password" } },
    { principal: { ...task.principal, runLevel: "highest" } },
    { trigger: { ...task.trigger, type: "time" } },
    { trigger: { ...task.trigger, userId: "EXAMPLE\\other" } },
    { settings: { ...task.settings, restartCount: 3 } },
    { settings: { ...task.settings, restartInterval: "PT5M" } },
    { settings: { ...task.settings, executionTimeLimit: "PT72H" } },
    { settings: { ...task.settings, disallowStartIfOnBatteries: true } },
    { settings: { ...task.settings, stopIfGoingOnBatteries: true } },
    { settings: { ...task.settings, multipleInstances: "parallel" } },
  ];
  for (const drift of drifts) {
    assert.equal(taskActionIsCanonical({ ...task, ...drift }, { stateDir: "C:/state" }), false);
  }
});

test("task canonicality accepts bare identities only for the current local account", () => {
  const stateDir = "C:/state";
  const action = taskAction({ stateDir });
  const localTask = canonicalTask(action, {
    currentUser: "GAME\\yuhaofeng",
    computerName: "GAME",
    principal: { userId: "yuhaofeng", logonType: "interactive", runLevel: "limited" },
    trigger: { type: "MSFT_TaskLogonTrigger", userId: "GAME\\yuhaofeng", enabled: true },
  });
  assert.equal(taskActionIsCanonical(localTask, { stateDir }), true);
  assert.equal(taskActionIsCanonical({
    ...localTask,
    principal: { ...localTask.principal, userId: "GAME\\yuhaofeng" },
    trigger: { ...localTask.trigger, userId: "yuhaofeng" },
  }, { stateDir }), true);

  const rejected = [
    { principal: { ...localTask.principal, userId: "other" } },
    { principal: { ...localTask.principal, userId: "OTHER\\yuhaofeng" } },
    {
      currentUser: "CORP\\yuhaofeng",
      principal: { ...localTask.principal, userId: "yuhaofeng" },
      trigger: { ...localTask.trigger, userId: "CORP\\yuhaofeng" },
    },
    { principal: { ...localTask.principal, userId: "" } },
    { principal: { ...localTask.principal, userId: "GAME\\yuhaofeng\\extra" } },
    { principal: { ...localTask.principal, userId: "\\yuhaofeng" } },
    { trigger: { ...localTask.trigger, userId: "GAME\\" } },
    { currentUser: "yuhaofeng" },
    { computerName: "" },
  ];
  for (const overrides of rejected) {
    assert.equal(taskActionIsCanonical({ ...localTask, ...overrides }, { stateDir }), false);
  }
});

test("status rejects health whose PID does not own the bound control port", async () => {
  const processState = { pid: 42 };
  const status = await taskManagerServiceStatus({
    stateDir: "C:/state",
    queryTask: async () => canonicalTask(taskAction({ stateDir: "C:/state" })),
    readProcessState: () => processState,
    processOwns: () => true,
    readPortOwner: async () => ({ known: true, pid: 99 }),
    readHealth: async () => ({
      ok: true,
      service: "codex-router-task-manager",
      mode: "standalone",
      pid: 42,
    }),
  });
  assert.equal(status.healthy, false);
  assert.equal(status.listener, "foreign");
});

test("status cannot be healthy when the live task definition is noncanonical", async () => {
  const processState = { pid: 42 };
  const expected = canonicalTask(taskAction({ stateDir: "C:/state" }));
  const status = await taskManagerServiceStatus({
    stateDir: "C:/state",
    queryTask: async () => ({
      ...expected,
      settings: { ...expected.settings, restartCount: 1 },
    }),
    readProcessState: () => processState,
    processOwns: () => true,
    readPortOwner: async () => ({ known: true, pid: 42 }),
    readHealth: async () => ({
      ok: true,
      service: "codex-router-task-manager",
      mode: "standalone",
      pid: 42,
    }),
  });
  assert.equal(status.canonical, false);
  assert.equal(status.healthy, false);
});

test("component purge stops exact ownership and removes only created service artifacts", async () => {
  const calls = [];
  await purgeTaskManagerCreatedServiceComponents(
    { task: false, wrapper: false, launcher: true },
    {
      stateDir: "C:/state",
      queryTask: async () => canonicalTask(taskAction({ stateDir: "C:/state" })),
      endTask: async () => calls.push("end"),
      stopOwnedProcess: async () => calls.push("stop-owned"),
      deleteTask: async () => calls.push("delete-task"),
      removeArtifact: (target) => calls.push(path.basename(target)),
      readArtifact: () => ({ known: true, present: true }),
      guardWrite: () => {},
    },
  );
  assert.deepEqual(calls, [
    "end",
    "stop-owned",
    "start-codex-router-task-manager-hidden.vbs",
  ]);
});

test("the platform dispatcher reports unsupported status without mutating non-Windows hosts", () => {
  const result = spawnSync(process.execPath, [dispatcherScript, "status"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CODEX_ROUTER_SERVICE_PLATFORM: "linux" },
  });
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.supported, false);
  assert.equal(status.state, "unsupported");
});

const recordedProcess = Object.freeze({
  version: 1,
  managed: true,
  pid: 42,
  processIdentity: "ticks|node.exe",
  commandLine: 'node.exe "C:/router/src/task-manager-host.mjs"',
  sourceRoot: "C:/router",
  stateDir: "C:/state",
  startedAt: 1_000,
});

function stopOptions(overrides = {}) {
  let now = 0;
  return {
    skipMutation: () => false,
    readProcessState: () => recordedProcess,
    processEvidence: () => "owned",
    killProcess: () => {},
    clearProcessState: () => {},
    now: () => now,
    sleep: (milliseconds) => { now += milliseconds; },
    timeoutMs: 3,
    pollMs: 1,
    ...overrides,
  };
}

test("stale gone and PID-reused records clear without killing a process", () => {
  for (const evidence of ["gone", "replaced"]) {
    let killed = false;
    let cleared = false;
    stopOwnedManagerProcess(stopOptions({
      processEvidence: () => evidence,
      killProcess: () => { killed = true; },
      clearProcessState: () => { cleared = true; },
    }));
    assert.equal(killed, false, evidence);
    assert.equal(cleared, true, evidence);
  }
});

test("a stale record reused by the current service CLI PID still clears on replaced evidence", () => {
  const selfRecord = { ...recordedProcess, pid: process.pid };
  let evidenceCalls = 0;
  let killed = false;
  let cleared = false;
  stopOwnedManagerProcess(stopOptions({
    readProcessState: () => selfRecord,
    processEvidence: () => {
      evidenceCalls += 1;
      return "replaced";
    },
    killProcess: () => { killed = true; },
    clearProcessState: () => { cleared = true; },
  }));
  assert.equal(evidenceCalls, 1);
  assert.equal(killed, false);
  assert.equal(cleared, true);
});

test("an owned current service CLI PID is refused instead of self-killed", () => {
  const selfRecord = { ...recordedProcess, pid: process.pid };
  let killed = false;
  let cleared = false;
  assert.throws(
    () => stopOwnedManagerProcess(stopOptions({
      readProcessState: () => selfRecord,
      processEvidence: () => "owned",
      killProcess: () => { killed = true; },
      clearProcessState: () => { cleared = true; },
    })),
    /current service CLI process/i,
  );
  assert.equal(killed, false);
  assert.equal(cleared, false);
});

test("failed taskkill preserves a still-owned record after a bounded wait", () => {
  let cleared = false;
  assert.throws(
    () => stopOwnedManagerProcess(stopOptions({
      killProcess: () => { throw new Error("access denied"); },
      clearProcessState: () => { cleared = true; },
    })),
    /could not confirm.*stopped/i,
  );
  assert.equal(cleared, false);
});

test("a transient unknown re-probe waits for positive gone evidence before clearing", () => {
  const evidence = ["owned", "unknown", "gone"];
  const events = [];
  let now = 0;
  stopOwnedManagerProcess(stopOptions({
    processEvidence: () => evidence.shift(),
    killProcess: () => events.push("kill"),
    clearProcessState: () => events.push("clear"),
    sleep: (milliseconds) => {
      events.push("sleep");
      now += milliseconds;
    },
    now: () => now,
  }));
  assert.deepEqual(events, ["kill", "sleep", "clear"]);
});

test("a replacement process record is preserved after taskkill", () => {
  const replacement = { ...recordedProcess, processIdentity: "new-ticks|node.exe" };
  let current = recordedProcess;
  let cleared = false;
  assert.throws(
    () => stopOwnedManagerProcess(stopOptions({
      readProcessState: () => current,
      killProcess: () => { current = replacement; },
      clearProcessState: () => { cleared = true; },
    })),
    /process record changed/i,
  );
  assert.equal(current, replacement);
  assert.equal(cleared, false);
});

test("a process record differing only by startedAt is preserved after taskkill", () => {
  const replacement = { ...recordedProcess, startedAt: recordedProcess.startedAt + 1 };
  const evidence = ["owned", "gone"];
  let current = recordedProcess;
  let cleared = false;
  assert.throws(
    () => stopOwnedManagerProcess(stopOptions({
      readProcessState: () => current,
      processEvidence: () => evidence.shift(),
      killProcess: () => { current = replacement; },
      clearProcessState: () => { cleared = true; },
    })),
    /process record changed/i,
  );
  assert.equal(current, replacement);
  assert.equal(cleared, false);
});
