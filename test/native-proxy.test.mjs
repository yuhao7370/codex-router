import assert from "node:assert/strict";
import http from "node:http";
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

test("native proxy fetch forwards HTTP and tunnels HTTPS targets through Mihomo", async () => {
  assert.equal(typeof nativeProxy.nativeProxyFetch, "function");
  const upstream = http.createServer((_request, response) => {
    response.end("native upstream");
  });
  const upstreamPort = await listen(upstream);
  let forwardedTarget;
  // Undici 8 sends HTTP proxy requests in absolute form; HTTPS still uses
  // CONNECT. Check both protocols rather than making the HTTP fixture wait
  // forever for a tunnel that the client no longer opens.
  const proxy = http.createServer((request, response) => {
    forwardedTarget = request.url;
    const hop = http.request({ hostname: "127.0.0.1", port: upstreamPort, path: "/health" }, (result) => {
      response.writeHead(result.statusCode, result.headers);
      result.pipe(response);
    });
    hop.on("error", () => response.destroy());
    request.pipe(hop);
  });
  const sockets = new Set();
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  let connectTarget;
  proxy.on("connect", (request, client) => {
    connectTarget = request.url;
    // Deliberately refuse the TLS tunnel: routing can be proven without a
    // trusted test certificate or changing TLS verification in production.
    client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
  });
  const proxyPort = await listen(proxy);
  try {
    const fetchNative = nativeProxy.nativeProxyFetch({
      CODEX_ROUTER_NATIVE_PROXY_URL: `http://127.0.0.1:${proxyPort}`,
    });
    const response = await fetchNative("http://native.test/health", { signal: AbortSignal.timeout(5_000) });
    assert.equal(await response.text(), "native upstream");
    assert.equal(forwardedTarget, "http://native.test/health");
    assert.equal(connectTarget, undefined, "HTTP requests should use ordinary proxy forwarding");
    await assert.rejects(
      fetchNative("https://native.test/health", { signal: AbortSignal.timeout(5_000) }),
      /fetch failed/,
    );
    assert.equal(connectTarget, "native.test:443");
  } finally {
    // server.close does not close upgraded CONNECT sockets, and HTTP clients
    // may retain idle pooled sockets. Their lifetime belongs to this fixture.
    for (const socket of sockets) socket.destroy();
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
