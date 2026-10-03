import test from "node:test";
import assert from "node:assert/strict";
import { isControlCompatible } from "../src/browser/ai-login.js";

test("never fills a button even when AI labels it as a username action", () => {
  assert.equal(isControlCompatible("fill_username", { tag: "button", type: "submit", text: "Continue" }), false);
});

test("accepts text fields for usernames and password fields for passwords", () => {
  assert.equal(isControlCompatible("fill_username", { tag: "input", type: "text", id: "signInName" }), true);
  assert.equal(isControlCompatible("fill_password", { tag: "input", type: "password" }), true);
});

test("rejects username fields as password targets", () => {
  assert.equal(isControlCompatible("fill_password", { tag: "input", type: "text", label: "Email" }), false);
});

test("allows only clickable controls for authentication click actions", () => {
  assert.equal(isControlCompatible("click_login_entry", { tag: "a", text: "Sign in" }), true);
  assert.equal(isControlCompatible("click_auth_continue", { tag: "div", role: "button", text: "Continue" }), true);
  assert.equal(isControlCompatible("click_auth_continue", { tag: "input", type: "text" }), false);
});
