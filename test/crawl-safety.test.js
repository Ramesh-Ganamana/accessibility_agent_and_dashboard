import test from "node:test";
import assert from "node:assert/strict";
import { isExcludedActionLabel, isUnsafeActionLabel, isUnsafeNavigationUrl } from "../src/scanner/actions.js";
import { sanitizeUrl, sanitizeUrlsInText } from "../src/url-security.js";
import { scopedAuthStatePath } from "../src/browser/session.js";

test("registration actions are never treated as safe crawl actions", () => {
  for (const label of ["Create your account", "Register now", "Sign up", "Enroll", "Join now", "Open account"]) {
    assert.equal(isUnsafeActionLabel(label), true, label);
  }
});

test("mutating URL actions and account deactivation are excluded", () => {
  assert.equal(isUnsafeActionLabel("Deactivate account"), true);
  for (const url of ["https://app.example/logout", "https://app.example/user/deactivate", "https://app.example/work?action=delete", "https://app.example/#/sign-out", "javascript:saveAccount()"])
    assert.equal(isUnsafeNavigationUrl(url), true, url);
  assert.equal(isUnsafeNavigationUrl("https://app.example/reports?page=2"), false);
});

test("per-scan action exclusions match normalized labels and whole words within them", () => {
  assert.equal(isExcludedActionLabel("  External   Provider ", ["external provider"]), true);
  assert.equal(isExcludedActionLabel("External Provider Details", ["external provider"]), true);
  assert.equal(isExcludedActionLabel("ExternalProvider Details", ["external provider"]), false);
});

test("financial mutations are excluded across every application profile", () => {
  for (const label of ["Sell", "Transfer funds", "Withdraw", "Redeem units", "Deposit", "Invest now", "Authorize payment", "Place trade", "Modify order", "E-sign agreement"]) {
    assert.equal(isUnsafeActionLabel(label), true, label);
  }
  for (const url of ["https://app.example/transfer", "https://app.example/?action=redeem", "https://app.example/orders/modify-order"]) {
    assert.equal(isUnsafeNavigationUrl(url), true, url);
  }
  for (const label of ["Portfolio", "Order history", "Statements", "Market overview", "Transactions", "Services"]) {
    assert.equal(isUnsafeActionLabel(label), false, label);
  }
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
