import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { taskManagerPath } from "../src/caller-auth.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";
const capabilityPath = taskManagerPath(CALLER_KEY);

test("task manager assets emit only capability-relative browser URLs", () => {
  const documents = [
    ["task-manager-ui.html", capabilityPath],
    ["usage.html", `${capabilityPath}usage`],
    ["sub2api-converter.html", `${capabilityPath}converter`],
  ];

  for (const [file, pathname] of documents) {
    const source = readFileSync(path.join(root, "src", file), "utf8");
    assert.doesNotMatch(source, /(?:href|src)=["']\//, file);
    for (const match of source.matchAll(/(?:href|src)=["']([^"']+)["']/g)) {
      const emitted = new URL(match[1], `http://127.0.0.1:4111${pathname}`);
      assert.ok(emitted.pathname.startsWith(capabilityPath), `${file}: ${emitted.pathname}`);
    }
  }

  for (const file of ["task-manager-ui.html", "usage.html", "usage-panel.js"]) {
    const source = readFileSync(path.join(root, "src", file), "utf8");
    assert.doesNotMatch(source, /(?:api|fetch)\(["']\//, file);
    const pathname = file === "usage.html" ? `${capabilityPath}usage` : capabilityPath;
    for (const match of source.matchAll(/(?:api|fetch)\(["']([^"']+)["']/g)) {
      const emitted = new URL(match[1], `http://127.0.0.1:4111${pathname}`);
      assert.ok(emitted.pathname.startsWith(capabilityPath), `${file}: ${emitted.pathname}`);
    }
  }

  for (const file of ["task-manager-ui.html", "usage-panel.js"]) {
    const source = readFileSync(path.join(root, "src", file), "utf8");
    assert.match(source, /request\.method === ["']POST["']/, file);
    assert.match(source, /Content-Type["']?: ["']application\/json/, file);
    assert.match(source, /request\.body === undefined/, file);
  }
});

test("usage panel persists only a valid selected range", () => {
  const source = readFileSync(path.join(root, "src", "usage-panel.js"), "utf8");
  assert.match(source, /RANGE_STORAGE_KEY\s*=\s*["']usage-range["']/);
  assert.match(source, /Object\.hasOwn\(RANGE_NAMES,\s*value\)/);
  assert.match(source, /localStorage\.getItem\(RANGE_STORAGE_KEY\)/);
  assert.match(source, /validRange\(savedRange\)/);
  assert.match(source, /localStorage\.setItem\(RANGE_STORAGE_KEY,\s*next\)/);
  assert.match(source, /setRange\(range\)/);
});

test("usage panel queues the latest range selected during an active load", () => {
  const source = readFileSync(path.join(root, "src", "usage-panel.js"), "utf8");
  assert.match(source, /let reloadPending\s*=\s*false/);
  assert.match(source, /const requestedRange\s*=\s*range/);
  assert.match(source, /if \(requestedRange === range\) render\(data\)/);
  assert.match(source, /if \(reloadPending\) \{[\s\S]*reloadPending = false;[\s\S]*return load\(\)/);
  assert.match(source, /if \(loading\) reloadPending = true;[\s\S]*load\(\)/);
});
