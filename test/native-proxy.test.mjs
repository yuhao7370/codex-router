import assert from "node:assert/strict";
import test from "node:test";

import { nativeProxyEnvironment } from "../src/native-proxy.mjs";

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
