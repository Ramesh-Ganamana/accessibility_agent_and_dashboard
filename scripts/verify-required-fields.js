import assert from "node:assert/strict";
import { chromium } from "playwright";
import { describeFocusedElement } from "../src/assistive-technology/nvda.js";
import { assessRequiredAnnouncement } from "../src/assistive-technology/required-fields.js";

// Synthetic, headless DOM checks only. No NVDA, native keys, external websites,
// backend service, form submissions, or modifications to a real application.
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html lang="en"><head><style>
    .required-label::after { content: "*"; }
    .hidden-marker::after { content: "*"; display: none; }
  </style></head><body>
    <form id="explained"><p id="generalHint">Fields marked with * are required.</p>
      <label for="native">Email</label><input id="native" required value="PRIVATE_INPUT_VALUE">
      <label for="nativeSelect">Country</label><select id="nativeSelect" required><option>PRIVATE_OPTION_VALUE</option></select>
      <label for="text">Account (Mandatory)</label><input id="text">
      <label for="star">Name <span aria-hidden="true">*</span></label><input id="star">
      <label for="css" class="required-label">Address</label><input id="css">
      <label for="adjacent">City</label><input id="adjacent"><span>*</span>
      <label for="conflict">Optional *</label><input id="conflict" required>
      <label for="ariaFalse">Reference (required)</label><input id="ariaFalse" aria-required="false">
      <label for="generalInstruction">Unmarked field</label><input id="generalInstruction" aria-describedby="generalHint">
    </form>
    <form id="unexplained">
      <label for="unknown">Nickname *</label><input id="unknown">
      <label for="optional">Telephone (not required)</label><input id="optional">
      <label for="plain">Ordinary field</label><input id="plain"><a href="#">An unrelated star *</a>
      <label for="neighbor">Neighbor</label><input id="neighbor"><label for="other">*</label><input id="other">
      <label class="hidden-marker" for="hiddenCss">Hidden marker</label><input id="hiddenCss">
      <label for="unsupported">Range</label><input type="range" id="unsupported" required>
      <label for="r1">One</label><input id="r1" type="radio" name="group" required>
      <label for="r2">Two</label><input id="r2" type="radio" name="group">
      <label>Note (required)<textarea id="wrapped">PRIVATE_TEXTAREA_VALUE</textarea></label>
    </form>
    <span id="customLabel">Custom email</span><div id="custom" role="textbox" contenteditable="true" aria-required="true" aria-labelledby="customLabel">PRIVATE_EDITABLE_VALUE</div>
    <span id="partLabel">Translated</span><input id="language" lang="hi" aria-required="true" aria-labelledby="partLabel">
    <span id="hint">Mandatory</span><input id="described" aria-label="Description" aria-describedby="hint">
    <button id="notField">Required documents *</button>
    <div id="shadow"></div><iframe id="frame" title="Local sample"></iframe>
  </body></html>`);
  const original = await page.content();
  const inspect = async (id) => { await page.locator(`#${id}`).focus(); return describeFocusedElement(page); };
  for (const [id, source] of [["native", "HTML required"], ["nativeSelect", "HTML required"], ["text", "Required/mandatory label or description"],
    ["star", "Associated asterisk"], ["css", "CSS asterisk"], ["adjacent", "Adjacent asterisk"], ["custom", "aria-required"],
    ["wrapped", "Required/mandatory label or description"], ["described", "Required/mandatory label or description"], ["r2", "HTML required"]]) {
    const focus = await inspect(id);
    assert.equal(focus.requiredField.expectation, "required", id);
    assert.ok(focus.requiredField.sources.includes(source), `${id}: ${JSON.stringify(focus)}`);
    assert.doesNotMatch(JSON.stringify(focus), /PRIVATE_/);
    const observed = assessRequiredAnnouncement({ kind: "focus", status: "executed", audibleComplete: true, focus, announcements: [`${focus.name} edit required`] });
    assert.equal(observed.status, "announced", id);
  }
  assert.equal((await inspect("native")).name, "Email", "Use the associated label, never the input value.");
  for (const id of ["star", "css", "adjacent"]) assert.equal((await inspect(id)).requiredField.asteriskExplained, true, id);
  for (const id of ["optional", "plain", "neighbor", "hiddenCss", "unsupported", "generalInstruction"]) {
    assert.equal((await inspect(id)).requiredField.expectation, "not-indicated", id);
  }
  const unknown = await inspect("unknown");
  assert.equal(unknown.requiredField.expectation, "possible");
  assert.equal(unknown.requiredField.asteriskExplained, false, "Another form's explanation must not be borrowed.");
  assert.equal(assessRequiredAnnouncement({ kind: "focus", status: "executed", audibleComplete: true, focus: unknown, announcements: ["Nickname star edit"] }).status, "needs-review");
  for (const id of ["conflict", "ariaFalse"]) assert.equal((await inspect(id)).requiredField.conflict, true, id);
  assert.equal((await inspect("language")).requiredField.language, "hi");
  assert.equal((await inspect("notField")).requiredField, undefined);
  assert.equal(await page.content(), original, "Inspection must not change values, attributes or page content.");
  await page.evaluate(() => {
    document.querySelector("#shadow").attachShadow({ mode: "open" }).innerHTML = '<label for="shadowField">Shadow *</label><input id="shadowField" required>';
    document.querySelector("#frame").srcdoc = '<html lang="en"><label for="framed">Frame field</label><input id="framed" required></html>';
  });
  await page.locator("#shadowField").focus();
  assert.equal((await describeFocusedElement(page)).requiredField.nativeRequired, true);
  await page.frameLocator("#frame").locator("#framed").focus();
  const framed = await describeFocusedElement(page);
  assert.equal(framed.name, "Frame field");
  assert.equal(framed.requiredField.nativeRequired, true);
  console.log("Required-field DOM detection passed: HTML/ARIA, labels, descriptions, explained/unexplained stars, CSS, adjacent markers, conflicts, radio groups, frames, shadow DOM and value privacy. No real NVDA execution.");
} finally {
  await browser.close();
}
