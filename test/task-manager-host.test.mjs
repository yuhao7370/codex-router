import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";
const SIGNAL_PROXY = `data:text/javascript,${encodeURIComponent(
  'process.on("message",(signal)=>{if(signal==="SIGTERM")process.emit("SIGTERM")})',
)}`;

async function waitForHealth(origin, child, errors) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Host exited early (${child.exitCode}): ${errors()}`);
    }
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return response;
    } catch {
      // The isolated host has not bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${origin}/health: ${errors()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) child.send("SIGTERM");
  else child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

function spawnHost({ stateDir, controlPort, routerPort }) {
  const child = spawn(process.execPath, [
    "--import",
    SIGNAL_PROXY,
    path.join(root, "src", "task-manager-host.mjs"),
  ], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_CONTROL_PORT: String(controlPort),
      MODEL_ROUTER_PORT: String(routerPort),
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return { child, errors: () => stderr };
}

test("standalone host serves minimal public health and shuts down cleanly", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "task-manager-host-"));
  const processStatePath = path.join(stateDir, "task-manager-process.json");
  writeFileSync(path.join(stateDir, "caller-secret"), `${CALLER_KEY}\n`, { mode: 0o600 });
  const controlPort = await openPort();
  const isolatedRouterPort = await openPort();
  const { child, errors } = spawnHost({
    stateDir,
    controlPort,
    routerPort: isolatedRouterPort,
  });

  try {
    const response = await waitForHealth(
      `http://127.0.0.1:${controlPort}`,
      child,
      errors,
    );
    assert.deepEqual(await response.json(), {
      ok: true,
      service: "codex-router-task-manager",
      mode: "standalone",
      pid: child.pid,
    });
    assert.equal(JSON.parse(readFileSync(processStatePath, "utf8")).pid, child.pid);
  } finally {
    await stopChild(child);
    assert.equal(existsSync(processStatePath), false);
    rmSync(stateDir, { recursive: true, force: true });
  }

  assert.ok(
    child.exitCode === 0 || child.signalCode === "SIGTERM",
    `unexpected host exit: code=${child.exitCode} signal=${child.signalCode}\n${errors()}`,
  );
});

test("standalone host preserves a replacement process record during shutdown", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "task-manager-host-replacement-"));
  const processStatePath = path.join(stateDir, "task-manager-process.json");
  writeFileSync(path.join(stateDir, "caller-secret"), `${CALLER_KEY}\n`, { mode: 0o600 });
  const controlPort = await openPort();
  const isolatedRouterPort = await openPort();
  const { child, errors } = spawnHost({
    stateDir,
    controlPort,
    routerPort: isolatedRouterPort,
  });

  try {
    await waitForHealth(`http://127.0.0.1:${controlPort}`, child, errors);
    const original = JSON.parse(readFileSync(processStatePath, "utf8"));
    const replacement = {
      ...original,
      processIdentity: `replacement|${original.processIdentity}`,
    };
    writeFileSync(processStatePath, `${JSON.stringify(replacement, null, 2)}\n`);

    await stopChild(child);
    assert.deepEqual(JSON.parse(readFileSync(processStatePath, "utf8")), replacement);
  } finally {
    await stopChild(child);
    rmSync(stateDir, { recursive: true, force: true });
  }
});
