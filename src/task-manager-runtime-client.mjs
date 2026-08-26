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
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body?.error?.message || `Router returned HTTP ${response.status}.`);
    }
    return body;
  };

  return {
    snapshot: () => request("runtime"),
    reload: () => request("reload", "POST"),
  };
}
