// Illustrative data only. It never represents a completed accessibility audit.
export const sampleReport = {
  id: "demo",
  targetUrl: "https://storefront.example",
  startedAt: new Date(Date.now() - 18_000).toISOString(),
  completedAt: new Date().toISOString(),
  summary: { pagesScanned: 5, statesObserved: 5, confirmedIssues: 8, needsReview: 1, evidenceScreenshots: 8, durationMs: 18_240, aiChecksUsed: 1, byImpact: { critical: 1, serious: 3, moderate: 3, minor: 1 } },
  pages: [
    { url: "https://storefront.example", title: "Home", depth: 0, issueIds: ["demo-1", "demo-2", "demo-3"], technology: { openShadowRoots: 2, dialogs: 1, iframes: 0 } },
    { url: "https://storefront.example/products", title: "Products", depth: 1, issueIds: ["demo-4", "demo-5"], technology: { openShadowRoots: 1, dialogs: 0, iframes: 0 } },
    { url: "https://storefront.example/account", title: "Account", depth: 1, issueIds: ["demo-6"], technology: { openShadowRoots: 3, dialogs: 1, iframes: 1 } },
    { url: "https://storefront.example/cart", title: "Cart", depth: 2, issueIds: ["demo-7", "demo-8"], technology: { openShadowRoots: 0, dialogs: 1, iframes: 0 } },
    { url: "https://storefront.example/help", title: "Help center", depth: 2, issueIds: [], technology: { openShadowRoots: 0, dialogs: 0, iframes: 1 } }
  ],
  graph: {
    nodes: [
      { id: "https://storefront.example", label: "Home", url: "https://storefront.example", depth: 0, issueCount: 3, status: "issues" },
      { id: "https://storefront.example/products", label: "Products", url: "https://storefront.example/products", depth: 1, issueCount: 2, status: "issues" },
      { id: "https://storefront.example/account", label: "Account", url: "https://storefront.example/account", depth: 1, issueCount: 1, status: "issues" },
      { id: "https://storefront.example/cart", label: "Cart", url: "https://storefront.example/cart", depth: 2, issueCount: 2, status: "issues" },
      { id: "https://storefront.example/help", label: "Help center", url: "https://storefront.example/help", depth: 2, issueCount: 0, status: "pass" }
    ],
    edges: [
      { source: "https://storefront.example", target: "https://storefront.example/products", type: "link" },
      { source: "https://storefront.example", target: "https://storefront.example/account", type: "popup" },
      { source: "https://storefront.example/products", target: "https://storefront.example/cart", type: "link" },
      { source: "https://storefront.example/account", target: "https://storefront.example/help", type: "link" }
    ]
  },
  issues: [
    issue("demo-1", "image-alt", "critical", "Images must have alternate text", "#featured-product img", "1.1.1", "The product image has no text alternative, so screen reader users cannot identify the featured item."),
    issue("demo-2", "color-contrast", "serious", "Text must meet minimum color contrast", ".hero .subtitle", "1.4.3", "Foreground and background colors do not meet the 4.5:1 contrast requirement."),
    issue("demo-3", "button-name", "serious", "Buttons must have discernible text", ["product-card", "button.icon-only"], "4.1.2", "The icon button has no accessible name."),
    issue("demo-4", "aria-valid-attr-value", "moderate", "ARIA attributes must use valid values", "[aria-expanded=maybe]", "4.1.2", "The supplied ARIA state is not a permitted token."),
    { ...issue("demo-5", "focus-visible", "serious", "Keyboard focus indicator may not be visible", "a.product-link", "2.4.7", "No visible focus outline or box-shadow was observed during keyboard traversal."), source: "keyboard-traversal", state: "keyboard-tab-7" },
    issue("demo-6", "label", "moderate", "Form elements must have labels", "#account-dialog input[name=phone]", "1.3.1", "A phone number input in the account dialog has no programmatic label."),
    { ...issue("demo-7", "ai-alt-quality", "moderate", "Image alternative may not match visual meaning", "img.cart-thumbnail", "1.1.1", "The alternative says “image” but does not identify the product."), source: "gpt-4o-mini" },
    issue("demo-8", "landmark-unique", "minor", "Landmarks should have unique roles or labels", "aside:nth-of-type(2)", "1.3.1", "Two complementary landmarks expose the same unlabeled role.")
  ],
  incomplete: [{ ...issue("demo-review-1", "color-contrast", "moderate", "Color contrast requires manual confirmation", ".promo-copy", "1.4.3", "The background could not be determined because another element overlaps the text."), findingType: "needs-review", reviewStatus: "needs-review", reviewHistory: [{ at: new Date().toISOString(), status: "needs-review", source: "axe-core", message: "Automated contrast calculation was inconclusive." }] }],
  events: [
    { at: new Date(Date.now() - 17_000).toISOString(), type: "session", message: "Loaded persisted authenticated session." },
    { at: new Date(Date.now() - 14_000).toISOString(), type: "progress", message: "Injected axe-core into 5 application routes." },
    { at: new Date(Date.now() - 10_000).toISOString(), type: "dialog", message: "Scanned 3 modal and popup states." },
    { at: new Date(Date.now() - 6_000).toISOString(), type: "ai", message: "Escalated one uncertain image description." },
    { at: new Date().toISOString(), type: "complete", message: "Generated visual evidence and ACR draft." }
  ],
  acr: [
    { criterion: "WCAG 1.1.1 Non-text Content", level: "A", status: "Does Not Support", issueCount: 2, remarks: "Product imagery includes a missing alternative and one contextually weak description. Affected nodes: #featured-product img; img.cart-thumbnail" },
    { criterion: "WCAG 1.3.1 Info and Relationships", level: "A", status: "Partially Supports", issueCount: 2, remarks: "One dialog field has no programmatic label and duplicate complementary landmarks require review." },
    { criterion: "WCAG 1.4.3 Contrast (Minimum)", level: "AA", status: "Does Not Support", issueCount: 1, remarks: "Hero subtitle contrast is below the required ratio. Affected node: .hero .subtitle" },
    { criterion: "WCAG 2.4.7 Focus Visible", level: "AA", status: "Does Not Support", issueCount: 1, remarks: "Keyboard traversal found a product link without a visible focus treatment." },
    { criterion: "WCAG 4.1.2 Name, Role, Value", level: "A", status: "Does Not Support", issueCount: 2, remarks: "An icon button lacks a name and an expanded state uses an invalid ARIA value." }
  ]
};

function issue(id, ruleId, impact, help, target, wcag, summary) {
  return {
    id, ruleId, impact, help, target: Array.isArray(target) ? target : [target], wcag: [wcag],
    pageUrl: id === "demo-4" || id === "demo-5" ? "https://storefront.example/products" : id === "demo-6" ? "https://storefront.example/account" : id === "demo-7" || id === "demo-8" ? "https://storefront.example/cart" : "https://storefront.example",
    frameUrl: "https://storefront.example", state: "default", source: "axe-core", evidence: "/demo-evidence.svg", failureSummary: summary, description: summary
  };
}
