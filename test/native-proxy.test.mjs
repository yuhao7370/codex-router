import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import * as nativeProxy from "../src/native-proxy.mjs";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("native proxy URLs accept only credential-free HTTP(S) endpoints", () => {
  assert.equal(typeof nativeProxy.parseNativeProxyUrl, "function");
  assert.equal(
    nativeProxy.parseNativeProxyUrl("http://proxy.internal:7897"),
    "http://proxy.internal:7897",
  );
  for (const value of [
    "http://",
    "ftp://proxy.internal:7897",
    "http://proxy-user@proxy.internal:7897",
    "http://%ZZ@proxy.internal:7897",
  ]) {
    assert.throws(
      () => nativeProxy.parseNativeProxyUrl(value),
      /CODEX_ROUTER_NATIVE_PROXY_URL must be a valid credential-free HTTP or HTTPS proxy URL/,
    );
  }
});

test("router child environments remove generic proxy variables", () => {
  assert.equal(typeof nativeProxy.withoutGenericProxyEnvironment, "function");
  assert.deepEqual(
    nativeProxy.withoutGenericProxyEnvironment({
      CODEX_ROUTER_NATIVE_PROXY_URL: "http://proxy.internal:7897",
      HTTP_PROXY: "http://proxy.internal:7897",
      HTTPS_PROXY: "http://proxy.internal:7897",
      ALL_PROXY: "socks://proxy.internal:1080",
      NODE_USE_ENV_PROXY: "1",
      NO_PROXY: "localhost",
      http_proxy: "http://proxy.internal:7897",
      https_proxy: "http://proxy.internal:7897",
      all_proxy: "socks://proxy.internal:1080",
      node_use_env_proxy: "1",
      no_proxy: "localhost",
      KEEP: "value",
    }),
    {
      CODEX_ROUTER_NATIVE_PROXY_URL: "http://proxy.internal:7897",
      KEEP: "value",
    },
  );
});

test("native proxy fetch tunnels remote native targets through Mihomo", async () => {
  assert.equal(typeof nativeProxy.nativeProxyFetch, "function");
  const upstream = http.createServer((_request, response) => {
    response.setHeader("Connection", "close");
    response.end("native upstream");
  });
  const proxy = http.createServer();
  let connectTarget;
  proxy.on("connect", (request, client, head) => {
    connectTarget = request.url;
    const upstreamSocket = net.connect(awaitedUpstreamPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstreamSocket.write(head);
      client.pipe(upstreamSocket);
      upstreamSocket.pipe(client);
    });
    upstreamSocket.on("error", () => client.destroy());
  });
  const awaitedUpstreamPort = await listen(upstream);
  const proxyPort = await listen(proxy);
  try {
    const fetchNative = nativeProxy.nativeProxyFetch({
      CODEX_ROUTER_NATIVE_PROXY_URL: `http://127.0.0.1:${proxyPort}`,
    });
    const response = await fetchNative("http://native.test/health");
    assert.equal(await response.text(), "native upstream");
    assert.equal(connectTarget, "native.test:80");
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test("native proxy fetch bypasses loopback targets", async () => {
  assert.equal(typeof nativeProxy.nativeProxyFetch, "function");
  const upstream = http.createServer((_request, response) => response.end("loopback"));
  const proxy = http.createServer();
  let connects = 0;
  proxy.on("connect", (_request, client) => {
    connects += 1;
    client.destroy();
  });
  const upstreamPort = await listen(upstream);
  const proxyPort = await listen(proxy);
  try {
    const fetchNative = nativeProxy.nativeProxyFetch({
      CODEX_ROUTER_NATIVE_PROXY_URL: `http://127.0.0.1:${proxyPort}`,
    });
    const response = await fetchNative(`http://127.0.0.1:${upstreamPort}/health`);
    assert.equal(await response.text(), "loopback");
    assert.equal(connects, 0);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});
