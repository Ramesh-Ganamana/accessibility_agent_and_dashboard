// Independently guards tab focus between commands. Checks are bounded and
// generation-tagged so an old observation cannot restart a canceled watch.
export function createTabScopeWatch({ getPage, isActive, runtime, canPause, enterPause, stop }) {
  let scopeTimer;
  let lostFocus = 0;
  let scopeReadFailures = 0;
  let watchGeneration = 0;
  function startWatch() {
    clearTimeout(scopeTimer);
    lostFocus = 0;
    scopeReadFailures = 0;
    void watchTab(++watchGeneration);
  }

  async function watchTab(generation) {
    // A pause or resume starts a new generation; an in-flight check from an
    // older one must neither act nor reschedule a second loop.
    const current = () => isActive() && generation === watchGeneration;
    if (!current()) return;
    try {
      if (getPage().isClosed?.()) return await stop("The testing tab was closed; NVDA stopped.", "tab-closed");
      // A wedged browser evaluation must not keep an unverified desktop reader
      // alive forever. Allow brief navigation-context resets, then fail closed.
      let timeout;
      let active;
      try {
        active = await Promise.race([
          runtime.tabActive(getPage()),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Testing tab verification timed out.")), runtime.scopeTimeoutMs); })
        ]);
      } finally { clearTimeout(timeout); }
      if (!current()) return;
      scopeReadFailures = 0;
      lostFocus = active === false ? lostFocus + 1 : 0;
      if (lostFocus >= 2) {
        if (canPause()) return await enterPause("The testing tab lost focus.", "tab-focus");
        return await stop("The testing tab lost focus; NVDA stopped. Remaining screen-reader tests were canceled.", "lost-focus");
      }
    } catch {
      if (!current()) return;
      lostFocus = 0;
      scopeReadFailures++;
      if (scopeReadFailures >= 3) return await stop("The testing tab could no longer be verified; NVDA stopped. Remaining screen-reader tests were canceled.", "unverified");
    }
    if (current()) {
      scopeTimer = setTimeout(() => { void watchTab(generation); }, runtime.scopeIntervalMs);
      scopeTimer.unref?.();
    }
  }
  function clear() {
    clearTimeout(scopeTimer);
    watchGeneration++;
    lostFocus = 0;
    scopeReadFailures = 0;
  }
  return { start: startWatch, clear };
}
