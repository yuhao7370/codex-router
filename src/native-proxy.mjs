import path from "node:path";

const LOOPBACK_BYPASS = ["127.0.0.1", "localhost", "::1"];

export function nativeProxyEnvironment(environment = process.env) {
  const proxy = String(environment.CODEX_ROUTER_NATIVE_PROXY_URL || "").trim();
  if (!proxy) return {};
  const bypass = String(environment.NO_PROXY || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    NODE_USE_ENV_PROXY: "1",
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    NO_PROXY: [...new Set([...bypass, ...LOOPBACK_BYPASS])].join(","),
  };
}

export function nativeProxyEnvironmentForChild(script, environment = process.env) {
  return path.basename(String(script || "")) === "router.mjs"
    ? nativeProxyEnvironment(environment)
    : {};
}
