// Serialized into the testing page. Read only: never fill fields, change
// semantics, submit a form, or collect entered values.
export function describeFocusedControl() {
  let doc = document;
  let node = doc.activeElement;
  for (let depth = 0; depth < 20 && node; depth++) {
    if (node.shadowRoot?.activeElement) { node = node.shadowRoot.activeElement; continue; }
    if (node.tagName === "IFRAME") {
      try {
        const child = node.contentDocument;
        if (child?.activeElement) { doc = child; node = child.activeElement; continue; }
      } catch { /* Cross-origin content is not inferred from its iframe label. */ }
    }
    break;
  }
  if (!node || node === doc.body) return { documentFocused: doc.hasFocus(), tag: "body", role: "", name: "" };
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const fieldSelector = 'input,select,textarea,[contenteditable="true"],[role="textbox"],[role="searchbox"],[role="combobox"],[role="checkbox"],[role="radio"],[role="radiogroup"],[role="listbox"],[role="spinbutton"]';
  const tag = node.tagName.toLowerCase();
  const role = node.getAttribute("role") || "";
  const type = tag === "input" ? node.type : "";
  const isField = node.matches(fieldSelector) && !["hidden", "button", "submit", "reset", "image"].includes(type);
  const root = node.getRootNode();
  const references = (attribute) => clean(node.getAttribute(attribute)).split(/\s+/).filter(Boolean)
    .map((id) => root.getElementById?.(id)).filter(Boolean);
  const safeText = (element) => {
    if (!element || element === node || element.matches('input,textarea,select,[contenteditable="true"],[role="textbox"],[role="searchbox"]')) return "";
    const clone = element.cloneNode(true);
    clone.querySelectorAll(`${fieldSelector},script,style`).forEach((child) => child.remove());
    return clean(clone.textContent);
  };
  const labels = [...(node.labels || [])];
  const labelRefs = references("aria-labelledby");
  const labelTexts = [...labelRefs, ...labels].map(safeText);
  const ariaLabel = clean(node.getAttribute("aria-label"));
  const name = clean(labelRefs.map(safeText).join(" ") || ariaLabel || labels.map(safeText).join(" ")
    || (!isField ? node.textContent : "") || node.getAttribute("title") || node.getAttribute("placeholder")).slice(0, 300);
  const result = { documentFocused: doc.hasFocus(), tag, role, name, type };
  if (!isField) return result;

  const descriptions = references("aria-describedby").map(safeText);
  const wording = clean([...labelTexts, ariaLabel, ...descriptions].join(" "));
  const optional = /\b(?:not\s+(?:required|mandatory)|optional)\b/i.test(wording);
  // A general instruction such as "fields marked * are required" does not
  // make every field required, even when associated through aria-describedby.
  const requiredText = [...labelTexts, ariaLabel, ...descriptions].some((text) =>
    !/\b(?:not\s+(?:required|mandatory)|fields?\s+(?:marked|indicated))\b/i.test(text)
    && /(?:\b(?:required|mandatory)(?:\s+field)?\s*[)\].!:*]*$|^(?:required|mandatory)\s*[:—-])/i.test(text));
  const starPattern = /[*＊﹡∗✱✳]/u;
  const markerWording = [...labelTexts, ariaLabel, ...descriptions.filter((text) => /^\s*[*＊﹡∗✱✳]\s*$/u.test(text))].join(" ");
  let star = starPattern.test(markerWording);
  const sources = [];
  const nativeTypes = new Set(["text", "search", "url", "tel", "email", "password", "date", "month", "week", "time", "datetime-local", "number", "checkbox", "radio", "file"]);
  let nativeRequired = Boolean(node.required && (["select", "textarea"].includes(tag) || nativeTypes.has(type)));
  // One required radio makes the same named, same-form radio group required.
  if (type === "radio" && node.name && !nativeRequired) {
    const peers = node.form ? [...node.form.elements] : [...root.querySelectorAll('input[type="radio"]')];
    nativeRequired = peers.some((peer) => peer.type === "radio" && peer.name === node.name && peer.form === node.form && peer.required);
  }
  const ariaValue = node.getAttribute("aria-required");
  const ariaRequired = ariaValue?.trim().toLowerCase() === "true";
  if (nativeRequired) sources.push("HTML required");
  if (ariaRequired) sources.push("aria-required");
  if (requiredText) sources.push("Required/mandatory label or description");
  if (star) sources.push("Associated asterisk");
  // Include CSS-generated stars on the control or its actual labels, including
  // their spans. Do not borrow another field's marker from a form container.
  const visible = (element) => element.getClientRects().length > 0 && doc.defaultView.getComputedStyle(element).visibility !== "hidden";
  for (const element of [node, ...labels, ...labelRefs].flatMap((entry) => [entry, ...entry.querySelectorAll("span,abbr,i,b,sup")]).slice(0, 100)) {
    if (!visible(element)) continue;
    for (const pseudo of ["::before", "::after"]) {
      const style = doc.defaultView.getComputedStyle(element, pseudo);
      if (style.display !== "none" && style.visibility !== "hidden" && starPattern.test(style.content || "")) {
        star = true;
        if (!sources.includes("CSS asterisk")) sources.push("CSS asterisk");
      }
    }
  }
  for (const sibling of [node.previousElementSibling, node.nextElementSibling]) {
    if (sibling && visible(sibling) && (!sibling.control || sibling.control === node) && !sibling.matches(fieldSelector) && !sibling.querySelector(fieldSelector)
      && /^\s*[*＊﹡∗✱✳]\s*$/u.test(safeText(sibling))) {
      star = true;
      if (!sources.includes("Adjacent asterisk")) sources.push("Adjacent asterisk");
    }
  }
  const formScope = node.form || node.closest('form,[role="form"],fieldset');
  const explanationTexts = [...descriptions, ...(formScope ? [...formScope.querySelectorAll('p,legend,small,[role="note"]')].slice(0, 100).map(safeText) : [])];
  const explained = star && explanationTexts.some((text) => {
    const normalized = text.replace(/\basterisks?\b/gi, "*").replace(/[＊﹡∗✱✳]/gu, "*");
    return /(?:\*\s*(?:means?|indicates?|denotes?)?\s*(?:a\s+)?(?:required|mandatory)\b|\b(?:fields?|items?)\s+(?:marked|indicated)\s+(?:with\s+)?(?:an?\s+)?\*\s*(?:are|is|:)\s*(?:required|mandatory)\b|\b(?:required|mandatory)\s+(?:fields?|items?)\s+(?:are\s+)?(?:marked|indicated)\s+(?:with\s+)?\*)/i.test(normalized);
  });
  if (explained) sources.push("Asterisk explained as required");
  const required = nativeRequired || ariaRequired || requiredText || explained;
  const conflict = Boolean((required && optional) || (required && ariaValue?.trim().toLowerCase() === "false"));
  result.requiredField = {
    expectation: required ? "required" : star ? "possible" : "not-indicated",
    sources, nativeRequired, ariaRequired, hasRequiredText: requiredText, hasAsterisk: star,
    asteriskExplained: explained, conflict,
    language: node.closest("[lang]")?.getAttribute("lang") || doc.documentElement.lang || ""
  };
  return result;
}

// Observation, not a WCAG verdict. Only actual speech from this focus action
// is considered; a page-wide Say All transcript cannot prove a field's state.
export function assessRequiredAnnouncement(action) {
  const field = action.focus?.requiredField;
  if ((action.kind && action.kind !== "focus") || !field || field.expectation === "not-indicated") return null;
  const text = (action.announcements || []).join(" ");
  const meaningful = /\b(?:required|mandatory)\b/i.test(text) && !/\b(?:not\s+(?:required|mandatory)|optional)\b/i.test(text);
  const reliable = action.status === "executed" && !action.stateChanged && action.focus.documentFocused
    && action.audibleComplete === true;
  const supportedLanguage = /^en(?:-|$)/i.test(field.language || "en");
  let reason;
  if (field.conflict) reason = "Required and optional indicators conflict; review the field and its instructions.";
  else if (field.expectation === "possible") reason = "An associated asterisk was found, but its required-field meaning was not established. Review its instructions; no pass or failure is inferred.";
  else if (!reliable) reason = "A required indicator was found, but focus, execution or audible completion was not confirmed for this stop.";
  else if (!supportedLanguage) reason = "Required-field announcement matching is currently English-only. Review this language's actual speech manually.";
  else if (!meaningful) reason = "The captured announcement did not explicitly communicate required/mandatory. Review the actual speech and any associated form instructions.";
  else reason = "The actual focus announcement communicated required/mandatory. This is an observation, not a complete form or WCAG pass.";
  return { status: !field.conflict && field.expectation === "required" && reliable && supportedLanguage && meaningful ? "announced" : "needs-review",
    expectation: field.expectation, sources: [...(field.sources || [])], reason };
}

export function annotateRequiredAnnouncement(action) {
  const observation = assessRequiredAnnouncement(action);
  if (!observation) return;
  action.requiredFieldCheck = observation;
  if (observation.status === "needs-review") action.outcome = "needs-review";
}

export function requiredFieldSummary(actions) {
  const observations = actions.map((action) => action.requiredFieldCheck).filter(Boolean);
  const reviews = observations.filter((entry) => entry.status === "needs-review").length;
  return { status: reviews ? "needs-review" : observations.length ? "observed" : "not-observed", commands: observations.length,
    reason: `${observations.length} required-field focus observation(s); ${reviews} need review. Only reached focus stops are checked, not every field in the application.` };
}
