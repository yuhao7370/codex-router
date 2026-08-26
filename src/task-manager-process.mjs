import { readFileSync, unlinkSync } from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import {
  SOURCE_ROOT,
  STATE_DIR,
  TASK_MANAGER_PROCESS_STATE_PATH,
} from "./paths.mjs";
import { processCommandLine, processStartIdentity } from "./process-identity.mjs";

const STATE_VERSION = 1;

function normalized(value) {
  return String(value || "").replaceAll("\\", "/").toLowerCase();
}

function safePid(pid) {
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "ESRCH" ? false : undefined;
  }
}

function entrypointFor(sourceRoot) {
  return normalized(path.join(sourceRoot, "src", "task-manager-host.mjs"));
}

function commandLineHasEntrypoint(commandLine, sourceRoot) {
  const entrypoint = entrypointFor(sourceRoot);
  const tokens = String(commandLine || "").match(/"[^"]*"|'[^']*'|[^\s]+/g) || [];
  return tokens.some((token) => {
    const unquoted = token.length > 1 && (
      (token.startsWith('"') && token.endsWith('"'))
      || (token.startsWith("'") && token.endsWith("'"))
    )
      ? token.slice(1, -1)
      : token;
    return normalized(unquoted) === entrypoint;
  });
}

export function buildTaskManagerProcessState({
  pid = process.pid,
  platform = process.platform,
  identity = processStartIdentity,
  commandLine = processCommandLine,
  sourceRoot = SOURCE_ROOT,
  stateDir = STATE_DIR,
} = {}) {
  const safe = safePid(pid);
  if (!safe) return undefined;
  const processIdentity = identity(safe, { platform });
  const liveCommandLine = commandLine(safe, { platform });
  if (
    !processIdentity
    || !liveCommandLine
    || !commandLineHasEntrypoint(liveCommandLine, sourceRoot)
  ) {
    return undefined;
  }
  return {
    version: STATE_VERSION,
    managed: true,
    pid: safe,
    processIdentity: String(processIdentity),
    commandLine: String(liveCommandLine),
    sourceRoot: path.resolve(sourceRoot),
    stateDir: path.resolve(stateDir),
    startedAt: Date.now(),
  };
}

export function writeTaskManagerProcessState(options = {}) {
  const state = buildTaskManagerProcessState(options);
  if (!state) {
    throw new Error(
      "The Task Manager could not verify its own task-manager-host.mjs process identity; refusing to run without a stoppable process record.",
    );
  }
  writePrivateJson(options.statePath || TASK_MANAGER_PROCESS_STATE_PATH, state);
  return state;
}

export function readTaskManagerProcessState(
  statePath = TASK_MANAGER_PROCESS_STATE_PATH,
) {
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    return state?.version === STATE_VERSION && state?.managed === true
      ? state
      : undefined;
  } catch {
    return undefined;
  }
}

export function clearTaskManagerProcessState(
  statePath = TASK_MANAGER_PROCESS_STATE_PATH,
) {
  try {
    unlinkSync(statePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function validProcessState(state) {
  return Boolean(
    state
    && state.version === STATE_VERSION
    && state.managed === true
    && safePid(state.pid)
    && typeof state.processIdentity === "string"
    && state.processIdentity
    && typeof state.commandLine === "string"
    && state.commandLine
    && typeof state.sourceRoot === "string"
    && state.sourceRoot
    && typeof state.stateDir === "string"
    && state.stateDir,
  );
}

export function taskManagerProcessStateMatches(left, right) {
  return Boolean(
    validProcessState(left)
    && validProcessState(right)
    && left.pid === right.pid
    && left.processIdentity === right.processIdentity
    && left.commandLine === right.commandLine
    && normalized(left.sourceRoot) === normalized(right.sourceRoot)
    && normalized(left.stateDir) === normalized(right.stateDir),
  );
}

export function taskManagerProcessEvidence(
  state,
  {
    platform = process.platform,
    identity = processStartIdentity,
    commandLine = processCommandLine,
    exists = processExists,
    sourceRoot = SOURCE_ROOT,
    stateDir = STATE_DIR,
  } = {},
) {
  const pid = safePid(state?.pid);
  if (
    !validProcessState(state)
    || !pid
    || normalized(state.sourceRoot) !== normalized(path.resolve(sourceRoot))
    || normalized(state.stateDir) !== normalized(path.resolve(stateDir))
    || !commandLineHasEntrypoint(state.commandLine, state.sourceRoot)
  ) {
    return "unknown";
  }
  try {
    const liveIdentity = identity(pid, { platform });
    if (!liveIdentity) return exists(pid) === false ? "gone" : "unknown";
    if (liveIdentity !== state.processIdentity) return "replaced";
    const liveCommandLine = commandLine(pid, { platform });
    return liveCommandLine
      && commandLineHasEntrypoint(liveCommandLine, state.sourceRoot)
      ? "owned"
      : "unknown";
  } catch {
    return "unknown";
  }
}

export function taskManagerProcessOwns(state, options = {}) {
  return taskManagerProcessEvidence(state, options) === "owned";
}
