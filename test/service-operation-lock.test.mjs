import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { withServiceOperationLock } from "../src/service-operation-lock.mjs";

const root = path.resolve(".");

test("only a final service shutdown stops router-managed Ollama", () => {
  const source = readFileSync(path.join(root, "src", "service.mjs"), "utf8");
  assert.match(source, /shutdownCommands = new Set\(\["stop", "uninstall"\]\)/);
  assert.match(source, /shutdownCommands\.has\(command\).*stopManagedOllama\(\)/s);
  const declaration = source.match(/shutdownCommands = new Set\((\[[^\n]+\])\)/)?.[1];
  assert.equal(declaration, '["stop", "uninstall"]');
});

test("service operation lock rejects overlap and releases afterward", { timeout: 5_000 }, async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-service-lock-"));
  let allowFirstToFinish;
  const firstCanFinish = new Promise((resolve) => {
    allowFirstToFinish = resolve;
  });
  let markFirstEntered;
  const firstEntered = new Promise((resolve) => {
    markFirstEntered = resolve;
  });

  const first = withServiceOperationLock(async () => {
    markFirstEntered();
    await firstCanFinish;
    return "first";
  }, { stateDir, waitMs: 100, retryMs: 10, staleMs: 5_000 });

  try {
    await firstEntered;
    await assert.rejects(
      withServiceOperationLock(
        async () => "overlap",
        { stateDir, waitMs: 50, retryMs: 10, staleMs: 5_000 },
      ),
      /Another background-service operation is still running/,
    );

    allowFirstToFinish();
    assert.equal(await first, "first");
    assert.equal(
      await withServiceOperationLock(
        async () => "second",
        { stateDir, waitMs: 100, retryMs: 10, staleMs: 5_000 },
      ),
      "second",
    );
    await assert.rejects(
      withServiceOperationLock(
        async () => {
          throw new Error("operation failed");
        },
        { stateDir, waitMs: 100, retryMs: 10, staleMs: 5_000 },
      ),
      /operation failed/,
    );
    assert.equal(
      await withServiceOperationLock(
        async () => "after failure",
        { stateDir, waitMs: 100, retryMs: 10, staleMs: 5_000 },
      ),
      "after failure",
    );
  } finally {
    allowFirstToFinish();
    await first.catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("different named service locks run together while matching names conflict", { timeout: 5_000 }, async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-named-service-lock-"));
  let releaseRouter;
  const routerCanFinish = new Promise((resolve) => {
    releaseRouter = resolve;
  });
  let markRouterEntered;
  const routerEntered = new Promise((resolve) => {
    markRouterEntered = resolve;
  });

  const router = withServiceOperationLock(async () => {
    markRouterEntered();
    await routerCanFinish;
  }, {
    stateDir,
    lockName: "router",
    waitMs: 100,
    retryMs: 10,
    staleMs: 5_000,
  });

  try {
    await routerEntered;
    assert.equal(
      await withServiceOperationLock(async () => "manager", {
        stateDir,
        lockName: "task-manager",
        waitMs: 50,
        retryMs: 10,
        staleMs: 5_000,
      }),
      "manager",
    );
    await assert.rejects(
      withServiceOperationLock(async () => "second router", {
        stateDir,
        lockName: "router",
        waitMs: 50,
        retryMs: 10,
        staleMs: 5_000,
      }),
      /Another background-service operation is still running/,
    );
  } finally {
    releaseRouter();
    await router.catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
});
