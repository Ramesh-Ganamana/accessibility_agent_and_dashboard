import { sanitizeUrlsInText } from "../../url-security.js";

export function errorHandler(error, _request, response, _next) {
  const message = error.type === "entity.parse.failed" ? "The request contains invalid JSON." : sanitizeUrlsInText(error.message || "Unexpected server error.");
  console.error(message);
  if (response.headersSent) return _next(error);
  response.status(error.status || (error.code === "ENOENT" ? 404 : 500)).json({ error: message });
}
