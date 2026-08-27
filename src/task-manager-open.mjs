import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCallerSecret,
  redactCallerUrl,
  taskManagerUrl,
} from "./caller-auth.mjs";
import { openInBrowser } from "./open-browser.mjs";
import { CALLER_SECRET_PATH, TASK_MANAGER_CONTROL_PORT } from "./paths.mjs";
import { classifyTaskManagerPortOwner } from "./task-manager-install.mjs";

const PROBE_TIMEOUT_MS = 2_000;
const PRINT_WARNING =
  "Warning: this address contains this machine's router capability. Treat it like a password, and do not paste it into chat, an issue, or a screen share.\n";

function callerSecret() {
  if (!existsSync(CALLER_SECRET_PATH)) {
    throw new Error(
      "The local router caller key is missing; run ./bin/doctor --fix (.\\codex-router.ps1 doctor --fix on Windows).",
    );
  }
  return assertCallerSecret(readFileSync(CALLER_SECRET_PATH, "utf8").trim());
}

async function fetchWithin(fetchImpl, url) {
  return fetchImpl(url, {
    method: "GET",
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
}

async function standaloneHealth(fetchImpl, origin, { requireHealthy = true } = {}) {
  try {
    const response = await fetchWithin(fetchImpl, `${origin}/health`);
    const health = await response.json();
    return health?.service === "codex-router-task-manager"
      && health.mode === "standalone"
      && (!requireHealthy || (response.ok && health.ok === true));
  } catch {
    return false;
  }
}

async function embeddedRootResponds(fetchImpl, origin) {
  try {
    const response = await fetchWithin(fetchImpl, `${origin}/`);
    return response.ok
      && String(response.headers.get("content-type") || "")
        .toLowerCase()
        .startsWith("text/html");
  } catch {
    return false;
  }
}

export async function openTaskManager({
  fetchImpl = fetch,
  openBrowser = openInBrowser,
  printOnly = false,
  readCallerSecret = callerSecret,
  classifyOwner = classifyTaskManagerPortOwner,
  ownerOptions = {},
  platform = process.platform,
  controlPort = TASK_MANAGER_CONTROL_PORT,
  writeOutput = (value) => process.stdout.write(value),
  writeWarning = (value) => process.stderr.write(value),
} = {}) {
  const origin = `http://127.0.0.1:${controlPort}`;
  let mode;
  if (platform !== "win32") {
    if (await standaloneHealth(fetchImpl, origin, { requireHealthy: false })) {
      throw new Error("The standalone Task Manager is supported only on Windows; refusing to open it.");
    }
    mode = "embedded";
  } else {
    mode = await classifyOwner({
      ...ownerOptions,
      controlPort,
      allowDevelopmentEmbedded: true,
    });
  }
  if (mode !== "standalone" && mode !== "embedded") {
    throw new Error(
      `Task Manager port ${controlPort} is not owned by a recognized Router installation; refusing to open it.`,
    );
  }
  let url;

  if (mode === "standalone" && await standaloneHealth(fetchImpl, origin)) {
    url = taskManagerUrl(controlPort, assertCallerSecret(readCallerSecret().trim()));
  } else if (mode === "embedded" && await embeddedRootResponds(fetchImpl, origin)) {
    url = `${origin}/`;
  } else {
    throw new Error(
      `The Task Manager is not answering on port ${controlPort}. Start it first, then run this again.`,
    );
  }

  if (printOnly) {
    writeWarning(PRINT_WARNING);
    writeOutput(`${url}\n`);
  } else {
    await openBrowser(url);
    writeOutput(`Opened the Task Manager at ${redactCallerUrl(url)}\n`);
  }
  return { url, mode };
}

function isMain() {
  return Boolean(
    process.argv[1]
      && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)),
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write(
      "Usage: task-manager open [--print]\n\n  --print   Print the capability-bearing URL instead of opening it.\n",
    );
    return;
  }
  if (args.some((arg) => arg !== "--print")) {
    throw new Error("Usage: task-manager open [--print]");
  }
  await openTaskManager({ printOnly: args.includes("--print") });
}

if (isMain()) {
  main().catch((error) => {
    process.stderr.write(
      `${redactCallerUrl(error instanceof Error ? error.message : String(error))}\n`,
    );
    process.exitCode = 1;
  });
}
