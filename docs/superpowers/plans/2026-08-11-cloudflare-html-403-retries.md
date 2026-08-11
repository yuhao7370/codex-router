# Cloudflare HTML 403 Retries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retry transient Cloudflare-marked HTML 403 responses on the native GPT/OpenAI path up to 20 times during a 60-second scheduling window.

**Architecture:** Extend the existing response classifier in `src/upstream-retry.mjs` so a 403 is eligible only when its headers identify a Cloudflare HTML response. Keep the existing pre-response retry loop, raise its hard retry ceiling to 20, cap each exponential delay at 3 seconds, and persist the approved 20/100/60000 defaults in the Windows service wrapper. No proxy or retry behavior is added to LiteLLM, DeepSeek, the local provider, or any provider forwarder.

**Tech Stack:** Node.js 24 ESM, built-in `fetch`/`Response`/`Headers`, `node:test`, Windows Task Scheduler service rendering.

## Global Constraints

- A retryable 403 must have status `403`, an HTML `Content-Type`, and a non-empty `cf-ray` header.
- JSON 403, unmarked HTML 403, 401, 429, 500, partial streams, and client aborts remain non-retryable.
- Configure at most 20 retries after the initial attempt, for at most 21 attempts.
- Use a 100 ms base delay, factor three, a 3,000 ms per-sleep cap, and a 60,000 ms scheduling budget.
- Do not forcibly abort an in-flight upstream request when the scheduling budget expires.
- Never log response bodies, response headers, ChatGPT authentication, provider keys, proxy credentials, or caller capability URLs.
- Keep the Mihomo environment confined to the native `router.mjs` child.
- Do not run a quota-consuming model smoke test.
- Leave the final Codex application restart to the user.

---

### Task 1: Classify Cloudflare HTML 403 responses

**Files:**
- Modify: `src/upstream-retry.mjs`
- Modify: `test/native-retry.test.mjs`

**Interfaces:**
- Consumes: a fetch-compatible response with numeric `status` and `headers.get(name)`.
- Produces: `isRetryableResponse(response): boolean`, used by `fetchWithRetry` for response failures; existing `isRetryableStatus(status): boolean` remains available for the status-only 5xx set.

- [ ] **Step 1: Write failing response-classification tests**

Add `isRetryableResponse` to the import from `src/upstream-retry.mjs` and add exact cases:

```js
test("only a Cloudflare-marked HTML 403 is retryable", () => {
  const response = (contentType, cfRay) => new Response("blocked", {
    status: 403,
    headers: {
      ...(contentType ? { "Content-Type": contentType } : {}),
      ...(cfRay ? { "cf-ray": cfRay } : {}),
    },
  });

  assert.equal(isRetryableResponse(response("text/html; charset=utf-8", "edge-ray")), true);
  assert.equal(isRetryableResponse(response("application/json", "edge-ray")), false);
  assert.equal(isRetryableResponse(response("text/html", undefined)), false);
  assert.equal(isRetryableResponse(new Response("error", { status: 500 })), false);
  assert.equal(isRetryableResponse(new Response("edge", { status: 503 })), true);
});
```

- [ ] **Step 2: Run the classifier test to verify RED**

Run:

```powershell
node --test --test-name-pattern "only a Cloudflare-marked HTML 403" test/native-retry.test.mjs
```

Expected: FAIL because `isRetryableResponse` is not exported.

- [ ] **Step 3: Implement the header-only classifier and use it in the loop**

Keep the status-only helper and add:

```js
export function isRetryableResponse(response) {
  const status = Number(response?.status);
  if (isRetryableStatus(status)) return true;
  if (status !== 403) return false;
  const contentType = String(response?.headers?.get?.("content-type") || "").trim();
  const cfRay = String(response?.headers?.get?.("cf-ray") || "").trim();
  return /^text\/html(?:\s*;|$)/i.test(contentType) && Boolean(cfRay);
}
```

In `fetchWithRetry`, replace the response branch of the retryability decision:

```js
const retryable = failure
  ? isRetryableTransportError(failure)
  : isRetryableResponse(response);
```

Update the surrounding comments so they describe the narrow Cloudflare HTML 403 exception and do not claim every 4xx is deterministic.

- [ ] **Step 4: Add native integration coverage**

Add this helper beside the existing retry scenarios:

```js
async function native403Scenario({ contentType, cfRay, failures }) {
  let attempts = 0;
  const native = await mockServer((_request, response) => {
    attempts += 1;
    if (attempts <= failures) {
      response.writeHead(403, {
        "Content-Type": contentType,
        ...(cfRay ? { "cf-ray": cfRay } : {}),
      });
      response.end("<html>blocked</html>");
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: "resp-after-edge-block", output: [] }));
  });
  const stateDir = stateDirectory();
  const routerPort = await openPort();
  const router = startRouter({
    nativePort: native.port,
    routerPort,
    stateDir,
    retries: 20,
    backoffMs: 1,
  });
  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const result = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
    });
    return { attempts, status: result.status };
  } finally {
    await stopChild(router);
    await closeServer(native.server);
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test("Cloudflare HTML 403 responses can recover on a later native attempt", async () => {
  const result = await native403Scenario({
    contentType: "text/html; charset=utf-8",
    cfRay: "test-ray",
    failures: 2,
  });
  assert.deepEqual(result, { attempts: 3, status: 200 });
});

test("a JSON 403 is not retried", async () => {
  const result = await native403Scenario({
    contentType: "application/json",
    cfRay: "test-ray",
    failures: 1,
  });
  assert.deepEqual(result, { attempts: 1, status: 403 });
});

test("an unmarked HTML 403 is not retried", async () => {
  const result = await native403Scenario({
    contentType: "text/html",
    cfRay: undefined,
    failures: 1,
  });
  assert.deepEqual(result, { attempts: 1, status: 403 });
});
```

Remove the old broad “native 403 is not retried” test after these narrower cases cover its safe behavior. Do not include a real Cloudflare body or ray identifier.

- [ ] **Step 5: Run Task 1 tests and checks**

Run:

```powershell
node --test --test-name-pattern "Cloudflare|JSON 403|unmarked HTML 403" test/native-retry.test.mjs
npm run check
git diff --check
```

Expected: all selected tests pass, syntax checks pass, and no whitespace errors are reported.

- [ ] **Step 6: Commit Task 1**

```powershell
git add src/upstream-retry.mjs test/native-retry.test.mjs
git commit -m "fix: retry transient Cloudflare HTML 403 responses"
```

---

### Task 2: Enforce 20 retries within the bounded schedule

**Files:**
- Modify: `src/upstream-retry.mjs`
- Modify: `test/native-retry.test.mjs`

**Interfaces:**
- Consumes: `fetchWithRetry(target, init, { retries, backoffMs, budgetMs, now, sleepImpl, fetchImpl })`.
- Produces: retry delays capped by internal policy constants; exported `NATIVE_RETRY_LIMIT` accepts values through 20.

- [ ] **Step 1: Write failing retry ceiling and delay tests**

Add deterministic tests using `fetchWithRetry` with injected `fetchImpl`, `sleepImpl`, and `now`:

```js
test("twenty retries permit a successful twenty-first attempt", async () => {
  let attempts = 0;
  const result = await fetchWithRetry("https://native.invalid", {}, {
    retries: 20,
    backoffMs: 0,
    budgetMs: 60_000,
    fetchImpl: async () => new Response("edge", { status: attempts++ < 20 ? 503 : 200 }),
  });
  assert.equal(result.response.status, 200);
  assert.equal(attempts, 21);
  assert.equal(result.retries, 20);
});

test("retry sleeps are capped at three seconds and stay inside the remaining budget", async () => {
  let clock = 0;
  let calls = 0;
  const delays = [];
  const result = await fetchWithRetry("https://native.invalid", {}, {
    retries: 20,
    backoffMs: 100,
    budgetMs: 10_000,
    now: () => clock,
    sleepImpl: async (delay) => {
      delays.push(delay);
      clock += delay;
    },
    fetchImpl: async () => {
      calls += 1;
      return new Response("edge", { status: 503 });
    },
  });
  assert.deepEqual(delays, [100, 300, 900, 2_700, 3_000]);
  assert.equal(Math.max(...delays), 3_000);
  assert.equal(delays.reduce((sum, delay) => sum + delay, 0), 7_000);
  assert.equal(calls, 6);
  assert.equal(result.response.status, 503);
});
```

Also change the import from `node:child_process` to include `spawnSync`, which Step 4 uses to test environment clamping.

- [ ] **Step 2: Run Task 2 tests to verify RED**

Run:

```powershell
node --test --test-name-pattern "twenty retries|retry sleeps" test/native-retry.test.mjs
```

Expected: at least the delay test fails because the current exponential delay is uncapped; a subprocess/config assertion added in the next step must also expose the current hard ceiling of five.

- [ ] **Step 3: Raise the ceiling and cap scheduled delay**

In `src/upstream-retry.mjs`, set:

```js
const MAX_RETRIES = 20;
const MAX_RETRY_DELAY_MS = 3_000;
```

Replace the unbounded delay calculation with a calculation that includes both caps:

```js
const elapsedMs = now() - startedAt;
const remainingMs = Math.max(0, budgetMs - elapsedMs);
if (remainingMs === 0) return settle(response, failure, attempt);
const delayMs = Math.min(
  backoffMs * BACKOFF_FACTOR ** attempt,
  MAX_RETRY_DELAY_MS,
  remainingMs,
);
if (!(delayMs < remainingMs)) return settle(response, failure, attempt);
```

Keep the existing abort and `canRetry` checks before body cancellation. The strict `delayMs < remainingMs` check must also happen before `discardBody(response)`, so the last upstream response remains relayable when there is not enough scheduling budget for another attempt.

- [ ] **Step 4: Verify environment clamping reaches 20**

Add a subprocess test that imports the module with `CODEX_ROUTER_NATIVE_RETRIES=20` and prints only `NATIVE_RETRY_LIMIT`:

```js
const result = spawnSync(
  process.execPath,
  ["--input-type=module", "-e", "import('./src/upstream-retry.mjs').then(m=>console.log(m.NATIVE_RETRY_LIMIT))"],
  {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CODEX_ROUTER_NATIVE_RETRIES: "20" },
  },
);
assert.equal(result.status, 0);
assert.equal(result.stdout.trim(), "20");
```

- [ ] **Step 5: Run the complete retry suite**

Run:

```powershell
node --test test/native-retry.test.mjs
npm run check
git diff --check
```

Expected: all retry tests pass, syntax checks pass, and no whitespace errors are reported.

- [ ] **Step 6: Commit Task 2**

```powershell
git add src/upstream-retry.mjs test/native-retry.test.mjs
git commit -m "feat: allow twenty bounded native retries"
```

---

### Task 3: Persist the approved Windows defaults

**Files:**
- Modify: `src/service-windows.mjs`
- Modify: `test/service-render.test.mjs`

**Interfaces:**
- Consumes: existing non-empty environment overrides for native retry settings.
- Produces: generated `start-codex-router.cmd` defaults of retries `20`, backoff `100`, and budget `60000`.

- [ ] **Step 1: Change the service-render assertions first**

In the Windows assertions of `background service definitions render for macOS, Linux, and Windows`, require:

```js
assert.match(windows, /set "CODEX_ROUTER_NATIVE_RETRIES=20"/);
assert.match(windows, /set "CODEX_ROUTER_NATIVE_RETRY_BACKOFF_MS=100"/);
assert.match(windows, /set "CODEX_ROUTER_NATIVE_RETRY_BUDGET_MS=60000"/);
```

Keep the existing proxy URL and credential-rejection assertions unchanged.

- [ ] **Step 2: Run the render test to verify RED**

Run:

```powershell
node --test --test-name-pattern "background service definitions render" test/service-render.test.mjs
```

Expected: FAIL because the wrapper still renders retries `5` and budget `10000`.

- [ ] **Step 3: Update only the Windows defaults**

In `src/service-windows.mjs`, change the fallback strings while retaining explicit environment override behavior:

```js
CODEX_ROUTER_NATIVE_RETRIES: process.env.CODEX_ROUTER_NATIVE_RETRIES || "20",
CODEX_ROUTER_NATIVE_RETRY_BACKOFF_MS:
  process.env.CODEX_ROUTER_NATIVE_RETRY_BACKOFF_MS || "100",
CODEX_ROUTER_NATIVE_RETRY_BUDGET_MS:
  process.env.CODEX_ROUTER_NATIVE_RETRY_BUDGET_MS || "60000",
```

- [ ] **Step 4: Run service and retry verification**

Run:

```powershell
node --test test/service-render.test.mjs test/native-retry.test.mjs
npm run check
git diff --check
```

Expected: all selected tests pass and syntax checks pass.

- [ ] **Step 5: Commit Task 3**

```powershell
git add src/service-windows.mjs test/service-render.test.mjs
git commit -m "chore: persist twenty native retries"
```

---

### Task 4: Integrate, regenerate the live service, and verify preservation

**Files:**
- Regenerate: `%USERPROFILE%\.codex\codex-router\start-codex-router.cmd`
- Verify only: `%USERPROFILE%\.codex\auth.json`
- Verify only: `%USERPROFILE%\.codex\config.toml.pre-codex-router`
- Verify only: `%USERPROFILE%\.codex\config.toml`

**Interfaces:**
- Consumes: reviewed commits merged into the installed checkout at `%LOCALAPPDATA%\codex-router`.
- Produces: a healthy Router service with native-only Mihomo proxying and the approved retry policy.

- [ ] **Step 1: Run complete verification on the feature branch**

```powershell
$env:Path="C:\Program Files\Git\bin;$env:Path"
npm test
npm run check
git diff --check
```

Expected: zero failed tests, `syntax checks passed`, and no diff errors.

- [ ] **Step 2: Complete the branch using the approved integration choice**

Use `superpowers:finishing-a-development-branch`. If the user selects local merge, fast-forward or merge the reviewed feature branch into `main`, then rerun `npm test` and `npm run check` in `%LOCALAPPDATA%\codex-router` before removing the owned worktree.

- [ ] **Step 3: Record preservation hashes without reading contents**

```powershell
Get-FileHash "$env:USERPROFILE\.codex\auth.json" -Algorithm SHA256
Get-FileHash "$env:USERPROFILE\.codex\config.toml.pre-codex-router" -Algorithm SHA256
```

Expected: record both hashes for comparison after service regeneration. Do not print either file's contents.

- [ ] **Step 4: Regenerate and restart only the Router service**

From `%LOCALAPPDATA%\codex-router`:

```powershell
node .\src\service.mjs install
node .\src\wait-health.mjs
```

Expected: installation succeeds and port 4102 reports healthy. Do not terminate or restart Codex.

- [ ] **Step 5: Verify generated settings without exposing secrets**

```powershell
Get-Content "$env:USERPROFILE\.codex\codex-router\start-codex-router.cmd" |
  Select-String 'CODEX_ROUTER_NATIVE_(PROXY_URL|RETRIES|RETRY_BACKOFF_MS|RETRY_BUDGET_MS)'
```

Expected: proxy `127.0.0.1:7897`, retries `20`, backoff `100`, and budget `60000`.

- [ ] **Step 6: Run non-quota verification and doctor**

```powershell
$env:NODE_USE_ENV_PROXY='1'
$env:HTTP_PROXY='http://127.0.0.1:7897'
$env:HTTPS_PROXY='http://127.0.0.1:7897'
$env:NO_PROXY='127.0.0.1,localhost,::1'
node -e "fetch('https://chatgpt.com/').then(r=>console.log(JSON.stringify({status:r.status}))).catch(e=>{console.error(e.name);process.exit(1)})"
node --test test/native-proxy.test.mjs
.\model-router.ps1 codex doctor
```

Expected: the unauthenticated probe returns an HTTP status through Mihomo, the proxy-scope tests pass, and doctor exits zero with the selected `local-router, deepseek` providers healthy. A probe 403 is acceptable. Do not attach ChatGPT authentication headers.

- [ ] **Step 7: Recheck preservation and repository state**

Re-run both hashes from Step 3 and require byte-for-byte equality. Run:

```powershell
git status --short
git log -8 --oneline
```

Expected: the installed checkout is clean and includes the reviewed retry commits. Report that the Router service was restarted, no quota-consuming model smoke test ran, and the final Codex application restart remains the user's action.
