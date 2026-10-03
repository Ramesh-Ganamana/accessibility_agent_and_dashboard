import test from "node:test";
import assert from "node:assert/strict";
import { isExcludedActionLabel, isUnsafeActionLabel } from "../src/scanner/actions.js";
import { sanitizeUrl, sanitizeUrlsInText } from "../src/url-security.js";
import { scopedAuthStatePath } from "../src/browser/session.js";

test("registration actions are never treated as safe crawl actions", () => {
  for (const label of ["Create your account", "Register now", "Sign up", "Enroll", "Join now", "Open account"]) {
    assert.equal(isUnsafeActionLabel(label), true, label);
  }
});

test("per-scan action exclusions use normalized exact labels", () => {
  assert.equal(isExcludedActionLabel("  External   Provider ", ["external provider"]), true);
  assert.equal(isExcludedActionLabel("External Provider Details", ["external provider"]), false);
});

test("OAuth and SSO values are removed from report URLs", () => {
  const sanitized = sanitizeUrl("https://app.example/callback?code=secret&state=random&screen=rewards#ignored");
  assert.equal(sanitized, "https://app.example/callback?screen=rewards");
});

test("OAuth and SSO values are removed from navigation error messages", () => {
  const message = sanitizeUrlsInText("Navigation was interrupted by https://app.example/callback?code=secret&state=random&screen=rewards.");
  assert.equal(message, "Navigation was interrupted by https://app.example/callback?screen=rewards.");
});

test("saved browser sessions are isolated by application hostname", () => {
  const first = scopedAuthStatePath("C:/scan/auth_state.json", "https://app-one.example/login");
  const second = scopedAuthStatePath("C:/scan/auth_state.json", "https://app-two.example/login");
  assert.match(first.replaceAll("\\", "/"), /auth_state\.app-one\.example\.json$/);
  assert.notEqual(first, second);
});
