const INTERACTIVE_ROLES = new Set([
  "button", "checkbox", "combobox", "gridcell", "link", "listbox", "menuitem", "menuitemcheckbox",
  "menuitemradio", "option", "radio", "searchbox", "slider", "spinbutton", "switch", "tab", "textbox", "treeitem"
]);
const LANDMARK_ROLES = new Set(["banner", "complementary", "contentinfo", "form", "main", "navigation", "region", "search"]);
const ANNOUNCED_ROLES = new Set([
  ...INTERACTIVE_ROLES, ...LANDMARK_ROLES, "alert", "dialog", "heading", "img", "list", "listitem", "status", "table"
]);

export function assistiveTechnologyMetadata() {
  return {
    automatedMode: "browser-accessibility-tree",
    automatedLabel: "Chromium accessibility-tree readiness",
    actualScreenReaders: {
      NVDA: "not-run",
      JAWS: "not-run",
      VoiceOver: "not-run",
      TalkBack: "not-run"
    },
    actualRuns: {},
    claim: "readiness-only",
    disclaimer: "The browser accessibility tree was inspected. This is not a run with NVDA, JAWS, VoiceOver, or TalkBack and is not assistive-technology certification unless an actual product run is shown separately below."
  };
}

export async function captureScreenReaderSnapshot(page, frame, pageUrl, state = "default") {
  let session;
  try {
    session = await page.context().newCDPSession(frame || page);
    await session.send("Accessibility.enable");
    const { nodes = [] } = await session.send("Accessibility.getFullAXTree", { depth: -1 });
    const exposed = nodes.filter((node) => !node.ignored);
    const normalized = exposed.map(normalizeNode);
    const unnamedInteractive = normalized.filter((node) => INTERACTIVE_ROLES.has(node.role) && !node.name);
    const unnamedDialogs = normalized.filter((node) => node.role === "dialog" && !node.name);
    const unnamedImages = normalized.filter((node) => node.role === "img" && !node.name);
    const headings = normalized.filter((node) => node.role === "heading");
    const landmarks = normalized.filter((node) => LANDMARK_ROLES.has(node.role));
    const controls = normalized.filter((node) => INTERACTIVE_ROLES.has(node.role));
    const liveRegions = normalized.filter((node) => ["alert", "status"].includes(node.role) || node.live);
    const warnings = [];
    if (unnamedInteractive.length) warnings.push(`${unnamedInteractive.length} interactive accessibility-tree node(s) have no accessible name.`);
    if (unnamedDialogs.length) warnings.push(`${unnamedDialogs.length} dialog node(s) have no accessible name.`);
    if (unnamedImages.length) warnings.push(`${unnamedImages.length} exposed image node(s) have no accessible name.`);
    if (!headings.length) warnings.push("No heading was exposed in this accessibility-tree state.");
    if (!landmarks.some((node) => node.role === "main")) warnings.push("No main landmark was exposed in this accessibility-tree state.");

    return {
      status: warnings.length ? "review-required" : "tree-exposed",
      mode: "browser-accessibility-tree",
      pageUrl,
      frameUrl: frame?.url?.() || page.url(),
      state,
      capturedAt: new Date().toISOString(),
      counts: {
        totalNodes: nodes.length,
        exposedNodes: exposed.length,
        controls: controls.length,
        namedControls: controls.length - unnamedInteractive.length,
        unnamedControls: unnamedInteractive.length,
        headings: headings.length,
        landmarks: landmarks.length,
        dialogs: normalized.filter((node) => node.role === "dialog").length,
        liveRegions: liveRegions.length
      },
      warnings,
      announcementPreview: normalized
        .filter((node) => ANNOUNCED_ROLES.has(node.role) && (node.name || INTERACTIVE_ROLES.has(node.role) || ["dialog", "img"].includes(node.role)))
        .slice(0, 60)
        .map((node) => ({ role: node.role, name: node.name, value: node.value, description: node.description, states: node.states }))
    };
  } catch (error) {
    return {
      status: "unavailable",
      mode: "browser-accessibility-tree",
      pageUrl,
      frameUrl: frame?.url?.() || page.url(),
      state,
      capturedAt: new Date().toISOString(),
      counts: {},
      warnings: [`Accessibility tree could not be captured: ${String(error?.message || error).split("\n", 1)[0]}`],
      announcementPreview: []
    };
  } finally {
    await session?.detach().catch(() => {});
  }
}

function normalizeNode(node) {
  const properties = Object.fromEntries((node.properties || []).map((property) => [property.name, property.value?.value]));
  return {
    role: String(node.role?.value || "").toLowerCase(),
    name: clean(node.name?.value),
    value: clean(node.value?.value),
    description: clean(node.description?.value),
    live: clean(properties.live),
    states: [
      properties.disabled ? "disabled" : null,
      properties.expanded === true ? "expanded" : properties.expanded === false ? "collapsed" : null,
      properties.focused ? "focused" : null,
      properties.invalid && properties.invalid !== "false" ? "invalid" : null,
      properties.required ? "required" : null,
      properties.selected ? "selected" : null
    ].filter(Boolean)
  };
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
}
