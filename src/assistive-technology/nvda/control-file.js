import fsp from "node:fs/promises";
import { randomBytes } from "node:crypto";

export async function writeControlFile(controlFile, control) {
  const temporary = `${controlFile}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await fsp.writeFile(temporary, JSON.stringify({ ...control, speechScope: "test-tab", expiresAtMs: Date.now() + 45_000 }), "utf8");
    // The add-on reads this file every 50 ms and Windows refuses to replace a
    // file that is open at that moment. A failed write becomes an NVDA stop.
    for (let attempt = 1; ; attempt++) {
      try { await fsp.rename(temporary, controlFile); break; }
      catch (error) {
        if (attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(error?.code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
      }
    }
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}
