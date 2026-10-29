import assert from "node:assert/strict";
import http from "node:http";
import { createBrowserSession, ensureAuthenticated } from "../src/browser/session.js";

// Local synthetic credentials only. No environment credentials, AI calls,
// saved sessions, NVDA or desktop focus are used by this regression.
const submitted = [];
let forbiddenClicks = 0;
const server = http.createServer(async (request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.url === "/verify") {
    let body = "";
    for await (const chunk of request) body += chunk;
    submitted.push(JSON.parse(body));
    response.end("ok");
    return;
  }
  if (request.url === "/forbidden") {
    forbiddenClicks += 1;
    response.end(html("<h1>This action must never be selected</h1>"));
    return;
  }
  if (request.url === "/entry") {
    response.end(html('<h1>Application welcome</h1><button type="button" onclick="location.href=\'/labelled\'">Sign in</button>'));
    return;
  }
  if (request.url === "/labelled") {
    response.end(html(loginForm("labelled")));
    return;
  }
  if (request.url === "/framed") {
    response.end(html('<h1>Corporate login</h1><label for="signInName">Username</label><input id="signInName" value="untouched"><iframe title="Sign in" src="/frame-login"></iframe>'));
    return;
  }
  if (request.url === "/frame-login") {
    response.end(html(loginForm("framed")));
    return;
  }
  if (request.url === "/shadow") {
    const markup = JSON.stringify(loginForm("shadow"));
    response.end(html(`<h1>Shadow login</h1><div id="host"></div><script>const root=document.getElementById("host").attachShadow({mode:"open"}); root.innerHTML=${markup};</script>`));
    return;
  }
  response.end(html("<h1>Authenticated application</h1>"));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const config = {
  targetUrl: `${origin}/home`, headless: true, browserChannel: "bundled",
  authStatePath: "unused-synthetic-auth.json", appShellWaitMs: 5_000,
  login: { url: `${origin}/entry`, email: "synthetic-name", password: "synthetic-secret", persist: false, aiEnabled: false }
};
const session = await createBrowserSession(config);
try {
  for (const fixture of ["entry", "framed", "shadow"]) {
    config.login.url = `${origin}/${fixture}`;
    // One scenario explicitly verifies selector precedence across frames. The
    // others leave every advanced selector blank and use no model fallback.
    config.login.emailSelector = fixture === "framed" ? "#identity-field" : "";
    config.login.passwordSelector = fixture === "framed" ? "#secret-field" : "";
    config.login.submitSelector = "";
    assert.equal(await ensureAuthenticated(session, config), true);
    assert.equal(session.page.url(), `${origin}/home`);
    const capture = submitted.at(-1);
    assert.equal(capture.username, "synthetic-name");
    assert.equal(capture.password, "synthetic-secret");
    assert.equal(capture.readOnlyName, "untouched");
    assert.equal(capture.readOnlyPassword, "untouched");
    assert.equal(capture.disabledName, "untouched");
    assert.equal(capture.verificationCode, "untouched");
    assert.equal(capture.newPassword, "untouched");
    if (fixture === "framed") assert.equal(capture.outerName, "untouched", "explicit frame selector must win over the main-frame default");
  }
  assert.equal(submitted.length, 3);
  assert.equal(forbiddenClicks, 0, "registration or other consequential submit controls must never be selected");
  console.log("Automatic authentication passed: plain Sign in entry, semantic labels, enabled/editable fields, protected OTP/new-password controls, frame selector precedence and open Shadow DOM; no advanced selectors or AI required.");
} finally {
  await session.close();
  await new Promise((resolve) => server.close(resolve));
}

function html(body) {
  return `<!doctype html><html lang="en"><head><title>Synthetic automatic login</title></head><body>${body}</body></html>`;
}

function loginForm(fixture) {
  // The real username has no type/name/autocomplete/username-like ID. Its
  // associated label is the only semantic identification available.
  return `<h1>Sign in</h1>
    <label for="username-readonly">Username</label><input id="username-readonly" type="text" readonly value="untouched">
    <label for="username-disabled">Username</label><input id="username-disabled" type="text" disabled value="untouched">
    <label for="email-code">Email verification code</label><input id="email-code" type="text" autocomplete="one-time-code" value="untouched">
    <label for="identity-field">Email address</label><input id="identity-field">
    <label for="secret-readonly">Password</label><input id="secret-readonly" type="password" readonly value="untouched">
    <label for="new-secret">New password</label><input id="new-secret" type="password" autocomplete="new-password" value="untouched">
    <label for="secret-field">Password</label><input id="secret-field" type="password">
    <button type="submit" onclick="top.location.href='/forbidden'">Create account</button>
    <button type="submit" disabled>Sign in</button>
    <button type="button" onclick="const root=this.getRootNode(); fetch('/verify',{method:'POST',body:JSON.stringify({fixture:'${fixture}',username:root.querySelector('#identity-field').value,password:root.querySelector('#secret-field').value,readOnlyName:root.querySelector('#username-readonly').value,disabledName:root.querySelector('#username-disabled').value,verificationCode:root.querySelector('#email-code').value,newPassword:root.querySelector('#new-secret').value,readOnlyPassword:root.querySelector('#secret-readonly').value,outerName:top.document.querySelector('#signInName')?.value})}).then(()=>top.location.href='/home')">Sign in</button>`;
}
