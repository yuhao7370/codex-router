import { fetch as undiciFetch, ProxyAgent } from "undici";

const NATIVE_PROXY_ERROR =
  "CODEX_ROUTER_NATIVE_PROXY_URL must be a valid credential-free HTTP or HTTPS proxy URL.";
const GENERIC_PROXY_VARIABLES = [
  "NODE_USE_ENV_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
];

export function parseNativeProxyUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error(NATIVE_PROXY_ERROR);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(NATIVE_PROXY_ERROR);
  }
  return parsed.origin;
}

function configuredNativeProxyUrl(environment) {
  const value = String(environment.CODEX_ROUTER_NATIVE_PROXY_URL || "").trim();
  return value ? parseNativeProxyUrl(value) : undefined;
}

function isLoopbackTarget(target) {
  try {
    const hostname = new URL(target).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
}

export function withoutGenericProxyEnvironment(environment = process.env) {
  const cleaned = { ...environment };
  for (const name of GENERIC_PROXY_VARIABLES) {
    delete cleaned[name];
    delete cleaned[name.toLowerCase()];
  }
  return cleaned;
}

// Undici's dispatcher is passed only to native fetches. This supports Node
// 22.19+ without relying on NODE_USE_ENV_PROXY, which arrived later in Node 22.
export function nativeProxyFetch(environment = process.env) {
  const proxy = configuredNativeProxyUrl(environment);
  if (!proxy) return fetch;
  const dispatcher = new ProxyAgent(proxy);
  return (target, init) =>
    isLoopbackTarget(target)
      ? fetch(target, init)
      : undiciFetch(target, { ...init, dispatcher });
}
