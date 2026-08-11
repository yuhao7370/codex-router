# Native OpenAI Mihomo Proxy Design

## Goal

Route only native GPT/OpenAI traffic from Codex Router through the local
Mihomo HTTP/mixed proxy at `http://127.0.0.1:7897`. Keep DeepSeek Official,
the keyless local router at `127.0.0.1:15721`, and every other routed provider
on their existing paths. Increase the router's native-upstream retry limit to
five retries, which is greater than Codex's documented default of four.

## Current State

Codex keeps the built-in `openai` provider but sends Responses requests to the
authenticated loopback entry point on port 4102. Native models such as
`gpt-5.6-sol` are forwarded directly by `src/router.mjs` to
`https://chatgpt.com/backend-api/codex`; routed providers go through LiteLLM on
4100 and the provider forwarders on 4101, 4103, or 4108.

Windows system proxy is enabled at `127.0.0.1:7897`, but the router service has
no proxy environment and no Mihomo TUN route is active. Node fetch therefore
does not currently use the Windows proxy setting.

## Design

### Scoped proxy environment

The Windows service wrapper will persist these native-route settings:

```text
CODEX_ROUTER_NATIVE_PROXY_URL=http://127.0.0.1:7897
CODEX_ROUTER_NATIVE_RETRIES=5
CODEX_ROUTER_NATIVE_RETRY_BACKOFF_MS=100
CODEX_ROUTER_NATIVE_RETRY_BUDGET_MS=10000
```

`src/router.mjs` will create an explicit `undici` `ProxyAgent` from
`CODEX_ROUTER_NATIVE_PROXY_URL` and pass it only to native ChatGPT fetches.
This avoids Node's environment-proxy support, which is unavailable in the
supported Node 22.19 and 22.20 releases. LiteLLM, API-forwarder, Kimi, and
Grok keep the ordinary fetch path; loopback native targets also bypass the
proxy.

### Retry behavior

The existing retry implementation remains unchanged except for its service
configuration. It may retry only 502, 503, 504, Cloudflare 520-524, and eligible
transport failures before any response byte reaches Codex. It must not retry
401, 403, 429, 500, partial streams, or client aborts.

Five router retries can multiply with Codex retries. The smaller 100 ms base
backoff and 10-second start budget limit the router's contribution while still
allowing five fast edge failures to be replayed. Retry attempts remain visible
in the router log and usage events.

## Persistence and compatibility

The settings belong in the Windows service generator rather than a hand-edited
generated `.cmd` file. Reinstalling or running `doctor --fix` will regenerate
the same settings. The implementation adds a pinned direct `undici` dependency.
Its supported Node floor is below this router's Node 22.19 floor, and its
explicit `ProxyAgent` API is tested on Node 22.19 and 22.20. macOS and Linux
service definitions remain unchanged.

If Mihomo moves away from port 7897, the configured native proxy URL must be
updated and the router service regenerated. A missing or unreachable proxy
will produce an ordinary native upstream transport failure; it must never fall
back silently to a direct connection.

## Security

No ChatGPT token, provider key, caller capability, or proxy credential is
written to source, logs, command arguments, or tests. Only the loopback proxy
URL is persisted. Existing caller and internal capability checks remain in
place.

## Verification

1. A service-render test proves the Windows wrapper persists the proxy and
   retry settings without exposing secrets.
2. A startup-environment test proves only the router child receives
   `NODE_USE_ENV_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY`, and loopback `NO_PROXY`.
3. Existing native retry tests prove five eligible failures are replayed and
   that 403 remains non-retryable.
4. The full test suite and syntax check pass.
5. Regenerate and restart only the Router background service, then run doctor.
6. Verify Mihomo sees a ChatGPT connection while DeepSeek and local-provider
   paths retain their existing process environments. Do not issue a
   quota-consuming model smoke test without separate approval.

Codex application restart remains the user's final step.
