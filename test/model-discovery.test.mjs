import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { PROVIDERS } = await import("../src/model-registry.mjs");
const { discoverProviderModels, discoveredMetadata, modelIds } = await import(
  "../src/model-discovery.mjs"
);

async function localServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(typeof address === "object" && address);
  return { server, port: address.port };
}

test("model discovery compares fixtures without needing or exposing a key", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-discovery-"));
  const fixture = path.join(testRoot, "models.json");
  writeFileSync(
    fixture,
    JSON.stringify({ data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-v5-preview" }] }),
  );
  try {
    const output = execFileSync(
      process.execPath,
      ["src/model-discovery.mjs", "deepseek", "--fixture", fixture, "--json"],
      { cwd: root, encoding: "utf8", env: { ...process.env, DEEPSEEK_API_KEY: "" } },
    );
    const result = JSON.parse(output);
    assert.deepEqual(result.unregistered, ["deepseek-v5-preview"]);
    assert.ok(result.unavailable.includes("deepseek-v4-flash"));
    assert.doesNotMatch(output, /Bearer|api[_-]?key/i);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Command Code discovery parses the Provider API model list", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-commandcode-discovery-"));
  const fixture = path.join(testRoot, "models.json");
  writeFileSync(
    fixture,
    JSON.stringify({
      object: "list",
      data: [{ id: "deepseek/deepseek-v4-flash" }, { id: "claude-sonnet-4-6" }],
    }),
  );
  try {
    const output = execFileSync(
      process.execPath,
      ["src/model-discovery.mjs", "commandcode", "--fixture", fixture, "--json"],
      { cwd: root, encoding: "utf8", env: { ...process.env, COMMAND_CODE_API_KEY: "" } },
    );
    const result = JSON.parse(output);
    assert.deepEqual(result.unregistered, ["claude-sonnet-4-6"]);
    assert.ok(result.unavailable.includes("deepseek/deepseek-v4-pro"));
    assert.doesNotMatch(output, /Bearer|api[_-]?key/i);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Copilot discovery exposes only account-enabled Responses models with tools", () => {
  const payload = {
    data: [
      {
        id: "gpt-responses",
        // Copilot CLI integrations currently receive picker=false even for
        // account-enabled models; policy is the account entitlement signal.
        model_picker_enabled: false,
        policy: { state: "enabled" },
        supported_endpoints: ["/responses", "/chat/completions"],
        capabilities: { supports: { tool_calls: true, streaming: true } },
      },
      {
        id: "chat-only",
        model_picker_enabled: true,
        policy: { state: "enabled" },
        supported_endpoints: ["/chat/completions"],
        capabilities: { supports: { tool_calls: true, streaming: true } },
      },
      {
        id: "no-tools",
        model_picker_enabled: true,
        policy: { state: "enabled" },
        supported_endpoints: ["/responses"],
        capabilities: { supports: { tool_calls: false, streaming: true } },
      },
      {
        id: "policy-disabled",
        model_picker_enabled: true,
        policy: { state: "disabled" },
        supported_endpoints: ["/responses"],
        capabilities: { supports: { tool_calls: true, streaming: true } },
      },
      {
        id: "utility",
        policy: { state: "unconfigured" },
        supported_endpoints: ["/responses"],
        capabilities: { supports: { tool_calls: true, streaming: true } },
      },
      {
        id: "accounts/router/internal",
        object: "model",
        model_picker_enabled: true,
        policy: { state: "enabled" },
        supported_endpoints: ["/responses"],
        capabilities: { type: "chat", supports: { tool_calls: true, streaming: true } },
      },
      {
        id: "embedding-record",
        object: "embedding",
        model_picker_enabled: true,
        policy: { state: "enabled" },
        supported_endpoints: ["/responses"],
        capabilities: { supports: { tool_calls: true, streaming: true } },
      },
      {
        id: "non-chat",
        object: "model",
        model_picker_enabled: true,
        policy: { state: "enabled" },
        supported_endpoints: ["/responses"],
        capabilities: { type: "embedding", supports: { tool_calls: true, streaming: true } },
      },
    ],
  };
  assert.deepEqual(modelIds(payload, PROVIDERS.get("github-copilot")), ["gpt-responses"]);
});

test("local-router discovery is unauthenticated and drops anthropic aliases", async () => {
  let headers;
  const local = await localServer((request, response) => {
    headers = request.headers;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      object: "list",
      data: [
        { id: "deepseek-v4-pro", object: "model" },
        { id: "anthropic/deepseek-v4-pro", object: "model" },
      ],
    }));
  });
  const previous = process.env.MODEL_ROUTER_LOCAL_OPENAI_BASE_URL;
  process.env.MODEL_ROUTER_LOCAL_OPENAI_BASE_URL = `http://127.0.0.1:${local.port}/v1`;
  try {
    const result = await discoverProviderModels("local-router");
    assert.deepEqual(result.discovered, ["deepseek-v4-pro"]);
    assert.equal(headers.authorization, undefined);
    assert.equal(headers["x-api-key"], undefined);
  } finally {
    if (previous === undefined) delete process.env.MODEL_ROUTER_LOCAL_OPENAI_BASE_URL;
    else process.env.MODEL_ROUTER_LOCAL_OPENAI_BASE_URL = previous;
    await new Promise((resolve) => local.server.close(resolve));
  }
});

test("discoveredMetadata honors sizing and effort capabilities from /v1/models", () => {
  const metadata = discoveredMetadata({
    id: "deepseek-v4-pro",
    max_input_tokens: 1000000,
    capabilities: {
      image_input: { supported: true },
      effort: {
        supported: true,
        low: { supported: false },
        medium: { supported: false },
        high: { supported: true },
        max: { supported: false },
        xhigh: { supported: false },
      },
    },
  });
  assert.deepEqual(metadata, {
    contextWindow: 1000000,
    autoCompact: 850000,
    inputModalities: ["text", "image"],
    reasoningLevels: [{ effort: "high", description: "Deep reasoning" }],
    defaultEffort: "high",
  });
});

test("discoveredMetadata returns empty metadata for entries without capabilities", () => {
  assert.deepEqual(discoveredMetadata({ id: "deepseek-v4-pro" }), {});
  assert.deepEqual(discoveredMetadata(null), {});
  assert.deepEqual(discoveredMetadata({ id: "x", max_input_tokens: 0 }), {});
});

test("discoverProviderModels captures real metadata for local-router models", async () => {
  const local = await localServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      object: "list",
      data: [
        {
          id: "deepseek-v4-pro",
          max_input_tokens: 1000000,
          capabilities: {
            image_input: { supported: false },
            effort: { high: { supported: true }, max: { supported: false } },
          },
        },
        { id: "no-capabilities" },
      ],
    }));
  });
  const previous = process.env.MODEL_ROUTER_LOCAL_OPENAI_BASE_URL;
  process.env.MODEL_ROUTER_LOCAL_OPENAI_BASE_URL = `http://127.0.0.1:${local.port}/v1`;
  try {
    const result = await discoverProviderModels("local-router");
    assert.equal(result.metadataById["deepseek-v4-pro"].contextWindow, 1000000);
    assert.deepEqual(
      result.metadataById["deepseek-v4-pro"].reasoningLevels.map((level) => level.effort),
      ["high"],
    );
    assert.equal(result.metadataById["no-capabilities"], undefined);
  } finally {
    if (previous === undefined) delete process.env.MODEL_ROUTER_LOCAL_OPENAI_BASE_URL;
    else process.env.MODEL_ROUTER_LOCAL_OPENAI_BASE_URL = previous;
    await new Promise((resolve) => local.server.close(resolve));
  }
});
