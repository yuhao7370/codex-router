import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyTaskManagerPortOwner,
  embeddedTaskManagerPageContract,
  parseCreatedTaskManagerComponents,
  readProtectedTaskManagerRouterHealth,
  runTaskManagerInstall,
  taskManagerInstallStatus,
  verifyEmbeddedTaskManager,
  windowsTaskManagerPortOwner,
} from "../src/task-manager-install.mjs";

function transactionDeps({
  owner = "embedded",
  previousStandalone = false,
  failAt,
  rollbackFailAt,
  createdComponents,
} = {}) {
  const calls = [];
  const routerSnapshot = { kind: "router", generation: "router-before" };
  const managerSnapshot = { kind: "manager", generation: "manager-before" };
  const failures = new Set(
    [failAt, rollbackFailAt]
      .flat()
      .filter(Boolean),
  );
  const step = async (name, value) => {
    calls.push(name);
    if (failures.has(name)) throw new Error(`${name} failed`);
    return value;
  };
  return {
    calls,
    routerSnapshot,
    managerSnapshot,
    deps: {
      checkPortOwner: () => step("port-owner-check", owner),
      preflightManagerTask: () => step("manager-preflight"),
      standaloneEnabled: () => previousStandalone,
      setStandaloneEnabled: (enabled) => {
        const name = enabled ? "marker-enable" : "marker-disable";
        calls.push(name);
        if (failures.has(name)) throw new Error(`${name} failed`);
      },
      snapshotRouterTaskAndLaunchers: () => step("snapshot-router", routerSnapshot),
      snapshotManagerTaskLaunchersAndShortcut: () => step("snapshot-manager", managerSnapshot),
      stopRouterService: () => step("service-stop"),
      installManagerService: () => step("manager-install"),
      startManagerService: () => step("manager-start"),
      uninstallManagerService: () => step("manager-uninstall"),
      purgeManagerServiceComponents: (components) => step("manager-purge-created", components),
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
      createdComponents,
    },
  };
}

test("install commits in the fixed manager-before-Router order", async () => {
  const fixture = transactionDeps();
  await runTaskManagerInstall("install", fixture.deps);
  assert.deepEqual(fixture.calls, [
    "port-owner-check", "manager-preflight", "snapshot-router", "snapshot-manager", "service-stop", "manager-install", "manager-health",
    "shortcut-install", "marker-enable", "service-install", "router-health",
    "manager-snapshot-discard", "router-snapshot-discard",
  ]);
});

test("install failure restores marker, both exact generations, and a healthy Router", async () => {
  const fixture = transactionDeps({ failAt: "service-install" });
  await assert.rejects(
    runTaskManagerInstall("install", fixture.deps),
    /service-install failed/,
  );
  assert.deepEqual(fixture.calls, [
    "port-owner-check", "manager-preflight", "snapshot-router", "snapshot-manager", "service-stop", "manager-install", "manager-health",
    "shortcut-install", "marker-enable", "service-install", "marker-disable", "manager-restore", "router-restore",
    "router-start-restored", "router-health", "manager-snapshot-discard", "router-snapshot-discard",
  ]);
});

test("rollback attempts every Router recovery step and reports every error", async () => {
  const fixture = transactionDeps({
    failAt: "service-install",
    rollbackFailAt: [
      "marker-disable",
      "manager-restore",
      "router-restore",
      "router-start-restored",
      "router-health",
    ],
  });
  await assert.rejects(
    runTaskManagerInstall("install", fixture.deps),
    (error) => {
      assert.ok(error instanceof AggregateError);
      const messages = error.errors.map(({ message }) => message).join("\n");
      for (const expected of [
        "service-install failed",
        "marker-disable failed",
        "manager-restore failed",
        "router-restore failed",
        "router-start-restored failed",
        "router-health failed",
      ]) assert.match(messages, new RegExp(expected));
      return true;
    },
  );
  assert.deepEqual(fixture.calls.slice(-5), [
    "marker-disable",
    "manager-restore",
    "router-restore",
    "router-start-restored",
    "router-health",
  ]);
  assert.equal(fixture.calls.some((call) => call.endsWith("snapshot-discard")), false);
});

test("health is the commit point and both snapshot cleanups are independent", async () => {
  const fixture = transactionDeps({ failAt: "manager-snapshot-discard" });
  const result = await runTaskManagerInstall("install", fixture.deps);
  assert.equal(result.command, "install");
  assert.match(result.cleanupErrors.join("\n"), /manager-snapshot-discard failed/);
  assert.deepEqual(fixture.calls.slice(-3), [
    "router-health",
    "manager-snapshot-discard",
    "router-snapshot-discard",
  ]);
  assert.equal(fixture.calls.includes("marker-disable"), false);
});

test("successful recovery discards both snapshots and reports only failed cleanup evidence", async () => {
  const fixture = transactionDeps({
    failAt: ["service-install", "manager-snapshot-discard"],
  });
  await assert.rejects(
    runTaskManagerInstall("install", fixture.deps),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.errors.map(({ message }) => message).join("\n"), /service-install failed/);
      assert.match(error.errors.map(({ message }) => message).join("\n"), /manager-snapshot-discard failed/);
      return true;
    },
  );
  assert.deepEqual(fixture.calls.slice(-3), [
    "router-health",
    "manager-snapshot-discard",
    "router-snapshot-discard",
  ]);
});

test("partial snapshot acquisition discards earlier evidence before any mutation", async () => {
  const fixture = transactionDeps({ failAt: "snapshot-manager" });
  await assert.rejects(runTaskManagerInstall("install", fixture.deps), /snapshot-manager failed/);
  assert.deepEqual(fixture.calls, [
    "port-owner-check",
    "manager-preflight",
    "snapshot-router",
    "snapshot-manager",
    "router-snapshot-discard",
  ]);
  assert.equal(fixture.calls.includes("service-stop"), false);
});

test("partial acquisition reports both capture and retained-evidence cleanup failures", async () => {
  const fixture = transactionDeps({
    failAt: ["snapshot-manager", "router-snapshot-discard"],
  });
  await assert.rejects(
    runTaskManagerInstall("install", fixture.deps),
    (error) => {
      assert.ok(error instanceof AggregateError);
      const messages = error.errors.map(({ message }) => message).join("\n");
      assert.match(messages, /snapshot-manager failed/);
      assert.match(messages, /router-snapshot-discard failed/);
      return true;
    },
  );
});

test("a noncanonical same-name manager refuses before snapshots or Router stop", async () => {
  const fixture = transactionDeps({ failAt: "manager-preflight" });
  await assert.rejects(runTaskManagerInstall("install", fixture.deps), /manager-preflight failed/);
  assert.deepEqual(fixture.calls, ["port-owner-check", "manager-preflight"]);
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
    "port-owner-check", "manager-preflight", "snapshot-router", "snapshot-manager", "manager-uninstall", "shortcut-uninstall",
    "marker-disable", "service-install", "embedded-health", "router-health",
    "manager-snapshot-discard", "router-snapshot-discard",
  ]);

  const purge = transactionDeps({ owner: "standalone", previousStandalone: true });
  await runTaskManagerInstall("purge", purge.deps);
  assert.deepEqual(purge.calls, [
    "port-owner-check", "manager-uninstall", "shortcut-uninstall", "marker-disable",
  ]);
});

test("component-scoped purge removes only artifacts marked as created", async () => {
  const created = {
    version: 1,
    task: true,
    wrapper: false,
    launcher: true,
    shortcut: false,
    marker: true,
  };
  const fixture = transactionDeps({ owner: "standalone", createdComponents: created });
  await runTaskManagerInstall("purge-created", fixture.deps);
  assert.deepEqual(fixture.calls, [
    "port-owner-check",
    "manager-purge-created",
    "marker-disable",
  ]);
});

test("created-component environment contract accepts only fixed boolean names", () => {
  const parsed = parseCreatedTaskManagerComponents(JSON.stringify({
    version: 1,
    task: true,
    wrapper: false,
    launcher: true,
    shortcut: false,
    marker: true,
  }));
  assert.equal(parsed.task, true);
  assert.equal(Object.isFrozen(parsed), true);
  assert.throws(
    () => parseCreatedTaskManagerComponents(JSON.stringify({
      ...parsed,
      path: "C:/untrusted",
    })),
    /exact boolean fields/i,
  );
});

test("selective purge restarts a wholly pre-existing standalone manager", async () => {
  const fixture = transactionDeps({
    owner: "standalone",
    createdComponents: {
      version: 1,
      task: false,
      wrapper: false,
      launcher: false,
      shortcut: true,
      marker: false,
    },
  });
  await runTaskManagerInstall("purge-created", fixture.deps);
  assert.deepEqual(fixture.calls, [
    "port-owner-check",
    "manager-purge-created",
    "shortcut-uninstall",
    "manager-start",
  ]);
});

test("production port classifier binds HTTP identities to the actual owning PID", async () => {
  const root = "C:/Router Root";
  const managerState = { pid: 52 };
  const embeddedCalls = [];
  assert.equal(await classifyTaskManagerPortOwner({
    sourceRoot: root,
    readPortOwner: async () => ({ known: true, pid: 41 }),
    readManagerHealth: async () => undefined,
    readRouterHealth: async () => ({ service: "codex-router", taskManagerMode: "embedded" }),
    readProcessCommandLine: (pid) => {
      embeddedCalls.push(pid);
      return `node.exe "${root}/src/router.mjs"`;
    },
    readManagerProcessState: () => undefined,
  }), "embedded");
  assert.deepEqual(embeddedCalls, [41]);

  assert.equal(await classifyTaskManagerPortOwner({
    sourceRoot: root,
    readPortOwner: async () => ({ known: true, pid: 52 }),
    readManagerHealth: async () => ({
      ok: true,
      service: "codex-router-task-manager",
      mode: "standalone",
      pid: 52,
    }),
    readRouterHealth: async () => undefined,
    readProcessCommandLine: () => "unrelated",
    readManagerProcessState: () => managerState,
    managerProcessOwns: (state) => state === managerState,
  }), "standalone");

  assert.equal(await classifyTaskManagerPortOwner({
    sourceRoot: root,
    readPortOwner: async () => ({ known: true, pid: 99 }),
    readManagerHealth: async () => ({
      ok: true,
      service: "codex-router-task-manager",
      mode: "standalone",
      pid: 52,
    }),
    readRouterHealth: async () => ({ service: "codex-router", taskManagerMode: "embedded" }),
    readProcessCommandLine: () => `node.exe "${root}/src/not-router.mjs"`,
    readManagerProcessState: () => managerState,
    managerProcessOwns: () => true,
  }), "unknown");
});

test("Router topology is read only from the protected capability health leaf", async () => {
  const secret = "test-caller-capability-with-sufficient-length";
  let requested;
  const health = await readProtectedTaskManagerRouterHealth({
    readCallerSecret: () => secret,
    fetchImpl: async (url) => {
      requested = url;
      return new Response(JSON.stringify({
        ok: true,
        service: "codex-router",
        taskManagerMode: "embedded",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.match(requested, new RegExp(`/_codex-router/${secret}/v1/health$`));
  assert.equal(health.taskManagerMode, "embedded");
});

test("Windows port-owner probe is bounded, UTF-8, and fail-closed", () => {
  let invocation;
  const result = windowsTaskManagerPortOwner({
    platform: "win32",
    spawn: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: JSON.stringify({ known: true, pid: 4242 }) };
    },
  });
  assert.deepEqual(result, { known: true, pid: 4242 });
  assert.equal(invocation.options.encoding, "utf8");
  assert.ok(invocation.options.timeout > 0);
  assert.match(invocation.args.at(-1), /OutputEncoding.*UTF8/);
  assert.match(invocation.args.at(-1), /Get-NetTCPConnection/);
  assert.match(invocation.args.at(-1), /4111|CODEX_ROUTER_CONTROL_PORT/);
});

test("embedded verification requires exact ownership plus root and non-standalone health contracts", async () => {
  const calls = [];
  assert.deepEqual(await verifyEmbeddedTaskManager({
    classifyOwner: async () => { calls.push("owner"); return "embedded"; },
    readPageContract: async () => { calls.push("page"); return true; },
    timeoutMs: 0,
  }), { ok: true, mode: "embedded" });
  assert.deepEqual(calls, ["owner", "page"]);

  await assert.rejects(verifyEmbeddedTaskManager({
    classifyOwner: async () => "embedded",
    readPageContract: async () => false,
    timeoutMs: 0,
  }), /embedded Task Manager/i);
});

test("embedded page boundary requires the embedded 404 health and HTML root contracts", async () => {
  const requests = [];
  const valid = await embeddedTaskManagerPageContract(async (url) => {
    requests.push(url);
    return url.endsWith("/health")
      ? new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
      : new Response("<!doctype html><title>Task Manager</title>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
  });
  assert.equal(valid, true);
  assert.equal(requests.some((url) => url.endsWith("/health")), true);
  assert.equal(requests.some((url) => url.endsWith("/")), true);

  assert.equal(await embeddedTaskManagerPageContract(async () => new Response("standalone", {
    status: 200,
    headers: { "content-type": "text/html" },
  })), false);
});

test("status is read-only and unknown commands are rejected", async () => {
  const fixture = transactionDeps();
  assert.deepEqual(await runTaskManagerInstall("status", fixture.deps), { installed: true });
  assert.deepEqual(fixture.calls, ["status"]);
  await assert.rejects(runTaskManagerInstall("remove", fixture.deps), /install\|uninstall\|purge\|status/);
});

test("status exposes fail-closed component baselines instead of converting unknown to absent", async () => {
  const status = await taskManagerInstallStatus({
    platform: "win32",
    readManagerStatus: async () => ({ installed: null, state: "unknown" }),
    readServiceComponents: async () => ({
      task: { known: false, present: null },
      wrapper: { known: true, present: true },
      launcher: { known: true, present: false },
    }),
    readMarkerState: () => ({ known: false, exists: true, enabled: false }),
    resolveShortcutPath: () => "C:/menu/manager.lnk",
    readPath: () => ({ known: true, present: true }),
  });
  assert.deepEqual(status.components, {
    task: { known: false, present: null },
    wrapper: { known: true, present: true },
    launcher: { known: true, present: false },
    shortcut: { known: true, present: true },
    marker: { known: false, present: true },
  });
});
