import http from "node:http";
import { createBrowserSession, ensureAuthenticated } from "../src/browser/session.js";
import { getConfig } from "../src/config.js";

const port = 4177;
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.url === "/login") {
    response.end(page(`
      <label for="identity-box">Corporate login ID</label>
      <input id="identity-box" type="text" aria-label="Corporate account identifier">
      <div id="advance-step" role="button" tabindex="0" aria-label="Continue to secret entry" onclick="location.href='/secret'">Proceed</div>
    `));
  } else if (request.url === "/secret") {
    response.end(page(`
      <label for="secret-box">Account password</label>
      <div id="secret-box" role="textbox" contenteditable="true" aria-label="Account password"></div>
      <div id="complete-login" role="button" tabindex="0" aria-label="Complete sign in" onclick="location.href='/home'">Enter workspace</div>
    `));
  } else {
    response.end(page("<h1>Authenticated application</h1>"));
  }
});

await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
const config = getConfig({
  targetUrl: `http://127.0.0.1:${port}`,
  browserChannel: "bundled",
  login: {
    url: `http://127.0.0.1:${port}/login`,
    username: "synthetic-user",
    password: "synthetic-password",
    persist: false,
    aiEnabled: true,
    emailSelector: ".intentionally-missing-username",
    passwordSelector: ".intentionally-missing-password",
    submitSelector: ".intentionally-missing-submit"
  }
});

if (!config.openAiApiKey) {
  console.error("OPENAI_API_KEY is required for this integration test.");
  process.exitCode = 1;
  await new Promise((resolve) => server.close(resolve));
} else {
  const session = await createBrowserSession(config);
  try {
    await ensureAuthenticated(session, config);
    if (session.page.url() !== `http://127.0.0.1:${port}/home`) {
      throw new Error(`Unexpected final URL: ${session.page.url()}`);
    }
    console.log("AI-assisted Chromium authentication flow passed without exposing credentials to the model.");
  } finally {
    await session.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

function page(body) {
  return `<!doctype html><html><body>${body}</body></html>`;
}
