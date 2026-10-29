import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeUrl, sanitizeUrlsInText } from "../src/url-security.js";

test("report URL sanitization removes credentials and tokens from hash routes", () => {
  assert.equal(sanitizeUrl("https://user:password@app.example/#/callback?access_token=secret&screen=home"),
    "https://app.example/#/callback?screen=home");
  assert.equal(sanitizeUrl("https://app.example/#!/callback?refresh_token=secret&state=random"),
    "https://app.example/#!/callback");
  assert.equal(sanitizeUrlsInText("Failed https://user:password@app.example/path?token=secret."),
    "Failed https://app.example/path.");
});

test("route and query trailing slashes are preserved during sanitization", () => {
  assert.equal(sanitizeUrl("https://app.example/?next=/"), "https://app.example/?next=/");
  assert.equal(sanitizeUrl("https://app.example/#/products/"), "https://app.example/#/products/");
});
