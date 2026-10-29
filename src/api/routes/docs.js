import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";

// API documentation only: serves the hand-maintained OpenAPI document and a
// Swagger UI page for it. Nothing here reads or changes scans, jobs or reports.
const SWAGGER_UI = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14";

export function createDocsRouter({ baseConfig }) {
  const router = Router();
  const specFile = path.join(baseConfig.rootDir, "docs", "openapi.json");

  router.get("/api/openapi.json", async (_request, response, next) => {
    try { response.type("application/json").send(await fs.readFile(specFile, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return response.status(404).json({ error: "The OpenAPI document docs/openapi.json was not found." });
      next(error);
    }
  });

  router.get("/api-docs", (_request, response) => {
    response.type("html").send(SWAGGER_PAGE);
  });
  return router;
}

const SWAGGER_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dashboard API documentation</title>
  <link rel="stylesheet" href="${SWAGGER_UI}/swagger-ui.css">
  <style>
    body { margin: 0; background: #fff; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    #load-error { margin: 2rem; font: 1rem/1.5 system-ui, sans-serif; }
  </style>
</head>
<body>
  <main id="content">
    <h1 class="visually-hidden">Dashboard API documentation</h1>
    <p id="load-error" hidden>Swagger UI could not be loaded from cdn.jsdelivr.net. The raw OpenAPI document is available at <a href="/api/openapi.json">/api/openapi.json</a>.</p>
    <div id="swagger-ui"></div>
  </main>
  <script src="${SWAGGER_UI}/swagger-ui-bundle.js" crossorigin="anonymous"></script>
  <script>
    if (window.SwaggerUIBundle) {
      window.ui = SwaggerUIBundle({ url: "/api/openapi.json", dom_id: "#swagger-ui", deepLinking: true, validatorUrl: null });
    } else {
      document.getElementById("load-error").hidden = false;
    }
  </script>
</body>
</html>
`;
