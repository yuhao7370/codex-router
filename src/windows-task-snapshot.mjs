import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

import { writePrivateFile } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";
import { skipServiceManagerCall } from "./service-write-guard.mjs";

const VERSION = 1;
const COMMAND_TIMEOUT_MS = 15_000;
export const MAX_WINDOWS_TASK_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_DIRECTORY = "windows-task-snapshots";
const handles = new WeakMap();

export function runSchtasksCommand(args, options = {}) {
  if (
    options.mutating
    && skipServiceManagerCall({ hostManaged: process.platform === "win32" })
  ) {
    return Buffer.alloc(0);
  }
  return execFileSync(options.executable || "schtasks.exe", args, {
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_WINDOWS_TASK_SNAPSHOT_BYTES,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runPowerShell(script, options = {}) {
  if (
    options.mutating
    && skipServiceManagerCall({ hostManaged: process.platform === "win32" })
  ) {
    return "";
  }
  const environment = options.env || process.env;
  return execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_WINDOWS_TASK_SNAPSHOT_BYTES,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
    },
  );
}

function utf8Prelude() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$Utf8 = [Text.UTF8Encoding]::new($false)",
    "[Console]::InputEncoding = $Utf8",
    "[Console]::OutputEncoding = $Utf8",
    "$OutputEncoding = $Utf8",
  ];
}

function taskMetadataScript() {
  return [
    ...utf8Prelude(),
    "$service = New-Object -ComObject 'Schedule.Service'",
    "$service.Connect()",
    "$folder = $service.GetFolder('\\')",
    // TASK_ENUM_HIDDEN = 1. A hidden same-name task is existing state, never
    // evidence that the name is free to delete or replace.
    "$tasks = $folder.GetTasks(1)",
    "$matches = @()",
    "for ($index = 1; $index -le $tasks.Count; $index += 1) { $candidate = $tasks.Item($index); if ($candidate.Name -eq [string]$env:CODEX_ROUTER_TASK) { $matches += $candidate } }",
    "if ($matches.Count -eq 0) { [Console]::Out.Write('{\"exists\":false}'); exit 0 }",
    "if ($matches.Count -ne 1) { throw 'Task name is ambiguous.' }",
    "$task = $matches[0]",
    "$instances = $task.GetInstances(0)",
    "$payload = [ordered]@{ exists = $true; running = ([int]$instances.Count -gt 0); sddl = [string]$task.GetSecurityDescriptor(7) }",
    "[Console]::Out.Write(($payload | ConvertTo-Json -Compress -Depth 2))",
  ].join("\n");
}

function fileAclReadScript() {
  return [
    ...utf8Prelude(),
    "$sections = [Security.AccessControl.AccessControlSections]::Access",
    "$acl = [IO.File]::GetAccessControl([string]$env:CODEX_ROUTER_SNAPSHOT_FILE, $sections)",
    "[Console]::Out.Write($acl.GetSecurityDescriptorSddlForm($sections))",
  ].join("\n");
}

function fileAclRestoreScript() {
  return [
    ...utf8Prelude(),
    "$sections = [Security.AccessControl.AccessControlSections]::Access",
    "$acl = [Security.AccessControl.FileSecurity]::new()",
    "$acl.SetSecurityDescriptorSddlForm([string]$env:CODEX_ROUTER_RESTORE_FILE_SDDL, $sections)",
    "[IO.File]::SetAccessControl([string]$env:CODEX_ROUTER_RESTORE_FILE, $acl)",
  ].join("\n");
}

function taskSddlRestoreScript() {
  return [
    ...utf8Prelude(),
    "$service = New-Object -ComObject 'Schedule.Service'",
    "$service.Connect()",
    "$task = $service.GetFolder('\\').GetTask([string]$env:CODEX_ROUTER_TASK)",
    "$task.SetSecurityDescriptor([string]$env:CODEX_ROUTER_RESTORE_TASK_SDDL, 0x10)",
  ].join("\n");
}

function taskNameIsSafe(taskName) {
  return typeof taskName === "string"
    && taskName.length > 0
    && !taskName.includes("\\")
    && !taskName.includes("/")
    && !taskName.includes("\0");
}

function explicitFiles(files) {
  if (!Array.isArray(files)) throw new TypeError("Windows task snapshot files must be an array.");
  const resolved = files.map((file) => {
    if (typeof file !== "string" || !path.isAbsolute(file)) {
      throw new Error("Windows task snapshot files must be explicit absolute paths.");
    }
    return path.resolve(file);
  });
  const seen = new Set();
  for (const file of resolved) {
    const key = process.platform === "win32" ? file.toLowerCase() : file;
    if (seen.has(key)) throw new Error(`Duplicate Windows task snapshot file: ${file}`);
    seen.add(key);
  }
  return resolved;
}

function statOrMissing(target) {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function snapshotRoot(stateDir) {
  const root = path.resolve(stateDir, SNAPSHOT_DIRECTORY);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return root;
}

function assertSnapshotDirectory(directory, root) {
  const resolvedDirectory = path.resolve(directory);
  const resolvedRoot = path.resolve(root);
  if (path.dirname(resolvedDirectory) !== resolvedRoot) {
    throw new Error("Refusing a Windows task snapshot outside its private snapshot root.");
  }
  return resolvedDirectory;
}

function cleanupSnapshotDirectory(directory, root) {
  const resolved = assertSnapshotDirectory(directory, root);
  rmSync(resolved, { recursive: true, force: true });
}

function parseTaskMetadata(raw) {
  let metadata;
  try {
    metadata = JSON.parse(String(raw));
  } catch (error) {
    throw new Error("Task Scheduler returned unreadable snapshot metadata.", { cause: error });
  }
  if (metadata?.exists === false) return { exists: false };
  if (
    metadata?.exists !== true
    || typeof metadata.running !== "boolean"
    || typeof metadata.sddl !== "string"
    || metadata.sddl.length === 0
  ) {
    throw new Error("Task Scheduler returned incomplete snapshot metadata.");
  }
  return {
    exists: true,
    running: metadata.running,
    sddl: metadata.sddl,
  };
}

function readFileAcl(target, dependencies) {
  if (dependencies.platform !== "win32") {
    return { kind: "mode", value: statSync(target).mode & 0o777 };
  }
  const sddl = String(dependencies.runPowerShell(fileAclReadScript(), {
    env: { ...process.env, CODEX_ROUTER_SNAPSHOT_FILE: target },
  })).trim();
  if (!sddl) throw new Error(`Could not read the ACL for ${target}.`);
  return { kind: "sddl", value: sddl };
}

function restoreFileAcl(target, acl, dependencies) {
  if (acl?.kind === "mode" && Number.isSafeInteger(acl.value)) {
    chmodSync(target, acl.value);
    return;
  }
  if (acl?.kind !== "sddl" || typeof acl.value !== "string" || !acl.value) {
    throw new Error(`Snapshot ACL is invalid for ${target}.`);
  }
  dependencies.runPowerShell(fileAclRestoreScript(), {
    env: {
      ...process.env,
      CODEX_ROUTER_RESTORE_FILE: target,
      CODEX_ROUTER_RESTORE_FILE_SDDL: acl.value,
    },
    mutating: true,
  });
}

function readManifest(handle) {
  const manifestPath = path.join(handle.directory, "snapshot.json");
  const stats = lstatSync(manifestPath);
  if (
    stats.isSymbolicLink()
    || !stats.isFile()
    || stats.size < 2
    || stats.size > MAX_WINDOWS_TASK_SNAPSHOT_BYTES
  ) {
    throw new Error("Windows task snapshot manifest is not a bounded regular file.");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    manifest?.version !== VERSION
    || manifest.taskName !== handle.taskName
    || manifest.exists !== handle.exists
    || !Array.isArray(manifest.files)
    || manifest.files.length !== handle.files.length
  ) {
    throw new Error("Windows task snapshot manifest does not match its trusted handle.");
  }
  for (let index = 0; index < manifest.files.length; index += 1) {
    const recorded = manifest.files[index];
    const trusted = handle.files[index];
    if (
      recorded?.path !== trusted.path
      || recorded.existed !== trusted.existed
      || recorded.backupName !== trusted.backupName
      || recorded.bytes !== trusted.bytes
    ) {
      throw new Error("Windows task snapshot file list does not match its trusted paths.");
    }
  }
  if (manifest.exists) {
    if (
      manifest.xmlName !== "task.xml"
      || !Number.isSafeInteger(manifest.xmlBytes)
      || manifest.xmlBytes < 1
      || manifest.xmlBytes > MAX_WINDOWS_TASK_SNAPSHOT_BYTES
      || typeof manifest.sddl !== "string"
      || !manifest.sddl
      || typeof manifest.running !== "boolean"
    ) {
      throw new Error("Windows task snapshot task definition is incomplete.");
    }
  } else if (
    manifest.xmlName !== null
    || manifest.xmlBytes !== 0
    || manifest.sddl !== null
    || manifest.running !== false
  ) {
    throw new Error("A missing Windows task snapshot has contradictory task state.");
  }
  return manifest;
}

function readSnapshotCopy(target, expectedBytes, label, { allowEmpty = false } = {}) {
  const stats = lstatSync(target);
  if (
    stats.isSymbolicLink()
    || !stats.isFile()
    || stats.size !== expectedBytes
    || (!allowEmpty && stats.size < 1)
    || stats.size > MAX_WINDOWS_TASK_SNAPSHOT_BYTES
  ) {
    throw new Error(`Windows task snapshot ${label} is not one bounded exact copy.`);
  }
  return readFileSync(target);
}

function removeFile(target) {
  try {
    unlinkSync(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function invokeIgnoringFailure(invoke) {
  try {
    invoke();
  } catch {
    // A task that is absent or already idle is already in the required state.
  }
}

export async function snapshotWindowsTask({
  taskName,
  files,
  stateDir = STATE_DIR,
  platform = process.platform,
  runSchtasks: invokeSchtasks = runSchtasksCommand,
  runPowerShell: invokePowerShell = runPowerShell,
  randomId = randomUUID,
} = {}) {
  if (!taskNameIsSafe(taskName)) throw new Error("Windows task snapshots require one exact root task name.");
  const trustedFiles = explicitFiles(files);
  if (!path.isAbsolute(stateDir)) throw new Error("Windows task snapshots require an absolute private state directory.");
  const root = snapshotRoot(stateDir);
  const directory = assertSnapshotDirectory(path.join(root, randomId()), root);
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  const dependencies = {
    platform,
    runSchtasks: invokeSchtasks,
    runPowerShell: invokePowerShell,
  };

  try {
    const metadata = parseTaskMetadata(invokePowerShell(taskMetadataScript(), {
      env: { ...process.env, CODEX_ROUTER_TASK: taskName },
    }));
    const xml = metadata.exists
      ? invokeSchtasks(["/Query", "/TN", taskName, "/XML"], {
          timeout: COMMAND_TIMEOUT_MS,
        })
      : null;
    if (metadata.exists && !Buffer.isBuffer(xml)) {
      throw new Error("Task Scheduler XML must be captured as raw bytes.");
    }
    if (
      metadata.exists
      && (xml.length < 1 || xml.length > MAX_WINDOWS_TASK_SNAPSHOT_BYTES)
    ) {
      throw new Error("Task Scheduler XML exceeds the snapshot maximum.");
    }
    if (metadata.exists) writePrivateFile(path.join(directory, "task.xml"), xml);

    const records = [];
    for (let index = 0; index < trustedFiles.length; index += 1) {
      const target = trustedFiles[index];
      const stats = statOrMissing(target);
      if (stats?.isSymbolicLink() || (stats && !stats.isFile())) {
        throw new Error(`Refusing to snapshot a non-regular launcher file: ${target}`);
      }
      const existed = Boolean(stats);
      if (existed && stats.size > MAX_WINDOWS_TASK_SNAPSHOT_BYTES) {
        throw new Error(`Launcher snapshot exceeds the snapshot maximum: ${target}`);
      }
      const backupName = existed ? `file-${index}.bin` : null;
      const acl = existed ? readFileAcl(target, dependencies) : null;
      if (existed) writePrivateFile(path.join(directory, backupName), readFileSync(target));
      records.push({ path: target, existed, backupName, bytes: existed ? stats.size : 0, acl });
    }

    const manifest = {
      version: VERSION,
      taskName,
      exists: metadata.exists,
      xmlName: metadata.exists ? "task.xml" : null,
      xmlBytes: metadata.exists ? xml.length : 0,
      sddl: metadata.exists ? metadata.sddl : null,
      running: metadata.exists ? metadata.running : false,
      files: records,
    };
    const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;
    if (Buffer.byteLength(manifestContents) > MAX_WINDOWS_TASK_SNAPSHOT_BYTES) {
      throw new Error("Windows task snapshot manifest exceeds the snapshot maximum.");
    }
    writePrivateFile(path.join(directory, "snapshot.json"), manifestContents, {
      directoryMode: 0o700,
    });
    const snapshot = { directory, ...manifest, xml: metadata.exists ? Buffer.from(xml) : null };
    handles.set(snapshot, {
      root,
      directory,
      taskName,
      exists: manifest.exists,
      files: records.map(({ path: target, existed, backupName, bytes }) => ({
        path: target,
        existed,
        backupName,
        bytes,
      })),
      dependencies,
    });
    return snapshot;
  } catch (error) {
    cleanupSnapshotDirectory(directory, root);
    throw error;
  }
}

export async function restoreWindowsTask(snapshot) {
  const handle = handles.get(snapshot);
  if (
    !handle
    || snapshot?.taskName !== handle.taskName
    || snapshot?.directory !== handle.directory
  ) {
    throw new Error("Refusing an untrusted or mismatched Windows task snapshot.");
  }
  assertSnapshotDirectory(handle.directory, handle.root);
  const manifest = readManifest(handle);
  const dependencies = handle.dependencies;
  const current = parseTaskMetadata(dependencies.runPowerShell(taskMetadataScript(), {
    env: { ...process.env, CODEX_ROUTER_TASK: handle.taskName },
  }));

  if (current.exists) {
    invokeIgnoringFailure(() => dependencies.runSchtasks(
      ["/End", "/TN", handle.taskName],
      { mutating: true },
    ));
    dependencies.runSchtasks(
      ["/Delete", "/TN", handle.taskName, "/F"],
      { mutating: true },
    );
  }

  for (const record of manifest.files) {
    if (!record.existed) {
      removeFile(record.path);
      continue;
    }
    const backupPath = path.join(handle.directory, record.backupName);
    writePrivateFile(
      record.path,
      readSnapshotCopy(
        backupPath,
        record.bytes,
        `copy ${record.backupName}`,
        { allowEmpty: true },
      ),
    );
    restoreFileAcl(record.path, record.acl, dependencies);
  }

  if (!manifest.exists) return snapshot;

  const xmlPath = path.join(handle.directory, manifest.xmlName);
  readSnapshotCopy(xmlPath, manifest.xmlBytes, "task XML");
  dependencies.runSchtasks(
    ["/Create", "/TN", handle.taskName, "/XML", xmlPath, "/F"],
    { mutating: true },
  );
  dependencies.runPowerShell(taskSddlRestoreScript(), {
    env: {
      ...process.env,
      CODEX_ROUTER_TASK: handle.taskName,
      CODEX_ROUTER_RESTORE_TASK_SDDL: manifest.sddl,
    },
    mutating: true,
  });
  if (manifest.running) {
    dependencies.runSchtasks(
      ["/Run", "/TN", handle.taskName],
      { mutating: true },
    );
  }
  return snapshot;
}

export async function discardWindowsTaskSnapshot(snapshot) {
  const handle = handles.get(snapshot);
  if (
    !handle
    || snapshot?.taskName !== handle.taskName
    || snapshot?.directory !== handle.directory
  ) {
    throw new Error("Refusing to discard an untrusted or mismatched Windows task snapshot.");
  }
  cleanupSnapshotDirectory(handle.directory, handle.root);
  handles.delete(snapshot);
}
