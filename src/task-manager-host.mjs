import { readFileSync } from "node:fs";

import { assertCallerSecret } from "./caller-auth.mjs";
import { CALLER_SECRET_PATH, TASK_MANAGER_CONTROL_PORT } from "./paths.mjs";
import { createRouterServiceController } from "./task-manager-service-control.mjs";
import { createTaskManagerRuntimeClient } from "./task-manager-runtime-client.mjs";
import {
  clearTaskManagerProcessState,
  readTaskManagerProcessState,
  taskManagerProcessStateMatches,
  writeTaskManagerProcessState,
} from "./task-manager-process.mjs";
import { startTaskManagerUi } from "./task-manager-ui.mjs";
import { startLocalRouterAutoSync } from "./local-router-auto-sync.mjs";

const callerSecret = assertCallerSecret(readFileSync(CALLER_SECRET_PATH, "utf8").trim());
const serviceController = createRouterServiceController();
const hostProcessState = writeTaskManagerProcessState();

function clearOwnProcessState() {
  if (taskManagerProcessStateMatches(readTaskManagerProcessState(), hostProcessState)) {
    clearTaskManagerProcessState();
  }
}

let server;
try {
  server = startTaskManagerUi({
    mode: "standalone",
    port: TASK_MANAGER_CONTROL_PORT,
    callerSecret,
    runtimeClient: createTaskManagerRuntimeClient({ callerSecret }),
    serviceController,
    restartRouter: () => serviceController.perform("restart"),
  });
} catch (error) {
  clearOwnProcessState();
  throw error;
}

// The host survives Router service restarts. Running discovery in the Router
// itself would let Windows taskkill /T terminate the worker that reloads it.
const localRouterAutoSync = startLocalRouterAutoSync({
  onError: () => console.error("[codex-router] Local model discovery did not finish; it will retry."),
});
server.once("close", () => {
  localRouterAutoSync.stop();
  clearOwnProcessState();
});
server.once("error", (error) => {
  localRouterAutoSync.stop();
  clearOwnProcessState();
  console.error(`[codex-router] Task Manager host failed: ${error.message}`);
  process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    localRouterAutoSync.stop();
    if (!server.listening) {
      clearOwnProcessState();
      process.exit(0);
    }
    server.close((error) => process.exit(error ? 1 : 0));
  });
}
