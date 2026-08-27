import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
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

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function validSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function normalizeTaskXml(xml) {
  if (
    (xml[0] === 0xff && xml[1] === 0xfe)
    || (xml[0] === 0xfe && xml[1] === 0xff)
  ) return xml;
  if (xml[0] === 0xef && xml[1] === 0xbb && xml[2] === 0xbf) {
    throw new Error("Task Scheduler XML with a UTF-8 BOM is not the known BOM-less pipe shape.");
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(xml);
  } catch (error) {
    throw new Error("Task Scheduler XML has no UTF-16 BOM and is not valid UTF-8.", { cause: error });
  }
  const declaration = text.match(/^<\?xml\s+[^?]*\?>/)?.[0];
  if (!declaration || !/^<\?xml\s+version\s*=\s*(?:"1\.[01]"|'1\.[01]')\s+encoding\s*=\s*(?:"UTF-16"|'UTF-16')(?:\s+standalone\s*=\s*(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>$/.test(declaration)) {
    throw new Error("Task Scheduler XML without a UTF-16 BOM must have a valid UTF-16 XML declaration.");
  }
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

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

function snapshotDefinitionValidationScript() {
  return [
    ...utf8Prelude(),
    "$xmlPath = [string]$env:CODEX_ROUTER_VALIDATE_TASK_XML",
    "if ($xmlPath) {",
    "  $settings = [Xml.XmlReaderSettings]::new()",
    "  $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit",
    "  $settings.XmlResolver = $null",
    "  $stream = [IO.File]::OpenRead($xmlPath)",
    "  try {",
    "    $reader = [Xml.XmlReader]::Create($stream, $settings)",
    "    try { while ($reader.Read()) { } } finally { $reader.Dispose() }",
    "  } finally { $stream.Dispose() }",
    "}",
    "$parsedSddls = ConvertFrom-Json -InputObject ([string]$env:CODEX_ROUTER_VALIDATE_TASK_SDDLS)",
    "$sddls = if ($null -eq $parsedSddls) { @() } else { @($parsedSddls) }",
    "foreach ($sddl in $sddls) { [void][Security.AccessControl.RawSecurityDescriptor]::new([string]$sddl) }",
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

function statOrMissing(target, inspect = lstatSync) {
  try {
    return inspect(target);
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
  const rawManifest = readFileSync(manifestPath);
  if (sha256(rawManifest) !== handle.manifestSha256) {
    throw new Error("Windows task snapshot manifest failed its trusted digest.");
  }
  const manifest = JSON.parse(rawManifest.toString("utf8"));
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
    if (
      recorded.sha256 !== trusted.sha256
      || (recorded.existed ? !validSha256(recorded.sha256) : recorded.sha256 !== null)
    ) {
      throw new Error("Windows task snapshot file digest does not match its trusted handle.");
    }
  }
  if (manifest.exists) {
    if (
      manifest.xmlName !== "task.xml"
      || !Number.isSafeInteger(manifest.xmlBytes)
      || manifest.xmlBytes < 1
      || manifest.xmlBytes > MAX_WINDOWS_TASK_SNAPSHOT_BYTES
      || !validSha256(manifest.xmlSha256)
      || typeof manifest.sddl !== "string"
      || !manifest.sddl
      || typeof manifest.running !== "boolean"
    ) {
      throw new Error("Windows task snapshot task definition is incomplete.");
    }
    if (manifest.xmlSha256 !== handle.xmlSha256) {
      throw new Error("Windows task snapshot XML digest does not match its trusted handle.");
    }
  } else if (
    manifest.xmlName !== null
    || manifest.xmlBytes !== 0
    || manifest.xmlSha256 !== null
    || manifest.sddl !== null
    || manifest.running !== false
  ) {
    throw new Error("A missing Windows task snapshot has contradictory task state.");
  }
  return manifest;
}

function readSnapshotCopy(
  target,
  expectedBytes,
  expectedSha256,
  label,
  { allowEmpty = false } = {},
) {
  const stats = lstatSync(target);
  if (
    stats.isSymbolicLink()
    || !stats.isFile()
    || stats.size > MAX_WINDOWS_TASK_SNAPSHOT_BYTES
  ) {
    throw new Error(`Windows task snapshot ${label} is not one bounded exact copy.`);
  }
  const descriptor = openSync(target, "r");
  try {
    const bounded = Buffer.allocUnsafe(MAX_WINDOWS_TASK_SNAPSHOT_BYTES + 1);
    let bytes = 0;
    while (bytes < bounded.length) {
      const read = readSync(descriptor, bounded, bytes, bounded.length - bytes, null);
      if (read === 0) break;
      bytes += read;
    }
    if (
      bytes !== expectedBytes
      || (!allowEmpty && bytes < 1)
      || bytes > MAX_WINDOWS_TASK_SNAPSHOT_BYTES
    ) {
      throw new Error(`Windows task snapshot ${label} is not one bounded exact copy.`);
    }
    const contents = Buffer.from(bounded.subarray(0, bytes));
    if (!validSha256(expectedSha256) || sha256(contents) !== expectedSha256) {
      throw new Error(`Windows task snapshot ${label} failed its integrity digest.`);
    }
    return contents;
  } finally {
    closeSync(descriptor);
  }
}

function validateSnapshotDefinition(xmlPath, manifest, dependencies) {
  if (dependencies.platform !== "win32") return;
  const sddls = [
    ...(manifest.exists ? [manifest.sddl] : []),
    ...manifest.files
      .filter((record) => record.existed && record.acl?.kind === "sddl")
      .map((record) => record.acl.value),
  ];
  dependencies.runPowerShell(snapshotDefinitionValidationScript(), {
    env: {
      ...process.env,
      CODEX_ROUTER_VALIDATE_TASK_XML: xmlPath || "",
      CODEX_ROUTER_VALIDATE_TASK_SDDLS: JSON.stringify(sddls),
    },
  });
}

function validateSnapshotAcl(target, acl, platform) {
  if (platform !== "win32") {
    if (acl?.kind !== "mode" || !Number.isSafeInteger(acl.value)) {
      throw new Error(`Snapshot ACL is invalid for ${target}.`);
    }
    return;
  }
  if (acl?.kind !== "sddl" || typeof acl.value !== "string" || !acl.value) {
    throw new Error(`Snapshot ACL is invalid for ${target}.`);
  }
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
  lstat: inspect = lstatSync,
  readFile = readFileSync,
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
    const rawXml = metadata.exists
      ? invokeSchtasks(["/Query", "/TN", taskName, "/XML"], {
          timeout: COMMAND_TIMEOUT_MS,
        })
      : null;
    if (metadata.exists && !Buffer.isBuffer(rawXml)) {
      throw new Error("Task Scheduler XML must be captured as raw bytes.");
    }
    if (
      metadata.exists
      && (rawXml.length < 1 || rawXml.length > MAX_WINDOWS_TASK_SNAPSHOT_BYTES)
    ) {
      throw new Error("Task Scheduler XML exceeds the snapshot maximum.");
    }
    const xml = metadata.exists ? normalizeTaskXml(rawXml) : null;
    if (metadata.exists && xml.length > MAX_WINDOWS_TASK_SNAPSHOT_BYTES) {
      throw new Error("Normalized Task Scheduler XML exceeds the snapshot maximum.");
    }
    if (metadata.exists) writePrivateFile(path.join(directory, "task.xml"), xml);
    const xmlSha256 = metadata.exists ? sha256(xml) : null;

    const records = [];
    for (let index = 0; index < trustedFiles.length; index += 1) {
      const target = trustedFiles[index];
      const stats = statOrMissing(target, inspect);
      if (stats?.isSymbolicLink() || (stats && !stats.isFile())) {
        throw new Error(`Refusing to snapshot a non-regular launcher file: ${target}`);
      }
      const existed = Boolean(stats);
      const contents = existed ? readFile(target) : null;
      if (existed && !Buffer.isBuffer(contents)) {
        throw new Error(`Launcher snapshot must be captured as raw bytes: ${target}`);
      }
      if (contents && contents.length > MAX_WINDOWS_TASK_SNAPSHOT_BYTES) {
        throw new Error(`Launcher snapshot exceeds the snapshot maximum: ${target}`);
      }
      const backupName = existed ? `file-${index}.bin` : null;
      const acl = existed ? readFileAcl(target, dependencies) : null;
      if (existed) writePrivateFile(path.join(directory, backupName), contents);
      records.push({
        path: target,
        existed,
        backupName,
        bytes: contents?.length || 0,
        sha256: contents ? sha256(contents) : null,
        acl,
      });
    }

    const manifest = {
      version: VERSION,
      taskName,
      exists: metadata.exists,
      xmlName: metadata.exists ? "task.xml" : null,
      xmlBytes: metadata.exists ? xml.length : 0,
      xmlSha256,
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
      xmlSha256,
      manifestSha256: sha256(Buffer.from(manifestContents, "utf8")),
      files: records.map(({ path: target, existed, backupName, bytes, sha256: digest }) => ({
        path: target,
        existed,
        backupName,
        bytes,
        sha256: digest,
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
  const preparedFiles = manifest.files.map((record) => {
    if (!record.existed) return { record, contents: null };
    validateSnapshotAcl(record.path, record.acl, dependencies.platform);
    return {
      record,
      contents: readSnapshotCopy(
        path.join(handle.directory, record.backupName),
        record.bytes,
        record.sha256,
        `copy ${record.backupName}`,
        { allowEmpty: true },
      ),
    };
  });
  const taskXml = manifest.exists
    ? readSnapshotCopy(
        path.join(handle.directory, manifest.xmlName),
        manifest.xmlBytes,
        manifest.xmlSha256,
        "task XML",
      )
    : null;
  const current = parseTaskMetadata(dependencies.runPowerShell(taskMetadataScript(), {
    env: { ...process.env, CODEX_ROUTER_TASK: handle.taskName },
  }));

  const restoreXmlPath = manifest.exists
    ? path.join(handle.directory, "restore-task.xml")
    : null;
  if (restoreXmlPath) writePrivateFile(restoreXmlPath, taskXml);
  validateSnapshotDefinition(restoreXmlPath, manifest, dependencies);

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

  for (const { record, contents } of preparedFiles) {
    if (!record.existed) {
      removeFile(record.path);
      continue;
    }
    writePrivateFile(record.path, contents);
    restoreFileAcl(record.path, record.acl, dependencies);
  }

  if (!manifest.exists) return snapshot;

  dependencies.runSchtasks(
    ["/Create", "/TN", handle.taskName, "/XML", restoreXmlPath, "/F"],
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
