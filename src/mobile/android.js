import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Native Android screen checks from the UI Automator hierarchy (adb
// "uiautomator dump" or Appium's page source). The hierarchy does not expose
// labelFor, importantForAccessibility or colours, so anything those could
// change is reported for human review rather than as a confirmed failure.
const INTERACTIVE_CLASS = /(Button|CheckBox|Switch|RadioButton|ToggleButton|EditText|Spinner|SeekBar|CompoundButton|Chip|RatingBar)$/;
const TEXT_INPUT_CLASS = /(EditText|AutoCompleteTextView|TextInputEditText)$/;
const IMAGE_CLASS = /(ImageView|ImageButton)$/;
const SYSTEM_PACKAGES = new Set(["com.android.systemui", "com.google.android.inputmethod.latin", "com.android.launcher3", "com.google.android.apps.nexuslauncher"]);
const MINIMUM_DP = 24;
const RECOMMENDED_DP = 48;

export function parseUiHierarchy(xml) {
  const root = { tag: "hierarchy", attributes: {}, children: [], parent: null };
  const stack = [root];
  const pattern = /<\s*(\/)?\s*([A-Za-z_][\w.$-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/)?\s*>/g;
  for (const match of String(xml).replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g, "").matchAll(pattern)) {
    const [, closing, tag, rawAttributes, selfClosing] = match;
    if (closing) {
      if (stack.length > 1 && stack.at(-1).tag === tag) stack.pop();
      continue;
    }
    if (tag === "hierarchy") { Object.assign(root.attributes, attributesOf(rawAttributes)); continue; }
    const node = { tag, attributes: attributesOf(rawAttributes), children: [], parent: stack.at(-1) };
    stack.at(-1).children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

function attributesOf(raw) {
  const attributes = {};
  for (const [, name, double, single] of String(raw).matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attributes[name] = decodeEntities(double ?? single);
  return attributes;
}

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code) => {
    const lower = code.toLowerCase();
    if (lower[0] === "#") return String.fromCodePoint(lower[1] === "x" ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[lower];
  });
}

export function parseBounds(value) {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(String(value || "").trim());
  if (!match) return null;
  const [x1, y1, x2, y2] = match.slice(1).map(Number);
  return { x1, y1, x2, y2, width: x2 - x1, height: y2 - y1 };
}

function* walk(node) {
  for (const child of node.children) { yield child; yield* walk(child); }
}

const className = (node) => node.attributes.class || node.tag;
const flag = (node, name) => node.attributes[name] === "true";
const own = (node) => (node.attributes["content-desc"] || node.attributes.text || "").trim();
const isActionable = (node) => flag(node, "clickable") || flag(node, "long-clickable") || flag(node, "checkable") || INTERACTIVE_CLASS.test(className(node));
const labelledActionableAncestor = (node) => {
  for (let current = node.parent; current?.parent; current = current.parent) if (isActionable(current) && accessibleLabel(current)) return true;
  return false;
};
// Scrolled content is clipped to its container; a target cut off at the edge
// is not measured.
const clippedByScroller = (node, bounds) => {
  for (let current = node.parent; current?.parent; current = current.parent) {
    if (!flag(current, "scrollable")) continue;
    const outer = parseBounds(current.attributes.bounds);
    return Boolean(outer) && (bounds.x1 <= outer.x1 || bounds.y1 <= outer.y1 || bounds.x2 >= outer.x2 || bounds.y2 >= outer.y2);
  }
  return false;
};

// TalkBack reads a focusable container as its own description, or the text of
// descendants that are not focus stops themselves.
export function accessibleLabel(node) {
  if (own(node)) return own(node);
  const parts = [];
  const collect = (current) => {
    for (const child of current.children) {
      if (isActionable(child)) continue;
      if (own(child)) parts.push(own(child));
      else collect(child);
    }
  };
  collect(node);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function xpath(node) {
  const segments = [];
  for (let current = node; current?.parent; current = current.parent) {
    const name = className(current);
    const siblings = current.parent.children.filter((child) => className(child) === name);
    segments.unshift(`${name}[${siblings.indexOf(current) + 1}]`);
  }
  return `//${segments.join("/")}`;
}

function describe(node) {
  const { attributes } = node;
  const bounds = attributes.bounds ? ` bounds="${attributes.bounds}"` : "";
  const id = attributes["resource-id"] ? ` resource-id="${attributes["resource-id"]}"` : "";
  const text = attributes.text ? ` text="${attributes.text.slice(0, 80)}"` : "";
  const description = attributes["content-desc"] ? ` content-desc="${attributes["content-desc"].slice(0, 80)}"` : "";
  return `<${className(node)}${id}${text}${description}${bounds}>`;
}

function foregroundPackage(nodes, requested) {
  if (requested) return requested;
  const counts = new Map();
  for (const node of nodes) {
    const name = node.attributes.package;
    if (name && !SYSTEM_PACKAGES.has(name)) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts].sort((left, right) => right[1] - left[1])[0]?.[0] || "";
}

const intersects = (left, right) => left.x1 < right.x2 && right.x1 < left.x2 && left.y1 < right.y2 && right.y1 < left.y2;
const contains = (outer, inner) => outer.x1 <= inner.x1 && outer.y1 <= inner.y1 && outer.x2 >= inner.x2 && outer.y2 >= inner.y2;

// density is the device's dots per inch / 160 (adb shell wm density).
export function analyzeAndroidScreen(xml, { density = 2.625, packageName = "", screen = "Screen 1", screenUrl = "android-app://unknown/" } = {}) {
  const root = parseUiHierarchy(xml);
  const all = [...walk(root)];
  const appPackage = foregroundPackage(all, packageName);
  const nodes = all.filter((node) => (!appPackage || node.attributes.package === appPackage)
    && node.attributes.displayed !== "false" && (parseBounds(node.attributes.bounds)?.width || 0) > 0 && (parseBounds(node.attributes.bounds)?.height || 0) > 0);
  const findings = [];
  const add = (node, rule) => findings.push({
    ruleId: rule.ruleId, findingType: rule.type, category: rule.type === "best-practice" ? "best-practice" : "wcag",
    impact: rule.impact, help: rule.help, description: rule.description, failureSummary: rule.summary,
    wcag: rule.wcag || [], tags: rule.type === "best-practice" ? ["best-practice", "android"] : ["android"],
    target: [node.attributes["resource-id"] ? `${className(node)}[resource-id="${node.attributes["resource-id"]}"]` : xpath(node)],
    xpath: xpath(node), html: describe(node), bounds: node.attributes.bounds, pageUrl: screenUrl, state: screen,
    source: "android-uiautomator", region: "screen"
  });
  const actionable = nodes.filter(isActionable);
  const targets = actionable.map((node) => ({ node, bounds: parseBounds(node.attributes.bounds) }));
  const labels = new Map();

  for (const node of nodes) {
    const name = className(node);
    const label = accessibleLabel(node);
    const hint = (node.attributes.hint || "").trim();
    if (TEXT_INPUT_CLASS.test(name)) {
      if (!label && !hint) add(node, { ruleId: "android-input-no-label", type: "needs-review", impact: "serious", wcag: ["1.3.1", "3.3.2", "4.1.2"],
        help: "Text fields need a label or hint that TalkBack announces",
        description: "The field has no text, hint or content description in the hierarchy.",
        summary: "Confirm the field is labelled through android:labelFor or a Compose semantics label; otherwise add a visible label linked to it." });
      continue;
    }
    if (isActionable(node)) {
      if (!label) add(node, { ruleId: "android-control-no-name", type: "violation", impact: "critical", wcag: ["1.1.1", "4.1.2"],
        help: "Interactive elements need an accessible name",
        description: "A clickable or checkable element has no text or content description, and neither do its descendants.",
        summary: "Set contentDescription (or a Compose contentDescription/semantics label) describing the action." });
      else {
        const key = label.toLowerCase();
        labels.set(key, [...(labels.get(key) || []), node]);
        if (/\b(button|btn)\b/i.test(own(node)) && /Button$/.test(name)) add(node, { ruleId: "android-redundant-role-in-label", type: "best-practice", impact: "minor",
          help: "Do not include the control type in its label",
          description: `TalkBack already announces the role, so “${own(node).slice(0, 60)}” is read with the role twice.`,
          summary: "Remove the word “button” from the content description." });
      }
      if (flag(node, "clickable") && !flag(node, "focusable") && node.attributes.focusable !== undefined) add(node, { ruleId: "android-clickable-not-focusable", type: "needs-review", impact: "serious", wcag: ["2.1.1"],
        help: "Clickable elements should be reachable with a keyboard or switch",
        description: "The element is clickable but not focusable, so keyboard, D-pad and some switch users may not reach it.",
        summary: "Check it with an external keyboard and Switch Access; make it focusable if it cannot be reached." });
      continue;
    }
    if (IMAGE_CLASS.test(name) && !label && !labelledActionableAncestor(node)) add(node, { ruleId: "android-image-no-description", type: "needs-review", impact: "moderate", wcag: ["1.1.1"],
      help: "Informative images need a content description",
      description: "An image without a content description is present in the hierarchy.",
      summary: "If the image conveys information, add a content description; if it is decorative, mark it not important for accessibility." });
  }

  for (const { node, bounds } of targets) {
    if (!bounds || clippedByScroller(node, bounds)) continue;
    const widthDp = bounds.width / density;
    const heightDp = bounds.height / density;
    if (widthDp < MINIMUM_DP || heightDp < MINIMUM_DP) {
      // WCAG 2.5.8 spacing exception: a 24 dp square centred on the target
      // must not overlap another target.
      const half = (MINIMUM_DP * density) / 2;
      const centreX = (bounds.x1 + bounds.x2) / 2;
      const centreY = (bounds.y1 + bounds.y2) / 2;
      const zone = { x1: centreX - half, y1: centreY - half, x2: centreX + half, y2: centreY + half };
      const crowded = targets.some((other) => other.node !== node && other.bounds && !contains(other.bounds, bounds) && !contains(bounds, other.bounds) && intersects(zone, other.bounds));
      if (crowded) {
        add(node, { ruleId: "android-touch-target-too-small", type: "violation", impact: "serious", wcag: ["2.5.8"],
          help: "Touch targets must be at least 24 × 24 dp or adequately spaced",
          description: `The target is ${Math.round(widthDp)} × ${Math.round(heightDp)} dp and overlaps the 24 dp spacing zone of a neighbouring target.`,
          summary: "Enlarge the touch area (minimum 24 dp; Android recommends 48 dp) or add spacing." });
        continue;
      }
    }
    if (widthDp < RECOMMENDED_DP || heightDp < RECOMMENDED_DP) add(node, { ruleId: "android-touch-target-48dp", type: "best-practice", impact: "minor",
      help: "Android recommends touch targets of at least 48 × 48 dp",
      description: `The target is ${Math.round(widthDp)} × ${Math.round(heightDp)} dp.`,
      summary: "Increase the touch area with padding or TouchDelegate / Modifier.minimumInteractiveComponentSize()." });
  }

  for (const [label, duplicates] of labels) {
    const distinct = duplicates.filter((node) => !duplicates.some((other) => other !== node && contains(parseBounds(other.attributes.bounds), parseBounds(node.attributes.bounds))));
    if (distinct.length < 2) continue;
    for (const node of distinct) add(node, { ruleId: "android-duplicate-label", type: "best-practice", impact: "minor",
      help: "Different controls on one screen should have distinguishable labels",
      description: `${distinct.length} controls are announced as “${label.slice(0, 60)}”.`,
      summary: "Add context to each label (for example “Edit address”, “Edit phone”) if they perform different actions." });
  }

  return {
    packageName: appPackage, density,
    elements: nodes.length, interactiveElements: actionable.length,
    findings: findings.map((finding, index) => ({ id: `${finding.ruleId}-${screen.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${index + 1}`, ...finding }))
  };
}

export function resolveAdb(env = process.env) {
  const home = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  const candidate = home ? path.join(home, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb") : null;
  return candidate && fs.existsSync(candidate) ? candidate : "adb";
}

export function runAdb(args, { adb = resolveAdb(), serial, timeoutMs = 30_000, encoding = "utf8", spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(adb, [...(serial ? ["-s", serial] : []), ...args], { windowsHide: true });
    const chunks = [];
    let error = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`adb ${args[0]} timed out.`)); }, timeoutMs);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => { error += chunk.toString(); });
    child.once("error", (cause) => { clearTimeout(timer); reject(cause); });
    child.once("close", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks);
      if (code !== 0) return reject(new Error(error.trim() || `adb ${args[0]} exited with code ${code}.`));
      resolve(encoding === "buffer" ? output : output.toString(encoding));
    });
  });
}

export async function listAdbDevices(options) {
  const output = await runAdb(["devices", "-l"], options);
  return output.split(/\r?\n/).slice(1).map((line) => line.trim()).filter(Boolean)
    .map((line) => { const [serial, state, ...rest] = line.split(/\s+/); return { serial, state, details: rest.join(" ") }; });
}

// Captures the screen the device is showing: hierarchy, screenshot, density
// and foreground activity. Nothing is tapped or typed.
export async function captureAndroidScreen(options = {}) {
  const remote = "/sdcard/rambo-window-dump.xml";
  await runAdb(["shell", "uiautomator", "dump", "--compressed", remote], options).catch(() => runAdb(["shell", "uiautomator", "dump", remote], options));
  const xml = await runAdb(["exec-out", "cat", remote], options);
  await runAdb(["shell", "rm", "-f", remote], options).catch(() => {});
  const screenshot = await runAdb(["exec-out", "screencap", "-p"], { ...options, encoding: "buffer" }).catch(() => null);
  const densityText = await runAdb(["shell", "wm", "density"], options).catch(() => "");
  const dpi = Number((/Override density:\s*(\d+)/.exec(densityText) || /Physical density:\s*(\d+)/.exec(densityText) || [])[1]);
  const activityText = await runAdb(["shell", "dumpsys", "activity", "activities"], options).catch(() => "");
  const activity = (/(?:mResumedActivity|topResumedActivity|ResumedActivity):?\s*ActivityRecord\{[^ ]+ [^ ]+ ([\w.]+\/[\w.$]+)/.exec(activityText) || [])[1] || "";
  return { xml, screenshot, density: dpi > 0 ? dpi / 160 : 2.625, activity, packageName: activity.split("/")[0] || "" };
}
