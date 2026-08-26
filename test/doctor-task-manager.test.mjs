import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { taskManagerDoctorRows } from "../src/task-manager-doctor.mjs";

const callerKey = "TEST_DOCTOR_CALLER_CAPABILITY_MUST_NOT_APPEAR";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function healthyFixture(overrides = {}) {
  return {
    platform: "win32",
    standalone: true,
    service: {
      installed: true,
      loaded: true,
      state: "running",
      canonical: true,
      healthy: true,
      pid: 4111,
    },
    health: {
      ok: true,
      service: "codex-router-task-manager",
      mode: "standalone",
      pid: 4111,
    },
    privateState: { caller: true, marker: true, process: true },
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

test("non-Windows and marker-disabled modes add no Task Manager warnings", () => {
  assert.deepEqual(taskManagerDoctorRows(healthyFixture({ platform: "linux" })), []);
  assert.deepEqual(taskManagerDoctorRows(healthyFixture({ standalone: false })), []);
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

test("every private Task Manager state file must be protected", () => {
  for (const field of ["caller", "marker", "process"]) {
    assertSafeFailure(
      taskManagerDoctorRows(healthyFixture({
        privateState: { caller: true, marker: true, process: true, [field]: false, callerKey },
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
