

export function selectNvdaAnnouncements(events) {
  // A focus-pane handoff may announce the previously focused control before the
  // document itself. Keep only control speech after the last document boundary.
  const boundary = events.reduce((last, event, index) => (
    event.focusIsDocument || /^RAMBO NVDA\b.*\bdocument$/i.test(event.text) ? index : last
  ), -1);
  return events.slice(boundary + 1)
    .filter((event) => event.inDocument === true && !event.focusIsDocument && !event.isFocusAnchor)
    .map((event) => event.text).filter(Boolean);
}

// Transcripts arrive before audible output finishes. Listener mode also waits
// for the synthesizer's terminal index/completion acknowledgement. silentWaitMs
// (NVDA_SILENT_WAIT_MS) ends the wait early when nothing at all was announced;
// 0 keeps the full bounded wait. Speech that has started is never cut short.
export async function waitForActionSpeech(receiver, mark, actionId, configuredWaitMs, { audibleCompletion = false, audioTimeoutMs = 30_000, silentWaitMs = 0 } = {}) {
  const maximumMs = Math.max(1_500, Math.min(4_000, Number(configuredWaitMs || 650) * 3));
  const silentMs = Number(silentWaitMs) > 0 ? Math.min(maximumMs, Number(silentWaitMs)) : maximumMs;
  const quietMs = 250;
  const started = Date.now();
  let lastCount = 0;
  let lastChange = started;
  let firstSpeechMs = null;
  const finish = async () => {
    if (!audibleCompletion) return { firstSpeechMs, settledMs: Date.now() - started };
    const deadline = Date.now() + Math.max(1, Math.min(30_000, Number(audioTimeoutMs) || 30_000));
    while (!receiver.stoppedReason && Date.now() < deadline) {
      const latest = Math.max(0, ...receiver.since(mark).filter((entry) => entry.actionId === actionId).map((entry) => entry.speechSequence || 0));
      if (!latest || !receiver.audioCompletionSupported || typeof receiver.waitForSpeechIdle !== "function") break;
      if (!await receiver.waitForSpeechIdle(actionId, latest, deadline - Date.now())) break;
      // The same command can announce multiple queued utterances. Verify the
      // acknowledgement still covers the latest one after a quiet interval.
      await receiver.waitForSpeech(Math.min(quietMs, Math.max(1, deadline - Date.now())));
      const current = Math.max(0, ...receiver.since(mark).filter((entry) => entry.actionId === actionId).map((entry) => entry.speechSequence || 0));
      if (current === latest && !receiver.stoppedReason) return { firstSpeechMs, settledMs: Date.now() - started, audibleComplete: true };
    }
    return { firstSpeechMs, settledMs: Date.now() - started, audibleComplete: false };
  };
  while (Date.now() - started < maximumMs) {
    if (receiver.stoppedReason) return { firstSpeechMs, settledMs: Date.now() - started, ...(audibleCompletion ? { audibleComplete: false } : {}) };
    const count = receiver.since(mark).filter((entry) => entry.actionId === actionId).length;
    if (count !== lastCount) {
      lastCount = count;
      lastChange = Date.now();
      firstSpeechMs ??= lastChange - started;
    }
    if (count > 0 && Date.now() - lastChange >= quietMs) return finish();
    if (count === 0 && silentMs < maximumMs && Date.now() - started >= silentMs) return { firstSpeechMs: null, settledMs: Date.now() - started, silent: true };
    const remaining = maximumMs - (Date.now() - started);
    const wait = Math.max(5, Math.min(remaining, count > 0 ? quietMs - (Date.now() - lastChange) : silentMs - (Date.now() - started)));
    if (typeof receiver.waitForSpeech === "function") await receiver.waitForSpeech(wait);
    else await new Promise((resolve) => setTimeout(resolve, Math.min(75, wait)));
  }
  return finish();
}
