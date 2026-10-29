import { spawn, spawnSync } from "node:child_process";
import { runPowerShellHelper } from "./native-keyboard.js";
import { clean, firstLine } from "./text.js";
import { startNvdaScript, stopNvdaScript } from "./paths.js";

export function checkNvdaRunning(executable, spawnProcess = spawnSync) {
  const result = spawnProcess(executable, ["--check-running"], { windowsHide: true, timeout: 5_000, stdio: "ignore" });
  if (result.error || ![0, 1].includes(result.status)) {
    // Installed UIAccess executables can reject direct Node spawning. Do not
    // mistake that for "NVDA is stopped" and later close the user's own reader.
    const fallback = spawnProcess("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "$sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId; if (Get-Process -Name nvda -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $sessionId }) { exit 0 } else { exit 1 }"
    ], { windowsHide: true, timeout: 20_000, encoding: "utf8" });
    if (fallback.error || ![0, 1].includes(fallback.status)) {
      const detail = clean(fallback.error?.code || fallback.stderr || `exit ${fallback.status}`, 300);
      throw new Error(`Could not determine whether NVDA is already running in this desktop session (${detail}). No NVDA instance was started or stopped.`);
    }
    return fallback.status === 0;
  }
  return result.status === 0;
}

export function stopNvda(executable, expectedPid) {
  if (!Number.isInteger(Number(expectedPid)) || Number(expectedPid) <= 0) return { ok: false, reason: "The test reader's process ID is unavailable." };
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", stopNvdaScript,
    "-Executable", executable,
    "-ExpectedProcessId", String(expectedPid)
  ], { windowsHide: true, timeout: 12_000, encoding: "utf8" });
  return result.status === 0 ? { ok: true } : { ok: false, reason: firstLine(result.error?.message || result.stderr || "The guarded NVDA exit request failed.") };
}

export async function startNvda(executable, configPath, logFile, runId) {
  const argumentsList = [
    "--minimal",
    `--config-path=${configPath}`,
    `--log-file=${logFile}`,
    "--log-level=20"
  ];
  try {
    const process = await spawnConfirmed(executable, argumentsList, {
      windowsHide: false,
      stdio: "ignore",
      env: { ...globalThis.process.env, RAMBO_NVDA_RUN_ID: runId }
    });
    return { process, pid: process.pid, mode: "direct" };
  } catch (error) {
    if (globalThis.process.platform !== "win32" || error?.code !== "EACCES") throw error;
    const fallback = await runPowerShellHelper(startNvdaScript, [
      "-Executable", executable,
      "-ConfigPath", configPath,
      "-LogFile", logFile
    ], { env: { ...globalThis.process.env, RAMBO_NVDA_RUN_ID: runId } });
    if (!fallback.ok) throw new Error(`Windows could not launch NVDA: ${fallback.reason}`);
    return { process: null, pid: Number(fallback.output.trim()), mode: "powershell-fallback" };
  }
}

export function spawnConfirmed(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    const failed = (error) => {
      child.removeListener("spawn", started);
      reject(error);
    };
    const started = () => {
      child.removeListener("error", failed);
      child.on("error", () => {});
      resolve(child);
    };
    child.once("error", failed);
    child.once("spawn", started);
  });
}
