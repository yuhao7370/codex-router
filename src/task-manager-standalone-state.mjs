import { lstatSync, readFileSync, unlinkSync } from "node:fs";

import { writePrivateJson } from "./file-security.mjs";
import { TASK_MANAGER_STANDALONE_PATH } from "./paths.mjs";

const VERSION = 1;
const MAX_STATE_BYTES = 4_096;

export function taskManagerStandaloneState(
  statePath = TASK_MANAGER_STANDALONE_PATH,
) {
  try {
    const stats = lstatSync(statePath);
    if (
      stats.isSymbolicLink()
      || !stats.isFile()
      || stats.size < 2
      || stats.size > MAX_STATE_BYTES
    ) {
      return { known: false, exists: true, enabled: false, state: "malformed" };
    }
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (state?.version !== VERSION || typeof state?.enabled !== "boolean") {
      return { known: false, exists: true, enabled: false, state: "malformed" };
    }
    return {
      known: true,
      exists: true,
      enabled: state.enabled,
      state: state.enabled ? "enabled" : "disabled",
    };
  } catch (error) {
    return error?.code === "ENOENT"
      ? { known: true, exists: false, enabled: false, state: "missing" }
      : { known: false, exists: true, enabled: false, state: "malformed" };
  }
}

export function taskManagerStandaloneEnabled(
  statePath = TASK_MANAGER_STANDALONE_PATH,
) {
  return taskManagerStandaloneState(statePath).enabled;
}

export function setTaskManagerStandaloneEnabled(
  enabled,
  statePath = TASK_MANAGER_STANDALONE_PATH,
) {
  if (typeof enabled !== "boolean") {
    throw new TypeError("Task Manager standalone state must be a boolean.");
  }
  if (enabled) {
    writePrivateJson(
      statePath,
      { version: VERSION, enabled: true },
      { directoryMode: 0o700 },
    );
  } else {
    try {
      unlinkSync(statePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return enabled;
}
