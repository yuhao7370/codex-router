import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  installTaskManagerShortcut,
  taskManagerShortcutPath,
  uninstallTaskManagerShortcut,
} from "../src/task-manager-shortcut-windows.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shortcutScript = path.join(root, "src", "task-manager-shortcut-windows.mjs");
const CALLER_KEY = "test-shortcut-caller-capability-with-sufficient-length";

test("rendered shortcut opens through the checkout wrapper without storing capability", () => {
  const appData = path.join(root, ".tmp-task-manager-shortcut-appdata");
  const env = { ...process.env, APPDATA: appData, CALLER_KEY };
  delete env.CODEX_ROUTER_START_MENU_DIR;
  const rendered = JSON.parse(execFileSync(process.execPath, [shortcutScript, "render"], {
    encoding: "utf8",
    env,
  }));

  assert.match(rendered.target, /powershell\.exe$/i);
  assert.match(rendered.arguments, /codex-router\.ps1.+task-manager.+open/i);
  assert.equal(rendered.arguments.includes(CALLER_KEY), false);
  assert.match(rendered.path, /Start Menu[\\/]Programs[\\/]Codex Router Task Manager\.lnk$/i);
  assert.equal(rendered.workingDirectory, root);
});

test("the test-only Start Menu override resolves one exact shortcut path", () => {
  const startMenu = path.join(root, ".tmp-task-manager-start-menu");
  const env = { ...process.env, CODEX_ROUTER_START_MENU_DIR: startMenu };
  assert.equal(
    taskManagerShortcutPath(env),
    path.join(startMenu, "Codex Router Task Manager.lnk"),
  );
});

test("service-manager guard skips shortcut mutations", () => {
  const env = {
    ...process.env,
    MODEL_ROUTER_SKIP_SERVICE_MANAGER: "1",
    CODEX_ROUTER_START_MENU_DIR: path.join(root, ".tmp-task-manager-start-menu"),
  };
  const forbidden = () => {
    throw new Error("guarded mutation ran");
  };

  assert.equal(installTaskManagerShortcut({ env, runPowerShell: forbidden }).skipped, true);
  assert.equal(uninstallTaskManagerShortcut({ env, removeShortcut: forbidden }).skipped, true);
});

test("uninstall removes only the rendered shortcut path", () => {
  const startMenu = path.join(root, ".tmp-task-manager-start-menu");
  const env = { CODEX_ROUTER_START_MENU_DIR: startMenu };
  const removed = [];
  const result = uninstallTaskManagerShortcut({
    env,
    removeShortcut: (shortcutPath) => removed.push(shortcutPath),
  });

  assert.deepEqual(removed, [path.join(startMenu, "Codex Router Task Manager.lnk")]);
  assert.equal(result.path, removed[0]);
});
