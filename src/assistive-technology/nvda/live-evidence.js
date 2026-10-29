import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// One screenshot registry per live session; equal images share evidence.
export function createNvdaEvidenceWriter(outputDir) {
  const screenshotHashes = new Map();
  async function screenshot(page, index, suffix = "") {
    const relative = path.posix.join("evidence", "nvda", `${String(index).padStart(3, "0")}-nvda-live${suffix}.png`);
    try {
      const buffer = await page.screenshot({ fullPage: false });
      const digest = createHash("sha256").update(buffer).digest("hex");
      if (screenshotHashes.has(digest)) return screenshotHashes.get(digest);
      await fs.mkdir(path.join(outputDir, "evidence", "nvda"), { recursive: true });
      await fs.writeFile(path.join(outputDir, ...relative.split("/")), buffer);
      screenshotHashes.set(digest, relative);
      return relative;
    } catch { return null; }
  }
  return screenshot;
}
