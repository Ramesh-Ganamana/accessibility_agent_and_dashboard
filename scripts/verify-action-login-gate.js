import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { getConfig } from "../src/config.js";
import { runAccessibilityScan } from "../src/scanner/crawler.js";

const port = 4179;
let callbackLoads = 0;
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.url === "/bootstrap-login") {
    response.end(page(`
      <h1>Sign in</h1>
      <button type="button" onclick="location.href='/auth0-login'">Continue</button>
      <button type="button">Create your account</button>
    `));
    return;
  }
  if (request.url === "/auth0-login" || request.url === "/tenant-login") {
    const destination = request.url === "/auth0-login" ? "/callback?code=one-time&state=fixture" : "/dashboard";
    response.end(page(`
      <h1>Sign in</h1>
      <label for="username">User ID</label><input id="username" name="username" autocomplete="username">
      <label for="password">Password</label><input id="password" type="password" autocomplete="current-password">
      <button id="signIn" type="button" onclick="location.href='${destination}'">Sign in</button>
    `));
    return;
  }
  if (request.url === "/dashboard") {
    response.end(page("<h1>Authenticated tenant dashboard</h1>"));
    return;
  }
  if (request.url?.startsWith("/callback")) {
    callbackLoads += 1;
    if (callbackLoads > 1) {
      response.end(page("<h1>Callback already consumed</h1>"));
      return;
    }
  }
  response.end(page(`
    <h1>Choose a benefits provider</h1>
    <div role="button" tabindex="0" onclick="location.href='/tenant-login'">Kaiser Permanente</div>
  `));
});

const reportsDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarity-login-gate-"));
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
try {
  const config = getConfig({
    targetUrl: `http://127.0.0.1:${port}/app`,
    maxPages: 4,
    maxDepth: 2,
    headless: true,
    browserChannel: "bundled",
    aiEnabled: false,
    login: {
      url: `http://127.0.0.1:${port}/bootstrap-login`,
      username: "qa-user",
      password: "qa-password",
      persist: false,
      emailSelector: "#username",
      passwordSelector: "#password",
      submitSelector: "#signIn"
    }
  });
  config.reportsDir = reportsDir;
  config.authStatePath = path.join(reportsDir, "auth-state.json");
  const report = await runAccessibilityScan(config);
  assert.ok(report.events.some((event) => event.message?.includes("login gate appeared")));
  assert.ok(report.graph.edges.some((edge) => edge.label === "click: Kaiser Permanente"));
  assert.ok(report.graph.nodes.some((node) => node.url.endsWith("/dashboard")));
  assert.equal(callbackLoads, 1, "the one-time authentication callback must not be reloaded during action discovery");
  console.log("Interaction-triggered login gate authentication passed.");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(reportsDir, { recursive: true, force: true });
}

function page(body) {
  return `<!doctype html><html lang="en"><head><title>Login gate fixture</title></head><body><main>${body}</main></body></html>`;
}
