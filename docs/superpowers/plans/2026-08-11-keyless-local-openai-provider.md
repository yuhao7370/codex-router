# Keyless Local OpenAI Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a keyless OpenAI-compatible loopback provider at `127.0.0.1:15721`, label the official DeepSeek routes unambiguously, and install both without changing unrelated Codex state or ChatGPT authentication.

**Architecture:** Register `local-router` as a catalog-only, keyless Responses provider while leaving the existing Ollama `local` provider unchanged. Reuse the API forwarder and user-model curation pipeline, with narrow keyless-header and diagnostic branches; curate the current non-`anthropic/` model IDs into protected user state.

**Tech Stack:** Node.js ES modules, Node test runner, JSON provider registry, PowerShell installer, LiteLLM, Codex Router doctor.

## Global Constraints

- Preserve existing Codex models, profiles, settings, projects, MCP configuration, features, and ChatGPT login.
- Never place a DeepSeek key in chat, command arguments, logs, environment snippets, or tracked files.
- Keep the existing `local` provider Ollama-specific and preserve its `/api/chat` plus bounded `num_ctx` behavior.
- Permit keyless routing only to loopback URLs.
- Import all ordinary IDs advertised by `http://127.0.0.1:15721/v1/models` and exclude every `anthropic/` alias.
- Use conservative curated metadata: text input, `high` effort, 131072 context, and 110000 auto-compaction.
- Enable exactly `local-router` and `deepseek` as external provider families.
- Do not run a smoke test or live model completion without separate quota approval.
- Do not restart or terminate Codex; the user performs the final restart.
- Keep all local fork changes committed so their maintenance boundary is explicit.

---

### Task 1: Register and route the keyless Responses provider

**Files:**
- Create: `config/local-router/local-router.json`
- Create: `test/local-openai-provider.test.mjs`
- Modify: `src/litellm-config.mjs:18-40`

**Interfaces:**
- Consumes: existing provider registry fields `id`, `kind`, `protocol`, `baseUrl`, `baseUrlEnv`, and `keyless`
- Produces: provider ID `local-router`; LiteLLM routes its curated models through `CODEX_ROUTER_API_FORWARD_BASE_URL`; provider ID `local` remains on `ollama_chat`

- [ ] **Step 1: Write the failing registry and LiteLLM test**

Create a temporary user-model file before importing the registry in a child process, then assert the provider and rendered route:

```js
test("local-router is a keyless loopback Responses provider", () => {
  const provider = PROVIDERS.get("local-router");
  assert.equal(provider.keyless, true);
  assert.equal(provider.protocol, "openai-responses");
  assert.equal(provider.baseUrl, "http://127.0.0.1:15721/v1");
});

test("local-router uses the Responses forwarder while local stays on Ollama", () => {
  const rendered = renderWithUserModel({
    slug: "local-router/deepseek-v4-flash",
    gatewayModel: "local-router-deepseek-v4-flash",
    upstreamModel: "deepseek-v4-flash",
    provider: "local-router",
  });
  assert.match(rendered, /openai\/responses\/local-router-deepseek-v4-flash/);
  assert.match(rendered, /CODEX_ROUTER_API_FORWARD_BASE_URL/);
  assert.doesNotMatch(rendered, /ollama_chat\/deepseek-v4-flash/);
  assert.match(rendered, /ollama_chat\//);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/local-openai-provider.test.mjs`

Expected: FAIL because `PROVIDERS.get("local-router")` is undefined and the route is absent.

- [ ] **Step 3: Add the provider definition**

Create `config/local-router/local-router.json`:

```json
{
  "version": 1,
  "providers": [
    {
      "id": "local-router",
      "displayName": "Local Router (OpenAI-compatible)",
      "kind": "openai-compatible",
      "protocol": "openai-responses",
      "ownedBy": "local",
      "baseUrl": "http://127.0.0.1:15721/v1",
      "baseUrlEnv": "MODEL_ROUTER_LOCAL_OPENAI_BASE_URL",
      "keyless": true,
      "planNote": "Runs through the OpenAI-compatible service on this machine."
    }
  ]
}
```

- [ ] **Step 4: Narrow the Ollama LiteLLM branch**

Change the existing condition in `renderLiteLlmConfig()` from all keyless providers to the Ollama provider only:

```js
if (provider.id === "local") {
```

All other providers, including keyless `local-router`, continue through the existing protocol-aware forwarder branch.

- [ ] **Step 5: Run focused and registry tests and verify GREEN**

Run: `node --test test/local-openai-provider.test.mjs test/registry.test.mjs`

Expected: PASS, including the existing Ollama native-protocol regression.

- [ ] **Step 6: Commit**

```powershell
git add config/local-router/local-router.json src/litellm-config.mjs test/local-openai-provider.test.mjs
git commit -m "feat: add keyless local OpenAI provider"
```

### Task 2: Omit authentication and filter duplicate aliases

**Files:**
- Modify: `src/api-forwarder.mjs:498-525`
- Modify: `src/model-discovery.mjs:13-55`
- Modify: `test/local-openai-provider.test.mjs`
- Modify: `test/model-discovery.test.mjs`
- Modify: `test/routing.test.mjs`

**Interfaces:**
- Consumes: `provider.keyless` and `provider.id`
- Produces: `providerCatalogHeaders(provider, credential): Record<string, string>`; keyless upstream requests contain no provider authorization header; `modelIds(payload, localRouter)` excludes `anthropic/` IDs

- [ ] **Step 1: Write the failing discovery tests**

```js
test("local-router discovery drops duplicate anthropic aliases", () => {
  const localRouter = PROVIDERS.get("local-router");
  assert.deepEqual(
    modelIds(
      { data: [{ id: "deepseek-v4-pro" }, { id: "anthropic/deepseek-v4-pro" }] },
      localRouter,
    ),
    ["deepseek-v4-pro"],
  );
});

test("keyless discovery sends no authorization header", () => {
  const provider = PROVIDERS.get("local-router");
  assert.deepEqual(providerCatalogHeaders(provider, { value: "local" }), {});
});
```

- [ ] **Step 2: Write the failing forwarder integration test**

Use the existing `mockServer`, `run`, `openPort`, `waitFor`, and protected user-model fixture helpers in `test/routing.test.mjs`. Send a Responses request for `local-router-deepseek-v4-pro` and assert the mock upstream receives neither header:

```js
assert.equal(upstreamHeaders.authorization, undefined);
assert.equal(upstreamHeaders["x-api-key"], undefined);
```

- [ ] **Step 3: Run both focused tests and verify RED**

Run: `node --test test/model-discovery.test.mjs test/routing.test.mjs`

Expected: FAIL because discovery retains the alias and both discovery/forwarding currently synthesize `Bearer local`.

- [ ] **Step 4: Implement the minimal discovery behavior**

Export a single header helper and reuse it in `providerPayload()`:

```js
export function providerCatalogHeaders(provider, credential) {
  if (provider.keyless) return {};
  return provider.protocol === "anthropic"
    ? { "x-api-key": credential.value, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${credential.value}` };
}
```

Filter only the selected local-router aliases in `modelIds()`:

```js
const visible = provider?.id === "local-router"
  ? candidates.filter((item) => !String(item?.id || "").startsWith("anthropic/"))
  : candidates;
```

Build the unique sorted IDs from `visible`.

- [ ] **Step 5: Implement the minimal forwarder behavior**

In `upstreamHeaders()`, keep the existing protocol-specific authentication logic behind a keyless guard:

```js
if (!provider.keyless) {
  if (provider.protocol === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] ||= "2023-06-01";
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
}
```

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `node --test test/model-discovery.test.mjs test/routing.test.mjs test/local-openai-provider.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/api-forwarder.mjs src/model-discovery.mjs test/model-discovery.test.mjs test/routing.test.mjs test/local-openai-provider.test.mjs
git commit -m "fix: keep keyless local requests unauthenticated"
```

### Task 3: Make doctor distinguish Ollama from a catalog-only local router

**Files:**
- Modify: `src/doctor.mjs:540-585`
- Modify: `test/local-openai-provider.test.mjs`

**Interfaces:**
- Consumes: provider IDs and `providerNeedsCuration(provider.id)`
- Produces: Ollama-specific fix text only for `local`; `local-router` fix text points to `curate-models local-router`

- [ ] **Step 1: Write the failing doctor test**

Run doctor with isolated `CODEX_HOME`, `MODEL_ROUTER_STATE_DIR`, and an enabled-provider file containing `local-router`. Parse `--json`, select the `Local Router (OpenAI-compatible) models` check, and assert:

```js
assert.match(check.fix, /curate-models local-router/);
assert.doesNotMatch(check.fix, /Ollama|local-models install/);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/local-openai-provider.test.mjs`

Expected: FAIL because doctor treats every keyless provider as Ollama.

- [ ] **Step 3: Implement provider-specific diagnostic text**

Introduce the local discriminator inside the existing provider loop:

```js
const ollamaLocal = provider.id === "local";
```

Use `ollamaLocal` for the two Ollama-only fixes and use these fallbacks for other keyless providers:

```js
`Start ${provider.displayName} at ${provider.baseUrl}.`
`Run ./bin/curate-models ${provider.id} in an interactive terminal.`
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/local-openai-provider.test.mjs test/local-models.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/doctor.mjs test/local-openai-provider.test.mjs
git commit -m "fix: distinguish local router diagnostics from Ollama"
```

### Task 4: Label official DeepSeek routes

**Files:**
- Modify: `config/deepseek/deepseek.json`
- Modify: `config/deepseek/deepseek-v4-flash.json`
- Modify: `config/deepseek/deepseek-v4-pro.json`
- Modify: `test/local-openai-provider.test.mjs`
- Modify only if they fail: `test/provider-key.test.mjs`, `test/setup-ui.test.mjs`, `test/setup-exit-codes.test.mjs`

**Interfaces:**
- Consumes: existing provider/model identities
- Produces: user-facing labels `DeepSeek Official API`, `DeepSeek V4 Flash (Official)`, and `DeepSeek V4 Pro (Official)` without changing IDs or endpoints

- [ ] **Step 1: Write the failing label test**

```js
test("official DeepSeek routes are labeled Official", () => {
  assert.equal(PROVIDERS.get("deepseek").displayName, "DeepSeek Official API");
  assert.equal(MODEL_BY_SLUG.get("deepseek/deepseek-v4-flash").displayName, "DeepSeek V4 Flash (Official)");
  assert.equal(MODEL_BY_SLUG.get("deepseek/deepseek-v4-pro").displayName, "DeepSeek V4 Pro (Official)");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/local-openai-provider.test.mjs`

Expected: FAIL because the current labels say `DeepSeek API` and `(API)`.

- [ ] **Step 3: Change only display strings**

Update the three registry JSON files with the exact approved strings. Do not change provider ID, slug, `gatewayModel`, `upstreamModel`, `baseUrl`, or credential metadata.

- [ ] **Step 4: Run affected tests and update exact string expectations**

Run: `node --test test/local-openai-provider.test.mjs test/provider-key.test.mjs test/setup-ui.test.mjs test/setup-exit-codes.test.mjs`

Update only assertions whose user-facing DeepSeek text intentionally changed. Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add config/deepseek test/local-openai-provider.test.mjs test/provider-key.test.mjs test/setup-ui.test.mjs test/setup-exit-codes.test.mjs
git commit -m "chore: label official DeepSeek routes"
```

### Task 5: Verify the local fork before installation

**Files:**
- Verify only: all tracked source and test files

**Interfaces:**
- Consumes: Tasks 1-4 commits
- Produces: clean passing repository checks with no generated tracked changes

- [ ] **Step 1: Run static checks**

Run: `npm run check`

Expected: exit 0.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`

Expected: all tests pass with exit 0.

- [ ] **Step 3: Check the diff**

Run: `git diff HEAD~4 --check` and `git status --short`.

Expected: no whitespace errors and no uncommitted tracked changes.

### Task 6: Curate, authenticate, install, and diagnose

**Files:**
- Protected state: `%USERPROFILE%\.codex\codex-router\user-models.json`
- Protected credential: router-managed DeepSeek credential file
- Managed config blocks only: `%USERPROFILE%\.codex\config.toml`
- Must remain byte-identical: `%USERPROFILE%\.codex\auth.json`

**Interfaces:**
- Consumes: healthy local `/v1/models`, interactive DeepSeek credential entry, passing repository tests
- Produces: selected providers `local-router,deepseek`, running Codex Router service, passing doctor report

- [ ] **Step 1: Reconfirm endpoint and capture non-secret pre-install hashes**

Run read-only checks against `/health`, `/v1/models`, and `OPTIONS /v1/responses`. Record SHA-256 for `auth.json` and `config.toml` without printing contents. Require the legacy detector to report no installations and no unknown conflict.

- [ ] **Step 2: Curate the ordinary local model IDs without applying**

Use Node to fetch `/v1/models`, select unique IDs that do not start with `anthropic/`, join them with commas, and pass the result to:

```powershell
node .\src\curate-models.mjs local-router --models $modelIds --no-apply
```

Verify the output reports 31 curated models and the protected user-model file contains no provider model whose `upstreamModel` begins with `anthropic/`.

- [ ] **Step 3: Open the hidden DeepSeek credential prompt**

Launch a visible PowerShell terminal in the stable checkout running:

```powershell
.\model-router.ps1 codex provider-key deepseek set
```

The user types the key directly into the echo-disabled terminal. Poll only `.\model-router.ps1 codex provider-key deepseek status` until it reports configured; never inspect the credential file.

- [ ] **Step 4: Run the supported installer**

Prepend the existing bundled Python 3.12 directory to `PATH`, then run from `%LOCALAPPDATA%\codex-router`:

```powershell
.\install.ps1 -Target codex -Auto -Providers local-router,deepseek
```

Do not pass `-MigrateKnown` because detection is clear. Do not pass `-SmokeTest`.

- [ ] **Step 5: Run doctor**

Run:

```powershell
.\model-router.ps1 codex doctor
```

Require core config, config privacy, catalog, caller capability, internal key, service, router health, Local Router endpoint, and DeepSeek Official API key to be `OK`. Unselected credentials may be `WARN`.

- [ ] **Step 6: Repair only if a managed layer fails**

Run `.\model-router.ps1 codex doctor --fix` only when a managed layer fails. Do not add `--migrate-known`. If repair still fails, run `.\bin\support-bundle` through its Windows-compatible entry point and report the local path without uploading it.

- [ ] **Step 7: Verify preservation**

Recompute the SHA-256 of `%USERPROFILE%\.codex\auth.json` and require it to equal the pre-install value `C46AE411E4F5CF7AA50068C2BD8C65457CD9396BCAEDDC3AFF0CF92E030708B7`. Run config-manager status and doctor to confirm only router-owned blocks were added; do not print credential contents or the complete managed caller URL.

- [ ] **Step 8: Hand off the final restart**

Leave Codex running. Tell the user to fully quit Codex, reopen it, create a new task, and choose either a `local-router/...` model or an `(Official)` DeepSeek model.
