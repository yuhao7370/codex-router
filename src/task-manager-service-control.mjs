import { spawn } from "node:child_process";
import path from "node:path";

import { redactCallerUrl } from "./caller-auth.mjs";
import { readControlHealth } from "./control-health.mjs";
import { SOURCE_ROOT } from "./paths.mjs";

const SERVICE_SCRIPT = path.join(SOURCE_ROOT, "src", "service.mjs");
const ACTIONS = new Set(["start", "stop", "restart"]);
const MAX_OUTPUT_BYTES = 8 * 1024;

function appendOutput(output, chunk) {
  return Buffer.concat([output, Buffer.from(chunk)]).subarray(-MAX_OUTPUT_BYTES);
}

function runServiceProcess(action) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVICE_SCRIPT, action], {
      cwd: SOURCE_ROOT,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    child.stdout.on("data", (chunk) => { stdout = appendOutput(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendOutput(stderr, chunk); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
      else {
        reject(new Error(redactCallerUrl(stderr.toString("utf8").trim() || `Router service exited ${code ?? signal}.`)));
      }
    });
  });
}

async function defaultReadServiceStatus() {
  const { stdout } = await runServiceProcess("status");
  return JSON.parse(stdout);
}

async function defaultRunServiceCommand(action) {
  await runServiceProcess(action);
}

export function routerServiceLifecycle({ service, health, operation, serviceError } = {}) {
  if (operation?.action === "start") return "starting";
  if (operation?.action === "stop") return "stopping";
  if (operation?.action === "restart") return "restarting";
  if (serviceError) return "failed";
  if (health?.ok) return "running";
  if (service?.loaded) return "unhealthy";
  if (service?.installed === false || service?.loaded === false) return "stopped";
  return "failed";
}

export function createRouterServiceController({
  runServiceCommand = defaultRunServiceCommand,
  readServiceStatus = defaultReadServiceStatus,
  readHealth = readControlHealth,
} = {}) {
  let operation = null;

  const snapshot = async () => {
    const [serviceResult, healthResult] = await Promise.allSettled([
      readServiceStatus(),
      readHealth(),
    ]);
    const service = serviceResult.status === "fulfilled" ? serviceResult.value : undefined;
    const health = healthResult.status === "fulfilled" ? healthResult.value : { ok: false };
    const serviceError = serviceResult.status === "rejected"
      ? "Router service status unavailable."
      : undefined;
    const healthError = healthResult.status === "rejected"
      ? "Router health unavailable."
      : undefined;
    const state = routerServiceLifecycle({ service, health, operation, serviceError, healthError });
    return { state, service, health, operation, serviceError, healthError };
  };

  return {
    snapshot,
    currentOperation: () => operation,
    async perform(action) {
      if (!ACTIONS.has(action)) throw new Error(`Unknown Router service action: ${action}`);
      if (operation) throw new Error("Another Router service operation is already running.");

      operation = { action, startedAt: Date.now() };
      try {
        await runServiceCommand(action);
        operation = null;
        return await snapshot();
      } finally {
        operation = null;
      }
    },
  };
}
