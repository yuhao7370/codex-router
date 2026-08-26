import assert from "node:assert/strict";
import test from "node:test";

import { runTaskManagerInstall } from "../src/task-manager-install.mjs";

function transactionDeps({
  owner = "embedded",
  previousStandalone = false,
  failAt,
  rollbackFailAt,
} = {}) {
  const calls = [];
  const routerSnapshot = { kind: "router", generation: "router-before" };
  const managerSnapshot = { kind: "manager", generation: "manager-before" };
  const step = async (name, value) => {
    calls.push(name);
    if (name === failAt || name === rollbackFailAt) throw new Error(`${name} failed`);
    return value;
  };
  return {
    calls,
    routerSnapshot,
    managerSnapshot,
    deps: {
      checkPortOwner: () => step("port-owner-check", owner),
      standaloneEnabled: () => previousStandalone,
      setStandaloneEnabled: (enabled) => {
        const name = enabled ? "marker-enable" : "marker-disable";
        calls.push(name);
        if (name === failAt || name === rollbackFailAt) throw new Error(`${name} failed`);
      },
      snapshotRouterTaskAndLaunchers: () => step("snapshot-router", routerSnapshot),
      snapshotManagerTaskLaunchersAndShortcut: () => step("snapshot-manager", managerSnapshot),
      stopRouterService: () => step("service-stop"),
      installManagerService: () => step("manager-install"),
      uninstallManagerService: () => step("manager-uninstall"),
      waitForManagerHealth: () => step("manager-health"),
      installShortcut: () => step("shortcut-install"),
      uninstallShortcut: () => step("shortcut-uninstall"),
      installRouterService: () => step("service-install"),
      waitForRouterHealth: () => step("router-health"),
      waitForEmbeddedTaskManager: () => step("embedded-health"),
      discardSnapshot: (snapshot) => step(`${snapshot.kind}-snapshot-discard`),
      restoreManagerTaskLaunchersAndShortcut: (snapshot) => {
        assert.equal(snapshot, managerSnapshot);
        return step("manager-restore");
      },
      restoreRouterTaskAndLaunchers: (snapshot) => {
        assert.equal(snapshot, routerSnapshot);
        return step("router-restore");
      },
      startRestoredRouterTask: () => step("router-start-restored"),
      readStatus: () => step("status", { installed: true }),
    },
  };
}

test("install commits in the fixed manager-before-Router order", async () => {
  const fixture = transactionDeps();
  await runTaskManagerInstall("install", fixture.deps);
  assert.deepEqual(fixture.calls, [
    "port-owner-check", "snapshot-router", "snapshot-manager", "service-stop", "manager-install", "manager-health",
    "shortcut-install", "marker-enable", "service-install", "router-health",
    "router-snapshot-discard", "manager-snapshot-discard",
  ]);
});

test("install failure restores marker, both exact generations, and a healthy Router", async () => {
  const fixture = transactionDeps({ failAt: "service-install" });
  await assert.rejects(
    runTaskManagerInstall("install", fixture.deps),
    /service-install failed/,
  );
  assert.deepEqual(fixture.calls, [
    "port-owner-check", "snapshot-router", "snapshot-manager", "service-stop", "manager-install", "manager-health",
    "shortcut-install", "marker-enable", "service-install", "marker-disable", "manager-restore", "router-restore",
    "router-start-restored", "router-health",
  ]);
});

test("rollback failure reports both the original and restoration errors", async () => {
  const fixture = transactionDeps({
    failAt: "service-install",
    rollbackFailAt: "router-restore",
  });
  await assert.rejects(
    runTaskManagerInstall("install", fixture.deps),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors.map(({ message }) => message), [
        "service-install failed",
        "router-restore failed",
      ]);
      return true;
    },
  );
});

test("an unknown port 4111 owner refuses before every snapshot or mutation", async () => {
  const fixture = transactionDeps({ owner: "unknown" });
  await assert.rejects(
    runTaskManagerInstall("install", fixture.deps),
    /unrecognized|unknown/i,
  );
  assert.deepEqual(fixture.calls, ["port-owner-check"]);
});

test("uninstall restores the embedded manager before commit and purge never restarts Router", async () => {
  const uninstall = transactionDeps({ owner: "standalone", previousStandalone: true });
  await runTaskManagerInstall("uninstall", uninstall.deps);
  assert.deepEqual(uninstall.calls, [
    "port-owner-check", "snapshot-router", "snapshot-manager", "manager-uninstall", "shortcut-uninstall",
    "marker-disable", "service-install", "embedded-health", "router-health",
    "router-snapshot-discard", "manager-snapshot-discard",
  ]);

  const purge = transactionDeps({ owner: "standalone", previousStandalone: true });
  await runTaskManagerInstall("purge", purge.deps);
  assert.deepEqual(purge.calls, [
    "port-owner-check", "manager-uninstall", "shortcut-uninstall", "marker-disable",
  ]);
});

test("status is read-only and unknown commands are rejected", async () => {
  const fixture = transactionDeps();
  assert.deepEqual(await runTaskManagerInstall("status", fixture.deps), { installed: true });
  assert.deepEqual(fixture.calls, ["status"]);
  await assert.rejects(runTaskManagerInstall("remove", fixture.deps), /install\|uninstall\|purge\|status/);
});
