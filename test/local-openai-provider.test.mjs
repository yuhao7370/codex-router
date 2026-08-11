import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { PROVIDERS } = await import("../src/model-registry.mjs");

function userModel(provider, upstreamModel) {
  const gatewayModel = `${provider}-${upstreamModel}`;
  return {
    slug: `${provider}/${upstreamModel}`,
    gatewayModel,
    upstreamModel,
    provider,
    listed: true,
    displayName: `${upstreamModel} (test)`,
    description: "Test-only local route.",
    priority: 100,
    defaultEffort: "high",
    reasoningLevels: [{ effort: "high", description: "Adaptive reasoning" }],
    contextWindow: 131072,
    autoCompact: 110000,
    inputModalities: ["text"],
    compHash: `${gatewayModel}-test-v1`,
  };
}

function renderWithLocalRoutes() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "local-openai-provider-test-"));
  const modelsPath = path.join(directory, "user-models.json");
  writeFileSync(
    modelsPath,
    JSON.stringify({
      version: 1,
      models: [
        userModel("local", "llama3.2:3b"),
        userModel("local-router", "deepseek-v4-flash"),
      ],
    }),
  );
  try {
    return execFileSync(
      process.execPath,
      [
        "-e",
        "const { renderLiteLlmConfig } = await import('./src/litellm-config.mjs'); process.stdout.write(renderLiteLlmConfig());",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, MODEL_ROUTER_USER_MODELS: modelsPath },
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("local-router is a keyless loopback Responses provider", () => {
  const provider = PROVIDERS.get("local-router");
  assert.equal(provider?.keyless, true);
  assert.equal(provider?.protocol, "openai-responses");
  assert.equal(provider?.baseUrl, "http://127.0.0.1:15721/v1");
});

test("local-router uses the Responses forwarder while local stays on Ollama", () => {
  const rendered = renderWithLocalRoutes();
  assert.match(rendered, /openai\/responses\/local-router-deepseek-v4-flash/);
  assert.match(rendered, /os\.environ\/CODEX_ROUTER_API_FORWARD_BASE_URL/);
  assert.doesNotMatch(rendered, /ollama_chat\/deepseek-v4-flash/);
  assert.match(rendered, /ollama_chat\/llama3\.2:3b/);
});

test("doctor sends catalog-only local-router users to curation instead of Ollama", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "local-router-doctor-test-"));
  writeFileSync(
    path.join(directory, "enabled-providers.json"),
    JSON.stringify({ version: 1, providers: ["local-router"] }),
  );
  try {
    const result = spawnSync(process.execPath, [path.join(root, "src", "doctor.mjs"), "--json"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: path.join(directory, "codex-home"),
        MODEL_ROUTER_STATE_DIR: directory,
      },
    });
    const report = JSON.parse(result.stdout);
    const check = report.checks.find(
      (entry) => entry.name === "Local Router (OpenAI-compatible) models",
    );
    assert.ok(check);
    assert.match(check.fix, /curate-models local-router/);
    assert.doesNotMatch(check.fix, /Ollama|local-models install/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
