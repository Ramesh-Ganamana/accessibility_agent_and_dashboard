import test from "node:test";
import assert from "node:assert/strict";
import { scanRequestError } from "../src/scan-request.js";

test("rejects malformed settings before acknowledging a scan", () => {
  for (const body of [undefined, null, [], "invalid", 1]) assert.ok(scanRequestError(body));
  for (const value of [null, [], "invalid", true, 42]) {
    assert.match(scanRequestError({ targetUrl: "https://example.test", auth: value }), /Authentication/);
    assert.match(scanRequestError({ targetUrl: "https://example.test", screenReaders: value }), /Screen-reader/);
  }
  assert.equal(scanRequestError({ targetUrl: "https://example.test", auth: { enabled: false } }), null);
  assert.equal(scanRequestError({ targetUrl: "https://example.test" }), null);
});

test("audit API accepts only supported profiles, versions and AA scope", () => {
  for (const audit of [null, [], "financial", { profile: "other" }, { wcagVersion: "3" }, { level: "AAA" }]) {
    assert.ok(scanRequestError({ targetUrl: "https://example.test", audit }));
  }
  for (const profile of ["general", "financial"]) for (const wcagVersion of ["2.1", "2.2"]) {
    assert.equal(scanRequestError({ targetUrl: "https://example.test", audit: { profile, wcagVersion, level: "AA" } }), null);
  }
});
