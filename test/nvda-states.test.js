import test from "node:test";
import assert from "node:assert/strict";
import { createNvdaStateTarget, nvdaStateIdentity, selectNvdaStates } from "../src/assistive-technology/state-targets.js";

const url = "https://application.test/";
const report = { targetUrl: url, pages: [{ url, observedStates: [
  { id: `${url}::menu`, stateId: "menu", findingState: "interaction:Menu", url },
  { id: `${url}::dialog`, stateId: "dialog", findingState: "dialog:Details", url }
] }] };

test("NVDA keeps separate states at one URL and reports its own state limit", () => {
  const all = selectNvdaStates(report);
  assert.equal(all.targets.length, 3);
  assert.deepEqual(all.targets.map((target) => target.state), ["default", "interaction:Menu", "dialog:Details"]);
  assert.equal(all.targets[1].replay, null, "historical state recipes must not be fabricated");
  const limited = selectNvdaStates(report, undefined, 2);
  assert.equal(limited.discovered, 3);
  assert.equal(limited.targets.length, 2);
  assert.equal(limited.skippedByLimit, 1);
});

test("NVDA uses only current-run targets from successful same-origin pages", () => {
  const targets = [
    { id: "base", pageUrl: url, url, state: "default" },
    { id: "menu", pageUrl: url, url, state: "interaction:Menu" },
    { id: "menu", pageUrl: url, url, state: "duplicate" },
    { id: "external", pageUrl: url, url: "https://external.test/", state: "default" },
    { id: "failed", pageUrl: `${url}failed`, url: `${url}failed`, state: "default" }
  ];
  const input = { ...report, pages: [...report.pages, { url: `${url}failed`, error: "Forbidden" }] };
  assert.deepEqual(selectNvdaStates(input, targets).targets.map((target) => target.id), ["base", "menu"]);
  assert.equal(selectNvdaStates(report, []).targets.length, 0, "an empty current-run target list must not fall back to old page-only behavior");
});

test("state identity ignores the NVDA title marker but not changed content or controls", () => {
  const snapshot = { url, title: "Application", headings: ["Home"], dialogs: [], selectedTabs: [], expanded: [], body: "Home Menu Details" };
  const target = createNvdaStateTarget({ id: "base", url, pageUrl: url, snapshot, replay: { baseUrl: url, path: [] } });
  assert.equal(target.identity, nvdaStateIdentity({ ...snapshot, title: "RAMBO NVDA run document" }));
  assert.notEqual(target.identity, nvdaStateIdentity({ ...snapshot, dialogs: ["Details"] }));
  assert.notEqual(target.identity, nvdaStateIdentity({ ...snapshot, body: "Different application content" }));
  assert.equal(Object.hasOwn(target, "snapshot"), false, "raw page text is not retained by the replay target");
});
