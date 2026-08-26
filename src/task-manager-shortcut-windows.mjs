import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SOURCE_ROOT } from "./paths.mjs";
import { skipServiceManagerCall } from "./service-write-guard.mjs";

const SHORTCUT_NAME = "Codex Router Task Manager.lnk";
const POWERSHELL = "powershell.exe";

export function taskManagerShortcutPath(env = process.env) {
  const directory = env.CODEX_ROUTER_START_MENU_DIR
    || (env.APPDATA
      ? path.join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs")
      : undefined);
  if (!directory) throw new Error("APPDATA is required to locate the current-user Start Menu.");
  return path.join(directory, SHORTCUT_NAME);
}

function shortcutSpec(env = process.env) {
  return {
    target: POWERSHELL,
    arguments: `-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${path.join(SOURCE_ROOT, "codex-router.ps1")}" task-manager open`,
    workingDirectory: SOURCE_ROOT,
    path: taskManagerShortcutPath(env),
  };
}

function runPowerShell(script, env) {
  execFileSync(
    POWERSHELL,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ],
    { encoding: "utf8", env, windowsHide: true },
  );
}

function mutationSkipped(env) {
  return skipServiceManagerCall({ hostManaged: process.platform === "win32", env });
}

export function installTaskManagerShortcut({
  env = process.env,
  runPowerShell: invoke = runPowerShell,
} = {}) {
  const spec = shortcutSpec(env);
  if (mutationSkipped(env)) return { ...spec, skipped: true };
  if (process.platform !== "win32") {
    throw new Error("The Task Manager Start Menu shortcut is supported on Windows only.");
  }
  mkdirSync(path.dirname(spec.path), { recursive: true });
  invoke(
    [
      "$ErrorActionPreference = 'Stop'",
      "$Utf8 = [Text.UTF8Encoding]::new($false)",
      "[Console]::InputEncoding = $Utf8",
      "[Console]::OutputEncoding = $Utf8",
      "$OutputEncoding = $Utf8",
      "$Shell = New-Object -ComObject WScript.Shell",
      "$Shortcut = $Shell.CreateShortcut([string]$env:CODEX_ROUTER_SHORTCUT_PATH)",
      "$Shortcut.TargetPath = [string]$env:CODEX_ROUTER_SHORTCUT_TARGET",
      "$Shortcut.Arguments = [string]$env:CODEX_ROUTER_SHORTCUT_ARGUMENTS",
      "$Shortcut.WorkingDirectory = [string]$env:CODEX_ROUTER_SHORTCUT_WORKING_DIRECTORY",
      "$Shortcut.Save()",
    ].join("; "),
    {
      ...env,
      CODEX_ROUTER_SHORTCUT_PATH: spec.path,
      CODEX_ROUTER_SHORTCUT_TARGET: spec.target,
      CODEX_ROUTER_SHORTCUT_ARGUMENTS: spec.arguments,
      CODEX_ROUTER_SHORTCUT_WORKING_DIRECTORY: spec.workingDirectory,
    },
  );
  return { ...spec, installed: true, skipped: false };
}

export function uninstallTaskManagerShortcut({
  env = process.env,
  removeShortcut = (shortcutPath) => rmSync(shortcutPath, { force: true }),
} = {}) {
  const spec = shortcutSpec(env);
  if (mutationSkipped(env)) return { ...spec, skipped: true };
  removeShortcut(spec.path);
  return { ...spec, installed: false, skipped: false };
}

function status(env = process.env) {
  const spec = shortcutSpec(env);
  return { ...spec, installed: existsSync(spec.path) };
}

function isMain() {
  return Boolean(
    process.argv[1]
      && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)),
  );
}

function main() {
  const command = process.argv[2] || "status";
  const result = command === "render"
    ? shortcutSpec()
    : command === "install"
      ? installTaskManagerShortcut()
      : command === "uninstall"
        ? uninstallTaskManagerShortcut()
        : command === "status"
          ? status()
          : undefined;
  if (!result) {
    process.stderr.write("Usage: task-manager-shortcut-windows.mjs render|install|uninstall|status\n");
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (isMain()) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
