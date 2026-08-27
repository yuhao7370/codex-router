import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { SOURCE_ROOT } from "../src/paths.mjs";
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

function htmlResponse(status = 200) {
  return new Response("<!doctype html><title>Task Manager</title>", {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function developmentOwnerOptions(commandLine) {
  return {
    sourceRoot: SOURCE_ROOT,
    stateDir: "C:/unused-router-state",
    readPortOwner: async () => ({ known: true, pid: 4123 }),
    readManagerHealth: async () => undefined,
    readManagerTask: async () => ({ known: true, exists: false }),
    readRouterTask: async () => ({ known: true, exists: false }),
    readProcessCommandLine: () => commandLine,
    readManagerProcessState: () => undefined,
  };
}

test("POSIX embedded opens the responding HTML root without Windows ownership or caller capability", async () => {
  const calls = [];
  const result = await openTaskManager({
    platform: "linux",
    controlPort: CONTROL_PORT,
    classifyOwner: async () => {
      calls.push("windows-owner");
      throw new Error("POSIX must not classify Windows ownership");
    },
    readCallerSecret: () => {
      calls.push("caller-secret");
      throw new Error("embedded mode must not need the caller capability");
    },
    fetchImpl: async (url) => String(url).endsWith("/health")
      ? response(404, { error: "not found" })
      : htmlResponse(),
    openBrowser: async (url) => calls.push(["browser", url]),
    writeOutput: () => {},
  });

  assert.deepEqual(result, { url: `${ORIGIN}/`, mode: "embedded" });
  assert.deepEqual(calls, [["browser", `${ORIGIN}/`]]);
});

test("POSIX standalone-shaped public health refuses before caller capability or browser", async () => {
  const calls = [];
  await assert.rejects(openTaskManager({
    platform: "darwin",
    controlPort: CONTROL_PORT,
    classifyOwner: async () => {
      calls.push("windows-owner");
      return "standalone";
    },
    readCallerSecret: () => {
      calls.push("caller-secret");
      return CALLER_KEY;
    },
    fetchImpl: async () => response(200, {
      ok: true,
      service: "codex-router-task-manager",
      mode: "standalone",
      pid: 123,
    }),
    openBrowser: async () => calls.push("browser"),
    writeOutput: () => {},
  }), /Windows|standalone|refus/i);
  assert.deepEqual(calls, []);
});

test("POSIX refuses non-2xx standalone-shaped health before HTML-root fallback", async () => {
  const calls = [];
  await assert.rejects(openTaskManager({
    platform: "linux",
    controlPort: CONTROL_PORT,
    classifyOwner: async () => calls.push("windows-owner"),
    readCallerSecret: () => {
      calls.push("caller-secret");
      return CALLER_KEY;
    },
    fetchImpl: async (url) => String(url).endsWith("/health")
      ? response(503, {
          ok: false,
          service: "codex-router-task-manager",
          mode: "standalone",
        })
      : htmlResponse(),
    openBrowser: async () => calls.push("browser"),
    writeOutput: () => {},
  }), /Windows|standalone|refus/i);
  assert.deepEqual(calls, []);
});

test("Windows development embedded accepts quoted and unquoted direct node entrypoints", async () => {
  const calls = [];
  const router = path.join(SOURCE_ROOT, "src", "router.mjs");
  for (const commandLine of [
    `node.exe ${router}`,
    `"C:/Program Files/nodejs/node.exe" "${router}"`,
  ]) {
    const result = await openTaskManager({
      platform: "win32",
      controlPort: CONTROL_PORT,
      ownerOptions: developmentOwnerOptions(commandLine),
      readCallerSecret: () => {
        calls.push("caller-secret");
        throw new Error("embedded mode must not need the caller capability");
      },
      fetchImpl: async () => htmlResponse(),
      openBrowser: async (url) => calls.push(["browser", url]),
      writeOutput: () => {},
    });
    assert.deepEqual(result, { url: `${ORIGIN}/`, mode: "embedded" });
  }
  assert.deepEqual(calls, [
    ["browser", `${ORIGIN}/`],
    ["browser", `${ORIGIN}/`],
  ]);
});

test("Windows development embedded refuses an expected entrypoint passed to a foreign script", async () => {
  const calls = [];
  await assert.rejects(openTaskManager({
    platform: "win32",
    controlPort: CONTROL_PORT,
    ownerOptions: developmentOwnerOptions(
      `node.exe C:/foreign/evil.mjs "${path.join(SOURCE_ROOT, "src", "router.mjs")}"`,
    ),
    readCallerSecret: () => {
      calls.push("caller-secret");
      return CALLER_KEY;
    },
    fetchImpl: async () => htmlResponse(),
    openBrowser: async () => calls.push("browser"),
    writeOutput: () => {},
  }), /owned|recognized Router installation/i);
  assert.deepEqual(calls, []);
});

for (const [label, commandLine] of [
  ["--import option-value bypass", `node.exe --import "${path.join(SOURCE_ROOT, "src", "router.mjs")}" C:/foreign/evil.mjs`],
  ["--require option-value bypass", `node.exe --require "${path.join(SOURCE_ROOT, "src", "router.mjs")}" C:/foreign/evil.mjs`],
  ["a generic Node flag", `node.exe --trace-warnings "${path.join(SOURCE_ROOT, "src", "router.mjs")}"`],
  ["trailing foreign arguments", `node.exe "${path.join(SOURCE_ROOT, "src", "router.mjs")}" C:/foreign/evil.mjs`],
]) {
  test(`Windows development embedded refuses ${label}`, async () => {
    const calls = [];
    await assert.rejects(openTaskManager({
      platform: "win32",
      controlPort: CONTROL_PORT,
      ownerOptions: developmentOwnerOptions(commandLine),
      readCallerSecret: () => {
        calls.push("caller-secret");
        return CALLER_KEY;
      },
      fetchImpl: async () => htmlResponse(),
      openBrowser: async () => calls.push("browser"),
      writeOutput: () => {},
    }), /owned|recognized Router installation/i);
    assert.deepEqual(calls, []);
  });
}

test("default Windows ownership refuses spoofed standalone health before caller capability or browser", async () => {
  const calls = [];
  await assert.rejects(openTaskManager({
    platform: "win32",
    controlPort: CONTROL_PORT,
    ownerOptions: {
      sourceRoot: SOURCE_ROOT,
      stateDir: "C:/unused-router-state",
      readPortOwner: async () => ({ known: true, pid: 9001 }),
      readManagerHealth: async () => ({
        ok: true,
        service: "codex-router-task-manager",
        mode: "standalone",
        pid: 9001,
      }),
      readManagerTask: async () => ({ known: true, exists: false }),
      readRouterTask: async () => ({ known: true, exists: false }),
      readProcessCommandLine: () => "node.exe C:/foreign/router.mjs",
      readManagerProcessState: () => undefined,
    },
    readCallerSecret: () => {
      calls.push("caller-secret");
      return CALLER_KEY;
    },
    fetchImpl: async () => htmlResponse(),
    openBrowser: async () => calls.push("browser"),
    writeOutput: () => {},
  }), /owned|recognized Router installation/i);
  assert.deepEqual(calls, []);
});

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
      return String(url).endsWith("/health") ? response(404) : htmlResponse();
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
      : htmlResponse(),
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
