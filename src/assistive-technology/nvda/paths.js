import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve relative to this module, never to the caller's working directory.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const sendKeysScript = path.resolve(moduleDir, "../../../scripts/windows/send-keys.ps1");
export const keyServerScript = path.resolve(moduleDir, "../../../scripts/windows/key-server.ps1");
export const focusBrowserScript = path.resolve(moduleDir, "../../../scripts/windows/focus-browser.ps1");
export const startNvdaScript = path.resolve(moduleDir, "../../../scripts/windows/start-nvda.ps1");
export const stopNvdaScript = path.resolve(moduleDir, "../../../scripts/windows/stop-nvda.ps1");
