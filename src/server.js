// CLI entry point and compatibility exports. Importing does not start the server.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "./config.js";
import { createDashboardApp } from "./api/app.js";

export { createDashboardApp } from "./api/app.js";
export { localRequestGuard } from "./api/middleware/local-request-guard.js";
export { updateJobFromEvent, settleJob, STOPPED_PHASE } from "./api/jobs/lifecycle.js";

const baseConfig = getConfig();
export const app = createDashboardApp({ config: baseConfig });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Express 5 calls this callback for listen errors too; report them instead of
  // crashing on server.address(), which is null when listening failed.
  const server = app.listen(baseConfig.port, "127.0.0.1", (error) => {
    if (error) {
      console.error(listenErrorMessage(error, baseConfig.port));
      process.exitCode = 1;
      return;
    }
    console.log(`Accessibility Agent dashboard: http://localhost:${server.address().port}`);
  });
}

export function listenErrorMessage(error, port) {
  if (error?.code === "EADDRINUSE") {
    return `Port ${port} is already in use, usually by another dashboard that is still running. Stop that server (Ctrl+C in its terminal), or start this one on another port, for example: $env:PORT = "${Number(port) + 1}"; npm start`;
  }
  if (error?.code === "EACCES") return `Windows did not allow the dashboard to listen on port ${port}. Choose another port with the PORT setting in .env.`;
  return `The dashboard could not start on port ${port}: ${error?.message || error}`;
}
