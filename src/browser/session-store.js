import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Saved sessions hold live cookies. On Windows they are encrypted with DPAPI for
// the current Windows user, so a copied file cannot be used by another account
// or on another machine. Elsewhere the previous plain-JSON format is kept.
const dpapiScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/windows/dpapi.ps1");
export const ENCRYPTED_SUFFIX = ".dpapi";
const FORMAT = "rambo-dpapi-v1";

export function encryptionAvailable() {
  return process.platform === "win32" && fs.existsSync(dpapiScript);
}

export function runDpapi(mode, base64, { spawnProcess = spawn, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", dpapiScript, "-Mode", mode], { windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    let output = "";
    let failure = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Saved-session encryption timed out.")); }, timeoutMs);
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { failure += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && output.trim()) resolve(output.trim());
      else reject(new Error(`Saved-session ${mode === "Protect" ? "encryption" : "decryption"} failed${failure.trim() ? `: ${failure.trim().split(/\r?\n/, 1)[0]}` : "."}`));
    });
    child.stdin.end(base64);
  });
}

export async function encryptText(text, options) {
  return runDpapi("Protect", Buffer.from(text, "utf8").toString("base64"), options);
}

export async function decryptText(base64, options) {
  return Buffer.from(await runDpapi("Unprotect", base64, options), "base64").toString("utf8");
}

// Reads the first available saved session: encrypted file, then a plain file at
// the per-user location, then a plain file left in the project by an older
// version. Returns { state, path, encrypted } or null.
export async function readSavedSession(authStatePath, legacyAuthStatePath, options = {}) {
  const candidates = [
    { file: `${authStatePath}${ENCRYPTED_SUFFIX}`, encrypted: true },
    { file: authStatePath, encrypted: false },
    ...(legacyAuthStatePath ? [{ file: legacyAuthStatePath, encrypted: false, legacy: true }] : [])
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.file)) continue;
    const raw = await fsp.readFile(candidate.file, "utf8");
    if (candidate.encrypted) {
      const wrapper = JSON.parse(raw);
      if (wrapper?.format !== FORMAT || typeof wrapper.data !== "string") throw new Error("The saved session file is not in a recognized encrypted format.");
      return { state: JSON.parse(await decryptText(wrapper.data, options)), path: candidate.file, encrypted: true, legacy: false };
    }
    return { state: JSON.parse(raw), path: candidate.file, encrypted: false, legacy: Boolean(candidate.legacy) };
  }
  return null;
}

// Writes a session encrypted when DPAPI is available. A plain copy left at the
// per-user location by an earlier version is removed after a successful save.
export async function writeSavedSession(state, authStatePath, options = {}) {
  await fsp.mkdir(path.dirname(authStatePath), { recursive: true });
  const json = JSON.stringify(state);
  if (options.encrypt ?? encryptionAvailable()) {
    const data = await encryptText(json, options);
    const target = `${authStatePath}${ENCRYPTED_SUFFIX}`;
    await writeAtomic(target, JSON.stringify({ format: FORMAT, scope: "windows-current-user", data }));
    await fsp.rm(authStatePath, { force: true });
    return { path: target, encrypted: true };
  }
  await writeAtomic(authStatePath, json);
  return { path: authStatePath, encrypted: false };
}

async function writeAtomic(file, content) {
  const temporary = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await fsp.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await fsp.rename(temporary, file);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}
