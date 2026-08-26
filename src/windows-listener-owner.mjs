import { spawnSync } from "node:child_process";

import { TASK_MANAGER_CONTROL_PORT } from "./paths.mjs";

const QUERY_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export function windowsLoopbackPortOwner({
  port = TASK_MANAGER_CONTROL_PORT,
  platform = process.platform,
  spawn = spawnSync,
  timeoutMs = QUERY_TIMEOUT_MS,
} = {}) {
  if (platform !== "win32") return { known: false, pid: null };
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$Utf8 = [Text.UTF8Encoding]::new($false)",
    "[Console]::InputEncoding = $Utf8",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "$OutputEncoding = $Utf8",
    "$port = [int]$env:CODEX_ROUTER_CONTROL_PORT",
    "$loopbackAddresses = @('127.0.0.1', '0.0.0.0', '::1', '::')",
    "$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { ([int]$_.LocalPort -eq $port) -and ($loopbackAddresses -contains [string]$_.LocalAddress) })",
    "$owners = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)",
    "if ($owners.Count -eq 0) { [Console]::Out.Write('{\"known\":true,\"pid\":null}'); exit 0 }",
    "if ($owners.Count -ne 1 -or [int]$owners[0] -lt 1) { throw 'Port owner is ambiguous.' }",
    "[Console]::Out.Write(([ordered]@{ known = $true; pid = [int]$owners[0] } | ConvertTo-Json -Compress))",
  ].join("\n");
  for (const executable of ["powershell.exe", "pwsh.exe"]) {
    const result = spawn(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        env: { ...process.env, CODEX_ROUTER_CONTROL_PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (result?.status !== 0) continue;
    try {
      const parsed = JSON.parse(String(result.stdout));
      if (parsed?.known !== true) continue;
      if (parsed.pid === null) return { known: true, pid: null };
      if (Number.isSafeInteger(parsed.pid) && parsed.pid > 0) {
        return { known: true, pid: parsed.pid };
      }
    } catch {
      // Try the other PowerShell host; malformed output remains unknown.
    }
  }
  return { known: false, pid: null };
}
