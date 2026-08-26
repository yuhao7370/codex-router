import { spawnSync } from "node:child_process";
import path from "node:path";

import { SOURCE_ROOT } from "./paths.mjs";
import { withServiceOperationLock } from "./service-operation-lock.mjs";

const platform = process.env.CODEX_ROUTER_SERVICE_PLATFORM || process.platform;
const command = process.argv[2] || "status";
const commands = new Set(["install", "uninstall", "start", "stop", "restart", "status"]);
const mutatingCommands = new Set(["install", "uninstall", "start", "stop", "restart"]);

if (!commands.has(command)) {
  console.error("Usage: task-manager-service.mjs install|uninstall|start|stop|restart|status");
  process.exit(2);
}

async function runCommand() {
  if (platform !== "win32") {
    if (command !== "status") {
      throw new Error("The standalone Task Manager service is supported on Windows only.");
    }
    process.stdout.write(`${JSON.stringify({
      supported: false,
      installed: false,
      loaded: false,
      state: "unsupported",
      canonical: false,
      healthy: false,
      pid: null,
    })}\n`);
    return 0;
  }

  const result = spawnSync(
    process.execPath,
    [
      path.join(SOURCE_ROOT, "src", "task-manager-service-windows.mjs"),
      ...process.argv.slice(2),
    ],
    { stdio: "inherit", env: process.env },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

try {
  const status = mutatingCommands.has(command)
    ? await withServiceOperationLock(runCommand, {
        lockName: "task-manager-service-operation",
      })
    : await runCommand();
  process.exit(status);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
