import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { getConfig } from "../src/config.js";
import { runAccessibilityScan } from "../src/scanner/crawler.js";

const port = 4186;
let directProtectedLoads = 0;
let rootLoads = 0;
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.url === "/protected") {
    directProtectedLoads += 1;
    response.statusCode = 403;
    response.end("<!doctype html><html><body>Forbidden</body></html>");
    return;
  }
  rootLoads += 1;
  if (rootLoads > 1) {
    response.statusCode = 403;
    response.end("<!doctype html><html><body>Forbidden</body></html>");
    return;
  }
  response.end(`<!doctype html><html lang="en"><head><title>Protected SPA fixture</title></head><body><main>
  </main><script>
    const renderRoot = () => {
      document.querySelector('main').innerHTML = '<h1>Authenticated application</h1><button id="open-language" type="button">Language</button><a id="open-security" href="/protected">Security</a>';
      document.querySelector('#open-language').onclick = () => {
        document.querySelector('main').insertAdjacentHTML('beforeend', '<section><h2>Choose language</h2><button type="button">English</button></section>');
      };
      document.querySelector('#open-security').onclick = (event) => {
        event.preventDefault();
        history.pushState({ screen: 'security' }, '', '/protected');
        document.querySelector('main').innerHTML = '<h1>Security</h1><img id="protected-image" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">';
        document.title = 'Security';
      };
    };
    addEventListener('popstate', () => {
      if (location.pathname === '/') {
        document.title = 'Protected SPA fixture';
        renderRoot();
      }
    });
    renderRoot();
  </script></body></html>`);
});

const reportsDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarity-protected-spa-"));
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
try {
  const config = getConfig({
    targetUrl: `http://127.0.0.1:${port}/`,
    maxPages: 3,
    maxDepth: 2,
    headless: true,
    browserChannel: "bundled",
    aiEnabled: false,
    login: false
  });
  config.reportsDir = reportsDir;
  config.authStatePath = path.join(reportsDir, "auth-state.json");
  const report = await runAccessibilityScan(config);
  const protectedPage = report.pages.find((page) => page.url.endsWith("/protected"));
  assert.ok(protectedPage, "the protected SPA route should be discovered");
  assert.equal(protectedPage.error, null, "the protected SPA route should be reopened through the recorded action path");
  assert.equal(rootLoads, 1, "a harmless changed SPA state must not force a protected root reload");
  assert.equal(directProtectedLoads, 0, "the crawler must not make a direct server request for a route reached through SPA state");
  assert.ok(report.issues.some((issue) => issue.pageUrl.endsWith("/protected") && issue.ruleId === "image-alt"), "the recovered protected route should be accessibility-scanned");
  assert.ok(report.events.some((event) => event.type === "route-replay"), "the report should record action-path route recovery");
  console.log("Protected SPA route replay avoided the Forbidden deep-link response and scanned the recovered page.");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(reportsDir, { recursive: true, force: true });
}
