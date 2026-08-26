import {
  reloadTaskManagerRuntime,
  taskManagerRuntimeSnapshot,
} from "./task-manager-bridge.mjs";

const ROUTES = new Set(["/task-manager/runtime", "/task-manager/reload"]);

export function isTaskManagerRouterRoute(route) {
  return ROUTES.has(route);
}

export async function handleTaskManagerRouterRequest(
  request,
  response,
  route,
  { writeJson },
) {
  if (!isTaskManagerRouterRoute(route)) return false;
  if (route === "/task-manager/runtime" && request.method === "GET") {
    writeJson(response, 200, taskManagerRuntimeSnapshot());
    return true;
  }
  if (route === "/task-manager/reload" && request.method === "POST") {
    writeJson(response, 200, await reloadTaskManagerRuntime());
    return true;
  }
  writeJson(response, 405, {
    error: { type: "invalid_request", message: "Method not allowed." },
  });
  return true;
}
