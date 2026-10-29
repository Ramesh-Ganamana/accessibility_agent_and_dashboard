import http from "node:http";
import { createBrowserSession, ensureAuthenticated } from "../src/browser/session.js";
import { getConfig } from "../src/config.js";

const server = http.createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.url === "/start") {
    response.end(page(`
      <a id="login-launch" href="/login" aria-label="Log in to your account">Log in</a>
    `));
  } else if (request.url === "/login") {
    response.end(page(`
      <label for="signInName">Username</label>
      <input id="signInName" type="text">
      <button id="continue" type="button" onclick="location.href='/password'">Continue</button>
    `));
  } else if (request.url === "/password") {
    response.end(page(`
      <label for="password">Password</label>
      <input id="password" type="password">
      <button id="signIn" type="button" onclick="this.disabled=true; setTimeout(()=>location.href='/home', 4000)">Sign in</button>
    `));
  } else {
    response.end(page("<h1>Authenticated application</h1>"));
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const port = server.address().port;
const config = getConfig({
  targetUrl: `http://127.0.0.1:${port}`,
  browserChannel: process.env.BROWSER_CHANNEL || "bundled",
  headless: true,
  login: {
    url: `http://127.0.0.1:${port}/start`,
    username: "integration-user",
    password: "integration-password",
    persist: false,
    emailSelector: "#signInName",
    passwordSelector: '#password, input[type="password"]',
    submitSelector: "#continue, #signIn"
  }
});

let session;
try {
  session = await createBrowserSession(config);
  await ensureAuthenticated(session, config);
  if (session.page.url() !== `http://127.0.0.1:${port}/home`) {
    throw new Error(`Unexpected final URL: ${session.page.url()}`);
  }
  console.log("Two-stage Chromium authentication flow passed.");
} finally {
  try { await session?.close(); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function page(body) {
  return `<!doctype html><html><body>${body}</body></html>`;
}
