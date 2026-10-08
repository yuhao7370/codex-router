import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { localTimeoutSeconds, localTransportIdleTimeoutMs } from "../src/local-timeouts.mjs";

test("local timeout defaults and overrides remain in seconds with a transport margin", () => {
  assert.equal(localTimeoutSeconds({}), 600);
  assert.equal(localTransportIdleTimeoutMs({}), 660_000);
  assert.equal(localTimeoutSeconds({ MODEL_ROUTER_LOCAL_TIMEOUT: "2400" }), 2400);
  assert.equal(localTransportIdleTimeoutMs({ MODEL_ROUTER_LOCAL_TIMEOUT: "2400" }), 2_460_000);
});

test("router routes only local and Grok through long-idle fetch", () => {
  const source = readFileSync(new URL("../src/router.mjs", import.meta.url), "utf8");
  const block = source.match(/function fetchForRoute\(route, url, init\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(block);
  assert.match(source, /const LOCAL_TRANSPORT_IDLE_TIMEOUT_MS = localTransportIdleTimeoutMs\(\);/);
  assert.match(block, /isGrokOauthRoute\(route\)[\s\S]*?bodyTimeoutMs: GROK_TRANSPORT_IDLE_TIMEOUT_MS/);
  assert.match(block, /canonicalProviderId\(route\.provider\) === "local"[\s\S]*?bodyTimeoutMs: LOCAL_TRANSPORT_IDLE_TIMEOUT_MS/);
  const calls = [];
  const capture = (transport) => (...args) => {
    calls.push({ transport, args });
    return transport;
  };
  // Exercise the extracted pure dispatcher without starting the Router or
  // making any network request. Keep native proxy routing distinct from an
  // ordinary external provider's fetch and from the two long-idle pools.
  const dispatch = runInNewContext(block + "; fetchForRoute", {
    isGrokOauthRoute: (route) => route?.provider === "grok-oauth",
    canonicalProviderId: (provider) => provider,
    GROK_TRANSPORT_IDLE_TIMEOUT_MS: 720_000,
    LOCAL_TRANSPORT_IDLE_TIMEOUT_MS: 660_000,
    longIdleStreamFetch: capture("long-idle"),
    fetch: capture("ordinary"),
    fetchNative: capture("native-proxy"),
  });
  const url = "http://upstream.invalid/responses";
  const init = { method: "POST", body: "unchanged request" };
  for (const [route, transport, timeout] of [
    [{ provider: "grok-oauth" }, "long-idle", 720_000],
    [{ provider: "local" }, "long-idle", 660_000],
    [{ provider: "local-router" }, "ordinary"],
    [{ provider: "deepseek" }, "ordinary"],
    [undefined, "native-proxy"],
    [null, "native-proxy"],
  ]) {
    assert.equal(dispatch(route, url, init), transport);
    const call = calls.pop();
    assert.equal(call.args[0], url);
    assert.equal(call.args[1], init);
    assert.equal(call.args[2]?.bodyTimeoutMs, timeout);
    assert.equal(calls.length, 0, "one request must choose exactly one transport");
  }
});
