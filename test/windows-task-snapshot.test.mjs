import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discardWindowsTaskSnapshot,
  MAX_WINDOWS_TASK_SNAPSHOT_BYTES,
  restoreWindowsTask,
  runSchtasksCommand,
  snapshotWindowsTask,
} from "../src/windows-task-snapshot.mjs";

const TASK_NAME = "Codex Router";
const XML = "<?xml version=\"1.0\" encoding=\"UTF-16\"?><Task><Command>C:\\用户\\启动器.vbs</Command></Task>\r\n";
const XML_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xfe]),
  Buffer.from(XML, "utf16le"),
]);
const SDDL = "D:P(A;;FA;;;SY)(A;;FA;;;OW)";
const FILE_SDDL = "D:P(A;;FA;;;OW)";

function windowsRunners({
  exists = true,
  running = true,
  currentExists = exists,
  currentError,
  taskXml = XML_BYTES,
  taskSddl = SDDL,
  validationError,
} = {}) {
  const calls = [];
  let metadataReads = 0;
  const runSchtasks = (args) => {
    calls.push({ kind: "schtasks", args: [...args] });
    if (args[0] === "/Query") return Buffer.from(taskXml);
    if (args[0] === "/Create") {
      calls.push({ kind: "created-xml", bytes: readFileSync(args[4]) });
    }
    return Buffer.alloc(0);
  };
  const runPowerShell = (_script, options = {}) => {
    const env = options.env || {};
    if (env.CODEX_ROUTER_SNAPSHOT_FILE) {
      calls.push({ kind: "read-file-acl", path: env.CODEX_ROUTER_SNAPSHOT_FILE });
      return FILE_SDDL;
    }
    if (env.CODEX_ROUTER_RESTORE_FILE) {
      calls.push({
        kind: "restore-file-acl",
        path: env.CODEX_ROUTER_RESTORE_FILE,
        sddl: env.CODEX_ROUTER_RESTORE_FILE_SDDL,
      });
      return "";
    }
    if (env.CODEX_ROUTER_RESTORE_TASK_SDDL) {
      calls.push({
        kind: "restore-task-sddl",
        taskName: env.CODEX_ROUTER_TASK,
        sddl: env.CODEX_ROUTER_RESTORE_TASK_SDDL,
      });
      return "";
    }
    if (env.CODEX_ROUTER_VALIDATE_TASK_XML) {
      calls.push({
        kind: "validate-definition",
        path: env.CODEX_ROUTER_VALIDATE_TASK_XML,
        sddls: env.CODEX_ROUTER_VALIDATE_TASK_SDDLS,
        script: _script,
      });
      if (validationError) throw validationError;
      return "";
    }
    calls.push({ kind: "task-metadata", taskName: env.CODEX_ROUTER_TASK, script: _script });
    if (metadataReads > 0 && currentError) throw currentError;
    const taskExists = metadataReads === 0 ? exists : currentExists;
    metadataReads += 1;
    return JSON.stringify(
      taskExists
        ? { exists: true, running, sddl: taskSddl }
        : { exists: false },
    );
  };
  return { calls, runSchtasks, runPowerShell };
}

test("snapshot and restore preserve exact task definition, security, running state, files, and ACLs", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-task-snapshot-"));
  const stateDir = path.join(root, "state");
  const wrapper = path.join(root, "launchers", "router.cmd");
  const shortcut = path.join(root, "menu", "router.lnk");
  const wrapperBytes = Buffer.from([0x00, 0xff, 0x41, 0x0d, 0x0a]);
  const shortcutBytes = Buffer.from("shortcut\0bytes", "utf8");
  mkdirSync(path.dirname(wrapper), { recursive: true });
  mkdirSync(path.dirname(shortcut), { recursive: true });
  writeFileSync(wrapper, wrapperBytes);
  writeFileSync(shortcut, shortcutBytes);
  const runners = windowsRunners();

  try {
    const snapshot = await snapshotWindowsTask({
      taskName: TASK_NAME,
      files: [wrapper, shortcut],
      stateDir,
      platform: "win32",
      ...runners,
    });

    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.taskName, TASK_NAME);
    assert.equal(snapshot.exists, true);
    assert.deepEqual(snapshot.xml, XML_BYTES);
    assert.match(snapshot.xmlSha256, /^[a-f0-9]{64}$/);
    assert.equal(snapshot.sddl, SDDL);
    assert.equal(snapshot.running, true);
    assert.deepEqual(snapshot.files.map(({ path: target, existed }) => ({ path: target, existed })), [
      { path: wrapper, existed: true },
      { path: shortcut, existed: true },
    ]);
    assert.ok(snapshot.files.every(({ sha256 }) => /^[a-f0-9]{64}$/.test(sha256)));
    assert.ok(snapshot.directory.startsWith(path.resolve(stateDir) + path.sep));

    writeFileSync(wrapper, "changed", "utf8");
    rmSync(shortcut);
    await restoreWindowsTask(snapshot);

    assert.deepEqual(readFileSync(wrapper), wrapperBytes);
    assert.deepEqual(readFileSync(shortcut), shortcutBytes);
    assert.deepEqual(
      runners.calls.filter(({ kind }) => kind === "restore-file-acl"),
      [
        { kind: "restore-file-acl", path: wrapper, sddl: FILE_SDDL },
        { kind: "restore-file-acl", path: shortcut, sddl: FILE_SDDL },
      ],
    );
    assert.ok(runners.calls.some(({ kind, args }) =>
      kind === "schtasks"
      && args[0] === "/Create"
      && args[2] === TASK_NAME
      && args.includes("/XML")
      && args.at(-1) === "/F"));
    assert.deepEqual(
      runners.calls.find(({ kind }) => kind === "created-xml")?.bytes,
      XML_BYTES,
    );
    assert.deepEqual(
      runners.calls.find(({ kind }) => kind === "restore-task-sddl"),
      { kind: "restore-task-sddl", taskName: TASK_NAME, sddl: SDDL },
    );
    assert.ok(runners.calls.some(({ kind, args }) =>
      kind === "schtasks" && args.join("|") === `/Run|/TN|${TASK_NAME}`));

    await discardWindowsTaskSnapshot(snapshot);
    assert.equal(existsSync(snapshot.directory), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoring a missing task deletes only its trusted name and explicit files", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-missing-task-snapshot-"));
  const explicit = path.join(root, "explicit.cmd");
  const unrelated = path.join(root, "unrelated.cmd");
  const runners = windowsRunners({ exists: false, currentExists: true, running: false });

  try {
    const snapshot = await snapshotWindowsTask({
      taskName: TASK_NAME,
      files: [explicit],
      stateDir: path.join(root, "state"),
      platform: "win32",
      ...runners,
    });
    assert.equal(snapshot.exists, false);
    assert.equal(runners.calls.some(({ kind, args }) => kind === "schtasks" && args[0] === "/Query"), false);

    writeFileSync(explicit, "created later", "utf8");
    writeFileSync(unrelated, "keep", "utf8");
    await restoreWindowsTask(snapshot);

    assert.equal(existsSync(explicit), false);
    assert.equal(readFileSync(unrelated, "utf8"), "keep");
    assert.ok(runners.calls.some(({ kind, args }) =>
      kind === "schtasks" && args.join("|") === `/Delete|/TN|${TASK_NAME}|/F`));
    assert.equal(runners.calls.some(({ kind, args }) =>
      kind === "schtasks" && args.includes("unrelated")), false);
    assert.equal(runners.calls.some(({ kind, args }) =>
      kind === "schtasks" && args[0] === "/Run"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable Scheduler state is never downgraded to missing", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-unknown-task-snapshot-"));
  try {
    await assert.rejects(
      snapshotWindowsTask({
        taskName: TASK_NAME,
        files: [],
        stateDir: path.join(root, "state"),
        platform: "win32",
        runPowerShell: () => { throw new Error("access denied"); },
        runSchtasks: () => { throw new Error("must not run"); },
      }),
      /access denied/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Scheduler enumeration includes hidden root tasks", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-hidden-task-snapshot-"));
  const runners = windowsRunners({ exists: false, currentExists: false });
  try {
    await snapshotWindowsTask({
      taskName: TASK_NAME,
      files: [],
      stateDir: path.join(root, "state"),
      platform: "win32",
      ...runners,
    });
    const query = runners.calls.find(({ kind }) => kind === "task-metadata");
    assert.match(query.script, /GetTasks\(1\)/);
    assert.doesNotMatch(query.script, /GetTasks\(0\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real schtasks runner boundary returns UTF-16 XML bytes without decoding", () => {
  const encoded = XML_BYTES.toString("base64");
  const output = runSchtasksCommand(
    ["-e", `process.stdout.write(Buffer.from(${JSON.stringify(encoded)}, "base64"))`],
    { executable: process.execPath },
  );
  assert.ok(Buffer.isBuffer(output));
  assert.deepEqual(output, XML_BYTES);
  assert.equal(output.subarray(0, 2).toString("hex"), "fffe");
});

test("snapshot creation and restoration share one maximum byte boundary", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-large-task-snapshot-"));
  try {
    await assert.rejects(
      snapshotWindowsTask({
        taskName: TASK_NAME,
        files: [],
        stateDir: path.join(root, "state"),
        platform: "win32",
        runPowerShell: () => JSON.stringify({ exists: true, running: false, sddl: SDDL }),
        runSchtasks: () => Buffer.alloc(MAX_WINDOWS_TASK_SNAPSHOT_BYTES + 1),
      }),
      /too large|maximum/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore refuses an unknown current Scheduler state before changing explicit files", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-unknown-restore-"));
  const launcher = path.join(root, "router.cmd");
  writeFileSync(launcher, "before", "utf8");
  const runners = windowsRunners({ currentError: new Error("current task unreadable") });

  try {
    const snapshot = await snapshotWindowsTask({
      taskName: TASK_NAME,
      files: [launcher],
      stateDir: path.join(root, "state"),
      platform: "win32",
      ...runners,
    });
    writeFileSync(launcher, "leave changed", "utf8");
    await assert.rejects(restoreWindowsTask(snapshot), /current task unreadable/);
    assert.equal(readFileSync(launcher, "utf8"), "leave changed");
    assert.equal(runners.calls.some(({ kind, args }) => kind === "schtasks" && args[0] === "/Delete"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore validates every sidecar in memory before the first task or launcher mutation", async () => {
  for (const corrupt of ["launcher", "xml"]) {
    const root = mkdtempSync(path.join(os.tmpdir(), `codex-router-corrupt-${corrupt}-`));
    const launcher = path.join(root, "router.cmd");
    writeFileSync(launcher, "before", "utf8");
    const runners = windowsRunners({ exists: true, currentExists: true, running: true });
    try {
      const snapshot = await snapshotWindowsTask({
        taskName: TASK_NAME,
        files: [launcher],
        stateDir: path.join(root, "state"),
        platform: "win32",
        ...runners,
      });
      const corruptPath = corrupt === "launcher"
        ? path.join(snapshot.directory, snapshot.files[0].backupName)
        : path.join(snapshot.directory, snapshot.xmlName);
      if (corrupt === "launcher") writeFileSync(corruptPath, "x", "utf8");
      else rmSync(corruptPath);
      writeFileSync(launcher, "leave changed", "utf8");
      runners.calls.length = 0;

      await assert.rejects(restoreWindowsTask(snapshot), /snapshot|ENOENT|exact copy/i);
      assert.equal(readFileSync(launcher, "utf8"), "leave changed");
      assert.deepEqual(
        runners.calls.filter(({ kind, args }) =>
          kind === "schtasks" && ["/End", "/Delete", "/Create", "/Run"].includes(args[0])),
        [],
      );
      assert.equal(runners.calls.some(({ kind }) => kind === "restore-file-acl"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("snapshot bounds and records the one file buffer read, never a stale stat size", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-growing-snapshot-"));
  const target = path.join(root, "growing.cmd");
  const fakeStats = {
    size: 1,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
  const runners = windowsRunners({ exists: false, currentExists: false });
  try {
    await assert.rejects(
      snapshotWindowsTask({
        taskName: TASK_NAME,
        files: [target],
        stateDir: path.join(root, "oversized-state"),
        platform: "win32",
        lstat: () => fakeStats,
        readFile: () => Buffer.alloc(MAX_WINDOWS_TASK_SNAPSHOT_BYTES + 1),
        ...runners,
      }),
      /launcher snapshot exceeds|maximum/i,
    );

    const exactBytes = Buffer.from("grew after stat", "utf8");
    const snapshot = await snapshotWindowsTask({
      taskName: TASK_NAME,
      files: [target],
      stateDir: path.join(root, "exact-state"),
      platform: "win32",
      lstat: () => fakeStats,
      readFile: () => Buffer.from(exactBytes),
      ...windowsRunners({ exists: false, currentExists: false }),
    });
    assert.equal(snapshot.files[0].bytes, exactBytes.length);
    assert.deepEqual(
      readFileSync(path.join(snapshot.directory, snapshot.files[0].backupName)),
      exactBytes,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function mutatingRunnerCalls(calls) {
  return calls.filter(({ kind, args }) =>
    (kind === "schtasks" && ["/End", "/Delete", "/Create", "/Run"].includes(args[0]))
    || kind === "restore-file-acl"
    || kind === "restore-task-sddl");
}

test("same-length launcher and XML corruption are rejected by digest before mutation", async () => {
  for (const corrupt of ["launcher", "xml"]) {
    const root = mkdtempSync(path.join(os.tmpdir(), `codex-router-same-length-${corrupt}-`));
    const launcher = path.join(root, "router.cmd");
    writeFileSync(launcher, "ABCDEF", "utf8");
    const runners = windowsRunners();
    try {
      const snapshot = await snapshotWindowsTask({
        taskName: TASK_NAME,
        files: [launcher],
        stateDir: path.join(root, "state"),
        platform: "win32",
        ...runners,
      });
      const sidecar = corrupt === "launcher"
        ? path.join(snapshot.directory, snapshot.files[0].backupName)
        : path.join(snapshot.directory, snapshot.xmlName);
      const original = readFileSync(sidecar);
      const changed = Buffer.from(original);
      changed[Math.floor(changed.length / 2)] ^= 0x01;
      writeFileSync(sidecar, changed);
      writeFileSync(launcher, "LIVE!!", "utf8");
      runners.calls.length = 0;

      await assert.rejects(restoreWindowsTask(snapshot), /digest|integrity/i);
      assert.equal(readFileSync(launcher, "utf8"), "LIVE!!");
      assert.deepEqual(mutatingRunnerCalls(runners.calls), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("native XML and SDDL validation fails before every mutation", async () => {
  for (const fixture of [
    {
      name: "xml",
      taskXml: Buffer.from("<Task><broken></Task>", "utf8"),
      taskSddl: SDDL,
      error: new Error("XML syntax invalid"),
    },
    {
      name: "sddl",
      taskXml: XML_BYTES,
      taskSddl: "not-an-sddl",
      error: new Error("SDDL invalid"),
    },
  ]) {
    const root = mkdtempSync(path.join(os.tmpdir(), `codex-router-invalid-${fixture.name}-`));
    const launcher = path.join(root, "router.cmd");
    writeFileSync(launcher, "before", "utf8");
    const runners = windowsRunners({
      taskXml: fixture.taskXml,
      taskSddl: fixture.taskSddl,
      validationError: fixture.error,
    });
    try {
      const snapshot = await snapshotWindowsTask({
        taskName: TASK_NAME,
        files: [launcher],
        stateDir: path.join(root, "state"),
        platform: "win32",
        ...runners,
      });
      writeFileSync(launcher, "live", "utf8");
      runners.calls.length = 0;
      await assert.rejects(restoreWindowsTask(snapshot), new RegExp(fixture.name, "i"));
      assert.equal(readFileSync(launcher, "utf8"), "live");
      assert.deepEqual(mutatingRunnerCalls(runners.calls), []);
      const validation = runners.calls.find(({ kind }) => kind === "validate-definition");
      assert.ok(validation);
      assert.match(validation.script, /XmlReader/);
      assert.match(validation.script, /RawSecurityDescriptor/);
      assert.match(validation.script, /OutputEncoding = \$Utf8/);
      assert.equal(validation.path, path.join(snapshot.directory, "restore-task.xml"));
      assert.doesNotMatch(validation.script, new RegExp(launcher.replaceAll("\\", "\\\\")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("manifest digest tampering is rejected against the trusted handle before mutation", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-digest-manifest-"));
  const launcher = path.join(root, "router.cmd");
  writeFileSync(launcher, "before", "utf8");
  const runners = windowsRunners();
  try {
    const snapshot = await snapshotWindowsTask({
      taskName: TASK_NAME,
      files: [launcher],
      stateDir: path.join(root, "state"),
      platform: "win32",
      ...runners,
    });
    const manifestPath = path.join(snapshot.directory, "snapshot.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files[0].sha256 = "0".repeat(64);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    writeFileSync(launcher, "live", "utf8");
    runners.calls.length = 0;

    await assert.rejects(restoreWindowsTask(snapshot), /trusted handle|digest/i);
    assert.equal(readFileSync(launcher, "utf8"), "live");
    assert.deepEqual(mutatingRunnerCalls(runners.calls), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
