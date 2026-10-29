import fs from "node:fs/promises";
import path from "node:path";
import { getConfig } from "../src/config.js";
import { ENCRYPTED_SUFFIX, encryptionAvailable, readSavedSession, writeSavedSession } from "../src/browser/session-store.js";

// Moves plain-text saved sessions (auth_state*.json) out of the project folder
// into the encrypted per-user store. Dry run by default; --apply performs it.
// Each original is deleted only after its encrypted copy decrypts to the same
// content. An existing encrypted session is never overwritten by an older file.
const apply = process.argv.includes("--apply");
const config = getConfig();
const projectDir = path.dirname(config.legacyAuthStatePath);
const storeDir = path.dirname(config.authStatePath);

if (!encryptionAvailable()) {
  console.error("Windows DPAPI encryption is not available here, so plain-text sessions were left unchanged.");
  process.exit(1);
}

const legacyFiles = (await fs.readdir(projectDir)).filter((name) => /^auth_state(?:\.[a-z0-9.-]+)?\.json$/i.test(name));
if (!legacyFiles.length) {
  console.log("No plain-text session files were found in the project folder.");
  process.exit(0);
}

let failures = 0;
for (const name of legacyFiles) {
  const source = path.join(projectDir, name);
  const target = path.join(storeDir, name);
  try {
    const original = JSON.parse(await fs.readFile(source, "utf8"));
    if (!Array.isArray(original.cookies) || !Array.isArray(original.origins)) throw new Error("not a Playwright storage-state file");
    const existing = await fs.stat(`${target}${ENCRYPTED_SUFFIX}`).catch(() => null);
    if (!apply) {
      console.log(`${name}: ${existing ? "an encrypted session already exists; the plain file would be deleted" : `would be encrypted to ${target}${ENCRYPTED_SUFFIX} and the plain file deleted`}`);
      continue;
    }
    if (!existing) {
      await writeSavedSession(original, target, { encrypt: true });
      const roundTrip = await readSavedSession(target, null);
      if (!roundTrip?.encrypted || JSON.stringify(roundTrip.state) !== JSON.stringify(original)) throw new Error("the encrypted copy did not decrypt to the original content; the plain file was kept");
    }
    await fs.rm(source);
    console.log(`${name}: ${existing ? "already in the encrypted store" : "encrypted and moved"}; plain file deleted`);
  } catch (error) {
    failures += 1;
    console.error(`${name}: not migrated (${error.message})`);
  }
}
if (!apply) console.log(`\nDry run only. Run "npm run sessions:migrate -- --apply" to encrypt and move these files to ${storeDir}.`);
process.exitCode = failures ? 1 : 0;
