import test from "node:test";
import assert from "node:assert/strict";
import { assessRequiredAnnouncement, annotateRequiredAnnouncement, requiredFieldSummary } from "../src/assistive-technology/required-fields.js";

function action(overrides = {}, field = {}) {
  return { kind: "focus", status: "executed", audibleComplete: true, announcements: ["Email edit required"],
    focus: { documentFocused: true, requiredField: { expectation: "required", sources: ["HTML required"], language: "en", ...field } }, ...overrides };
}

test("required speech is an observation, never a conformance pass", () => {
  assert.equal(assessRequiredAnnouncement(action()).status, "announced");
  assert.equal(assessRequiredAnnouncement(action({ announcements: ["Email edit mandatory"] })).status, "announced");
  assert.match(assessRequiredAnnouncement(action()).reason, /not a complete form or WCAG pass/);
});

test("missing, star-only, negated, silent and untranslated speech need review", () => {
  for (const announcements of [[], ["Email edit"], ["Email star edit"], ["Email optional"], ["Email not required"]]) {
    assert.equal(assessRequiredAnnouncement(action({ announcements })).status, "needs-review");
  }
  const translated = assessRequiredAnnouncement(action({ announcements: ["ईमेल आवश्यक"] }, { language: "hi" }));
  assert.equal(translated.status, "needs-review");
  assert.match(translated.reason, /English-only/);
  assert.equal(assessRequiredAnnouncement(action({}, { language: "hi" })).status, "needs-review", "An English word alone must not certify non-English pronunciation.");
});

test("unexplained asterisk and conflicting semantics never automatically pass", () => {
  assert.equal(assessRequiredAnnouncement(action({}, { expectation: "possible", sources: ["Associated asterisk"] })).status, "needs-review");
  assert.equal(assessRequiredAnnouncement(action({}, { conflict: true })).status, "needs-review");
});

test("required wording cannot bypass incomplete execution or focus checks", () => {
  for (const change of [{ status: "blocked" }, { status: "partial" }, { stateChanged: true }, { audibleComplete: false }, { audibleComplete: undefined }]) {
    assert.equal(assessRequiredAnnouncement(action(change)).status, "needs-review");
  }
  const unfocused = action(); unfocused.focus.documentFocused = false;
  assert.equal(assessRequiredAnnouncement(unfocused).status, "needs-review");
});

test("whole-page speech and ordinary fields do not establish required-field coverage", () => {
  assert.equal(assessRequiredAnnouncement(action({ kind: "reading" })), null);
  assert.equal(assessRequiredAnnouncement(action({}, { expectation: "not-indicated" })), null);
  assert.equal(assessRequiredAnnouncement({ command: "Tab", focus: { tag: "a" } }), null);
});

test("annotation preserves genuine speech and marks missing announcements for review", () => {
  const missing = action({ announcements: ["Email edit"], outcome: "announced" });
  annotateRequiredAnnouncement(missing);
  assert.deepEqual(missing.announcements, ["Email edit"]);
  assert.equal(missing.outcome, "needs-review");
  const announced = action(); annotateRequiredAnnouncement(announced);
  const summary = requiredFieldSummary([announced, missing]);
  assert.equal(summary.status, "needs-review");
  assert.equal(summary.commands, 2);
  assert.match(summary.reason, /not every field/);
  assert.equal(requiredFieldSummary([]).status, "not-observed");
});
