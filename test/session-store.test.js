import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { decryptText, encryptText, encryptionAvailable, readSavedSession, writeSavedSession } from "../src/browser/session-store.js";

// A stand-in for the DPAPI helper: "encrypts" by reversing the base64 text.
function fakeDpapi({ fail = false, calls = [] } = {}) {
  return (command, args) => {
    const mode = args[args.indexOf("-Mode") + 1];
    calls.push(mode);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    let input = "";
    child.stdin = { end: (value) => { input = value; setImmediate(finish); } };
    function finish() {
      if (fail) { child.stderr.emit("data", Buffer.from("Key not valid for use in specified state.\r\nat line 4")); child.emit("close", 1); return; }
      child.stdout.emit("data", Buffer.from(`${[...input].reverse().join("")}\r\n`));
      child.emit("close", 0);
    }
    return child;
  };
}

const state = { cookies: [{ name: "session", value: "secret-cookie-value", domain: "app.test" }], origins: [] };

test("saved sessions are written encrypted and the plain copy is removed", async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-store-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "nested", "auth_state.app.test.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ cookies: [], origins: [] }));
  const calls = [];
  const written = await writeSavedSession(state, file, { encrypt: true, spawnProcess: fakeDpapi({ calls }) });
  assert.deepEqual(written, { path: `${file}.dpapi`, encrypted: true });
  await assert.rejects(fs.stat(file), { code: "ENOENT" }, "the plain file is removed after an encrypted save");
  const raw = await fs.readFile(`${file}.dpapi`, "utf8");
  assert.equal(raw.includes("secret-cookie-value"), false, "cookie values never appear in the encrypted file");
  assert.equal(JSON.parse(raw).format, "rambo-dpapi-v1");
  const read = await readSavedSession(file, null, { spawnProcess: fakeDpapi({ calls }) });
  assert.deepEqual(read.state, state);
  assert.equal(read.encrypted, true);
  assert.deepEqual(calls, ["Protect", "Unprotect"]);
  assert.equal((await fs.readdir(path.dirname(file))).some((name) => name.endsWith(".tmp")), false, "no temporary files remain");
});

test("reading falls back to plain and legacy files in order", async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-store-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "auth_state.json");
  const legacy = path.join(dir, "legacy.json");
  assert.equal(await readSavedSession(file, legacy), null);
  await fs.writeFile(legacy, JSON.stringify({ cookies: [], origins: [], from: "legacy" }));
  assert.deepEqual(await readSavedSession(file, legacy).then((value) => [value.state.from, value.legacy, value.encrypted]), ["legacy", true, false]);
  await fs.writeFile(file, JSON.stringify({ cookies: [], origins: [], from: "plain" }));
  assert.equal((await readSavedSession(file, legacy)).state.from, "plain");
  await writeSavedSession({ cookies: [], origins: [], from: "encrypted" }, file, { encrypt: true, spawnProcess: fakeDpapi() });
  assert.equal((await readSavedSession(file, legacy, { spawnProcess: fakeDpapi() })).state.from, "encrypted");
});

test("decryption failures and unknown formats are reported, never ignored silently", async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-store-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "auth_state.json");
  await fs.writeFile(`${file}.dpapi`, JSON.stringify({ format: "something-else", data: "x" }));
  await assert.rejects(readSavedSession(file, null), /not in a recognized encrypted format/);
  await fs.writeFile(`${file}.dpapi`, JSON.stringify({ format: "rambo-dpapi-v1", data: "abc" }));
  await assert.rejects(readSavedSession(file, null, { spawnProcess: fakeDpapi({ fail: true }) }), /decryption failed: Key not valid for use in specified state\.$/);
  await assert.rejects(writeSavedSession(state, path.join(dir, "other.json"), { encrypt: true, spawnProcess: fakeDpapi({ fail: true }) }), /encryption failed/);
  await assert.rejects(fs.stat(path.join(dir, "other.json.dpapi")), { code: "ENOENT" }, "a failed encryption writes nothing");
});

test("without encryption the plain format is kept", async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-store-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "auth_state.json");
  assert.deepEqual(await writeSavedSession(state, file, { encrypt: false }), { path: file, encrypted: false });
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), state);
});

test("real Windows DPAPI round trip for the current user", { skip: !encryptionAvailable() && "DPAPI is only available on Windows" }, async () => {
  const text = "Unicode check: ₹ ✓ — secret-cookie-value";
  const protectedText = await encryptText(text);
  assert.equal(protectedText.includes("secret"), false);
  assert.notEqual(Buffer.from(protectedText, "base64").toString("utf8"), text);
  assert.equal(await decryptText(protectedText), text);
});
