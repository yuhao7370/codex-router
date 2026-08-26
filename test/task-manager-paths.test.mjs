import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("task manager paths use a dedicated task and state files", () => {
  const script = `import * as p from ${JSON.stringify(pathToFileURL(path.resolve("src/paths.mjs")).href)}; console.log(JSON.stringify({port:p.TASK_MANAGER_CONTROL_PORT,task:p.TASK_MANAGER_TASK_NAME,log:p.TASK_MANAGER_LOG_PATH,process:p.TASK_MANAGER_PROCESS_STATE_PATH,standalone:p.TASK_MANAGER_STANDALONE_PATH}))`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, MODEL_ROUTER_CONTROL_PORT: "43111", MODEL_ROUTER_STATE_DIR: path.resolve(".tmp-task-manager-paths") },
  });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.port, 43111);
  assert.equal(value.task, "Codex Router Task Manager");
  assert.match(value.log, /task-manager\.log$/);
  assert.match(value.process, /task-manager-process\.json$/);
  assert.match(value.standalone, /task-manager-standalone\.json$/);
});
