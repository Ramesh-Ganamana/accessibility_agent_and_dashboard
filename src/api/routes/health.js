import { Router } from "express";

export function createHealthRouter({ baseConfig, detectNvdaCapability }) {
  const router = Router();
  router.get("/api/health", (_request, response) => {
    const nvda = detectNvdaCapability(baseConfig.nvda);
    response.json({
      ok: true,
      service: "AI Accessibility Automation Agent",
      build: "accessibility-nvda-recovery-44",
      browserChannel: baseConfig.browserChannel,
      aiLoginAvailable: Boolean(baseConfig.openAiApiKey),
      // Shown under the Do not click field: these entries apply to every scan and journey.
      actionExclusions: { serverEntries: baseConfig.excludeActionLabels || [] },
      nvda: { available: nvda.available, configured: nvda.configured, reason: nvda.reason, mode: nvda.mode, order: baseConfig.nvda.mode, recovery: "same-state-bounded-v2" }
    });
  });
  return router;
}
