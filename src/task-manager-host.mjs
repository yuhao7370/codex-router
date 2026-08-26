import { readFileSync } from "node:fs";

import { assertCallerSecret } from "./caller-auth.mjs";
import { CALLER_SECRET_PATH, TASK_MANAGER_CONTROL_PORT } from "./paths.mjs";
import { createRouterServiceController } from "./task-manager-service-control.mjs";
import { createTaskManagerRuntimeClient } from "./task-manager-runtime-client.mjs";
import {
  clearTaskManagerProcessState,
  readTaskManagerProcessState,
  writeTaskManagerProcessState,
} from "./task-manager-process.mjs";
import { startTaskManagerUi } from "./task-manager-ui.mjs";

const callerSecret = assertCallerSecret(readFileSync(CALLER_SECRET_PATH, "utf8").trim());
const serviceController = createRouterServiceController();
writeTaskManagerProcessState();

function clearOwnProcessState() {
  if (readTaskManagerProcessState()?.pid === process.pid) {
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

server.once("close", clearOwnProcessState);
server.once("error", (error) => {
  clearOwnProcessState();
  console.error(`[codex-router] Task Manager host failed: ${error.message}`);
  process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!server.listening) {
      clearOwnProcessState();
      process.exit(0);
    }
    server.close((error) => process.exit(error ? 1 : 0));
  });
}
