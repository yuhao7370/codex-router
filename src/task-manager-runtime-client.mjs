import { taskManagerUrl } from "./caller-auth.mjs";
import { PORTS } from "./paths.mjs";

export function createTaskManagerRuntimeClient({
  fetchImpl = fetch,
  routerPort = PORTS.router,
  callerSecret,
} = {}) {
  const base = taskManagerUrl(routerPort, callerSecret);
  const request = async (leaf, method = "GET") => {
    const response = await fetchImpl(new URL(leaf, base), {
      method,
      headers: method === "POST" ? { "content-type": "application/json" } : undefined,
      body: method === "POST" ? "{}" : undefined,
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const error = new Error(`Router runtime request failed (HTTP ${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return response.json().catch(() => ({}));
  };

  return {
    snapshot: () => request("runtime"),
    reload: () => request("reload", "POST"),
  };
}
