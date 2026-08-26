import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  runTaskManagerWindowsCommand,
  taskManagerServiceStatus,
} from "../src/task-manager-service-windows.mjs";

const root = path.resolve(".");
const serviceScript = path.join(root, "src", "task-manager-service-windows.mjs");
const dispatcherScript = path.join(root, "src", "task-manager-service.mjs");

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

test("status keeps a scheduler query failure unknown", async () => {
  const status = await taskManagerServiceStatus({
    queryTask: async () => ({ known: false }),
    readProcessState: () => undefined,
    readHealth: async () => undefined,
  });
  assert.deepEqual(status, {
    installed: null,
    loaded: null,
    state: "unknown",
    canonical: null,
    healthy: false,
    pid: null,
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
    queryTask: async () => ({
      known: true,
      exists: true,
      state: "running",
      action: expectedAction,
    }),
    readProcessState: () => processState,
    processOwns: (state) => state === processState,
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
  });

  const wrongIdentity = await taskManagerServiceStatus({
    stateDir: "C:/state",
    queryTask: async () => ({
      known: true,
      exists: true,
      state: "running",
      action: expectedAction,
    }),
    readProcessState: () => processState,
    processOwns: () => true,
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
