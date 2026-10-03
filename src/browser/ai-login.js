import OpenAI from "openai";

const SAFE_ACTIONS = new Set(["fill_username", "fill_password", "click", "click_login_entry", "click_auth_continue", "user_action_required", "none"]);
const DANGEROUS_TEXT = /sign\s*up|create account|delete|remove|purchase|pay|transfer|forgot password|reset password/i;

export async function findLoginControlWithAI({ page, expectedAction, config, onEvent = () => {} }) {
  if (!config.login.aiEnabled || !config.openAiApiKey) return null;

  const inventory = await collectSanitizedInventory(page);
  if (!inventory.controls.length) return null;
  onEvent({ type: "ai-auth", message: `AI is identifying the ${humanAction(expectedAction)} control from sanitized DOM metadata.` });

  const client = new OpenAI({ apiKey: config.openAiApiKey });
  try {
    const response = await client.responses.create({
      model: config.openAiModel,
      store: false,
      instructions: [
        "You classify controls on a login page. Choose exactly one safe next action.",
        "Never choose sign-up, password reset, account creation, payment, deletion, logout, or unrelated navigation.",
        "click_login_entry means only a Log in, Sign in, My account, or identity-provider control that opens authentication from an application landing page.",
        "click_auth_continue means only Continue, Next, Sign in, or Log in after the authentication form has already started.",
        "If CAPTCHA, OTP, MFA, passkey, security key, device approval, or biometric action is required, choose user_action_required.",
        "The application will supply credentials itself; you never receive or generate credentials.",
        `The control currently needed is: ${expectedAction}.`
      ].join(" "),
      input: JSON.stringify(inventory),
      text: {
        format: {
          type: "json_schema",
          name: "login_control_decision",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              action: { type: "string", enum: [...SAFE_ACTIONS] },
              controlId: { type: "string" },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              reason: { type: "string" }
            },
            required: ["action", "controlId", "confidence", "reason"]
          }
        }
      },
      max_output_tokens: 220
    });

    const decision = JSON.parse(response.output_text || "{}");
    if (!SAFE_ACTIONS.has(decision.action)) return null;
    if (decision.action === "user_action_required") {
      return { requiresUser: true, message: sanitizeReason(decision.reason) || "The login provider requires a user-completed security challenge." };
    }
    const actionMatches = decision.action === expectedAction ||
      (["click_login_entry", "click_auth_continue"].includes(expectedAction) && decision.action === "click");
    if (!actionMatches || Number(decision.confidence) < 0.68) return null;

    const selected = inventory.controls.find((control) => control.controlId === decision.controlId);
    if (!selected || DANGEROUS_TEXT.test(`${selected.text} ${selected.label} ${selected.ariaLabel}`)) return null;
    if (!isControlCompatible(expectedAction, selected)) return null;
    const locator = await locatorForControl(page, selected.controlId);
    return locator ? { locator, reason: sanitizeReason(decision.reason), confidence: decision.confidence } : null;
  } catch (error) {
    onEvent({ type: "ai-error", message: `AI login fallback was unavailable: ${firstLine(error.message)}` });
    return null;
  }
}

export function isControlCompatible(action, control) {
  const type = String(control.type || "").toLowerCase();
  const role = String(control.role || "").toLowerCase();
  const tag = String(control.tag || "").toLowerCase();
  const semantics = `${control.id || ""} ${control.name || ""} ${control.placeholder || ""} ${control.ariaLabel || ""} ${control.label || ""} ${control.nearbyText || ""}`;
  const fillable = ["input", "textarea", "select"].includes(tag) || role === "textbox" || Boolean(control.contentEditable);
  const nonTextInput = ["button", "submit", "reset", "checkbox", "radio", "file", "image", "hidden"].includes(type);
  if (action === "fill_username") return fillable && !nonTextInput && type !== "password";
  if (action === "fill_password") return fillable && !nonTextInput && (type === "password" || /password|passcode|secret/i.test(semantics));
  if (["click", "click_login_entry", "click_auth_continue"].includes(action)) {
    return ["button", "a"].includes(tag) || role === "button" || ["button", "submit", "image"].includes(type);
  }
  return false;
}

export async function detectSecurityChallenge(page) {
  const phrases = [];
  for (const frame of page.frames()) {
    const text = await frame.locator("body").innerText({ timeout: 700 }).catch(() => "");
    phrases.push(scrub(text).slice(0, 4_000));
  }
  const combined = phrases.join(" ").toLowerCase();
  const challenges = [
    [/(captcha|recaptcha|hcaptcha|prove you are human|verify you are human)/, "CAPTCHA or human verification"],
    [/(one[- ]time (code|password)|verification code|enter (the )?code|\botp\b)/, "one-time verification code"],
    [/(authenticator app|approve (the )?sign[- ]?in|device approval|push notification)/, "authenticator or device approval"],
    [/(passkey|security key|touch id|face id|windows hello|biometric)/, "passkey, security key, or biometric verification"]
  ];
  for (const [pattern, label] of challenges) if (pattern.test(combined)) return label;
  return null;
}

async function collectSanitizedInventory(page) {
  const controls = [];
  const frames = page.frames();
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frameControls = await frames[frameIndex].evaluate(({ frameIndex }) => {
      const results = [];
      const controlSelector = 'input, textarea, button, select, a[href], [role="button"], [role="textbox"], [contenteditable="true"]';
      const text = (value, limit = 180) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
      const inspect = (element) => {
        if (!element.matches?.(controlSelector) || results.length >= 120) return;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (rect.width < 2 || rect.height < 2 || style.visibility === "hidden" || style.display === "none") return;
        const controlId = `auth-f${frameIndex}-e${results.length}`;
        element.setAttribute("data-a11y-auth-id", controlId);
        const nativeLabels = element.labels ? [...element.labels].map((label) => label.textContent) : [];
        const wrappingLabel = element.closest?.("label")?.textContent;
        const labelledBy = (element.getAttribute("aria-labelledby") || "")
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent)
          .filter(Boolean);
        const parentText = element.parentElement?.textContent || element.previousElementSibling?.textContent || "";
        results.push({
          controlId,
          frameIndex,
          tag: element.localName,
          type: element.getAttribute("type") || "",
          id: element.id || "",
          name: element.getAttribute("name") || "",
            role: element.getAttribute("role") || "",
            contentEditable: element.isContentEditable,
          autocomplete: element.getAttribute("autocomplete") || "",
          placeholder: text(element.getAttribute("placeholder")),
          ariaLabel: text(element.getAttribute("aria-label")),
          label: text([...nativeLabels, wrappingLabel, ...labelledBy].filter(Boolean).join(" ")),
          nearbyText: text(parentText, 240),
          text: ["button", "a"].includes(element.localName) || element.getAttribute("role") === "button"
            ? text(element.textContent)
            : ""
        });
      };
      const visit = (root) => {
        for (const element of root.children || []) {
          if (results.length >= 120) break;
          inspect(element);
          visit(element);
          if (element.shadowRoot) visit(element.shadowRoot);
        }
      };
      visit(document);
      return results;
    }, { frameIndex }).catch(() => []);
    controls.push(...frameControls);
  }
  return {
    page: { urlOrigin: safeOrigin(page.url()), title: scrub(await page.title()).slice(0, 180) },
    controls: controls.slice(0, 180)
  };
}

async function locatorForControl(page, controlId) {
  for (const frame of page.frames()) {
    const locator = frame.locator(`[data-a11y-auth-id="${controlId}"]`).first();
    if (await locator.isVisible({ timeout: 300 }).catch(() => false)) return locator;
  }
  return null;
}

function safeOrigin(value) {
  try { return new URL(value).origin; } catch { return "unknown"; }
}

function scrub(value) {
  return String(value || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b\d{4,}\b/g, "[number]")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeReason(value) {
  return scrub(value).slice(0, 300);
}

function humanAction(action) {
  return action.replace("fill_", "").replaceAll("_", " ");
}

function firstLine(value) {
  return String(value || "Unknown error").split(/\r?\n/, 1)[0];
}
