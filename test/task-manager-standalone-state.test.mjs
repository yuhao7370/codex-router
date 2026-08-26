import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-manager-marker-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;

const {
  setTaskManagerStandaloneEnabled,
  taskManagerStandaloneEnabled,
  taskManagerStandaloneState,
} = await import("../src/task-manager-standalone-state.mjs");
const { privateFileIsProtected } = await import("../src/file-security.mjs");

const markerPath = path.join(stateDir, "task-manager-standalone.json");

test.after(() => rmSync(stateDir, { recursive: true, force: true }));

test("standalone state defaults closed and uses one private versioned marker", () => {
  const unrelated = path.join(stateDir, "unrelated.json");
  writeFileSync(unrelated, "keep me\n", "utf8");

  assert.equal(taskManagerStandaloneEnabled(), false);
  assert.equal(setTaskManagerStandaloneEnabled(true), true);
  assert.deepEqual(JSON.parse(readFileSync(markerPath, "utf8")), {
    version: 1,
    enabled: true,
  });
  assert.equal(privateFileIsProtected(markerPath), true);
  assert.equal(taskManagerStandaloneEnabled(), true);

  assert.equal(setTaskManagerStandaloneEnabled(false), false);
  assert.equal(existsSync(markerPath), false);
  assert.equal(readFileSync(unrelated, "utf8"), "keep me\n");
});

test("missing, malformed, and unrecognized standalone markers read disabled", () => {
  for (const contents of [
    "not json\n",
    `${JSON.stringify({ version: 2, enabled: true })}\n`,
    `${JSON.stringify({ version: 1, enabled: false })}\n`,
  ]) {
    writeFileSync(markerPath, contents, "utf8");
    assert.equal(taskManagerStandaloneEnabled(), false);
    assert.deepEqual(taskManagerStandaloneState(), {
      known: false,
      exists: true,
      enabled: false,
    });
  }
});
