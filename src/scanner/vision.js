import OpenAI from "openai";

export async function scanAltQuality(page, pageUrl, config, onEvent = () => {}) {
  if (!config.aiEnabled || !config.openAiApiKey) return [];
  const client = new OpenAI({ apiKey: config.openAiApiKey });
  const images = page.locator('img[alt]:not([alt=""])');
  const count = Math.min(await images.count(), 6);
  const findings = [];

  for (let index = 0; index < count; index += 1) {
    const image = images.nth(index);
    if (!(await image.isVisible().catch(() => false))) continue;
    const alt = await image.getAttribute("alt");
    const screenshot = await image.screenshot({ type: "jpeg", quality: 72 }).catch(() => null);
    if (!screenshot) continue;

    onEvent({ type: "ai", message: `Evaluating image ${index + 1}/${count} only because it already has custom alt text.`, url: pageUrl });
    try {
      const response = await client.chat.completions.create({
        model: config.openAiModel,
        temperature: 0,
        max_tokens: 180,
        response_format: { type: "json_object" },
        messages: [{
          role: "user",
          content: [
            {
              type: "text",
              text: `Assess whether this image alt text is concise and contextually accurate. Alt text: ${JSON.stringify(alt)}. Return JSON with {"adequate":boolean,"confidence":number,"reason":string}. Decorative images should normally use empty alt text.`
            },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${screenshot.toString("base64")}` } }
          ]
        }]
      });
      const verdict = JSON.parse(response.choices[0]?.message?.content || "{}");
      if (verdict.adequate === false && Number(verdict.confidence || 0) >= 0.65) {
        const target = await image.evaluate((element) => element.id ? `#${CSS.escape(element.id)}` : `img[alt=${JSON.stringify(element.alt)}]`);
        findings.push({
          id: `ai-alt-${index}-${Date.now().toString(36)}`,
          findingType: "needs-review",
          ruleId: "ai-alt-quality",
          impact: "moderate",
          help: "Image alternative may not match visual meaning",
          description: verdict.reason || "Vision review indicated that the supplied text alternative may be inaccurate or unhelpful.",
          helpUrl: "https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html",
          tags: ["wcag2a", "wcag111"],
          wcag: ["1.1.1"],
          target: [target],
          html: `<img alt=${JSON.stringify(alt)}>`,
          failureSummary: `AI confidence ${Math.round(Number(verdict.confidence) * 100)}%. ${verdict.reason}`,
          pageUrl,
          frameUrl: pageUrl,
          state: "default",
          evidence: null,
          source: config.openAiModel
        });
      }
    } catch (error) {
      onEvent({ type: "ai-error", message: `Vision check skipped: ${error.message}`, url: pageUrl });
    }
  }
  return findings;
}

