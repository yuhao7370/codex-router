import { readFileSync } from "node:fs";

import { assertCallerSecret } from "./caller-auth.mjs";
import { CALLER_SECRET_PATH, TASK_MANAGER_CONTROL_PORT } from "./paths.mjs";
import { createRouterServiceController } from "./task-manager-service-control.mjs";
import { createTaskManagerRuntimeClient } from "./task-manager-runtime-client.mjs";
import { startTaskManagerUi } from "./task-manager-ui.mjs";

const callerSecret = assertCallerSecret(readFileSync(CALLER_SECRET_PATH, "utf8").trim());
const serviceController = createRouterServiceController();
const server = startTaskManagerUi({
  mode: "standalone",
  port: TASK_MANAGER_CONTROL_PORT,
  callerSecret,
  runtimeClient: createTaskManagerRuntimeClient({ callerSecret }),
  serviceController,
  restartRouter: () => serviceController.perform("restart"),
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
