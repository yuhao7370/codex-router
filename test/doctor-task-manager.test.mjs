import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { taskManagerDoctorRows } from "../src/task-manager-doctor.mjs";

const callerKey = "TEST_DOCTOR_CALLER_CAPABILITY_MUST_NOT_APPEAR";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function healthyFixture(overrides = {}) {
  const present = { known: true, present: true };
  return {
    platform: "win32",
    markerState: { known: true, exists: true, enabled: true, state: "enabled" },
    service: {
      installed: true,
      loaded: true,
      state: "running",
      canonical: true,
      healthy: true,
      pid: 4111,
      listener: "owned",
    },
    health: {
      ok: true,
      service: "codex-router-task-manager",
      mode: "standalone",
      pid: 4111,
    },
    components: {
      task: present,
      wrapper: present,
      launcher: present,
      shortcut: present,
      process: present,
    },
    privateState: { caller: true, marker: true, process: true, config: true },
    routerMode: "standalone",
    ...overrides,
  };
}

function assertRow(rows, label, status) {
  const row = rows.find((entry) => entry.label === label);
  assert.ok(row, `missing doctor row: ${label}`);
  assert.equal(row.status, status);
  return row;
}

function assertSafeFailure(rows, label, remedy) {
  const row = assertRow(rows, label, "fail");
  assert.equal(row.remedy, remedy);
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(callerKey));
}

test("standalone Task Manager reports four healthy doctor rows", () => {
  const rows = taskManagerDoctorRows(healthyFixture());
  assert.equal(rows.length, 4);
  assertRow(rows, "Task Manager service", "ok");
  assertRow(rows, "Task Manager health", "ok");
  assertRow(rows, "Task Manager privacy", "ok");
  assertRow(rows, "Task Manager topology", "ok");
});

test("non-Windows and a missing marker with proven-absent components add no rows", () => {
  const absent = { known: true, present: false };
  assert.deepEqual(taskManagerDoctorRows(healthyFixture({ platform: "linux" })), []);
  assert.deepEqual(taskManagerDoctorRows(healthyFixture({
    markerState: { known: true, exists: false, enabled: false, state: "missing" },
    service: {
      installed: false,
      loaded: false,
      state: "stopped",
      canonical: false,
      healthy: false,
      pid: null,
      listener: "absent",
    },
    components: {
      task: absent,
      wrapper: absent,
      launcher: absent,
      shortcut: absent,
      process: absent,
    },
  })), []);
});

test("missing, malformed, and disabled markers fail closed for every manager component", () => {
  const absent = { known: true, present: false };
  const present = { known: true, present: true };
  const emptyComponents = {
    task: absent,
    wrapper: absent,
    launcher: absent,
    shortcut: absent,
    process: absent,
  };
  const evidence = [
    ["installed", { service: { ...healthyFixture().service, installed: true, loaded: false, state: "ready", healthy: false, pid: null } }],
    ["running", { service: { ...healthyFixture().service, installed: true, loaded: true, state: "running" } }],
    ...["task", "wrapper", "launcher", "shortcut", "process"].map((name) => [
      name,
      { service: { installed: false, loaded: false, state: "stopped", canonical: false, healthy: false, pid: null, listener: "absent" }, components: { ...emptyComponents, [name]: present } },
    ]),
  ];
  for (const state of ["missing", "malformed", "disabled"]) {
    const markerState = state === "missing"
      ? { known: true, exists: false, enabled: false, state }
      : state === "disabled"
        ? { known: true, exists: true, enabled: false, state }
        : { known: false, exists: true, enabled: false, state };
    for (const [name, overrides] of evidence) {
      const rows = taskManagerDoctorRows(healthyFixture({
        markerState,
        components: emptyComponents,
        ...overrides,
      }));
      assertRow(rows, "Task Manager service", "fail");
      assertRow(rows, "Task Manager privacy", "fail");
      assertRow(rows, "Task Manager topology", "fail");
      assert.doesNotMatch(JSON.stringify(rows), /4111|C:\\|_codex-router|sentinel/i, `${state}/${name}`);
    }
  }
});

test("an enabled marker with a missing or unknown task fails closed", () => {
  for (const service of [
    { installed: false, loaded: false, state: "stopped", canonical: true, healthy: false, pid: null },
    { installed: null, loaded: null, state: "unknown", canonical: null, healthy: false, pid: null },
  ]) {
    assertSafeFailure(
      taskManagerDoctorRows(healthyFixture({ service })),
      "Task Manager service",
      "task-manager service install",
    );
  }
});

test("a contradictory non-running task state fails closed", () => {
  assertSafeFailure(
    taskManagerDoctorRows(healthyFixture({
      service: { ...healthyFixture().service, state: "ready" },
    })),
    "Task Manager service",
    "task-manager service install",
  );
});

test("a running manager with embedded Router topology fails", () => {
  assertSafeFailure(
    taskManagerDoctorRows(healthyFixture({
      routerMode: `embedded-${callerKey}`,
    })),
    "Task Manager topology",
    "task-manager service install",
  );
});

test("manager health must match the recognized process identity", () => {
  assertSafeFailure(
    taskManagerDoctorRows(healthyFixture({
      health: {
        ok: true,
        service: "codex-router-task-manager",
        mode: "standalone",
        pid: 9999,
        callerKey,
      },
    })),
    "Task Manager health",
    "task-manager service install",
  );
});

test("a foreign control-port listener fails both service and topology rows", () => {
  const rows = taskManagerDoctorRows(healthyFixture({
    service: { ...healthyFixture().service, listener: "foreign", healthy: false },
  }));
  assertRow(rows, "Task Manager service", "fail");
  assertRow(rows, "Task Manager topology", "fail");
});

test("every private Task Manager state file including token configuration must be protected", () => {
  for (const field of ["caller", "marker", "process", "config"]) {
    assertSafeFailure(
      taskManagerDoctorRows(healthyFixture({
        privateState: { caller: true, marker: true, process: true, config: true, [field]: false, callerKey },
      })),
      "Task Manager privacy",
      "doctor --fix",
    );
  }
});

test("doctor reads standalone topology only through protected control health", () => {
  const source = readFileSync(path.join(root, "src", "doctor.mjs"), "utf8");
  assert.match(source, /import \{ readControlHealth \} from "\.\/control-health\.mjs"/);
  assert.match(source, /await readControlHealth\(\)/);
  assert.match(source, /routerMode:\s*protectedHealth\.taskManagerMode/);
  assert.doesNotMatch(source, /routerMode:\s*health\.payload\?\.taskManagerMode/);
});
