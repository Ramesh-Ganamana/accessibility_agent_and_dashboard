const SENSITIVE_QUERY_KEYS = /^(?:code|state|session_state|access_token|id_token|token|oauth_token|oauth_verifier|code_challenge|code_verifier|nonce|samlresponse|relaystate)$/i;

export function sanitizeUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.test(key)) url.searchParams.delete(key);
    }
    if (!/^#(?:!\/|\/)/.test(url.hash)) url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function sanitizeUrlsInText(value) {
  return String(value || "").replace(/https?:\/\/[^\s'"<>]+/gi, (candidate) => {
    const match = candidate.match(/^(.*?)([),.;]*)$/);
    const url = match?.[1] || candidate;
    const trailing = match?.[2] || "";
    return `${sanitizeUrl(url) || "[redacted URL]"}${trailing}`;
  });
}
