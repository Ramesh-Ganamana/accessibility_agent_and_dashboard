const SENSITIVE_QUERY_KEYS = /^(?:code|state|session_state|access_token|refresh_token|id_token|token|oauth_token|oauth_verifier|code_challenge|code_verifier|nonce|samlresponse|relaystate)$/i;

function removeSensitiveParameters(parameters) {
  for (const key of [...parameters.keys()]) {
    if (SENSITIVE_QUERY_KEYS.test(key)) parameters.delete(key);
  }
}

export function sanitizeUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.username = "";
    url.password = "";
    removeSensitiveParameters(url.searchParams);
    if (/^#(?:!\/|\/)/.test(url.hash)) {
      const queryIndex = url.hash.indexOf("?");
      if (queryIndex !== -1) {
        const route = url.hash.slice(0, queryIndex);
        const parameters = new URLSearchParams(url.hash.slice(queryIndex + 1));
        removeSensitiveParameters(parameters);
        url.hash = `${route}${parameters.size ? `?${parameters}` : ""}`;
      }
    } else {
      url.hash = "";
    }
    return url.search || url.hash ? url.href : url.href.replace(/\/$/, "");
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
