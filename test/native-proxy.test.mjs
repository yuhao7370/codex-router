import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  nativeProxyEnvironment,
  nativeProxyEnvironmentForChild,
} from "../src/native-proxy.mjs";

test("no native proxy setting leaves the router child environment unchanged", () => {
  assert.deepEqual(nativeProxyEnvironment({}), {});
});

test("the native router child uses Mihomo and bypasses every loopback spelling", () => {
  assert.deepEqual(
    nativeProxyEnvironment({
      CODEX_ROUTER_NATIVE_PROXY_URL: "http://127.0.0.1:7897",
      NO_PROXY: "internal.example",
    }),
    {
      NODE_USE_ENV_PROXY: "1",
      HTTP_PROXY: "http://127.0.0.1:7897",
      HTTPS_PROXY: "http://127.0.0.1:7897",
      NO_PROXY: "internal.example,127.0.0.1,localhost,::1",
    },
  );
});

test("only the router child receives the native proxy environment", () => {
  const environment = {
    CODEX_ROUTER_NATIVE_PROXY_URL: "http://127.0.0.1:7897",
  };
  const childEnvironment = (script) =>
    nativeProxyEnvironmentForChild(path.join("router-root", "src", script), environment);

  assert.deepEqual(childEnvironment("router.mjs"), {
    NODE_USE_ENV_PROXY: "1",
    HTTP_PROXY: "http://127.0.0.1:7897",
    HTTPS_PROXY: "http://127.0.0.1:7897",
    NO_PROXY: "127.0.0.1,localhost,::1",
  });
  for (const [child, script] of [
    ["OAuth forwarder", "oauth-forwarder.mjs"],
    ["API forwarder", "api-forwarder.mjs"],
    ["Grok OAuth forwarder", "grok-oauth-forwarder.mjs"],
    ["LiteLLM", "--config"],
  ]) {
    assert.deepEqual(childEnvironment(script), {}, child);
  }
});
