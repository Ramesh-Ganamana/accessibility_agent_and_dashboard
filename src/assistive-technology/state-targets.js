import { createHash } from "node:crypto";
import { captureApplicationState, clickSafeAction, inventorySafeActions, isExcludedActionLabel, isUnsafeNavigationUrl } from "../scanner/actions.js";
import { detectPageAccessFailure, navigateAndWait } from "../browser/readiness.js";
import { sanitizeUrl } from "../url-security.js";

// Replay recipes stay in memory for this execution. Only IDs, state labels and
// outcomes are persisted; selectors and authenticated replay URLs are not added
// to the report by this module.
export function createNvdaStateTarget({ id, stateId, state, url, pageUrl, title, snapshot, replay }) {
  return { id, stateId, state, url, pageUrl, title, identity: nvdaStateIdentity(snapshot), replay };
}

export function nvdaStateIdentity(snapshot) {
  if (!snapshot) return null;
  // The test's browser title marker is deliberately excluded. Content/state
  // changes still invalidate a replay instead of silently testing another view.
  return createHash("sha256").update(JSON.stringify({
    url: sanitizeUrl(snapshot.url),
    headings: snapshot.headings,
    dialogs: snapshot.dialogs,
    selectedTabs: snapshot.selectedTabs,
    expanded: snapshot.expanded,
    body: snapshot.body
  })).digest("hex");
}

export function selectNvdaStates(report, stateTargets, limit = 100) {
  const eligiblePages = (report.pages || []).filter((page) => !page.error && sameOrigin(page.actualUrl || page.url, report.targetUrl));
  const eligibleUrls = new Set(eligiblePages.flatMap((page) => [page.url, page.actualUrl].filter(Boolean)));
  const candidates = Array.isArray(stateTargets) ? stateTargets : eligiblePages.flatMap((page) => [
    { id: page.url, state: "default", url: page.actualUrl || page.url, pageUrl: page.url, title: page.title,
      replay: { baseUrl: page.actualUrl || page.url, path: [] }, legacy: true },
    ...(page.observedStates || []).map((state) => ({
      id: state.id, stateId: state.stateId, state: state.findingState || state.label || state.state,
      url: state.url || page.url, pageUrl: page.url, title: state.label, replay: null, legacy: true
    }))
  ]);
  const seen = new Set();
  const all = candidates.filter((target) => {
    if (!target.id || seen.has(target.id) || !eligibleUrls.has(target.pageUrl || target.url) || !sameOrigin(target.url, report.targetUrl)) return false;
    seen.add(target.id);
    return true;
  });
  const parsed = Number(limit);
  const budget = Number.isFinite(parsed) ? Math.min(500, Math.max(1, Math.trunc(parsed))) : 100;
  return { targets: all.slice(0, budget), discovered: all.length, skippedByLimit: Math.max(0, all.length - budget) };
}

export async function restoreNvdaState(page, target, { beforeReplay = async () => {}, excludeLabels = [] } = {}) {
  if (!target.replay) throw new Error("No safe replay recipe was captured for this state. Run a new scan to test it with NVDA.");
  const { baseUrl, path = [] } = target.replay;
  if (!sameOrigin(baseUrl, target.url) || isUnsafeNavigationUrl(baseUrl)) throw new Error("The recorded state has no safe same-origin replay entry.");
  await navigateAndWait(page, baseUrl, { timeout: 60_000, shellWaitMs: 60_000, settleMs: 700 });
  await assertAccessibleApplication(page, target.url);
  await beforeReplay();
  for (const expected of path) {
    if (isExcludedActionLabel(expected.label, excludeLabels)) throw new Error("A state replay action is excluded for this application.");
    const candidates = await inventorySafeActions(page, { excludeLabels, attempts: 2 });
    const matches = candidates.filter((action) => expected.signature
      ? action.signature === expected.signature
      : action.path === expected.path && action.label === expected.label);
    if (matches.length !== 1) throw new Error(`The safe replay control “${expected.label || "unknown"}” is missing or ambiguous.`);
    if (matches[0].href && !sameOrigin(matches[0].href, target.url)) throw new Error("State replay would leave the application origin.");
    const result = await clickSafeAction(page, matches[0]);
    if (result.popup) await result.popup.close().catch(() => {});
    if (!result.clicked || result.popup) throw new Error("The recorded state could not be reopened in the dedicated browser.");
    await assertAccessibleApplication(page, target.url);
  }
  const observed = await captureApplicationState(page);
  if (sanitizeUrl(observed.url) !== sanitizeUrl(target.url)) throw new Error("State replay opened a different application route.");
  if (target.identity && nvdaStateIdentity(observed) !== target.identity) {
    throw new Error("State replay did not reproduce the captured content and controls; NVDA testing was not attributed to this state.");
  }
  return observed;
}

async function assertAccessibleApplication(page, targetUrl) {
  if (!sameOrigin(page.url(), targetUrl)) throw new Error("State replay left the application origin or reached an external login.");
  const failure = await detectPageAccessFailure(page);
  if (failure) throw new Error(`State replay reached an access-error page: ${failure}.`);
}

function sameOrigin(left, right) {
  try { return new URL(left).origin === new URL(right).origin; } catch { return false; }
}
