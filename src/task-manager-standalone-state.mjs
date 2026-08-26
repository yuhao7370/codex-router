import { readFileSync, unlinkSync } from "node:fs";

import { writePrivateJson } from "./file-security.mjs";
import { TASK_MANAGER_STANDALONE_PATH } from "./paths.mjs";

const VERSION = 1;

export function taskManagerStandaloneEnabled(
  statePath = TASK_MANAGER_STANDALONE_PATH,
) {
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    return state?.version === VERSION && state?.enabled === true;
  } catch {
    return false;
  }
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
