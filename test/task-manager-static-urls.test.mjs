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
