import test from "node:test";
import assert from "node:assert/strict";
import { actionExclusionsFor, isExcludedActionUrl, mergeActionExclusions, parseActionExclusions, sameApplicationOrigin } from "../src/browser/action-exclusions.js";
import { scanRequestError } from "../src/scan-request.js";
import { isExcludedActionLabel } from "../src/scanner/actions.js";

test("exclusions preserve multiple names and full URLs without silent truncation", () => {
  assert.deepEqual(parseActionExclusions(" First  button, Second button, Kaiser Permanente, First  button\nThird button"),
    ["First button", "Second button", "Kaiser Permanente", "Third button"]);
  const url = `https://example.test/image?token=${"a".repeat(300)}`;
  assert.deepEqual(parseActionExclusions(url), [url]);
  assert.deepEqual(parseActionExclusions(["Company, Inc.", url]), ["Company, Inc.", url]);
  assert.deepEqual(parseActionExclusions(undefined), []);
});

test("exclusion limits reject a request instead of silently dropping protection", () => {
  for (const excludeActionLabels of [{}, [1], [null], "x".repeat(2049), Array.from({ length: 101 }, (_, i) => `Control ${i}`)]) {
    assert.throws(() => parseActionExclusions(excludeActionLabels));
    assert.match(scanRequestError({ targetUrl: "https://example.test", excludeActionLabels }), /Do not click/);
  }
});

test("text entries match the whole label or whole words in it, never part of a word", () => {
  assert.equal(isExcludedActionLabel("First action details", ["first ACTION"]), true);
  assert.equal(isExcludedActionLabel("Visit Kaiser Permanente", ["Kaiser"]), true);
  assert.equal(isExcludedActionLabel("Pay now", ["Pay"]), true);
  assert.equal(isExcludedActionLabel("Payroll summary", ["Pay"]), false);
  assert.equal(isExcludedActionLabel("Go to /provider page", ["/provider"]), true);
  assert.equal(isExcludedActionLabel("Download (PDF)", ["(pdf)"]), true, "regular-expression characters in an entry are literal");
  assert.equal(isExcludedActionLabel("View details", ["Pay", "Close", "Kaiser"]), false);
  assert.equal(isExcludedActionLabel("Close", ["Sign in", "Pay", "close"]), true, "every entry is checked, not just the first");
  assert.equal(isExcludedActionLabel("KaiserPermanente", ["Kaiser Permanente"]), true, "raw text that lost the space between blocks still matches");
});

test("one entry per line; commas inside quotes, after a backslash or in a link query stay in the entry", () => {
  assert.deepEqual(parseActionExclusions('"No, thanks", Alpha option\nBravo option\r\nDoe\\, Jane'), ["No, thanks", "Alpha option", "Bravo option", "Doe, Jane"]);
  assert.deepEqual(parseActionExclusions("Home, Logo, /report?ids=1,2"), ["Home", "Logo", "/report?ids=1,2"], "a query comma never splits a URL into a stray '2' entry");
  assert.deepEqual(parseActionExclusions("/a, /b,/c"), ["/a", "/b", "/c"]);
  assert.deepEqual(parseActionExclusions(`First${String.fromCharCode(0x2028)}Second`), ["First", "Second"]);
  assert.deepEqual(parseActionExclusions('"Unterminated, entry'), ['"Unterminated', "entry"]);
});

test("server, dashboard and journey entries are merged, never replaced, and the combined limit still applies", () => {
  assert.deepEqual(mergeActionExclusions("Contact sales, /report?ids=1", "", undefined), ["Contact sales", "/report?ids=1"]);
  assert.deepEqual(mergeActionExclusions("Contact sales", "Open chat\nContact sales", ["Doe, Jane"]), ["Contact sales", "Open chat", "Doe, Jane"]);
  assert.throws(() => mergeActionExclusions(Array.from({ length: 60 }, (_, i) => `Env ${i}`), Array.from({ length: 41 }, (_, i) => `Form ${i}`)), /at most 100/);
});

test("the list applies to the application's www/https variants and adopted origins, not to unrelated hosts", () => {
  assert.equal(sameApplicationOrigin("http://localhost:8080", "http://www.localhost:8080"), true);
  assert.equal(sameApplicationOrigin("http://127.0.0.1:8080", "https://127.0.0.1:8443"), true);
  assert.equal(sameApplicationOrigin("http://127.0.0.1:8080", "http://localhost:8080"), false);
  assert.equal(sameApplicationOrigin("http://app.example.test:1", "http://app.example.test:2"), false);
  const config = { excludeActionLabels: ["Pay"], excludeActionOrigin: "http://app.example.test" };
  assert.deepEqual(actionExclusionsFor(config, "https://www.app.example.test/x"), ["Pay"]);
  assert.deepEqual(actionExclusionsFor(config, "https://portal.example.test/x"), []);
  assert.deepEqual(actionExclusionsFor({ ...config, excludeActionOrigins: ["https://portal.example.test"] }, "https://portal.example.test/x"), ["Pay"]);
});

test("URL entries match the same page however the crawler spells its address", () => {
  const origin = "http://127.0.0.1:5000";
  for (const [url, entry] of [
    [`${origin}/team/roster/`, "/team/roster"], [`${origin}/billing/summary#top`, `${origin}/billing/summary`],
    [`${origin}/report?id=7&utm_source=nav`, "/report?id=7"], [`${origin}/docs/handbook.pdf#page=2`, "/docs/handbook.pdf"],
    ["https://127.0.0.1:5001/team/roster", `${origin}/team/roster`], [`${origin}/provider/search`, "127.0.0.1:5000/provider/search"],
    [`${origin}/provider/search`, "provider/search"], [`${origin}/provider/search`, "/provider/search/"], [`${origin}/brand/logo.svg`, "logo.svg"],
    [`${origin}/report?ids=1,2`, "/report?ids=1,2"]
  ]) assert.equal(isExcludedActionUrl(url, ["Unrelated", entry]), true, `${entry} must match ${url}`);
  assert.equal(isExcludedActionUrl(`${origin}/home/news`, ["Home"]), false, "a plain word is not a path entry");
  assert.equal(isExcludedActionUrl(`${origin}/team/rosters`, ["/team/roster"]), false);
  assert.equal(isExcludedActionUrl(`${origin}/#/settings`, ["/#/billing"]), false, "hash routes stay distinct");
});
