# Keyless Local OpenAI Provider Design

## Goal

Install Codex Router with exactly two external provider families enabled:

- a keyless OpenAI-compatible local router at `http://127.0.0.1:15721/v1`;
- the official DeepSeek API, clearly distinguished from DeepSeek models exposed by the local router.

The change must preserve existing Codex models, profiles, settings, projects, MCP configuration, features, and ChatGPT login. It must not restart Codex or run a quota-consuming model request.

## Chosen approach

Add a distinct `local-router` provider instead of changing the existing `local` provider. The existing provider remains Ollama-specific and keeps its native `/api/chat` behavior. The new provider uses the already-supported OpenAI Responses forwarding path and has no credential because its base URL is restricted to loopback.

Alternatives rejected:

- Auto-detect the protocol behind the existing `local` provider: this adds runtime magic and risks breaking working Ollama installations.
- Reuse a hosted-provider identity with a dummy key: this mislabels the route, invents authentication, and violates the requested provider boundary.

## Provider registry

Add a catalog-only provider with these properties:

- ID: `local-router`
- Display name: `Local Router (OpenAI-compatible)`
- Kind: `openai-compatible`
- Protocol: `openai-responses`
- Base URL: `http://127.0.0.1:15721/v1`
- Base URL environment override: `MODEL_ROUTER_LOCAL_OPENAI_BASE_URL`
- Keyless: `true`

The registry's existing loopback validation remains the security boundary: a keyless provider may never point outside `127.0.0.1`, `localhost`, or `[::1]`.

## Routing and authentication

The request path is:

`Codex -> Codex Router -> LiteLLM -> API forwarder -> 127.0.0.1:15721/v1/responses`

The existing Ollama-only LiteLLM branch will apply only to the existing `local` provider. A keyless OpenAI-compatible provider follows the normal API-forwarder route. The API forwarder and model discovery omit both `Authorization` and `x-api-key` headers for keyless providers. No dummy, stored, environment, or ChatGPT credential is sent to the local service.

## Local model selection

Read the local router's `/v1/models` endpoint and curate every ordinary model ID currently advertised. Exclude every ID beginning with `anthropic/`, because those are duplicate protocol aliases for the same upstream models.

Curated entries use the repository's conservative defaults:

- text input only;
- `high` reasoning effort;
- 131,072-token context window;
- 110,000-token automatic compaction threshold.

No image, tool, context, or reasoning capability is inferred from a model name. Model display names retain the existing curated suffix; provider slugs begin with `local-router/`, which keeps their identity distinct from official providers.

The initial installation curates the current ordinary model list. Future changes to the local router's catalog require rerunning the same curation command; automatic background synchronization is out of scope.

## Official DeepSeek identity

Rename only the user-facing official provider and checked-in official model labels:

- Provider: `DeepSeek Official API`
- `DeepSeek V4 Flash (Official)`
- `DeepSeek V4 Pro (Official)`

Provider ID, model slugs, gateway IDs, upstream IDs, endpoints, and credential locations remain unchanged. The DeepSeek key is entered only through the repository's hidden interactive terminal prompt.

## Diagnostics and failure behavior

Doctor retains Ollama-specific instructions only for provider ID `local`. Other keyless catalog-only providers receive generic local-endpoint and `curate-models` guidance.

Installation stops if:

- the local endpoint is unavailable;
- `/v1/models` is invalid;
- an unknown legacy router is detected;
- DeepSeek authentication is not configured;
- doctor reports a failed managed layer.

Unselected provider credentials may remain warnings. No smoke test or live model completion is run without separate quota approval.

## Tests

Add or update focused regression tests proving:

- the new provider is keyless, loopback-only, and uses the Responses protocol;
- the existing `local` provider still renders `ollama_chat` and `num_ctx`;
- `local-router` renders through the API forwarder rather than the Ollama branch;
- keyless forwarding and discovery omit provider authorization headers;
- local discovery/capture filters `anthropic/` aliases during installation curation;
- doctor gives Ollama instructions only for `local` and curation instructions for `local-router`;
- official DeepSeek user-facing labels contain `Official`;
- the full repository check and test suites pass.

## Installation and preservation verification

After tests pass:

1. Curate the local router's ordinary model IDs into protected user state.
2. Enter the official DeepSeek credential in a visible interactive terminal with echo disabled.
3. Run the supported installer with providers `local-router,deepseek`, without migration or smoke-test flags.
4. Run Codex Router doctor and repair only managed layers if required.
5. Verify `auth.json` is byte-identical to its pre-install SHA-256 and confirm unrelated Codex configuration remains outside the router-owned managed blocks.
6. Leave Codex running and instruct the user to perform the final full quit and restart.

## Maintenance consequence

This is a committed local fork of the public checkout. The normal updater will refuse to overwrite tracked local changes. Future upstream updates must be fetched and merged or rebased manually; untracked credentials and protected router state remain outside Git.
