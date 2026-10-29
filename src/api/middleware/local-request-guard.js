/** Create a localhost-only guard; importing this module never opens a listener. */
export function createLocalRequestGuard(extraHosts = process.env.DASHBOARD_ALLOWED_HOSTS || "") {
  const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]", ...String(extraHosts).split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)]);
  // The dashboard has no login and serves screenshots of authenticated sites. A
  // page using DNS rebinding reaches 127.0.0.1 under its own hostname, so only
  // requests addressed to localhost are served, and state-changing requests must
  // not come from another origin.
  return function localRequestGuard(request, response, next) {
    const host = String(request.headers.host || "").toLowerCase();
    const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
    if (!allowedHosts.has(hostname)) return response.status(421).json({ error: "This dashboard only accepts requests addressed to localhost." });
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.origin) {
      let originHost = "";
      try { originHost = new URL(request.headers.origin).hostname.toLowerCase(); } catch {}
      if (!allowedHosts.has(originHost)) return response.status(403).json({ error: "Cross-origin requests are not allowed." });
    }
    next();
  };
}

export const localRequestGuard = createLocalRequestGuard();
