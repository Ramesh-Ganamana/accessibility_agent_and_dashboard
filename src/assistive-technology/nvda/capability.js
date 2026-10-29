import fs from "node:fs";
import path from "node:path";
import { sendKeysScript, focusBrowserScript, startNvdaScript, stopNvdaScript } from "./paths.js";

const REQUIRED_ADDON = [1, 9, 1];

export function detectNvdaCapability(config = {}) {
  const executable = resolveNvdaExecutable(config.executable);
  if (process.platform !== "win32") return capability(false, "NVDA requires a Windows interactive desktop.", null, config);
  if (!config.allowed) return capability(false, "Set NVDA_ENABLED=true after installing NVDA and the capture add-on.", executable, config);
  if (!executable) return capability(false, "NVDA was not found. Install it and set NVDA_PATH in .env.", null, config);
  if (!fs.existsSync(sendKeysScript)) return capability(false, "The guarded Chromium keyboard helper is missing from this installation.", executable, config);
  if (!fs.existsSync(focusBrowserScript)) return capability(false, "The browser foreground helper is missing from this installation.", executable, config);
  if (!fs.existsSync(startNvdaScript) || !fs.existsSync(stopNvdaScript)) return capability(false, "The NVDA Windows launch helpers are missing from this installation.", executable, config);
  const addonManifest = config.configPath && path.join(path.resolve(config.configPath), "addons", "accessibilityAgentCapture", "manifest.ini");
  if (!addonManifest || !fs.existsSync(addonManifest)) {
    return capability(false, "The RAMBO NVDA capture add-on is not installed in NVDA_CONFIG_PATH. Run npm run install:nvda-addon.", executable, config);
  }
  const installedVersion = fs.readFileSync(addonManifest, "utf8").match(/^version\s*=\s*(\d+)\.(\d+)(?:\.(\d+))?\s*$/m);
  const installed = installedVersion ? installedVersion.slice(1).map((part) => Number(part || 0)) : [0, 0, 0];
  const outdated = REQUIRED_ADDON.some((required, index) => installed.slice(0, index).every((part, position) => part === REQUIRED_ADDON[position]) && installed[index] < required);
  if (outdated) {
    return capability(false, `Update the RAMBO NVDA capture add-on to ${REQUIRED_ADDON.join(".")}: run npm run install:nvda-addon, exit manually running NVDA, then restart the agent server.`, executable, config);
  }
  return capability(true, "NVDA is configured for optional headed website testing.", executable, config);
}

export function capability(available, reason, executable, config) {
  return {
    available,
    reason,
    configured: Boolean(config.allowed),
    executable,
    mode: "headed-windows-live-state"
  };
}

export function resolveNvdaExecutable(configured) {
  const candidates = [
    configured,
    process.env.NVDA_PATH,
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "NVDA", "nvda.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "NVDA", "nvda.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "NVDA", "nvda.exe")
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}
