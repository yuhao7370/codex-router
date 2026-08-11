# Cloudflare HTML 403 Retry Design

## Goal

Allow the native GPT/OpenAI path to recover from the intermittent Cloudflare
HTML 403 response observed at the ChatGPT edge. Retry at most 20 times during a
60-second scheduling window without retrying genuine OpenAI authentication or
authorization failures.

This specification supersedes only the retry limits and 403 classification in
`2026-08-11-native-openai-mihomo-proxy-design.md`. Proxy scoping, provider
isolation, credential handling, and the prohibition on quota-consuming smoke
tests remain unchanged.

## Response classification

A 403 is retryable only when all three conditions are true:

1. The HTTP status is 403.
2. `Content-Type` identifies an HTML response.
3. A `cf-ray` response header is present.

This classification is available from response headers, so the router does
not need to read, log, or retain the Cloudflare response body. JSON 403
responses and 403 responses without these Cloudflare HTML markers remain
non-retryable. Existing handling of 401, 429, 500, partial streams, and client
aborts remains unchanged.

## Retry limits and timing

The Windows service wrapper will persist:

```text
CODEX_ROUTER_NATIVE_RETRIES=20
CODEX_ROUTER_NATIVE_RETRY_BACKOFF_MS=100
CODEX_ROUTER_NATIVE_RETRY_BUDGET_MS=60000
```

The retry implementation will accept at most 20 retries after the initial
attempt, for at most 21 upstream attempts. Delay still grows by a factor of
three, but each sleep is capped at 3,000 ms. Before sleeping, the delay is also
limited to the remaining scheduling budget. No new retry is scheduled after
the 60-second budget is exhausted.

The budget governs retry scheduling rather than forcibly aborting an in-flight
upstream request. A request already sent near the deadline may therefore make
wall-clock duration exceed 60 seconds. This avoids terminating a valid model
response merely to enforce a strict stopwatch deadline.

The same numeric limit continues to cover the already eligible 502, 503, 504,
Cloudflare 520-524, and transport failures. The new 403 eligibility is narrower
than those status-only rules because it requires both Cloudflare and HTML
markers.

## Safety and observability

Retries remain legal only before any response byte reaches Codex. A caller
abort stops the sleep and prevents further attempts. Each retry continues to
log only the attempt count, status or transport class, model, route, and delay;
response bodies, headers, tokens, and caller capability URLs are never logged.

The proxy stays confined to the native `router.mjs` child. DeepSeek Official,
the local provider at `127.0.0.1:15721`, LiteLLM, and every provider forwarder
remain outside this proxy and retry path.

## Verification

1. Unit tests classify only Cloudflare-marked HTML 403 responses as retryable.
2. A native integration test proves a sequence of eligible HTML 403 responses
   can recover on a later attempt.
3. Tests prove JSON 403 and unmarked HTML 403 responses are relayed after one
   attempt.
4. Retry timing tests prove the 3,000 ms delay cap and the 60-second remaining
   budget bound.
5. Service-render tests prove the persisted values are 20, 100, and 60000.
6. The full repository test suite, syntax check, Router health check, and Codex
   doctor pass without a quota-consuming model request.

