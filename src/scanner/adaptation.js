import { storeDeduplicatedEvidence } from "./evidence.js";
import { waitForPageReady } from "../browser/readiness.js";

// WCAG 1.4.12 test values (the W3C text-spacing bookmarklet).
const TEXT_SPACING_CSS = "*:not(svg):not(svg *){line-height:1.5!important;letter-spacing:0.12em!important;word-spacing:0.16em!important}p{margin-bottom:2em!important}";
const MAX_TARGETS = 6;

// Checks how a page adapts for low-vision users and records needs-review
// findings with a screenshot taken while the condition is applied:
//   1.4.4  text resized to 200% (a 640 CSS px viewport = 200% zoom at 1280 px)
//   1.4.10 reflow at 320 CSS px without two-dimensional scrolling
//   1.4.12 increased text spacing without clipped text
// The viewport is restored afterwards. When the viewport cannot be resized
// (a maximized headed window shared with NVDA), only the text-spacing check runs.
export async function scanVisualAdaptation(page, pageUrl, { canResize = true, outputDir, evidenceRegistry, nextEvidenceIndex = () => 0 } = {}) {
  const findings = [];
  const original = page.viewportSize();
  const baseline = await measure(page).catch(() => null);
  if (!baseline) return { findings, skipped: ["The page could not be measured for zoom, reflow and text spacing."] };
  const skipped = [];
  const capture = async (name) => {
    if (!outputDir) return null;
    const buffer = await page.screenshot({ fullPage: false }).catch(() => null);
    if (!buffer) return null;
    return (await storeDeduplicatedEvidence({ outputDir, fileName: `${String(nextEvidenceIndex()).padStart(4, "0")}-${name}.png`, buffer, registry: evidenceRegistry })).path;
  };

  if (canResize && original) {
    try {
      for (const [width, criterion] of [[640, "1.4.4"], [320, "1.4.10"]]) {
        await page.setViewportSize({ width, height: original.height });
        await settle(page);
        const state = await measure(page);
        const newlyClipped = state.clipped.filter((entry) => !baseline.clippedKeys.includes(entry.key));
        const overflowing = state.overflowing;
        if (criterion === "1.4.10" && state.horizontalScroll) {
          findings.push(needsReview("reflow-horizontal-scroll", ["1.4.10"], "serious", "Content needs horizontal scrolling at 320 CSS pixels",
            `At a 320 CSS px wide viewport (400% zoom at 1280 px) the page is ${state.scrollWidth} px wide, so content needs scrolling in two directions. Data tables, maps, diagrams and toolbars are permitted exceptions.`,
            overflowing.length ? overflowing : [{ target: "html", label: "page" }], pageUrl, `${overflowing.length} element(s) extend beyond the viewport.`, await capture("reflow-320")));
        }
        if (newlyClipped.length) {
          const rule = criterion === "1.4.4" ? "zoom-text-clipped" : "reflow-text-clipped";
          findings.push(needsReview(rule, [criterion], "serious", criterion === "1.4.4" ? "Text is cut off when zoomed to 200%" : "Text is cut off when reflowed to 320 CSS pixels",
            `${newlyClipped.length} text element(s) are clipped at a ${width} CSS px viewport that are fully visible at the original size.`,
            newlyClipped, pageUrl, newlyClipped.slice(0, 3).map((entry) => `“${entry.label}”`).join(", "), await capture(criterion === "1.4.4" ? "zoom-200" : "reflow-320-clipped")));
        }
      }
    } finally {
      await page.setViewportSize(original).catch(() => {});
      await settle(page);
    }
  } else {
    skipped.push("Zoom (1.4.4) and reflow (1.4.10) checks were skipped because the browser window is shared with the NVDA test and cannot be resized.");
  }

  try {
    await page.addStyleTag({ content: TEXT_SPACING_CSS }).then((handle) => handle.evaluate((node) => node.setAttribute("data-a11y-text-spacing", "true")));
    await page.waitForTimeout(250);
    const spaced = await measure(page);
    const newlyClipped = spaced.clipped.filter((entry) => !baseline.clippedKeys.includes(entry.key));
    if (newlyClipped.length) {
      findings.push(needsReview("text-spacing-clipped", ["1.4.12"], "serious", "Text is cut off with increased text spacing",
        `With WCAG text-spacing values (line height 1.5, letter 0.12em, word 0.16em, paragraph 2em), ${newlyClipped.length} text element(s) are clipped that were fully visible before.`,
        newlyClipped, pageUrl, newlyClipped.slice(0, 3).map((entry) => `“${entry.label}”`).join(", "), await capture("text-spacing")));
    }
  } finally {
    await page.evaluate(() => document.querySelectorAll("[data-a11y-text-spacing]").forEach((node) => node.remove())).catch(() => {});
  }
  return { findings, skipped };
}

async function settle(page) {
  await page.waitForTimeout(300);
  await waitForPageReady(page, { timeout: 4_000, settleMs: 300 }).catch(() => {});
}

// Runs in the page: horizontal overflow and clipped text, ignoring the
// two-dimensional content WCAG 1.4.10 permits to scroll.
function measureInPage(maxTargets) {
  const exempt = "table,pre,code,canvas,svg,video,iframe,map,img,[role='grid'],[role='toolbar'],[role='img'],[role='application'],math";
  const selector = (element) => {
    if (element.id) return `#${CSS.escape(element.id)}`;
    const parts = [];
    for (let node = element; node && node !== document.body && parts.length < 5; node = node.parentElement) {
      const siblings = node.parentElement ? [...node.parentElement.children].filter((item) => item.localName === node.localName) : [];
      parts.unshift(`${node.localName}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : ""}`);
    }
    return parts.join(" > ");
  };
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const scrollsItself = (element) => {
    for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
      const overflowX = getComputedStyle(node).overflowX;
      if (overflowX === "auto" || overflowX === "scroll") return true;
    }
    return false;
  };
  const ownText = (element) => [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 1);
  const overflowing = [];
  const clipped = [];
  for (const element of document.body?.querySelectorAll("*") || []) {
    if (!visible(element) || element.closest(exempt) || element.closest("[data-a11y-evidence-overlay],[data-a11y-grounding-overlay]")) continue;
    const rect = element.getBoundingClientRect();
    if (overflowing.length < maxTargets && rect.right > innerWidth + 2 && rect.width < document.documentElement.scrollWidth && !scrollsItself(element) && ownText(element)) {
      overflowing.push({ target: selector(element), label: element.textContent.trim().replace(/\s+/g, " ").slice(0, 60) });
    }
    if (ownText(element)) {
      const style = getComputedStyle(element);
      const hides = (value) => value === "hidden" || value === "clip";
      const clipsVertically = hides(style.overflowY) && element.scrollHeight > element.clientHeight + 2;
      const clipsHorizontally = hides(style.overflowX) && element.scrollWidth > element.clientWidth + 2 && style.textOverflow !== "ellipsis";
      if ((clipsVertically || clipsHorizontally) && clipped.length < 200) {
        clipped.push({ key: selector(element), target: selector(element), label: element.textContent.trim().replace(/\s+/g, " ").slice(0, 60) });
      }
    }
  }
  return {
    scrollWidth: document.documentElement.scrollWidth,
    horizontalScroll: document.documentElement.scrollWidth > innerWidth + 2,
    overflowing,
    clipped,
    clippedKeys: clipped.map((entry) => entry.key)
  };
}

async function measure(page) {
  const result = await page.evaluate(measureInPage, MAX_TARGETS);
  result.clipped = result.clipped.slice(0, 200);
  return result;
}

function needsReview(ruleId, wcag, impact, help, description, elements, pageUrl, summary, evidence) {
  const targets = elements.slice(0, MAX_TARGETS);
  return {
    id: `${ruleId}-${simpleHash(`${pageUrl}-${targets.map((entry) => entry.target).join("|")}`)}`,
    findingType: "needs-review",
    ruleId,
    impact,
    help,
    description,
    helpUrl: `https://www.w3.org/WAI/WCAG22/Understanding/${{ "1.4.4": "resize-text", "1.4.10": "reflow", "1.4.12": "text-spacing" }[wcag[0]]}.html`,
    tags: ["wcag2aa", "wcag21aa", ...wcag.map((id) => `wcag${id.replaceAll(".", "")}`)],
    wcag,
    target: [targets[0]?.target || "html"],
    relatedTargets: targets.map((entry) => entry.target),
    html: targets.map((entry) => `<${entry.target}> ${entry.label || ""}`).join("\n").slice(0, 800),
    failureSummary: summary,
    pageUrl,
    frameUrl: pageUrl,
    state: `adaptation:${wcag[0]}`,
    evidence,
    evidenceKind: evidence ? "condition" : "unavailable",
    source: "visual-adaptation"
  };
}

function simpleHash(value) {
  let hash = 0;
  for (const char of value) hash = Math.imul(31, hash) + char.charCodeAt(0) | 0;
  return Math.abs(hash).toString(36);
}
