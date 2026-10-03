import assert from "node:assert/strict";
import http from "node:http";
import { createBrowserSession, ensureAuthenticated } from "../src/browser/session.js";
import { resolveContextChooserIfPresent, resolvePostLoginObstructions, waitForPostLoginObstruction } from "../src/browser/post-login.js";
import { getConfig } from "../src/config.js";

const port = 4183;
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.url === "/login") {
    response.end(page(`
      <input id="username" type="text" aria-label="Username">
      <input id="password" type="password" aria-label="Password">
      <button id="signIn" type="button" onclick="location.href='/home'">Sign in</button>
    `));
    return;
  }
  response.end(page(`
    <header><a href="#">Login</a></header><main id="application"></main>
    <script>
      setTimeout(() => {
        document.querySelector('#application').innerHTML = '<h1>Dashboard</h1><div id="domain-dialog" role="dialog" aria-modal="true"><h2>Select a Domain</h2><input id="domain-search" placeholder="Search Domains"><div id="domain-jcb">JCB</div><div>Other tenant</div></div><div id="notice" role="dialog" aria-modal="true" hidden><p>Welcome notice</p><button aria-label="Close">×</button></div>';
        document.querySelector('#domain-jcb').addEventListener('click',()=>{document.body.dataset.domain='JCB';document.querySelector('#domain-dialog').hidden=true;document.querySelector('#notice').hidden=false});
        document.querySelector('#notice button').addEventListener('click',()=>{document.querySelector('#notice').hidden=true});
      }, 1200);
    </script>
  `));
});

await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
const config = getConfig({
  targetUrl: `http://127.0.0.1:${port}/home`,
  browserChannel: "bundled",
  login: {
    url: `http://127.0.0.1:${port}/login`, username: "fixture-user", password: "fixture-password", persist: false, aiEnabled: false,
    postLoginValue: "JCB", emailSelector: "#username", passwordSelector: "#password", submitSelector: "#signIn"
  }
});
const session = await createBrowserSession(config);
try {
  const authenticationStartedAt = Date.now();
  await ensureAuthenticated(session, config);
  assert.ok(Date.now() - authenticationStartedAt >= 1_000, "authentication should wait for the delayed application surface");
  assert.ok(Date.now() - authenticationStartedAt < 15_000, "authentication should continue early when the application finishes before the five-minute ceiling");
  assert.equal(await session.page.locator("body").getAttribute("data-domain"), "JCB");
  assert.equal(await session.page.locator("#domain-dialog").isVisible(), false);
  assert.equal(await session.page.locator("#notice").isVisible(), false);

  await session.page.setContent(page('<h1>Normal dashboard</h1><label>Client filter <input id="ordinary-client" placeholder="Search client"></label><button id="ordinary-jcb">JCB</button>'));
  assert.equal(await waitForPostLoginObstruction(session.page, 100), false);
  assert.equal(await session.page.locator("#ordinary-client").inputValue(), "");

  await session.page.setContent(page('<div id="profile-dialog" role="dialog" aria-modal="true"><h2>Profile details</h2><button aria-label="Close">×</button></div>'));
  const unrelatedDialog = await resolveContextChooserIfPresent(session.page, config);
  assert.equal(unrelatedDialog.handled, false);
  assert.equal(await session.page.locator("#profile-dialog").isVisible(), true);

  await session.page.setContent(page('<div role="dialog" aria-modal="true"><h2>Select a workspace</h2><input placeholder="Search workspace"><div>JCB</div></div>'));
  await assert.rejects(
    () => resolvePostLoginObstructions(session.page, { login: { postLoginValue: "" } }),
    (error) => error.code === "POST_LOGIN_INPUT_REQUIRED" && /Domain \/ tenant \/ workspace/.test(error.message)
  );
  console.log("Post-login domain selection, safe close, and missing-value prompt passed.");
} finally {
  await session.close();
  await new Promise((resolve) => server.close(resolve));
}

function page(body) { return `<!doctype html><html><body>${body}</body></html>`; }
