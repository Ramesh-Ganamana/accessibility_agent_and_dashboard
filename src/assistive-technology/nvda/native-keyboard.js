import fs from "node:fs";
import { spawn } from "node:child_process";
import { detectNvdaCapability } from "./capability.js";
import { clean, firstLine } from "./text.js";
import { sendKeysScript, keyServerScript, focusBrowserScript } from "./paths.js";
import { desktopLease } from "./desktop-lease.js";

let keyHelper = null;

// Reuse the warmed helper instead of spawning NVDA --check-running and a second
// PowerShell fallback. An unknown result is never interpreted as permission to
// launch/own a personal reader. This read-only query keeps the Node server free.
export async function probeNvdaRunning(helper = startKeyHelper()) {
  const reply = await helper.send({ op: "nvda-status" }, 5000);
  if (!reply?.ok || typeof reply.running !== "boolean") {
    throw new Error(`Could not determine whether NVDA is already running in this desktop session (${clean(reply?.reason || "the native helper did not confirm reader status", 300)}). No NVDA instance was started or stopped.`);
  }
  return reply.running;
}

export function warmNvdaKeyboardHelper(config) {
  if (desktopLease.active || !detectNvdaCapability(config).available) return;
  // Starting a pipe reader sends no keyboard input and does not start NVDA.
  return startKeyHelper();
}

export function releaseWarmedNvdaHelper(helper) {
  // Browser launch can fail before an owned reader exists. Dispose only an
  // idle warmup belonging to this session; never disturb an active reader.
  if (helper && helper === keyHelper && !desktopLease.active) closeKeyHelper();
}

export async function focusAndMaximizeBrowser(windowTitle) {
  const result = await runPowerShellHelper(focusBrowserScript, ["-WindowTitle", windowTitle]);
  if (!result.ok) return result;
  try {
    const data = JSON.parse(result.output.trim().split(/\r?\n/).at(-1));
    return {
      ok: true,
      processId: Number(data.processId),
      windowHandle: String(data.windowHandle || ""),
      title: String(data.title || "")
    };
  } catch {
    return { ok: false, reason: "The browser foreground helper returned an invalid response." };
  }
}

export async function sendNativeTab(windowTitle, expectedProcessId, delayMs) {
  return runKeyCommand({ op: "tab", windowTitle, processId: Number(expectedProcessId), preserveState: true, delayMs: Number(delayMs) || 100 }, 6_000, [
    "-WindowTitle", windowTitle,
    "-ExpectedProcessId", String(expectedProcessId),
    "-Key", "{TAB}",
    "-PreserveState",
    "-DelayMs", String(delayMs)
  ]);
}

export async function focusNativeDocumentAnchor(windowTitle, expectedProcessId) {
  // DOM focus alone can leave Windows focus in Chrome's toolbar after the
  // keyboard audit. Focus only our synthetic marker via UIA, without clicking
  // application controls or using pane-switching keys inside an open dialog.
  return runKeyCommand({ op: "anchor", windowTitle, processId: Number(expectedProcessId) }, 6_000, [
    "-WindowTitle", windowTitle, "-ExpectedProcessId", String(expectedProcessId), "-Key", "ANCHOR", "-PreserveState"
  ]);
}

export async function inspectNativeDocumentFocus(windowTitle, expectedProcessId) {
  const result = await runKeyCommand({ op: "scope", windowTitle, processId: Number(expectedProcessId) }, 6_000, [
    "-WindowTitle", windowTitle, "-ExpectedProcessId", String(expectedProcessId), "-Key", "SCOPE", "-PreserveState"
  ]);
  if (!result.ok || typeof result.inDocument === "boolean") return result;
  try { return { ...result, ...JSON.parse(result.output.trim()) }; }
  catch { return { ok: false, reason: "Native document focus could not be verified." }; }
}

export async function prepareNativeDocumentFocus(windowTitle, expectedProcessId) {
  // Windows can leave native focus in Chromium chrome even when CDP reports
  // document.hasFocus(). Perform the pane handoff once before replay, never
  // between the Tab commands of an opened menu/dialog. These are setup keys,
  // not NVDA test commands, and speech capture remains disarmed.
  return runKeyCommand({ op: "prepare", windowTitle, processId: Number(expectedProcessId), delayMs: 100 }, 15_000, [
    "-WindowTitle", windowTitle, "-ExpectedProcessId", String(expectedProcessId),
    "-Key", "{TAB}", "-DelayMs", "100"
  ]);
}

// One long-running helper replaces a new powershell.exe (about two seconds of
// startup and C# compilation) for every key. If the helper cannot start, the
// per-call script is used. A command that was sent but timed out is never
// retried, so a key can never be sent twice.
export async function runKeyCommand(command, timeoutMs, fallbackArgs) {
  if (process.platform === "win32" && fs.existsSync(keyServerScript)) {
    const reply = await startKeyHelper().send(command, timeoutMs);
    if (reply) return reply.ok ? { ...reply, ok: true, output: "" } : { ok: false, reason: clean(reply.reason, 800) || "The keyboard helper did not send the key." };
  }
  return runPowerShellHelper(sendKeysScript, fallbackArgs);
}

export function startKeyHelper(spawnProcess = spawn) {
  if (keyHelper && !keyHelper.broken) return keyHelper;
  const pending = new Map();
  let buffer = "";
  let sequence = 0;
  let markReady;
  const helper = { broken: false, ready: new Promise((resolve) => { markReady = resolve; }) };
  const fail = () => {
    helper.broken = true;
    markReady(false);
    for (const resolve of pending.values()) resolve({ ok: false, reason: "The keyboard helper stopped before confirming the key." });
    pending.clear();
  };
  let child;
  try {
    child = spawnProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", keyServerScript], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    fail();
    helper.send = async () => null;
    helper.close = () => {};
    return helper;
  }
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.ready) { markReady(true); continue; }
      const resolve = pending.get(message.id);
      if (resolve) { pending.delete(message.id); resolve(message); }
    }
  });
  child.stderr?.on("data", () => {});
  child.once("error", fail);
  child.once("exit", fail);
  helper.send = async (command, timeoutMs) => {
    if (helper.broken) return null;
    const started = await Promise.race([helper.ready, new Promise((resolve) => setTimeout(() => resolve(false), 15_000).unref?.())]);
    if (!started || helper.broken) { fail(); return null; }
    const id = `key-${++sequence}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        helper.broken = true;
        try { child.kill(); } catch {}
        resolve({ ok: false, reason: "The keyboard helper did not confirm the key in time; the command was not retried." });
      }, timeoutMs);
      pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      try { child.stdin.write(`${JSON.stringify({ ...command, id })}\n`); }
      catch { clearTimeout(timer); pending.delete(id); fail(); resolve(null); }
    });
  };
  helper.close = () => {
    if (!helper.broken) {
      try { child.stdin.write('{"op":"exit"}\n'); child.stdin.end(); } catch {}
    }
    helper.broken = true;
    setTimeout(() => { try { child.kill(); } catch {} }, 1_000).unref?.();
  };
  // The helper must never keep the agent process alive.
  child.unref?.();
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.unref?.();
  keyHelper = helper;
  return helper;
}

export function closeKeyHelper() {
  keyHelper?.close();
  keyHelper = null;
}

export function runPowerShellHelper(script, args, { spawnProcess = spawn, timeoutMs = 20_000, env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", script,
        ...args
      ], { windowsHide: true, ...(env ? { env } : {}) });
    } catch (cause) {
      resolve({ ok: false, reason: firstLine(cause.message) });
      return;
    }
    let output = "";
    let error = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ ok: false, reason: `The Windows helper timed out after ${timeoutMs / 1_000} seconds.` });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { error += chunk.toString(); });
    child.once("error", (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: false, reason: firstLine(cause.message) });
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(code === 0
        ? { ok: true, output }
        : { ok: false, reason: clean(error, 800) || `Windows helper exited with code ${code}.` });
    });
  });
}
