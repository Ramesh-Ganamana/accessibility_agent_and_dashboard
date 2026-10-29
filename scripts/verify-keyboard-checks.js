import assert from "node:assert/strict";
import { chromium } from "playwright";
import { scanKeyboardFocus } from "../src/scanner/focus.js";

// Local synthetic pages only. Each page isolates one keyboard problem.
const browser = await chromium.launch({ headless: true });
const rules = async (page, html, maxTabs = 40) => {
  await page.setContent(`<!doctype html><html lang="en"><body>${html}</body></html>`);
  return (await scanKeyboardFocus(page, "https://fixture.test/", maxTabs)).map((finding) => finding.ruleId);
};
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

  assert.deepEqual(await rules(page, "<main><h1>Clean</h1><a href='#a'>First</a> <button>Second</button><input aria-label='Search'></main>"), [], "a simple accessible page has no keyboard findings");

  assert.ok((await rules(page, "<main><div role='button' onclick='void 0'>Save draft</div><button>Real button</button></main>")).includes("keyboard-custom-control"), "a role=button div without tabindex is reported");
  assert.ok((await rules(page, "<main><button tabindex='-1'>Hidden from Tab</button><button>Reachable</button></main>")).includes("keyboard-removed-from-tab-order"));
  assert.ok((await rules(page, "<main><a href='#b'>Second link</a><button tabindex='3'>Jumps ahead</button></main>")).includes("focus-order-positive-tabindex"));

  const tabs = await rules(page, "<main><div role='tablist'><button role='tab' aria-selected='true'>One</button><button role='tab' tabindex='-1'>Two</button></div><button>After</button></main>");
  assert.equal(tabs.includes("keyboard-removed-from-tab-order") || tabs.includes("keyboard-unreachable"), false, "roving tabindex inside a tablist is correct and not reported");

  const trap = await rules(page, "<main><button>Before</button><input id='trap' aria-label='Code editor'><button>After</button></main><script>document.querySelector('#trap').addEventListener('keydown', (event) => { if (event.key === 'Tab') event.preventDefault(); });</script>");
  assert.ok(trap.includes("keyboard-trap"), `a field that swallows Tab is reported as a trap (${trap.join(", ")})`);
  assert.equal(trap.includes("keyboard-unreachable"), false, "unreachable controls are not inferred from an incomplete traversal");

  const modal = await rules(page, "<div role='dialog' aria-modal='true'><button id='m1'>OK</button><button id='m2'>Cancel</button></div><main><button>Behind</button></main><script>document.addEventListener('keydown', (event) => { if (event.key !== 'Tab') return; const items = [...document.querySelectorAll('[role=dialog] button')]; const index = items.indexOf(document.activeElement); if (index === -1) return; event.preventDefault(); items[(index + (event.shiftKey ? items.length - 1 : 1)) % items.length].focus(); });</script>");
  assert.equal(modal.includes("keyboard-trap"), false, "focus contained inside an open modal dialog is correct");

  const obscured = await rules(page, "<header style='position:fixed;top:0;left:0;right:0;height:120px;background:#123;z-index:5'><a href='#h' style='color:#fff'>Home</a></header><main style='padding-top:0'><a href='#under' style='position:absolute;top:40px;left:300px'>Under the header</a></main>");
  assert.ok(obscured.includes("focus-obscured"), `a link entirely behind a fixed header is reported (${obscured.join(", ")})`);

  const jump = await rules(page, "<main style='position:relative;height:2400px'><a href='#low' style='position:absolute;top:1800px'>Low link first in DOM</a><a href='#high' style='position:absolute;top:20px'>High link second</a></main>");
  assert.ok(jump.includes("focus-order-jump"), `a large backward focus jump is reported (${jump.join(", ")})`);

  console.log("Keyboard checks passed: custom controls, removed controls, positive tabindex, composite widgets, traps, modal containment, obscured focus and order jumps.");
} finally {
  await browser.close();
}
