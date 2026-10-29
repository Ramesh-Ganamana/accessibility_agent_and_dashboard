import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const safeName = (value) => String(value).replace(/[^a-z0-9_-]+/gi, "-").slice(0, 80);

function selectorSegments(target) {
  if (typeof target === "string") return [target];
  if (!Array.isArray(target)) return [];
  return target.flat(Infinity).filter((part) => typeof part === "string" && part.trim());
}

export function resolveTarget(frame, target) {
  const segments = selectorSegments(target);
  if (!segments.length) return null;
  let locator = frame.locator(segments.shift()).first();
  for (const segment of segments) locator = locator.locator(segment).first();
  return locator;
}

export function createEvidenceRegistry() {
  return new Map();
}

export async function storeDeduplicatedEvidence({ outputDir, relativeDir = "evidence", fileName, buffer, registry }) {
  const digest = createHash("sha256").update(buffer).digest("hex");
  const existing = registry?.get(digest);
  if (existing) return { path: existing, duplicate: true };
  const relativePath = path.posix.join(relativeDir.replace(/\\/g, "/"), fileName);
  const absolutePath = path.join(outputDir, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, buffer);
  registry?.set(digest, relativePath);
  return { path: relativePath, duplicate: false };
}

export function consolidateDuplicateVisualFindings(report) {
  const removedIds = new Set();
  let mergedCount = 0;

  for (const collectionName of ["issues", "incomplete", "bestPractices"]) {
    const findings = Array.isArray(report?.[collectionName]) ? report[collectionName] : [];
    const retainedByVisual = new Map();
    const retained = [];

    for (const finding of findings) {
      // Page-context screenshots intentionally support many different findings. Only
      // consolidate findings that produced the same highlighted screenshot bytes.
      if (!finding?.evidence || finding.evidenceKind === "page-context") {
        retained.push(finding);
        continue;
      }

      const key = [finding.evidence, finding.ruleId, finding.pageUrl, finding.frameUrl || ""].join("|");
      const existing = retainedByVisual.get(key);
      if (!existing) {
        finding.observedOccurrences = [findingOccurrence(finding)];
        retainedByVisual.set(key, finding);
        retained.push(finding);
        continue;
      }

      existing.observedOccurrences.push(findingOccurrence(finding));
      removedIds.add(finding.id);
      mergedCount += 1;
    }

    if (collectionName !== "bestPractices" || Array.isArray(report?.bestPractices)) report[collectionName] = retained;
  }

  if (removedIds.size) {
    for (const page of report.pages || []) {
      page.issueIds = (page.issueIds || []).filter((id) => !removedIds.has(id));
      page.incompleteIds = (page.incompleteIds || []).filter((id) => !removedIds.has(id));
      if (page.bestPracticeIds) page.bestPracticeIds = page.bestPracticeIds.filter((id) => !removedIds.has(id));
    }
  }

  return mergedCount;
}

function findingOccurrence(finding) {
  return {
    id: finding.id,
    state: finding.state,
    target: finding.target
  };
}

export async function captureHighlightedEvidence({ page, frame, target, issue, outputDir, index, evidenceRegistry }) {
  const expectedFrameUrl = comparableUrl(issue.frameUrl);
  if (expectedFrameUrl && comparableUrl(frame.url()) !== expectedFrameUrl) return null;
  if (!(await matchesDocument(frame, issue.documentToken))) return null;
  const locator = resolveTarget(frame, target);
  if (!locator) return null;

  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 2_500 });
    const box = await locator.boundingBox({ timeout: 2_500 });
    if (!box || box.width < 1 || box.height < 1) return null;
    if (expectedFrameUrl && comparableUrl(frame.url()) !== expectedFrameUrl) return null;
    if (!(await matchesDocument(frame, issue.documentToken))) return null;

    const label = `${issue.wcag?.[0] ? `WCAG ${issue.wcag[0]} · ` : ""}${issue.help}`;
    await page.evaluate(({ rect, text }) => {
      document.querySelector("[data-a11y-evidence-overlay]")?.remove();
      const overlay = document.createElement("div");
      overlay.dataset.a11yEvidenceOverlay = "true";
      Object.assign(overlay.style, {
        position: "fixed",
        left: `${Math.max(0, rect.x - 4)}px`,
        top: `${Math.max(0, rect.y - 4)}px`,
        width: `${Math.max(12, rect.width + 8)}px`,
        height: `${Math.max(12, rect.height + 8)}px`,
        border: "4px solid #ff3b5c",
        borderRadius: "8px",
        boxShadow: "0 0 0 3px rgba(255,255,255,.9), 0 10px 30px rgba(95,15,31,.35)",
        pointerEvents: "none",
        zIndex: "2147483647",
        boxSizing: "border-box"
      });
      const badge = document.createElement("div");
      badge.textContent = text;
      Object.assign(badge.style, {
        position: "absolute",
        left: "-4px",
        bottom: "calc(100% + 8px)",
        maxWidth: "420px",
        padding: "7px 10px",
        color: "#fff",
        background: "#c9183c",
        borderRadius: "6px",
        font: "600 13px/1.25 system-ui, sans-serif",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        boxShadow: "0 4px 16px rgba(0,0,0,.25)"
      });
      overlay.appendChild(badge);
      document.documentElement.appendChild(overlay);
    }, { rect: box, text: label });

    const fileName = `${String(index).padStart(4, "0")}-${safeName(issue.ruleId)}.png`;
    if (expectedFrameUrl && comparableUrl(frame.url()) !== expectedFrameUrl || !(await matchesDocument(frame, issue.documentToken))) {
      await page.evaluate(() => document.querySelector("[data-a11y-evidence-overlay]")?.remove()).catch(() => {});
      return null;
    }
    const screenshot = await page.screenshot({ fullPage: false });
    if (!(await matchesDocument(frame, issue.documentToken))) {
      await page.evaluate(() => document.querySelector("[data-a11y-evidence-overlay]")?.remove()).catch(() => {});
      return null;
    }
    const stored = await storeDeduplicatedEvidence({ outputDir, fileName, buffer: screenshot, registry: evidenceRegistry });
    await page.evaluate(() => document.querySelector("[data-a11y-evidence-overlay]")?.remove());

    return stored.path;
  } catch {
    await page.evaluate(() => document.querySelector("[data-a11y-evidence-overlay]")?.remove()).catch(() => {});
    return null;
  }
}

async function matchesDocument(frame, token) {
  if (!token) return true;
  return frame.evaluate((expected) => globalThis.__clarityDocumentToken === expected, token).catch(() => false);
}

function comparableUrl(value) {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:code|state|session_state|access_token|id_token|token|nonce)$/i.test(key)) url.searchParams.delete(key);
    }
    if (!/^#(?:!\/|\/)/.test(url.hash)) url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return String(value || "");
  }
}
