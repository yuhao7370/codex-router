import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildTaskManagerProcessState,
  clearTaskManagerProcessState,
  readTaskManagerProcessState,
  taskManagerProcessOwns,
  writeTaskManagerProcessState,
} from "../src/task-manager-process.mjs";

const sourceRoot = "C:/router";
const stateDir = "C:/state";

function identity() {
  return "ticks|node.exe";
}

function commandLine() {
  return 'node.exe "C:/router/src/task-manager-host.mjs"';
}

test("manager process ownership requires this checkout and host entrypoint", () => {
  const state = buildTaskManagerProcessState({
    pid: 42,
    sourceRoot,
    stateDir,
    identity,
    commandLine,
  });
  assert.equal(
    taskManagerProcessOwns(state, {
      sourceRoot,
      stateDir,
      identity,
      commandLine,
    }),
    true,
  );
  assert.equal(
    taskManagerProcessOwns(state, {
      sourceRoot: "C:/other",
      stateDir,
      identity,
      commandLine: () => state.commandLine,
    }),
    false,
  );
  assert.equal(
    taskManagerProcessOwns(state, {
      sourceRoot,
      stateDir: "C:/other-state",
      identity,
      commandLine,
    }),
    false,
  );
  assert.equal(
    taskManagerProcessOwns(state, {
      sourceRoot,
      stateDir,
      identity: () => "other-ticks|node.exe",
      commandLine,
    }),
    false,
  );
  assert.equal(
    taskManagerProcessOwns(state, {
      sourceRoot,
      stateDir,
      identity,
      commandLine: () => 'node.exe "C:/router/src/task-manager-host.mjs.backup"',
    }),
    false,
  );
});

test("manager process state is private, readable, and removable", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-manager-state-"));
  const statePath = path.join(directory, "task-manager-process.json");
  try {
    const state = writeTaskManagerProcessState({
      pid: 42,
      sourceRoot,
      stateDir,
      identity,
      commandLine,
      statePath,
    });
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).pid, state.pid);
    assert.equal(readTaskManagerProcessState(statePath).processIdentity, identity());
    clearTaskManagerProcessState(statePath);
    assert.equal(readTaskManagerProcessState(statePath), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
