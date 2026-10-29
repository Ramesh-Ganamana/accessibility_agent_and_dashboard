import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

// Isolated PowerShell process queries are mocked. No real reader is signaled.
function shutdownFixture(disappeared) {
  const helper = path.resolve("scripts/windows/stop-nvda.ps1").replaceAll("'", "''");
  const script = [
    "$script:queries = 0",
    "function Test-Path { param($LiteralPath,$PathType) return $true }",
    "function Get-Process {",
    "  param($Id,$Name,$ErrorAction)",
    "  if ($Name) { return [pscustomobject]@{ Id=77; ProcessName='nvda'; SessionId=[System.Diagnostics.Process]::GetCurrentProcess().SessionId } }",
    "  $script:queries++",
    "  if (" + (disappeared ? "$true" : "$false") + " -and $script:queries -gt 1) { return $null }",
    "  return [pscustomobject]@{ Id=42; ProcessName='nvda'; Path='C:\\fixture\\nvda.exe' }",
    "}",
    "function Start-Process { throw 'UNSAFE: attempted IPC' }",
    "function Stop-Process { throw 'UNSAFE: attempted termination' }",
    "& '" + helper + "' -Executable 'C:\\fixture\\nvda.exe' -ExpectedProcessId 42"
  ].join("\n");
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 15000 });
}

test("NVDA shutdown accepts a graceful exit between snapshots without signaling another reader", { skip: process.platform !== "win32" }, () => {
  const result = shutdownFixture(true);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test("NVDA shutdown refuses an ambiguous desktop when its owned PID exists", { skip: process.platform !== "win32" }, () => {
  const result = shutdownFixture(false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to send shutdown/);
  assert.doesNotMatch(result.stderr, /UNSAFE/);
});
