import assert from "node:assert/strict";
import { chromium } from "playwright";
import { attemptAiGroundedAction, buildNumberedDomMap, removeGroundingOverlays } from "../src/scanner/ai-grounding.js";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  await page.setContent(`<!doctype html><html><body>
    <main>
      <h1>Grounding fixture</h1>
      <div><span>Informational text</span></div>
      <label for="email">Email address</label>
      <input id="email" type="email" value="private@example.com">
      <button id="open" type="button" onclick="document.querySelector('#panel').hidden=false">Open reports</button>
      <button id="excluded" type="button">Excluded provider</button>
      <div id="listener-only">Open listener-only tools</div>
      <button id="delete" type="button">Delete account</button>
      <section id="panel" hidden><h2>Reports panel</h2></section>
      <ground-test></ground-test>
    </main>
    <script>
      const root = document.querySelector('ground-test').attachShadow({mode:'open'});
      root.innerHTML = '<button type="button">Open shadow tools</button>';
      document.querySelector('#listener-only').addEventListener('click', () => document.body.dataset.listenerClicked='true');
    </script>
  </body></html>`);

  const map = await buildNumberedDomMap(page);
  assert.ok(map.elements.length >= 5);
  assert.equal(JSON.stringify(map).includes("private@example.com"), false);
  assert.equal(new Set(map.elements.map((entry) => entry.number)).size, map.elements.length);
  assert.ok(map.elements.some((entry) => entry.label === "Open shadow tools"));
  assert.equal(map.elements.find((entry) => entry.label === "Open listener-only tools")?.detectedInteractive, false);
  assert.equal(map.elements.find((entry) => entry.label === "Open listener-only tools")?.actionable, true);
  const desired = map.elements.find((entry) => entry.label === "Open reports");
  assert.ok(desired?.actionable);
  await removeGroundingOverlays(page);

  const result = await attemptAiGroundedAction(page, {
    config: { aiEnabled: true, excludeActionLabels: ["Excluded provider"] },
    chooseNumber: async ({ allowed }) => {
      const open = allowed.find((entry) => entry.label === "Open reports");
      assert.ok(open);
      assert.equal(allowed.some((entry) => entry.label === "Delete account"), false);
      assert.equal(allowed.some((entry) => entry.label === "Excluded provider"), false);
      return { action: "click", number: open.number, confidence: 0.99, reason: "safe fixture navigation" };
    }
  });
  assert.equal(result.clicked, true);
  assert.equal(await page.locator("#panel").isVisible(), true);
  assert.equal(await page.locator("[data-a11y-grounding-overlay]").count(), 0);
  console.log("Numbered DOM map, safety validation, Shadow DOM discovery, and JavaScript click passed.");
} finally {
  await browser.close();
}
