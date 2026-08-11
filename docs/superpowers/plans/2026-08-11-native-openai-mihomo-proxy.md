# Native OpenAI Mihomo Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route only native GPT/OpenAI fetches through Mihomo at `http://127.0.0.1:7897` and persist five bounded native retries in the Windows service.

**Architecture:** The service wrapper persists native-only proxy and retry settings. `src/router.mjs` uses a pinned `undici` `ProxyAgent` only for native ChatGPT fetches, so supported Node 22.19+ releases do not depend on later environment-proxy support. LiteLLM and provider-forwarder children keep their original fetch paths. Existing native retry code remains unchanged and consumes the persisted tuning variables.

**Tech Stack:** Node.js 22.19+ ESM with pinned `undici`, Windows Task Scheduler service wrapper, Node test runner, PowerShell installer/service commands.

## Global Constraints

- Proxy only native GPT/OpenAI traffic; do not proxy DeepSeek Official, Kimi, Grok, or the local provider at `127.0.0.1:15721`.
- Use `http://127.0.0.1:7897` through an explicit `undici` `ProxyAgent`; keep the pinned direct dependency needed for Node 22.19+ compatibility.
- Persist `CODEX_ROUTER_NATIVE_RETRIES=5`, `CODEX_ROUTER_NATIVE_RETRY_BACKOFF_MS=100`, and `CODEX_ROUTER_NATIVE_RETRY_BUDGET_MS=10000`.
- Never retry 401, 403, 429, 500, partial streams, or client aborts.
- Never write ChatGPT tokens, provider keys, caller capabilities, proxy credentials, or unredacted protected URLs to source, tests, commands, or logs.
- Rebuild and restart only the Router background service. Leave the Codex application restart to the user.
- Do not run a quota-consuming model smoke test without separate approval.

---

### Task 1: Build the native-only proxy child environment

**Files:**
- Create: `src/native-proxy.mjs`
- Create: `test/native-proxy.test.mjs`
- Modify: `src/start.mjs:1-205`

**Interfaces:**
- Consumes: `CODEX_ROUTER_NATIVE_PROXY_URL` and an optional existing `NO_PROXY` from an environment object.
- Produces: `nativeProxyEnvironment(environment = process.env): Record<string, string>`, returning an empty object when no proxy is configured.
- `src/start.mjs` passes the returned object only as the `extraEnv` argument for the `src/router.mjs` child.

- [ ] **Step 1: Read the repository's good-test rules**

Run: `Get-Content -Raw C:\Users\yuhaofeng\.codex\plugins\cache\openai-curated-remote\superpowers\6.2.0\skills\test-driven-development\writing-good-tests.md`

Expected: rules require assertions on real behavior and a named production change that makes each test pass.

- [ ] **Step 2: Write the failing proxy-environment tests**

Create `test/native-proxy.test.mjs`:

```js
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
```

- [ ] **Step 3: Run the tests and verify RED**

Run: `node --test test/native-proxy.test.mjs`

Expected: FAIL because `src/native-proxy.mjs` does not exist.

- [ ] **Step 4: Implement the smallest proxy environment helper**

Create `src/native-proxy.mjs`:

```js
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
```

Modify `src/start.mjs` to import the helper and scope it to the frontend child:

```js
import { nativeProxyEnvironment } from "./native-proxy.mjs";
```

```js
const router = run(
  process.execPath,
  [path.join(SOURCE_ROOT, "src", frontend.script)],
  nativeProxyEnvironment(),
);
```

Do not pass this environment to the OAuth, API-forwarder, Grok, or LiteLLM `run(...)` calls.

- [ ] **Step 5: Run the proxy tests and syntax check**

Run: `node --test test/native-proxy.test.mjs`

Expected: 2 tests pass.

Run: `npm run check`

Expected: `syntax checks passed`.

- [ ] **Step 6: Commit the scoped proxy environment**

```powershell
git add src/native-proxy.mjs src/start.mjs test/native-proxy.test.mjs
git commit -m "feat: proxy native OpenAI traffic through Mihomo"
```

---

### Task 2: Persist the proxy and five retries in the Windows service

**Files:**
- Modify: `test/service-render.test.mjs:70-105`
- Modify: `src/service-windows.mjs:39-75`
- Modify: `test/native-retry.test.mjs:115-560`

**Interfaces:**
- Consumes: Windows wrapper rendering through `node src/service-windows.mjs render`.
- Produces: four non-secret wrapper variables: `CODEX_ROUTER_NATIVE_PROXY_URL`, `CODEX_ROUTER_NATIVE_RETRIES`, `CODEX_ROUTER_NATIVE_RETRY_BACKOFF_MS`, and `CODEX_ROUTER_NATIVE_RETRY_BUDGET_MS`.
- Existing `src/upstream-retry.mjs` consumes the three retry variables; no production retry algorithm changes are allowed.

- [ ] **Step 1: Write the failing Windows wrapper assertions**

Extend `background service definitions render for macOS, Linux, and Windows` in `test/service-render.test.mjs`:

```js
assert.match(
  windows,
  /set "CODEX_ROUTER_NATIVE_PROXY_URL=http:\/\/127\.0\.0\.1:7897"/,
);
assert.match(windows, /set "CODEX_ROUTER_NATIVE_RETRIES=5"/);
assert.match(windows, /set "CODEX_ROUTER_NATIVE_RETRY_BACKOFF_MS=100"/);
assert.match(windows, /set "CODEX_ROUTER_NATIVE_RETRY_BUDGET_MS=10000"/);
```

- [ ] **Step 2: Run the service-render test and verify RED**

Run: `node --test --test-name-pattern "background service definitions render" test/service-render.test.mjs`

Expected: FAIL because the Windows wrapper omits `CODEX_ROUTER_NATIVE_PROXY_URL`.

- [ ] **Step 3: Persist the four settings in the Windows wrapper**

Add these entries to the `variables` object in `src/service-windows.mjs`:

```js
CODEX_ROUTER_NATIVE_PROXY_URL:
  process.env.CODEX_ROUTER_NATIVE_PROXY_URL || "http://127.0.0.1:7897",
CODEX_ROUTER_NATIVE_RETRIES:
  process.env.CODEX_ROUTER_NATIVE_RETRIES || "5",
CODEX_ROUTER_NATIVE_RETRY_BACKOFF_MS:
  process.env.CODEX_ROUTER_NATIVE_RETRY_BACKOFF_MS || "100",
CODEX_ROUTER_NATIVE_RETRY_BUDGET_MS:
  process.env.CODEX_ROUTER_NATIVE_RETRY_BUDGET_MS || "10000",
```

This local Windows default is durable across reinstall and `doctor --fix`; explicit environment overrides remain possible.

- [ ] **Step 4: Run the service-render test and verify GREEN**

Run: `node --test --test-name-pattern "background service definitions render" test/service-render.test.mjs`

Expected: PASS.

- [ ] **Step 5: Add a five-retry behavior test**

Add these tests to `test/native-retry.test.mjs`:

```js
test("five native retries can rescue the sixth attempt", async () => {
  let attempts = 0;
  const native = await mockServer((_request, response) => {
    attempts += 1;
    response.writeHead(attempts <= 5 ? 503 : 200, {
      "Content-Type": "application/json",
    });
    response.end(JSON.stringify(attempts <= 5
      ? { error: { message: EDGE_503_BODY } }
      : { id: "resp-sixth-attempt", output: [] }));
  });
  const stateDir = stateDirectory();
  const routerPort = await openPort();
  const router = startRouter({
    nativePort: native.port,
    routerPort,
    stateDir,
    retries: 5,
    backoffMs: 1,
  });
  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const result = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
    });
    assert.equal(result.status, 200);
    assert.equal(attempts, 6);
  } finally {
    await stopChild(router);
    await closeServer(native.server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a native 403 is not retried even when five retries are configured", async () => {
  let attempts = 0;
  const native = await mockServer((_request, response) => {
    attempts += 1;
    response.writeHead(403, { "Content-Type": "text/html" });
    response.end("<html>forbidden</html>");
  });
  const stateDir = stateDirectory();
  const routerPort = await openPort();
  const router = startRouter({
    nativePort: native.port,
    routerPort,
    stateDir,
    retries: 5,
    backoffMs: 1,
  });
  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const result = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
    });
    assert.equal(result.status, 403);
    assert.equal(attempts, 1);
  } finally {
    await stopChild(router);
    await closeServer(native.server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});
```

The production change that makes the first assertion operationally active is the Windows wrapper's persisted retry value; the second test protects the unchanged non-retryable boundary.

- [ ] **Step 6: Run the focused retry tests**

Run: `node --test --test-name-pattern "five native retries|native 403" test/native-retry.test.mjs`

Expected: 2 tests pass.

- [ ] **Step 7: Commit the durable Windows settings**

```powershell
git add src/service-windows.mjs test/service-render.test.mjs test/native-retry.test.mjs
git commit -m "feat: persist native proxy and retry settings"
```

---

### Task 3: Regenerate the live service and verify routing boundaries

**Files:**
- Regenerate: `%USERPROFILE%\.codex\codex-router\start-codex-router.cmd`
- Verify only: `%USERPROFILE%\.codex\config.toml`, `%USERPROFILE%\.codex\auth.json`, `%USERPROFILE%\.codex\codex-router\router.log`

**Interfaces:**
- Consumes: the committed service generator and the existing protected Router state.
- Produces: a restarted Router background service whose 4102 child uses Mihomo for native fetches.

- [ ] **Step 1: Run the complete repository verification**

Run: `$env:Path="C:\Program Files\Git\bin;$env:Path"; npm test`

Expected: 0 failed tests.

Run: `npm run check`

Expected: `syntax checks passed`.

- [ ] **Step 2: Record preservation evidence before service regeneration**

Run:

```powershell
Get-FileHash "$env:USERPROFILE\.codex\auth.json" -Algorithm SHA256
Get-FileHash "$env:USERPROFILE\.codex\config.toml.pre-codex-router" -Algorithm SHA256
```

Expected: capture hashes without printing file contents.

- [ ] **Step 3: Regenerate and restart only the Router service**

Run:

```powershell
node .\src\service.mjs install
node .\src\wait-health.mjs
```

Expected: service installation succeeds and 4102 reports healthy. Do not restart Codex.

- [ ] **Step 4: Verify the generated wrapper without exposing secrets**

Run:

```powershell
Get-Content "$env:USERPROFILE\.codex\codex-router\start-codex-router.cmd" |
  Select-String 'CODEX_ROUTER_NATIVE_(PROXY_URL|RETRIES|RETRY_BACKOFF_MS|RETRY_BUDGET_MS)'
```

Expected: proxy URL `127.0.0.1:7897`, retries `5`, backoff `100`, budget `10000`.

- [ ] **Step 5: Verify Node's proxy behavior without a model request**

Run a one-off Node 24 process with the same environment and fetch a public non-model HTTPS endpoint through Mihomo. Do not send ChatGPT authentication headers:

```powershell
$env:NODE_USE_ENV_PROXY='1'
$env:HTTP_PROXY='http://127.0.0.1:7897'
$env:HTTPS_PROXY='http://127.0.0.1:7897'
$env:NO_PROXY='127.0.0.1,localhost,::1'
node -e "fetch('https://chatgpt.com/').then(r=>console.log(JSON.stringify({status:r.status}))).catch(e=>{console.error(e.name);process.exit(1)})"
```

Expected: the fetch reaches ChatGPT through Mihomo and prints an HTTP status;
403 is acceptable because this is an unauthenticated edge probe. Re-run
`node --test test/native-proxy.test.mjs` to verify provider-forwarder children
do not receive the scoped proxy environment. Do not dump process environments,
remote IPs, or secrets.

- [ ] **Step 6: Run doctor and preservation checks**

Run: `.\model-router.ps1 codex doctor`

Expected: exit 0; OpenAI sign-in authenticated, providers `local-router, deepseek`, Router healthy, and model catalog intact. Warnings for unselected providers are acceptable.

Re-run the `auth.json` hash and compare it byte-for-byte with Step 2. Confirm `config.toml.pre-codex-router` is unchanged.

- [ ] **Step 7: Inspect final repository state**

Run:

```powershell
git status --short
git log -3 --oneline
```

Expected: clean worktree and the two implementation commits above the design and plan commits.

Report that the Router service was restarted, no quota-consuming smoke test ran, and the Codex application restart remains the user's action.
