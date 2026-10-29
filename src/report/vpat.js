import { CONFORMANCE_STATUSES, isDocumentedReview } from "../scanner/wcag.js";

// VPAT® 2.5-structured Accessibility Conformance Report in four editions.
// WCAG rows come from the audit's documented criterion decisions. Section 508
// and EN 301 549 rows need their own documented reviewer decision ("vpat-row"
// reviews); nothing here is decided automatically. Verify the output against
// the current ITI VPAT 2.5 template before issuing it to a customer.
export const VPAT_EDITIONS = {
  wcag: { label: "WCAG", title: "WCAG Edition", standards: ["wcag"] },
  508: { label: "Section 508", title: "Revised Section 508 Edition", standards: ["wcag", "508"] },
  eu: { label: "EN 301 549", title: "EU Edition", standards: ["wcag", "en"] },
  int: { label: "International", title: "International Edition", standards: ["wcag", "508", "en"] }
};

// Related WCAG criteria are listed for the reviewer's reference only.
const FUNCTIONAL = {
  vision: ["1.1.1", "1.3.1", "1.3.2", "2.1.1", "2.4.3", "2.4.4", "2.4.6", "3.3.2", "4.1.2", "4.1.3"],
  lowVision: ["1.4.3", "1.4.4", "1.4.10", "1.4.11", "1.4.12", "2.4.7", "2.4.11"],
  color: ["1.4.1", "1.4.3", "1.4.11"],
  hearing: ["1.2.1", "1.2.2", "1.2.4"],
  limitedHearing: ["1.2.2", "1.4.2"],
  speech: [],
  manipulation: ["2.1.1", "2.5.1", "2.5.2", "2.5.4", "2.5.7", "2.5.8"],
  reach: ["2.5.4", "2.5.8"],
  seizures: ["2.3.1"],
  cognition: ["2.2.1", "2.4.2", "2.4.6", "3.1.1", "3.2.3", "3.2.4", "3.3.1", "3.3.3", "3.3.7", "3.3.8"],
  privacy: []
};

const row = (id, criterion, related = [], note = "") => ({ id, criterion, related, note });
export const SECTION_508 = [
  { chapter: "Chapter 3: Functional Performance Criteria (FPC)", rows: [
    row("508-302.1", "302.1 Without Vision", FUNCTIONAL.vision), row("508-302.2", "302.2 With Limited Vision", FUNCTIONAL.lowVision),
    row("508-302.3", "302.3 Without Perception of Color", FUNCTIONAL.color), row("508-302.4", "302.4 Without Hearing", FUNCTIONAL.hearing),
    row("508-302.5", "302.5 With Limited Hearing", FUNCTIONAL.limitedHearing), row("508-302.6", "302.6 Without Speech", FUNCTIONAL.speech, "Confirm that no function requires speech input."),
    row("508-302.7", "302.7 With Limited Manipulation", FUNCTIONAL.manipulation), row("508-302.8", "302.8 With Limited Reach and Strength", FUNCTIONAL.reach),
    row("508-302.9", "302.9 With Limited Language, Cognitive, and Learning Abilities", FUNCTIONAL.cognition)
  ] },
  { chapter: "Chapter 4: Hardware", rows: [row("508-ch4", "Chapter 4 Hardware (402–415)", [], "Web software is not hardware; a reviewer normally records Not Applicable with that explanation.")] },
  { chapter: "Chapter 5: Software", rows: [
    row("508-501.1", "501.1 Scope – Incorporation of WCAG 2.0 AA", [], "For web content, see the WCAG 2.x tables."),
    row("508-502.2.1", "502.2.1 User Control of Accessibility Features"), row("508-502.2.2", "502.2.2 No Disruption of Accessibility Features"),
    row("508-502.3.1", "502.3.1 Object Information"), row("508-502.3.2", "502.3.2 Modification of Object Information"), row("508-502.3.3", "502.3.3 Row, Column, and Headers"),
    row("508-502.3.4", "502.3.4 Values"), row("508-502.3.5", "502.3.5 Modification of Values"), row("508-502.3.6", "502.3.6 Label Relationships"),
    row("508-502.3.7", "502.3.7 Hierarchical Relationships"), row("508-502.3.8", "502.3.8 Text"), row("508-502.3.9", "502.3.9 Modification of Text"),
    row("508-502.3.10", "502.3.10 List of Actions"), row("508-502.3.11", "502.3.11 Actions on Objects"), row("508-502.3.12", "502.3.12 Focus Cursor"),
    row("508-502.3.13", "502.3.13 Modification of Focus Cursor"), row("508-502.3.14", "502.3.14 Event Notification"), row("508-502.4", "502.4 Platform Accessibility Features"),
    row("508-503.2", "503.2 User Preferences"), row("508-503.3", "503.3 Alternative User Interfaces"), row("508-503.4.1", "503.4.1 Caption Controls"),
    row("508-503.4.2", "503.4.2 Audio Description Controls"), row("508-504.2", "504.2 Content Creation or Editing"),
    row("508-504.2.1", "504.2.1 Preservation of Information Provided for Accessibility in Format Conversion"), row("508-504.2.2", "504.2.2 PDF Export"),
    row("508-504.3", "504.3 Prompts"), row("508-504.4", "504.4 Templates")
  ] },
  { chapter: "Chapter 6: Support Documentation and Services", rows: [
    row("508-602.2", "602.2 Accessibility and Compatibility Features"), row("508-602.3", "602.3 Electronic Support Documentation", [], "See the WCAG 2.x tables for electronic documentation."),
    row("508-602.4", "602.4 Alternate Formats for Non-Electronic Support Documentation"), row("508-603.2", "603.2 Information on Accessibility and Compatibility Features"),
    row("508-603.3", "603.3 Accommodation of Communication Needs")
  ] }
];

export const EN_301_549 = [
  { chapter: "Chapter 4: Functional Performance Statements (FPS)", rows: [
    row("en-4.2.1", "4.2.1 Usage without vision", FUNCTIONAL.vision), row("en-4.2.2", "4.2.2 Usage with limited vision", FUNCTIONAL.lowVision),
    row("en-4.2.3", "4.2.3 Usage without perception of colour", FUNCTIONAL.color), row("en-4.2.4", "4.2.4 Usage without hearing", FUNCTIONAL.hearing),
    row("en-4.2.5", "4.2.5 Usage with limited hearing", FUNCTIONAL.limitedHearing), row("en-4.2.6", "4.2.6 Usage with no or limited vocal capability", FUNCTIONAL.speech),
    row("en-4.2.7", "4.2.7 Usage with limited manipulation or strength", FUNCTIONAL.manipulation), row("en-4.2.8", "4.2.8 Usage with limited reach", FUNCTIONAL.reach),
    row("en-4.2.9", "4.2.9 Minimize photosensitive seizure triggers", FUNCTIONAL.seizures), row("en-4.2.10", "4.2.10 Usage with limited cognition, language or learning", FUNCTIONAL.cognition),
    row("en-4.2.11", "4.2.11 Privacy", FUNCTIONAL.privacy)
  ] },
  { chapter: "Chapter 5: Generic Requirements", rows: [
    row("en-5.1", "5.1 Closed functionality"), row("en-5.2", "5.2 Activation of accessibility features"), row("en-5.3", "5.3 Biometrics"),
    row("en-5.4", "5.4 Preservation of accessibility information during conversion"), row("en-5.5.1", "5.5.1 Means of operation"), row("en-5.5.2", "5.5.2 Operable parts discernibility"),
    row("en-5.6.1", "5.6.1 Tactile or auditory status"), row("en-5.6.2", "5.6.2 Visual status"), row("en-5.7", "5.7 Key repeat"), row("en-5.8", "5.8 Double-strike key acceptance"),
    row("en-5.9", "5.9 Simultaneous user actions")
  ] },
  { chapter: "Chapter 6: ICT with Two-Way Voice Communication", rows: [row("en-ch6", "Chapter 6 (6.1–6.6)", [], "Applies only if the product provides two-way voice communication.")] },
  { chapter: "Chapter 7: ICT with Video Capabilities", rows: [
    row("en-7.1.1", "7.1.1 Captioning playback", ["1.2.2"]), row("en-7.1.2", "7.1.2 Captioning synchronization", ["1.2.2"]), row("en-7.1.3", "7.1.3 Preservation of captioning"),
    row("en-7.1.4", "7.1.4 Captions characteristics"), row("en-7.1.5", "7.1.5 Spoken subtitles"), row("en-7.2.1", "7.2.1 Audio description playback", ["1.2.5"]),
    row("en-7.2.2", "7.2.2 Audio description synchronization", ["1.2.5"]), row("en-7.2.3", "7.2.3 Preservation of audio description"),
    row("en-7.3", "7.3 User controls for captions and audio description")
  ] },
  { chapter: "Chapter 8: Hardware", rows: [row("en-ch8", "Chapter 8 (8.1–8.5)", [], "Web software is not hardware; a reviewer normally records Not Applicable with that explanation.")] },
  { chapter: "Chapter 9: Web", wcag: true, rows: [row("en-9.6", "9.6 WCAG conformance requirements", [], "Requires conformance to all WCAG 2.1 Level A and AA success criteria for the full pages and complete processes in scope.")] },
  { chapter: "Chapter 10: Non-web Documents", rows: [row("en-ch10", "Chapter 10 Non-web documents (10.1–10.6)", [], "Linked documents such as PDFs; see the automated document checks summarized below.")] },
  { chapter: "Chapter 11: Software", rows: [row("en-ch11", "Chapter 11 Software (11.1–11.8)", [], "For web content, Chapter 9 applies. Platform software, authoring tools and closed functionality are assessed here if in scope.")] },
  { chapter: "Chapter 12: Documentation and Support Services", rows: [
    row("en-12.1.1", "12.1.1 Accessibility and compatibility features"), row("en-12.1.2", "12.1.2 Accessible documentation"),
    row("en-12.2.2", "12.2.2 Information on accessibility and compatibility features"), row("en-12.2.3", "12.2.3 Effective communication"),
    row("en-12.2.4", "12.2.4 Accessible documentation")
  ] },
  { chapter: "Chapter 13: ICT Providing Relay or Emergency Service Access", rows: [row("en-ch13", "Chapter 13 (13.1–13.3)", [], "Applies only to relay or emergency service access.")] }
];

// EN 301 549 V3.2.1 references WCAG 2.1; criteria added in WCAG 2.2 are not in Chapter 9.
const WCAG_22_ONLY = new Set(["2.4.11", "2.5.7", "2.5.8", "3.2.6", "3.3.7", "3.3.8"]);
export const VPAT_ROW_IDS = new Set([...SECTION_508, ...EN_301_549].flatMap((chapter) => chapter.rows.map((entry) => entry.id)));

export function findVpatRow(id) {
  for (const chapter of [...SECTION_508, ...EN_301_549]) {
    const found = chapter.rows.find((entry) => entry.id === id);
    if (found) return { ...found, chapter: chapter.chapter };
  }
  return null;
}

export function buildVpat(report, profile = {}, edition = "wcag") {
  const config = VPAT_EDITIONS[edition];
  if (!config) throw Object.assign(new Error("Edition must be wcag, 508, eu or int."), { status: 400 });
  const audit = report.audit;
  if (!audit) throw new Error("The report's audit must be built before a VPAT can be produced.");
  const reviews = Array.isArray(report.auditReviews) ? report.auditReviews : [];
  const criteria = new Map(audit.criteria.map((criterion) => [criterion.id, criterion]));
  const decision = (id) => {
    const latest = [...reviews].reverse().find((review) => review?.kind === "vpat-row" && review.targetId === id);
    return isDocumentedReview(latest) ? latest : null;
  };
  const relatedRemark = (related) => related.length
    ? ` Related WCAG criteria for reference: ${related.filter((id) => criteria.has(id)).map((id) => `${id} (${criteria.get(id).status})`).join(", ")}.`
    : "";
  const reviewedRow = (entry) => {
    const review = decision(entry.id);
    return {
      criterion: entry.criterion,
      status: review?.status || "Not Evaluated",
      remarks: review ? `${review.notes} Reviewer: ${review.reviewer}. Scope: ${review.scope}.` : `${entry.note ? `${entry.note} ` : ""}A documented reviewer decision is required.${relatedRemark(entry.related)}`,
      reviewed: Boolean(review)
    };
  };
  const wcagRows = (level) => audit.criteria.filter((criterion) => criterion.level === level).map((criterion) => ({
    criterion: `${criterion.id} ${criterion.name} (Level ${criterion.level}${criterion.since !== "2.0" ? ` ${criterion.since}` : ""})`,
    status: criterion.status,
    remarks: criterion.remarks,
    reviewed: criterion.status !== "Not Evaluated"
  }));

  const sections = [{ heading: `WCAG ${audit.wcagVersion} Report`, intro: "Tables 1 and 2 cover WCAG Level A and Level AA success criteria. Level AAA was not evaluated.", tables: [
    { caption: "Table 1: Success Criteria, Level A", rows: wcagRows("A") },
    { caption: "Table 2: Success Criteria, Level AA", rows: wcagRows("AA") }
  ] }];
  if (config.standards.includes("508")) {
    sections.push({ heading: "Revised Section 508 Report", intro: "Chapter 5 and Chapter 6 rows that incorporate WCAG for web content refer to the WCAG 2.x tables above.", tables: SECTION_508.map((chapter) => ({ caption: chapter.chapter, rows: chapter.rows.map(reviewedRow) })) });
  }
  if (config.standards.includes("en")) {
    sections.push({ heading: "EN 301 549 Report", intro: "Chapter 9 maps one-to-one to WCAG 2.1 Level A and AA; its statuses come from the WCAG decisions above.", tables: EN_301_549.map((chapter) => ({
      caption: chapter.chapter,
      rows: [
        ...(chapter.wcag ? audit.criteria.filter((criterion) => !WCAG_22_ONLY.has(criterion.id)).map((criterion) => ({
          criterion: `9.${criterion.id} ${criterion.name}`, status: criterion.status, remarks: `See WCAG ${criterion.id}. ${criterion.remarks}`, reviewed: criterion.status !== "Not Evaluated"
        })) : []),
        ...chapter.rows.map((entry) => {
          const result = reviewedRow(entry);
          if (entry.id === "en-ch10" && report.documents) result.remarks += ` Automated document checks: ${report.documents.checked.length} PDF(s) checked, ${report.documents.skipped.length} document(s) not checked automatically.`;
          return result;
        })
      ]
    })) });
  }
  const rows = sections.flatMap((section) => section.tables.flatMap((table) => table.rows));
  const unreviewed = rows.filter((entry) => !entry.reviewed).length;
  const standards = [
    ["Web Content Accessibility Guidelines 2.0", "Level A (Yes) · Level AA (Yes) · Level AAA (No)"],
    ["Web Content Accessibility Guidelines 2.1", audit.wcagVersion === "2.1" || audit.wcagVersion === "2.2" ? "Level A (Yes) · Level AA (Yes) · Level AAA (No)" : "No"],
    ["Web Content Accessibility Guidelines 2.2", audit.wcagVersion === "2.2" ? "Level A (Yes) · Level AA (Yes) · Level AAA (No)" : "No"],
    ["Revised Section 508 standards published January 18, 2017 and corrected January 22, 2018", config.standards.includes("508") ? "Yes" : "No"],
    ["EN 301 549 Accessibility requirements for ICT products and services – V3.2.1 (2021-03)", config.standards.includes("en") ? "Yes" : "No"]
  ];
  return {
    edition, editionTitle: config.title,
    title: `${profile.productName || "Product"} Accessibility Conformance Report`,
    subtitle: `${config.title} (Based on VPAT® Version 2.5)`,
    product: profile.productName || "Not recorded", version: profile.productVersion || audit.scope.applicationVersion || "Not recorded",
    reportDate: profile.reportDate || new Date().toISOString().slice(0, 10),
    description: profile.description || "Not recorded", contact: profile.contact || "Not recorded",
    notes: [profile.notes, `Evaluated URL: ${audit.scope.targetUrl}. Scan ${audit.scope.reportId} (${audit.scope.pages.length} page records, ${audit.scope.statesRecorded} state records).`].filter(Boolean).join(" "),
    evaluationMethods: profile.evaluationMethods || `Automated testing (${audit.methods.automatedEngines.join(", ") || "axe-core"}), keyboard traversal, zoom/reflow/text-spacing checks, accessibility-tree inspection${audit.methods.nvdaStatus === "executed" ? ", NVDA screen-reader sampling" : ""}, and documented manual review decisions recorded in this report.`,
    standards,
    terms: [
      ["Supports", "The functionality of the product has at least one method that meets the criterion without known defects or meets with equivalent facilitation."],
      ["Partially Supports", "Some functionality of the product does not meet the criterion."],
      ["Does Not Support", "The majority of product functionality does not meet the criterion."],
      ["Not Applicable", "The criterion is not relevant to the product."],
      ["Not Evaluated", "The product has not been evaluated against the criterion. This can only be used in WCAG Level AAA criteria."]
    ],
    sections,
    readiness: { rows: rows.length, unreviewed, final: unreviewed === 0 },
    draftNotice: unreviewed ? `DRAFT – ${unreviewed} of ${rows.length} rows have no documented reviewer decision and show “Not Evaluated”, which VPAT 2.5 permits only for Level AAA. Record decisions before issuing this report.` : null,
    legal: "VPAT® is a registered service mark of the Information Technology Industry Council (ITI). This report follows the VPAT 2.5 structure; verify it against the current ITI template before publication. Automated results do not establish conformance; every status above reflects a recorded reviewer decision or is marked Not Evaluated."
  };
}

export function renderVpatHtml(model) {
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const table = (caption, headers, rows) => `<table><caption>${esc(caption)}</caption><thead><tr>${headers.map((header) => `<th scope="col">${esc(header)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(model.title)} – ${esc(model.editionTitle)}</title>
<style>body{font-family:Arial,Helvetica,sans-serif;color:#1d1d1d;line-height:1.45;margin:0}main{max-width:1100px;margin:auto;padding:32px}h1{font-size:1.8rem;margin-bottom:.2rem}h2{margin-top:2rem;border-bottom:2px solid #1d1d1d;padding-bottom:.2rem}h3{margin-top:1.4rem}.draft{border:2px solid #9a1b1b;background:#fff0f0;color:#7a1010;padding:12px;font-weight:700}dl{display:grid;grid-template-columns:220px 1fr;gap:6px 16px}dt{font-weight:700}dd{margin:0}table{border-collapse:collapse;width:100%;margin:12px 0 24px;font-size:.92rem}caption{text-align:left;font-weight:700;padding:6px 0}th,td{border:1px solid #777;padding:8px;vertical-align:top;text-align:left}thead th{background:#e8e8e8}td:first-child{width:28%}td:nth-child(2){width:16%;font-weight:700}.legal{font-size:.85rem;color:#444;margin-top:2rem}@media print{main{padding:0}thead{display:table-header-group}tr{break-inside:avoid}}</style></head>
<body><main>
<h1>${esc(model.title)}</h1><p><strong>${esc(model.subtitle)}</strong></p>
${model.draftNotice ? `<p class="draft" role="note">${esc(model.draftNotice)}</p>` : ""}
<dl><dt>Name of Product/Version</dt><dd>${esc(model.product)} ${esc(model.version)}</dd><dt>Report Date</dt><dd>${esc(model.reportDate)}</dd><dt>Product Description</dt><dd>${esc(model.description)}</dd><dt>Contact Information</dt><dd>${esc(model.contact)}</dd><dt>Notes</dt><dd>${esc(model.notes)}</dd><dt>Evaluation Methods Used</dt><dd>${esc(model.evaluationMethods)}</dd></dl>
<h2>Applicable Standards/Guidelines</h2>
${table("This report covers the degree of conformance for the following accessibility standards/guidelines", ["Standard/Guideline", "Included In Report"], model.standards.map(([standard, included]) => `<tr><td>${esc(standard)}</td><td>${esc(included)}</td></tr>`))}
<h2>Terms</h2><dl>${model.terms.map(([term, definition]) => `<dt>${esc(term)}</dt><dd>${esc(definition)}</dd>`).join("")}</dl>
${model.sections.map((section) => `<h2>${esc(section.heading)}</h2><p>${esc(section.intro)}</p>${section.tables.map((entry) => table(entry.caption, ["Criteria", "Conformance Level", "Remarks and Explanations"], entry.rows.map((item) => `<tr><td>${esc(item.criterion)}</td><td>${esc(item.status)}</td><td>${esc(item.remarks)}</td></tr>`))).join("")}`).join("")}
<h2>Legal Disclaimer</h2><p class="legal">${esc(model.legal)}</p>
</main></body></html>`;
}

export async function renderVpatDocx(model) {
  const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, TextRun, WidthType } = await import("docx");
  const cell = (text, header = false) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: String(text ?? ""), bold: header })] })] });
  const table = (headers, rows) => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ tableHeader: true, children: headers.map((header) => cell(header, true)) }), ...rows.map((values) => new TableRow({ cantSplit: true, children: values.map((value) => cell(value)) }))]
  });
  const children = [
    new Paragraph({ text: model.title, heading: HeadingLevel.TITLE }),
    new Paragraph({ children: [new TextRun({ text: model.subtitle, bold: true })] }),
    ...(model.draftNotice ? [new Paragraph({ children: [new TextRun({ text: model.draftNotice, bold: true, color: "9A1B1B" })] })] : []),
    ...[["Name of Product/Version", `${model.product} ${model.version}`], ["Report Date", model.reportDate], ["Product Description", model.description], ["Contact Information", model.contact], ["Notes", model.notes], ["Evaluation Methods Used", model.evaluationMethods]]
      .map(([label, value]) => new Paragraph({ children: [new TextRun({ text: `${label}: `, bold: true }), new TextRun(String(value))] })),
    new Paragraph({ text: "Applicable Standards/Guidelines", heading: HeadingLevel.HEADING_1 }),
    table(["Standard/Guideline", "Included In Report"], model.standards),
    new Paragraph({ text: "Terms", heading: HeadingLevel.HEADING_1 }),
    ...model.terms.map(([term, definition]) => new Paragraph({ children: [new TextRun({ text: `${term}: `, bold: true }), new TextRun(definition)] }))
  ];
  for (const section of model.sections) {
    children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }), new Paragraph(section.intro));
    for (const entry of section.tables) {
      children.push(new Paragraph({ text: entry.caption, heading: HeadingLevel.HEADING_2 }), table(["Criteria", "Conformance Level", "Remarks and Explanations"], entry.rows.map((item) => [item.criterion, item.status, item.remarks])));
    }
  }
  children.push(new Paragraph({ text: "Legal Disclaimer", heading: HeadingLevel.HEADING_1 }), new Paragraph(model.legal));
  const document = new Document({ title: `${model.title} – ${model.editionTitle}`, description: model.subtitle, creator: "QualiBrix Accessibility Agent", sections: [{ children }] });
  return Packer.toBuffer(document);
}

export const VPAT_STATUSES = CONFORMANCE_STATUSES;
