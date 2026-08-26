import assert from "node:assert/strict";
import test from "node:test";

import { openTaskManager } from "../src/task-manager-open.mjs";

const CALLER_KEY = "test-task-manager-caller-capability-with-sufficient-length";
const CONTROL_PORT = 46111;
const ORIGIN = `http://127.0.0.1:${CONTROL_PORT}`;

function response(status, body) {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
  });
}

test("standalone health opens the capability URL without printing the capability", async () => {
  const opened = [];
  const output = [];
  const requested = [];
  const result = await openTaskManager({
    controlPort: CONTROL_PORT,
    classifyOwner: async () => "standalone",
    readCallerSecret: () => CALLER_KEY,
    fetchImpl: async (url, options) => {
      requested.push([String(url), options?.method]);
      return response(200, {
        ok: true,
        service: "codex-router-task-manager",
        mode: "standalone",
        pid: 123,
      });
    },
    openBrowser: async (url) => opened.push(url),
    writeOutput: (value) => output.push(value),
  });

  assert.deepEqual(requested, [[`${ORIGIN}/health`, "GET"]]);
  assert.deepEqual(opened, [`${ORIGIN}/_codex-router/${CALLER_KEY}/task-manager/`]);
  assert.deepEqual(result, { url: opened[0], mode: "standalone" });
  assert.equal(output.join("").includes(CALLER_KEY), false);
  assert.match(output.join(""), /\[REDACTED\]/);
});

test("an embedded root is opened when health is absent", async () => {
  const opened = [];
  const requested = [];
  const result = await openTaskManager({
    controlPort: CONTROL_PORT,
    classifyOwner: async () => "embedded",
    readCallerSecret: () => {
      throw new Error("embedded mode must not need the caller capability");
    },
    fetchImpl: async (url) => {
      requested.push(String(url));
      return String(url).endsWith("/health") ? response(404) : response(200);
    },
    openBrowser: async (url) => opened.push(url),
    writeOutput: () => {},
  });

  assert.deepEqual(requested, [`${ORIGIN}/`]);
  assert.deepEqual(opened, [`${ORIGIN}/`]);
  assert.deepEqual(result, { url: `${ORIGIN}/`, mode: "embedded" });
});

test("non-manager health falls back to a responding embedded root", async () => {
  const opened = [];
  const result = await openTaskManager({
    controlPort: CONTROL_PORT,
    classifyOwner: async () => "embedded",
    readCallerSecret: () => CALLER_KEY,
    fetchImpl: async (url) => String(url).endsWith("/health")
      ? response(200, { ok: true, service: "codex-router", mode: "router" })
      : response(200),
    openBrowser: async (url) => opened.push(url),
    writeOutput: () => {},
  });

  assert.deepEqual(result, { url: `${ORIGIN}/`, mode: "embedded" });
  assert.deepEqual(opened, [`${ORIGIN}/`]);
});

test("a stopped manager fails before launching a browser", async () => {
  let opened = false;
  await assert.rejects(
    openTaskManager({
      controlPort: CONTROL_PORT,
      classifyOwner: async () => "standalone",
      readCallerSecret: () => CALLER_KEY,
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
      openBrowser: async () => {
        opened = true;
      },
      writeOutput: () => {},
    }),
    /not answering|start/i,
  );
  assert.equal(opened, false);
});

test("--print is a warned deliberate capability disclosure and does not launch", async () => {
  const output = [];
  const warnings = [];
  let opened = false;
  const result = await openTaskManager({
    controlPort: CONTROL_PORT,
    classifyOwner: async () => "standalone",
    printOnly: true,
    readCallerSecret: () => CALLER_KEY,
    fetchImpl: async () => response(200, {
      ok: true,
      service: "codex-router-task-manager",
      mode: "standalone",
      pid: 123,
    }),
    openBrowser: async () => {
      opened = true;
    },
    writeOutput: (value) => output.push(value),
    writeWarning: (value) => warnings.push(value),
  });

  assert.equal(opened, false);
  assert.equal(output.join("").trim(), result.url);
  assert.equal(output.join("").includes(CALLER_KEY), true);
  assert.match(warnings.join(""), /password/i);
});

test("a spoofed listener fails ownership before reading or opening the capability", async () => {
  const calls = [];
  await assert.rejects(
    openTaskManager({
      controlPort: CONTROL_PORT,
      classifyOwner: async () => {
        calls.push("ownership");
        return "unknown";
      },
      fetchImpl: async () => response(200, {
        ok: true,
        service: "codex-router-task-manager",
        mode: "standalone",
        pid: 123,
      }),
      readCallerSecret: () => {
        calls.push("caller-secret");
        return CALLER_KEY;
      },
      openBrowser: async () => calls.push("browser"),
      writeOutput: () => {},
    }),
    /owned|recognized Router installation/i,
  );
  assert.deepEqual(calls, ["ownership"]);
});
