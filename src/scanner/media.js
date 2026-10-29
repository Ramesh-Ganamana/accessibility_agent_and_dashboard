// Finds audio, video, embedded players and moving content, and records what a
// reviewer must confirm. Automation cannot judge caption accuracy or whether
// an audio description is needed, so every result is needs-review.
const EMBEDDED_PLAYER = /(?:youtube(?:-nocookie)?\.com\/embed|player\.vimeo\.com|fast\.wistia\.(?:net|com)|players\.brightcove\.net|jwplayer|vidyard\.com|dailymotion\.com\/embed|loom\.com\/embed|kaltura|vimeo\.com\/video)/i;

export async function scanMedia(page, pageUrl) {
  const items = await page.evaluate((playerPattern) => {
    const embeddedPlayer = new RegExp(playerPattern, "i");
    const selector = (element) => {
      if (element.id) return `#${CSS.escape(element.id)}`;
      const parts = [];
      for (let node = element; node && node !== document.body && parts.length < 5; node = node.parentElement) {
        const siblings = node.parentElement ? [...node.parentElement.children].filter((item) => item.localName === node.localName) : [];
        parts.unshift(`${node.localName}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : ""}`);
      }
      return parts.join(" > ");
    };
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width >= 2 && rect.height >= 2;
    };
    const pauseControlNear = (element) => {
      const scope = element.closest("section,article,figure,div") || document.body;
      return [...scope.querySelectorAll("button,[role='button']")].some((control) => /\b(pause|stop|play)\b/i.test(`${control.getAttribute("aria-label") || ""} ${control.textContent || ""}`));
    };
    const results = [];
    for (const media of document.querySelectorAll("video,audio")) {
      const tracks = [...media.querySelectorAll("track")].map((track) => track.kind || "subtitles");
      results.push({
        kind: media.localName,
        target: selector(media),
        visible: visible(media),
        controls: media.hasAttribute("controls"),
        autoplay: media.autoplay || media.hasAttribute("autoplay"),
        muted: media.muted || media.hasAttribute("muted"),
        loop: media.loop,
        duration: Number.isFinite(media.duration) ? media.duration : null,
        captions: tracks.some((kind) => kind === "captions" || kind === "subtitles"),
        descriptions: tracks.includes("descriptions"),
        label: media.getAttribute("aria-label") || media.getAttribute("title") || ""
      });
    }
    for (const frame of document.querySelectorAll("iframe[src]")) {
      if (embeddedPlayer.test(frame.src) && visible(frame)) {
        results.push({ kind: "embedded-player", target: selector(frame), src: new URL(frame.src, location.href).hostname, label: frame.getAttribute("title") || "", autoplay: /[?&]autoplay=1/.test(frame.src) });
      }
    }
    for (const element of document.querySelectorAll("marquee,[class*='marquee' i],[class*='ticker' i],[class*='carousel' i],[class*='slider' i]")) {
      if (results.filter((item) => item.kind === "moving").length >= 5 || !visible(element)) continue;
      const style = getComputedStyle(element);
      const animated = element.localName === "marquee" || style.animationIterationCount === "infinite"
        || [...element.querySelectorAll("*")].slice(0, 200).some((child) => getComputedStyle(child).animationIterationCount === "infinite")
        || element.hasAttribute("data-autoplay") || /autoplay/i.test(element.className);
      if (animated && !pauseControlNear(element)) results.push({ kind: "moving", target: selector(element), label: element.getAttribute("aria-label") || element.className.toString().slice(0, 60) });
    }
    return results;
  }, EMBEDDED_PLAYER.source).catch(() => []);

  const findings = [];
  for (const item of items) {
    if (item.kind === "video" && item.visible) {
      if (!item.captions) findings.push(review("media-captions", ["1.2.2"], "serious", "Video has no captions track", "This video has no captions or subtitles track. Confirm captions are provided (open captions burned into the video also satisfy 1.2.2).", item, pageUrl));
      if (!item.descriptions) findings.push(review("media-audio-description", ["1.2.5"], "moderate", "Confirm audio description for video", "No descriptions track was found. If visual information is not conveyed by the existing audio, an audio description is required.", item, pageUrl));
      if (item.autoplay && (item.loop || item.duration === null || item.duration > 5) && !item.controls) findings.push(review("media-pause-control", ["2.2.2"], "serious", "Autoplaying video has no visible pause control", "This video starts automatically and plays for more than five seconds without native controls. Confirm a mechanism to pause, stop or hide it.", item, pageUrl));
    }
    if ((item.kind === "video" || item.kind === "audio") && item.autoplay && !item.muted && (item.duration === null || item.duration > 3)) {
      findings.push(review("media-autoplay-audio", ["1.4.2"], "serious", "Audio plays automatically", "Media with sound starts automatically. If it plays for more than three seconds, a control to pause, stop or change its volume must be available at the start of the page.", item, pageUrl));
    }
    if (item.kind === "audio") findings.push(review("media-transcript", ["1.2.1"], "moderate", "Confirm a transcript for audio content", "Prerecorded audio-only content needs a text alternative such as a transcript. Confirm one is available near the player.", item, pageUrl));
    if (item.kind === "embedded-player") {
      findings.push(review("media-embedded-player", ["1.2.2", "1.2.5"], "moderate", `Embedded ${item.src} video needs caption review`, `Captions and audio description in this embedded ${item.src} player cannot be inspected from the page. Confirm accurate captions and, where needed, audio description.${item.autoplay ? " The player is set to autoplay." : ""}`, item, pageUrl));
      if (!item.label) findings.push(review("media-embedded-player-title", ["4.1.2"], "moderate", "Embedded player frame has no title", "The iframe that holds this player has no title attribute, so screen-reader users cannot tell what it contains.", item, pageUrl));
    }
    if (item.kind === "moving") findings.push(review("media-moving-content", ["2.2.2"], "moderate", "Moving content may lack a pause control", "This element appears to animate or rotate continuously, and no Pause/Stop control was found next to it. Moving content that lasts more than five seconds needs a way to pause, stop or hide it.", item, pageUrl));
  }
  return findings;
}

function review(ruleId, wcag, impact, help, description, item, pageUrl) {
  return {
    id: `${ruleId}-${simpleHash(`${pageUrl}-${item.target}`)}`,
    findingType: "needs-review",
    ruleId,
    impact,
    help,
    description,
    helpUrl: `https://www.w3.org/WAI/WCAG22/Understanding/${UNDERSTANDING[wcag[0]]}.html`,
    tags: wcag.map((id) => `wcag${id.replaceAll(".", "")}`),
    wcag,
    target: [item.target],
    html: `<${item.kind === "embedded-player" ? "iframe" : item.kind}${item.label ? ` title="${String(item.label).replace(/"/g, "&quot;")}"` : ""}>`,
    failureSummary: [item.autoplay ? "autoplay" : null, item.controls === false ? "no native controls" : null, item.captions === false ? "no captions track" : null].filter(Boolean).join("; ") || description,
    pageUrl,
    frameUrl: pageUrl,
    state: "default",
    evidence: null,
    source: "media-check"
  };
}

const UNDERSTANDING = {
  "1.2.1": "audio-only-and-video-only-prerecorded", "1.2.2": "captions-prerecorded", "1.2.5": "audio-description-prerecorded",
  "1.4.2": "audio-control", "2.2.2": "pause-stop-hide", "4.1.2": "name-role-value"
};

function simpleHash(value) {
  let hash = 0;
  for (const char of value) hash = Math.imul(31, hash) + char.charCodeAt(0) | 0;
  return Math.abs(hash).toString(36);
}
