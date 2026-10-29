// Contract test for docs/openapi.json (OpenAPI 3.0.3):
//   1. structure: required fields, $refs, path parameters, operationIds, 2xx
//      responses, descriptions and every example (JSON where JSON, valid
//      against its schema);
//   2. route parity with the Express router stack built by createDashboardApp;
//   3. live contract: an in-process server on 127.0.0.1 (no browser, no
//      external network, stub runners) answers documented requests with the
//      documented status codes, content types, schemas and error examples.
// Temporary folders are removed afterwards. Run: npm run test:openapi
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDashboardApp } from "../src/api/app.js";
import { getConfig } from "../src/config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const specFile = path.join(root, "docs", "openapi.json");
const spec = JSON.parse(await fs.readFile(specFile, "utf8"));
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const JSON_MEDIA = /^application\/(?:[\w.+-]+\+)?json$/;

function resolveRef(ref) {
  assert.ok(typeof ref === "string" && ref.startsWith("#/"), `only local $refs are used: ${ref}`);
  return ref.slice(2).split("/").reduce((node, key) => node?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], spec);
}
const deref = (node) => { let current = node; while (current?.$ref) current = resolveRef(current.$ref); return current; };
const operations = Object.entries(spec.paths || {}).flatMap(([route, item]) => METHODS.filter((method) => item[method])
  .map((method) => ({ method, route, item, operation: item[method], name: `${method.toUpperCase()} ${route}` })));
const exampleEntries = (media) => [
  ...("example" in media ? [["example", media.example]] : []),
  ...Object.entries(media.examples || {}).map(([name, example]) => [name, deref(example)?.value])
];

// ---- OpenAPI 3.0 schema-object validator (the subset this document uses)
const typeOf = (value) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function schemaErrors(input, value, where = "body", out = []) {
  const schema = deref(input);
  if (!schema || typeof schema !== "object") return out;
  if (value === null && schema.nullable === true) return out;
  if (schema.enum && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) out.push(`${where}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  if (schema.type) {
    const actual = typeOf(value);
    const ok = schema.type === "integer" ? Number.isInteger(value) : schema.type === "number" ? actual === "number" : actual === schema.type;
    if (!ok) { out.push(`${where}: expected ${schema.type}, found ${actual}`); return out; }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${where}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${where}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) out.push(`${where}: ${JSON.stringify(value.slice(0, 80))} does not match ${schema.pattern}`);
    if (schema.format === "date-time" && (!DATE_TIME.test(value) || Number.isNaN(Date.parse(value)))) out.push(`${where}: ${value} is not an RFC 3339 date-time`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${where}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${where}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${where}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${where}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => schemaErrors(schema.items, item, `${where}[${index}]`, out));
  }
  if (typeOf(value) === "object") {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) out.push(`${where}: missing required "${key}"`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) schemaErrors(schema.properties[key], item, `${where}.${key}`, out);
      else if (schema.additionalProperties === false) out.push(`${where}: undocumented property "${key}"`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") schemaErrors(schema.additionalProperties, item, `${where}.${key}`, out);
    }
  }
  for (const part of schema.allOf || []) schemaErrors(part, value, where, out);
  const passes = (part) => !schemaErrors(part, value, where, []).length;
  if (schema.anyOf && !schema.anyOf.some(passes)) out.push(`${where}: matches none of anyOf`);
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(passes).length;
    if (matches !== 1) out.push(`${where}: matches ${matches} oneOf alternatives, expected 1`);
  }
  return out;
}

// ---- 1. structure
test("docs/openapi.json is a structurally valid OpenAPI 3.0.3 document", () => {
  const problems = [];
  const fail = (where, message) => problems.push(`${where}: ${message}`);
  if (spec.openapi !== "3.0.3") fail("openapi", `expected 3.0.3, found ${spec.openapi}`);
  if (typeof spec.info?.title !== "string" || !spec.info.title) fail("info.title", "required");
  if (typeof spec.info?.version !== "string" || !spec.info.version) fail("info.version", "required");
  if (!spec.paths || typeof spec.paths !== "object") fail("paths", "required");
  if (spec.servers !== undefined && (!Array.isArray(spec.servers) || spec.servers.some((server) => typeof server?.url !== "string"))) fail("servers", "each server needs a url");

  (function walk(node, where) {
    if (Array.isArray(node)) return node.forEach((item, index) => walk(item, `${where}[${index}]`));
    if (!node || typeof node !== "object") return;
    if ("$ref" in node) {
      if (typeof node.$ref !== "string" || !node.$ref.startsWith("#/")) fail(where, `non-local $ref ${node.$ref}`);
      else if (resolveRef(node.$ref) === undefined) fail(where, `unresolved $ref ${node.$ref}`);
      if (Object.keys(node).length > 1) fail(where, "$ref has sibling keys, which OpenAPI 3.0 ignores");
    }
    for (const [key, value] of Object.entries(node)) walk(value, `${where}/${key}`);
  })(spec, "#");

  // OpenAPI 3.0 schema keywords, and every schema-level `example` against its schema.
  function visitSchema(schema, where) {
    if (!schema || typeof schema !== "object" || schema.$ref) return;
    for (const key of ["const", "examples", "prefixItems", "$schema", "if", "then", "else", "unevaluatedProperties", "dependentRequired"]) if (key in schema) fail(where, `"${key}" is not an OpenAPI 3.0 schema keyword`);
    if (Array.isArray(schema.type) || schema.type === "null") fail(where, "OpenAPI 3.0 has no type arrays or type null");
    if (schema.nullable && !schema.type) fail(where, "nullable needs an explicit type");
    for (const key of ["exclusiveMinimum", "exclusiveMaximum"]) if (key in schema && typeof schema[key] !== "boolean") fail(where, `${key} must be a boolean in OpenAPI 3.0`);
    if ("example" in schema) for (const error of schemaErrors(schema, schema.example, `${where} (example)`)) problems.push(error);
    for (const [key, child] of Object.entries(schema.properties || {})) visitSchema(child, `${where}.${key}`);
    if (schema.items) visitSchema(schema.items, `${where}[]`);
    if (typeof schema.additionalProperties === "object") visitSchema(schema.additionalProperties, `${where}{}`);
    for (const key of ["allOf", "oneOf", "anyOf"]) (schema[key] || []).forEach((child, index) => visitSchema(child, `${where}/${key}/${index}`));
  }
  for (const [name, schema] of Object.entries(spec.components?.schemas || {})) visitSchema(schema, `#/components/schemas/${name}`);

  const checkMedia = (content, where) => {
    for (const [type, media] of Object.entries(content || {})) {
      if (!/^[\w.+-]+\/[\w.+*-]+$/.test(type)) fail(where, `invalid media type ${type}`);
      visitSchema(media.schema, `${where} ${type} schema`);
      if ("example" in media && media.examples) fail(`${where} ${type}`, "example and examples are mutually exclusive");
      for (const [name, value] of exampleEntries(media)) {
        const label = `${where} ${type} (${name})`;
        if (value === undefined) { fail(label, "example has no value"); continue; }
        let parsed = value;
        if (typeof value === "string" && (JSON_MEDIA.test(type) || /^\s*[[{]/.test(value))) {
          try { parsed = JSON.parse(value); } catch (error) { fail(label, `example is not valid JSON: ${error.message}`); continue; }
          if (!JSON_MEDIA.test(type)) parsed = value; // JSON text inside a non-JSON body stays a string for the schema
        }
        if (media.schema) for (const error of schemaErrors(media.schema, parsed, label)) problems.push(error);
      }
    }
  };

  const declaredTags = new Set((spec.tags || []).map((tag) => tag.name));
  const operationIds = new Set();
  for (const { route, item, operation, name } of operations) {
    if (!route.startsWith("/")) fail(name, "path must start with /");
    if (typeof operation.operationId !== "string" || !operation.operationId) fail(name, "operationId is required here");
    else if (operationIds.has(operation.operationId)) fail(name, `duplicate operationId ${operation.operationId}`);
    operationIds.add(operation.operationId);
    if (typeof operation.description !== "string" || !operation.description.trim()) fail(name, "description is missing");
    if (!operation.tags?.length) fail(name, "no tag");
    for (const tag of operation.tags || []) if (!declaredTags.has(tag)) fail(name, `tag "${tag}" is not declared`);

    // Operation-level parameters override path-level ones with the same name and location.
    const pathLevel = (item.parameters || []).map(deref);
    const operationLevel = (operation.parameters || []).map(deref);
    for (const list of [pathLevel, operationLevel]) {
      const keys = list.map((parameter) => `${parameter?.in}:${parameter?.name}`);
      if (new Set(keys).size !== keys.length) fail(name, `duplicate parameters ${keys.join(", ")}`);
    }
    const parameters = [...pathLevel.filter((shared) => !operationLevel.some((own) => own?.in === shared?.in && own?.name === shared?.name)), ...operationLevel];
    for (const parameter of parameters) {
      if (!parameter?.name || !["path", "query", "header", "cookie"].includes(parameter.in)) { fail(name, `invalid parameter ${JSON.stringify(parameter)}`); continue; }
      if (!parameter.schema && !parameter.content) fail(name, `parameter ${parameter.name} needs a schema`);
      visitSchema(parameter.schema, `${name} parameter ${parameter.name} schema`);
      if ("example" in parameter && parameter.schema) for (const error of schemaErrors(parameter.schema, parameter.example, `${name} parameter ${parameter.name} (example)`)) problems.push(error);
    }
    const templated = [...route.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    const declared = parameters.filter((parameter) => parameter?.in === "path");
    for (const parameterName of templated) {
      const parameter = declared.find((entry) => entry.name === parameterName);
      if (!parameter) fail(name, `path parameter {${parameterName}} is not declared`);
      else if (parameter.required !== true) fail(name, `path parameter {${parameterName}} must be required: true`);
    }
    for (const parameter of declared) if (!templated.includes(parameter.name)) fail(name, `path parameter "${parameter.name}" is not in the path template`);

    const body = deref(operation.requestBody);
    if (body) {
      if (!body.content || !Object.keys(body.content).length) fail(name, "requestBody needs content");
      checkMedia(body.content, `${name} requestBody`);
    }
    const responses = Object.entries(operation.responses || {});
    if (!responses.some(([status]) => /^2\d\d$/.test(status))) fail(name, "no 2xx response");
    for (const [status, response] of responses) {
      if (!/^(?:[1-5]\d\d|[1-5]XX|default)$/.test(status)) fail(name, `invalid response code ${status}`);
      const resolved = deref(response);
      if (typeof resolved?.description !== "string") fail(`${name} ${status}`, "response description is required");
      checkMedia(resolved?.content, `${name} ${status}`);
      for (const [header, definition] of Object.entries(resolved?.headers || {})) {
        const resolvedHeader = deref(definition);
        if ("example" in resolvedHeader && resolvedHeader.schema) for (const error of schemaErrors(resolvedHeader.schema, resolvedHeader.example, `${name} ${status} header ${header}`)) problems.push(error);
      }
    }
  }
  assert.deepEqual(problems, [], `\n${problems.join("\n")}`);
  assert.ok(operations.length > 0);
});

// ---- 2. route parity
const STUB_NVDA = () => ({ available: false, configured: false, reason: "OpenAPI contract test fixture", executable: null, mode: "headed-windows-live-state" });

function registeredRoutes(app) {
  const routes = [];
  (function collect(stack) {
    for (const layer of stack || []) {
      if (layer.route) {
        for (const [method, enabled] of Object.entries(layer.route.methods)) if (enabled && method !== "_all") routes.push({ method: method.toUpperCase(), path: layer.route.path });
      } else if (layer.handle?.stack) collect(layer.handle.stack);
    }
  })(app.router.stack);
  return routes;
}

const segments = (value) => value.split("/").filter(Boolean);
// Express 5 (path-to-regexp v8) without wildcards: ":name" matches one segment.
const routeMatches = (routePath, documentedPath) => {
  const routeParts = segments(routePath);
  const documentedParts = segments(documentedPath);
  return routeParts.length === documentedParts.length && routeParts.every((part, index) => part.startsWith(":")
    || (!documentedParts[index].startsWith("{") && part.toLowerCase() === documentedParts[index].toLowerCase()));
};

test("every Express route is documented and every documented API path is routed to it", async () => {
  const reportsDir = await fs.mkdtemp(path.join(os.tmpdir(), "openapi-parity-"));
  try {
    const app = createDashboardApp({ config: { ...getConfig(), reportsDir }, jobs: new Map(), scanRunner: async () => ({}), journeyRunner: async () => ({}), nvdaCapability: STUB_NVDA, allowedHosts: "" });
    const routes = registeredRoutes(app);
    assert.ok(routes.length > 0, "no Express routes found on app.router.stack");
    for (const route of routes) assert.match(route.path, /^\/[\w./:-]*$/, `unexpected route syntax ${route.path}`);

    const toExpress = (documentedPath) => documentedPath.replace(/\{([^}]+)\}/g, ":$1");
    const documented = new Set();
    for (const { method, route, operation, name } of operations) {
      const mapping = operation["x-express-route"];
      if (mapping?.startsWith("STATIC ")) {
        assert.ok(route.startsWith(`${mapping.slice(7)}/`), `${name} is outside its static mount ${mapping}`);
        continue;
      }
      const expected = mapping || `${method.toUpperCase()} ${toExpress(route)}`;
      documented.add(expected);
      // The first route in stack order that matches is the one Express runs.
      const handler = routes.find((entry) => entry.method === method.toUpperCase() && routeMatches(entry.path, route));
      assert.ok(handler, `${name} is documented but no Express route matches it`);
      assert.equal(`${handler.method} ${handler.path}`, expected, `${name} is handled by ${handler.method} ${handler.path}`);
      if (!mapping) assert.ok(route.startsWith("/api"), `${name}: only API paths and static mounts are expected`);
    }
    for (const route of routes) assert.ok(documented.has(`${route.method} ${route.path}`), `${route.method} ${route.path} is registered in Express but not documented`);
    assert.equal(new Set(routes.map((route) => `${route.method} ${route.path}`)).size, documented.size, "documented Express routes and registered routes differ");
  } finally {
    await removeTemp(reportsDir);
  }
});

// ---- 3. live contract
const CURRENT = "2026-10-28T09-12-44-512Z-k3x9a";   // the ReportId parameter example
const PREVIOUS = "2026-10-20T08-00-01-000Z-p0q1r";  // the PreviousReportId parameter example
const OTHER_SITE = "2026-10-21T00-00-00-000Z-other";
const RUNNING = "2026-10-27T00-00-00-000Z-runng";
const HOST = "app.example.test";                    // the BacklogHost parameter example
const ORIGIN = `https://${HOST}`;
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

function syntheticReports() {
  const finding = (id, ruleId, wcag, impact, pageUrl, target, extra = {}) => ({ id, ruleId, wcag, impact, help: `${ruleId} help`, pageUrl, target, state: "default", source: "axe-core", ...extra });
  const pages = [
    { url: `${ORIGIN}/`, title: "Home", issueIds: ["i-1"], incompleteIds: ["r-1"], observedStates: [{ state: "dialog", label: "Menu" }], baseline: "evidence/baselines/001-home.png",
      ruleOutcomes: [{ engine: "axe-core", rules: [{ ruleId: "image-alt", wcag: ["1.1.1"], status: "fail" }, { ruleId: "document-title", wcag: ["2.4.2"], status: "pass" }] }],
      screenReaderStates: [{ state: "default", warnings: ["Unlabelled button"] }] },
    { url: `${ORIGIN}/about`, title: "About", issueIds: ["i-2"], observedStates: [] }
  ];
  const graph = { nodes: [{ id: "n1", label: "Home", url: `${ORIGIN}/`, depth: 0, status: "scanned", issueCount: 1, state: "page" }, { id: "n2", label: "About", url: `${ORIGIN}/about`, depth: 1, status: "scanned", issueCount: 1, state: "page" }], edges: [{ source: "n1", target: "n2", type: "navigate", label: "About" }] };
  const current = {
    id: CURRENT, targetUrl: `${ORIGIN}/`, startedAt: "2026-10-28T09:12:44.512Z", completedAt: "2026-10-28T09:20:00.000Z", status: "complete",
    configuration: { maxPages: 2, maxStates: 10, maxDepth: 1, aiEnabled: false, headless: true, device: "desktop", audit: { profile: "financial", wcagVersion: "2.2", level: "AA" } },
    summary: { pagesScanned: 2, statesObserved: 3, confirmedIssues: 2, needsReview: 1, bestPracticeFindings: 1 },
    pages, graph, crawlTermination: { reason: "completed", message: "Crawl coverage complete" },
    assistiveTechnology: { automatedMode: "accessibility-tree", actualScreenReaders: { NVDA: "not-run" }, actualRuns: {} },
    issues: [
      finding("i-1", "image-alt", ["1.1.1"], "serious", `${ORIGIN}/`, ["#logo"], { evidence: "evidence/001-image-alt.png", evidenceKind: "highlighted" }),
      finding("i-2", "color-contrast", ["1.4.3"], "moderate", `${ORIGIN}/about`, [".muted"])
    ],
    incomplete: [finding("r-1", "aria-allowed-role", ["4.1.2"], "minor", `${ORIGIN}/`, ["#menu"], { findingType: "needs-review" })],
    bestPractices: [finding("b-1", "region", [], "moderate", `${ORIGIN}/`, ["footer"], { tags: ["best-practice"], category: "best-practice" })],
    events: [{ at: "2026-10-28T09:13:00.000Z", type: "progress", message: "Scanned Home", url: `${ORIGIN}/`, current: 1, total: 2 }],
    limitations: []
  };
  const previous = {
    ...current, id: PREVIOUS, startedAt: "2026-10-20T08:00:01.000Z", completedAt: "2026-10-20T08:05:00.000Z",
    configuration: { ...current.configuration, audit: { profile: "general", wcagVersion: "2.1", level: "AA" } },
    issues: [current.issues[0], finding("i-old", "label", ["1.3.1"], "critical", `${ORIGIN}/`, ["#search"])], incomplete: [], bestPractices: []
  };
  const otherSite = { ...previous, id: OTHER_SITE, targetUrl: "https://other.example.test/", startedAt: "2026-10-21T00:00:00.000Z" };
  const running = { id: RUNNING, targetUrl: `${ORIGIN}/`, startedAt: "2026-10-27T00:00:00.000Z", status: "in-progress", pages: [], issues: [], incomplete: [], summary: {}, graph: { nodes: [], edges: [] } };
  return [current, previous, otherSite, running];
}

const VALID_JOURNEY = { name: "Contract journey", environment: "sandbox", startUrl: `${ORIGIN}/`, allowedOrigins: [ORIGIN], steps: [{ action: "checkpoint", name: "Home" }] };
const INVALID_JOURNEY = { ...VALID_JOURNEY, startUrl: "https://elsewhere.example.test/" };

async function removeTemp(directory) {
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep), `refusing to remove ${directory}`);
  await fs.rm(directory, { recursive: true, force: true });
}

async function listen(app) {
  const server = await new Promise((resolve, reject) => { const result = app.listen(0, "127.0.0.1", () => resolve(result)); result.once("error", reject); });
  return { server, port: server.address().port, close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}

// Native HTTP client so that Host (and Origin) can be set explicitly.
function send(port, method, urlPath, { body, headers = {} } = {}) {
  const payload = body === undefined ? undefined : typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const finalHeaders = { Host: "localhost", Connection: "close", ...(payload !== undefined ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}), ...headers };
  return new Promise((resolve, reject) => {
    let answered = false;
    const request = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers: finalHeaders, agent: false }, (response) => {
      answered = true;
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve({ status: response.statusCode, headers: response.headers, buffer, text: buffer.toString("utf8") });
      });
    });
    request.on("error", (error) => { if (!answered) reject(error); });
    request.end(payload);
  });
}

test("live responses match the documented status codes, content types, schemas and examples", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openapi-contract-"));
  const reportsDir = path.join(tempRoot, "reports");
  const previousExclusions = process.env.EXCLUDE_ACTION_LABELS;
  process.env.EXCLUDE_ACTION_LABELS = "Server entry";
  const servers = [];
  t.mock.method(console, "error", () => {}); // the error handler logs every documented error case
  t.after(async () => {
    for (const entry of servers) await entry.close();
    if (previousExclusions === undefined) delete process.env.EXCLUDE_ACTION_LABELS; else process.env.EXCLUDE_ACTION_LABELS = previousExclusions;
    await removeTemp(tempRoot);
  });

  // A project root of its own: the real spec, plus local journeys and reports.
  await fs.mkdir(path.join(tempRoot, "docs"), { recursive: true });
  await fs.copyFile(specFile, path.join(tempRoot, "docs", "openapi.json"));
  await fs.mkdir(path.join(tempRoot, "journeys"), { recursive: true });
  await fs.writeFile(path.join(tempRoot, "journeys", "example-sandbox.json"), JSON.stringify(VALID_JOURNEY));
  await fs.writeFile(path.join(tempRoot, "journeys", "invalid.json"), JSON.stringify(INVALID_JOURNEY));
  for (const report of syntheticReports()) {
    await fs.mkdir(path.join(reportsDir, report.id, "evidence", "baselines"), { recursive: true });
    await fs.writeFile(path.join(reportsDir, report.id, "vpat_draft.json"), JSON.stringify(report));
  }
  await fs.writeFile(path.join(reportsDir, CURRENT, "evidence", "001-image-alt.png"), PNG);
  await fs.writeFile(path.join(reportsDir, CURRENT, "evidence", "baselines", "001-home.png"), PNG);

  const base = getConfig();
  const config = { ...base, rootDir: tempRoot, reportsDir, openAiApiKey: "", browserChannel: "bundled", excludeActionLabels: ["Server entry"], nvda: { ...base.nvda, mode: "during-crawl" } };
  const scanOutcomes = [];
  const runnerCalls = { scan: 0, journey: 0 };
  const scanRunner = async (_config, onEvent) => {
    runnerCalls.scan += 1;
    onEvent({ at: new Date().toISOString(), type: "progress", message: "Synthetic page scanned", url: "https://stub.example.test/", current: 1, total: 2 });
    return (scanOutcomes.shift() || (() => ({ id: "stub-complete", targetUrl: "https://stub.example.test/", status: "complete", pages: [], issues: [] })))();
  };
  const journeyRunner = async () => { runnerCalls.journey += 1; return { id: "journey-stub", status: "complete" }; };
  const app = createDashboardApp({ config, jobs: new Map(), scanRunner, journeyRunner, nvdaCapability: STUB_NVDA, allowedHosts: "" });
  const main = await listen(app);
  servers.push(main);
  const call = (method, urlPath, options) => send(main.port, method, urlPath, options);

  const verified = new Set();
  // Asserts one response against the documented operation and returns the parsed body.
  function expectDocumented(response, method, specPath, status, { example, examplePattern } = {}) {
    const operation = spec.paths[specPath]?.[method.toLowerCase()];
    assert.ok(operation, `${method} ${specPath} is not documented`);
    const label = `${method} ${specPath} -> ${response.status}`;
    assert.equal(response.status, status, `${label}: expected ${status}. Body: ${response.text.slice(0, 400)}`);
    const documented = deref(operation.responses[String(status)]);
    assert.ok(documented, `${method} ${specPath} does not document status ${status}`);
    verified.add(`${method} ${specPath} ${status}`);
    const content = documented.content || {};
    const contentType = String(response.headers["content-type"] || "").split(";")[0].trim();
    if (!Object.keys(content).length) return undefined;
    const media = content[contentType];
    assert.ok(media, `${label}: Content-Type ${contentType || "(none)"} is not documented (${Object.keys(content).join(", ")})`);
    let body = response.text;
    if (JSON_MEDIA.test(contentType)) {
      body = JSON.parse(response.text);
      const errors = schemaErrors(media.schema, body, `${label} body`);
      assert.deepEqual(errors, [], `\n${errors.slice(0, 40).join("\n")}`);
    }
    if (example) {
      const entry = exampleEntries(media).find(([name]) => name === example);
      assert.ok(entry, `${label}: no documented example named ${example}`);
      assert.deepEqual(body, entry[1], `${label}: body differs from documented example ${example}`);
    }
    if (examplePattern) assert.match(typeof body === "string" ? body : body.error, examplePattern, label);
    return body;
  }
  const json = (body, headers = {}) => ({ body, headers });
  const requestExample = (specPath, method, name) => {
    const media = deref(spec.paths[specPath][method].requestBody).content["application/json"];
    return structuredClone(exampleEntries(media).find(([entry]) => entry === name)[1]);
  };
  const reportPath = (suffix = "", id = CURRENT) => `/api/reports/${id}${suffix}`;
  const ENOENT = /^ENOENT: no such file or directory, realpath '.+'$/;

  await t.test("local request guard, body parser and unmatched routes", async () => {
    expectDocumented(await call("GET", "/api/health", { headers: { Host: "untrusted.example" } }), "GET", "/api/health", 421, { example: "example" });
    expectDocumented(await call("POST", "/api/scans", { ...json({ targetUrl: `${ORIGIN}/` }), headers: { Origin: "https://untrusted.example" } }), "POST", "/api/scans", 403, { example: "example" });
    expectDocumented(await call("POST", "/api/scans", { body: JSON.stringify({ targetUrl: "x".repeat(1_100_000) }) }), "POST", "/api/scans", 413, { example: "example" });
    expectDocumented(await call("POST", "/api/scans", { body: "{}", headers: { "Content-Type": "application/json; charset=latin1" } }), "POST", "/api/scans", 415, { example: "charset" });
    expectDocumented(await call("POST", "/api/scans", { body: "{}", headers: { "Content-Encoding": "br2" } }), "POST", "/api/scans", 415, { example: "encoding" });
    expectDocumented(await call("POST", "/api/scans", { body: "{" }), "POST", "/api/scans", 400, { example: "invalidJson" });
    const unmatched = await call("GET", "/api/scans");
    assert.equal(unmatched.status, 404);
    assert.match(unmatched.headers["content-type"], /^text\/html/);
    assert.match(unmatched.text, /Cannot GET \/api\/scans/);
    // Documented exception: Express answers OPTIONS on a routed path itself.
    const options = await call("OPTIONS", "/api/scans");
    assert.deepEqual([options.status, options.headers.allow, options.text], [200, "POST", "POST"]);
    assert.match(options.headers["content-type"], /^text\/plain/);
    assert.equal(runnerCalls.scan, 0);
  });

  await t.test("health", async () => {
    const health = expectDocumented(await call("GET", "/api/health"), "GET", "/api/health", 200);
    assert.deepEqual(health.actionExclusions, { serverEntries: ["Server entry"] });
    assert.equal(health.nvda.reason, "OpenAPI contract test fixture");
  });

  await t.test("documentation routes", async () => {
    const document = expectDocumented(await call("GET", "/api/openapi.json"), "GET", "/api/openapi.json", 200);
    assert.deepEqual(document, spec);
    const page = expectDocumented(await call("GET", "/api-docs"), "GET", "/api-docs", 200);
    assert.match(page, /id="swagger-ui"/);
    assert.match(page, /url: "\/api\/openapi\.json"/);
    const emptyRoot = await fs.mkdtemp(path.join(tempRoot, "empty-root-"));
    const bare = await listen(createDashboardApp({ config: { ...config, rootDir: emptyRoot }, jobs: new Map(), scanRunner, journeyRunner, nvdaCapability: STUB_NVDA, allowedHosts: "" }));
    servers.push(bare);
    expectDocumented(await send(bare.port, "GET", "/api/openapi.json"), "GET", "/api/openapi.json", 404, { example: "missing" });
  });

  await t.test("scans and jobs", async () => {
    const invalid = {
      notObject: [], invalidUrl: { targetUrl: "file:///private" }, authNotObject: { targetUrl: `${ORIGIN}/`, auth: "yes" },
      screenReadersNotObject: { targetUrl: `${ORIGIN}/`, screenReaders: true }, auditNotObject: { targetUrl: `${ORIGIN}/`, audit: [] },
      auditProfile: { targetUrl: `${ORIGIN}/`, audit: { profile: "legal" } }, wcagVersion: { targetUrl: `${ORIGIN}/`, audit: { wcagVersion: 2.2 } },
      auditLevel: { targetUrl: `${ORIGIN}/`, audit: { level: "AAA" } }, device: { targetUrl: `${ORIGIN}/`, device: "tablet" },
      nvdaMobile: { targetUrl: `${ORIGIN}/`, device: "mobile", screenReaders: { nvda: true } }, exclusionsType: { targetUrl: `${ORIGIN}/`, excludeActionLabels: 5 },
      exclusionItem: { targetUrl: `${ORIGIN}/`, excludeActionLabels: ["Delete", 7] },
      exclusionsCount: { targetUrl: `${ORIGIN}/`, excludeActionLabels: Array.from({ length: 101 }, (_, index) => `Entry ${index}`) },
      exclusionLength: { targetUrl: `${ORIGIN}/`, excludeActionLabels: ["x".repeat(2049)] },
      exclusionsMerged: { targetUrl: `${ORIGIN}/`, excludeActionLabels: Array.from({ length: 100 }, (_, index) => `Entry ${index}`) },
      loginUrl: { targetUrl: `${ORIGIN}/`, auth: { enabled: true, loginUrl: "ftp://app.example.test/login" } },
      credentials: { targetUrl: `${ORIGIN}/`, auth: { enabled: true, loginUrl: `${ORIGIN}/login`, username: "  ", password: "secret" } }
    };
    const documented400 = deref(spec.paths["/api/scans"].post.responses["400"]).content["application/json"].examples;
    for (const name of Object.keys(documented400)) if (name !== "invalidJson") assert.ok(invalid[name], `no request triggers the documented example ${name}`);
    for (const [name, body] of Object.entries(invalid)) expectDocumented(await call("POST", "/api/scans", json(body)), "POST", "/api/scans", 400, { example: name });
    expectDocumented(await call("POST", "/api/scans", { body: '{"targetUrl":"https://app.example.test/"}', headers: { "Content-Type": "text/plain" } }), "POST", "/api/scans", 400, { example: "notObject" });
    assert.equal(runnerCalls.scan, 0, "a rejected scan request must not start the runner");

    scanOutcomes.push(
      () => ({ id: "stub-stopped", status: "stopped", pages: [], stopReason: { code: "TEST_BROWSER_CLOSED", message: "Test browser closed" }, stoppedAt: new Date().toISOString() }),
      () => { throw Object.assign(new Error("Synthetic launch failure"), { code: "BROWSER_LAUNCH_FAILED" }); }
    );
    const jobs = [];
    for (const name of ["minimal", "dashboardWithLogin", "financialMobile"]) {
      const job = expectDocumented(await call("POST", "/api/scans", json(requestExample("/api/scans", "post", name))), "POST", "/api/scans", 202);
      assert.equal(job.status, "queued");
      jobs.push(job.id);
    }
    const finals = [];
    for (const id of jobs) {
      let job;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        job = expectDocumented(await call("GET", `/api/jobs/${id}`), "GET", "/api/jobs/{id}", 200);
        if (!["queued", "running"].includes(job.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      finals.push(job.status);
      assert.doesNotMatch(JSON.stringify(job), /REPLACE_LOCALLY/, "credentials never appear in a job");
    }
    assert.deepEqual(finals, ["stopped", "failed", "complete"]);
    expectDocumented(await call("GET", "/api/jobs/job-unknown-0000"), "GET", "/api/jobs/{id}", 404, { example: "jobNotFound" });
  });

  await t.test("reports, sections, exports, comparison and VPAT", async () => {
    const listing = expectDocumented(await call("GET", "/api/reports"), "GET", "/api/reports", 200);
    assert.deepEqual(listing.map((entry) => entry.id), [CURRENT, RUNNING, OTHER_SITE, PREVIOUS]);
    assert.equal(listing.find((entry) => entry.id === RUNNING).status, "interrupted");

    const report = expectDocumented(await call("GET", reportPath()), "GET", "/api/reports/{id}", 200);
    assert.equal(report.audit.criteria.length, 55);
    assert.equal(report.audit.vpatRows.length, 84);
    expectDocumented(await call("GET", reportPath("", "bad.id")), "GET", "/api/reports/{id}", 400, { example: "invalidId" });
    expectDocumented(await call("GET", reportPath("", "missing-report")), "GET", "/api/reports/{id}", 404, { examplePattern: ENOENT });

    const sections = ["overview", "score", "issues", "pages", "graph", "activity", "acr", "audit", "financial", "reviews", "evidence", "assistive-technology"];
    for (const section of sections) {
      expectDocumented(await call("GET", reportPath(`/${section}`)), "GET", `/api/reports/{id}/${section}`, 200);
      expectDocumented(await call("GET", reportPath(`/${section}`, "missing-report")), "GET", `/api/reports/{id}/${section}`, 404, { examplePattern: ENOENT });
    }
    assert.equal(expectDocumented(await call("GET", reportPath("/financial", PREVIOUS)), "GET", "/api/reports/{id}/financial", 200), null, "general-profile reports have no financial section");
    const evidence = expectDocumented(await call("GET", reportPath("/evidence")), "GET", "/api/reports/{id}/evidence", 200);
    assert.equal(evidence.items[0].evidenceUrl, `/reports/${CURRENT}/evidence/001-image-alt.png`);
    // Not a documented path: the generic route's own 404, described on each section operation.
    const unknownSection = await call("GET", reportPath("/unknown-section", "bad.id"));
    assert.equal(unknownSection.status, 404);
    assert.deepEqual(JSON.parse(unknownSection.text), { error: "Unknown report section." });
    for (const section of sections) {
      const examples = deref(spec.paths[`/api/reports/{id}/${section}`].get.responses["404"]).content["application/json"].examples;
      assert.ok(!Object.values(examples).some((entry) => entry.value.error === "Unknown report section."), `${section}: that 404 cannot occur for a documented section path`);
    }

    for (const [format, type] of [["json", "application/json"], ["csv", "text/csv"], ["html", "text/html"]]) {
      const response = await call("GET", reportPath(`/exports/${format}`));
      expectDocumented(response, "GET", "/api/reports/{id}/exports/{format}", 200);
      assert.match(response.headers["content-type"], new RegExp(`^${type}`));
      assert.equal(response.headers["content-disposition"], `attachment; filename="accessibility-draft-${CURRENT}.${format}"`);
    }
    expectDocumented(await call("GET", reportPath("/exports/pdf")), "GET", "/api/reports/{id}/exports/{format}", 404, { example: "unknownFormat" });
    expectDocumented(await call("GET", reportPath("/exports/pdf", "missing-report")), "GET", "/api/reports/{id}/exports/{format}", 404, { examplePattern: ENOENT });

    const comparison = expectDocumented(await call("GET", reportPath(`/compare/${PREVIOUS}`)), "GET", "/api/reports/{id}/compare/{previousId}", 200);
    // i-1 persists, i-old (previous only) is fixed, i-2 is new on the covered /about page.
    assert.deepEqual(comparison.counts, { new: 1, fixed: 1, unresolved: 1 });
    expectDocumented(await call("GET", reportPath(`/compare/${OTHER_SITE}`)), "GET", "/api/reports/{id}/compare/{previousId}", 409, { example: "crossSite" });
    expectDocumented(await call("GET", reportPath(`/compare/${CURRENT}`, PREVIOUS)), "GET", "/api/reports/{id}/compare/{previousId}", 400, { example: "notOlder" });
    expectDocumented(await call("GET", reportPath(`/compare/${CURRENT}`)), "GET", "/api/reports/{id}/compare/{previousId}", 400, { example: "notCompleted" });
    expectDocumented(await call("GET", reportPath(`/compare/${PREVIOUS}`, RUNNING)), "GET", "/api/reports/{id}/compare/{previousId}", 400, { example: "notCompleted" });

    assert.deepEqual(expectDocumented(await call("GET", reportPath("/vpat-profile")), "GET", "/api/reports/{id}/vpat-profile", 200), {});
    expectDocumented(await call("GET", reportPath("/vpat-profile", "missing-report")), "GET", "/api/reports/{id}/vpat-profile", 404, { examplePattern: ENOENT });
    const profile = expectDocumented(await call("POST", reportPath("/vpat-profile"), json(requestExample("/api/reports/{id}/vpat-profile", "post", "example"))), "POST", "/api/reports/{id}/vpat-profile", 200);
    assert.equal(profile.notes, "");
    expectDocumented(await call("GET", reportPath("/vpat-profile")), "GET", "/api/reports/{id}/vpat-profile", 200);
    expectDocumented(await call("POST", reportPath("/vpat-profile"), { body: "productName=x", headers: { "Content-Type": "application/x-www-form-urlencoded" } }), "POST", "/api/reports/{id}/vpat-profile", 400, { example: "required" });
    expectDocumented(await call("POST", reportPath("/vpat-profile"), json({ productVersion: "v".repeat(101) })), "POST", "/api/reports/{id}/vpat-profile", 400, { example: "tooLong" });
    expectDocumented(await call("POST", reportPath("/vpat-profile"), json({ reportDate: "15/10/2026" })), "POST", "/api/reports/{id}/vpat-profile", 400, { example: "date" });
    expectDocumented(await call("POST", reportPath("/vpat-profile", "bad.id"), json({})), "POST", "/api/reports/{id}/vpat-profile", 400, { example: "invalidId" });
    expectDocumented(await call("POST", reportPath("/vpat-profile", "missing-report"), json({})), "POST", "/api/reports/{id}/vpat-profile", 404, { examplePattern: ENOENT });
    expectDocumented(await call("POST", reportPath("/vpat-profile"), { body: "{" }), "POST", "/api/reports/{id}/vpat-profile", 400, { example: "invalidJson" });

    const html = await call("GET", reportPath("/vpat/wcag/html"));
    assert.match(expectDocumented(html, "GET", "/api/reports/{id}/vpat/{edition}/{format}", 200), /Fixture Portal Accessibility Conformance Report/);
    assert.equal(html.headers["content-disposition"], `attachment; filename="VPAT-2.5-WCAG-${CURRENT}-DRAFT.html"`);
    const docx = await call("GET", reportPath("/vpat/508/docx"));
    expectDocumented(docx, "GET", "/api/reports/{id}/vpat/{edition}/{format}", 200);
    assert.equal(docx.buffer.subarray(0, 2).toString(), "PK");
    expectDocumented(await call("GET", reportPath("/vpat/fake/html", "missing-report")), "GET", "/api/reports/{id}/vpat/{edition}/{format}", 404, { example: "unknownEditionOrFormat" });
    expectDocumented(await call("GET", reportPath("/vpat/wcag/pdf")), "GET", "/api/reports/{id}/vpat/{edition}/{format}", 404, { example: "unknownEditionOrFormat" });
    expectDocumented(await call("GET", reportPath("/vpat/int/html", "missing-report")), "GET", "/api/reports/{id}/vpat/{edition}/{format}", 404, { examplePattern: ENOENT });
    expectDocumented(await call("GET", reportPath("/vpat/constructor/html")), "GET", "/api/reports/{id}/vpat/{edition}/{format}", 500, { example: "prototypeEdition" });
  });

  await t.test("manual review decisions", async () => {
    const valid = (overrides = {}) => ({ kind: "check", targetId: "keyboard-workflows", status: "pass", reviewer: "A. Reviewer", notes: "Checked.", scope: "Chrome / Windows", evidence: ["TC-1"], ...overrides });
    const execution = { environment: "sandbox", applicationVersion: "4.2.0", browser: "Chrome / Windows", assistiveTechnology: "NVDA", authorizationRef: "CHG-1" };
    const step = (overrides = {}) => valid({ kind: "financial-step", targetId: "account-change", status: "blocked", execution, ...overrides });
    const invalid = {
      noObject: [], kind: valid({ kind: "page" }), target: valid({ targetId: "   " }), targetNotFound: valid({ targetId: "no-such-check" }),
      status: valid({ status: "Supports" }), criterionConflict: valid({ kind: "criterion", targetId: "1.1.1", status: "Supports" }),
      evidenceCount: valid({ evidence: [] }), reviewer: valid({ reviewer: "" }), notes: valid({ notes: 5 }), scope: valid({ scope: "s".repeat(4001) }),
      evidenceItem: valid({ evidence: ["ok", "  "] }), executionMissing: step({ execution: undefined }), environment: step({ execution: { ...execution, environment: "production" } }),
      sandboxRequired: step({ status: "pass", execution: { ...execution, environment: "production-read-only" } }),
      executionField: step({ execution: { ...execution, applicationVersion: "" } }), findingIdsShape: step({ findingIds: "i-1" }),
      findingIdsForeign: step({ findingIds: ["not-in-report"] }), findingIdsConfirmed: step({ status: "pass", findingIds: ["i-1"] })
    };
    const documented400 = deref(spec.paths["/api/reports/{id}/reviews"].post.responses["400"]).content["application/json"].examples;
    const runtimeUntestable = new Set(["invalidDirectory", "invalidFile"]); // need links that resolve outside reports/
    for (const name of Object.keys(documented400)) if (!["invalidId", "invalidJson"].includes(name) && !runtimeUntestable.has(name)) assert.ok(invalid[name], `no request triggers the documented example ${name}`);
    for (const [name, body] of Object.entries(invalid)) expectDocumented(await call("POST", reportPath("/reviews"), json(body)), "POST", "/api/reports/{id}/reviews", 400, { example: name });
    expectDocumented(await call("POST", reportPath("/reviews"), { body: JSON.stringify(valid()), headers: { "Content-Type": "text/plain" } }), "POST", "/api/reports/{id}/reviews", 400, { example: "noObject" });
    expectDocumented(await call("POST", reportPath("/reviews", "bad.id"), json(valid())), "POST", "/api/reports/{id}/reviews", 400, { example: "invalidId" });
    expectDocumented(await call("POST", reportPath("/reviews"), { body: "{" }), "POST", "/api/reports/{id}/reviews", 400, { example: "invalidJson" });
    expectDocumented(await call("POST", reportPath("/reviews", "missing-report"), json(valid())), "POST", "/api/reports/{id}/reviews", 404, { examplePattern: ENOENT });
    assert.deepEqual(expectDocumented(await call("GET", reportPath("/reviews")), "GET", "/api/reports/{id}/reviews", 200), []);

    const names = ["criterion", "check", "financialStep", "vpatRow", "complianceItem"];
    let report;
    for (const name of names) report = expectDocumented(await call("POST", reportPath("/reviews"), json(requestExample("/api/reports/{id}/reviews", "post", name))), "POST", "/api/reports/{id}/reviews", 201);
    assert.equal(report.auditReviews.length, names.length);
    const history = expectDocumented(await call("GET", reportPath("/reviews")), "GET", "/api/reports/{id}/reviews", 200);
    assert.deepEqual(history.map((entry) => entry.kind), ["criterion", "check", "financial-step", "vpat-row", "compliance-item"]);
    expectDocumented(await call("GET", reportPath("/audit")), "GET", "/api/reports/{id}/audit", 200);
    expectDocumented(await call("GET", reportPath("/financial")), "GET", "/api/reports/{id}/financial", 200);
  });

  await t.test("compliance checklists", async () => {
    const catalog = expectDocumented(await call("GET", "/api/compliance/sets"), "GET", "/api/compliance/sets", 200);
    assert.deepEqual(catalog.sets.map((set) => set.id), ["gigw-3.0", "sebi-digital-accessibility"]);
    for (const name of ["jsonItems", "csvText"]) expectDocumented(await call("POST", "/api/compliance/sets", json(requestExample("/api/compliance/sets", "post", name))), "POST", "/api/compliance/sets", 201);
    const item = { reference: "R1", requirement: "Provide text alternatives." };
    const invalid = {
      id: { id: "x", title: "T", items: [item] }, builtIn: { id: "gigw-3.0", title: "T", items: [item] }, title: { id: "custom", title: " ", items: [item] },
      noItems: { id: "custom", title: "T", items: [] }, tooMany: { id: "custom", title: "T", items: Array.from({ length: 1001 }, () => item) },
      item: { id: "custom", title: "T", items: [{ reference: "R1" }] }, csvHeader: { id: "custom", title: "T", format: "csv", csv: "ref,req\nR1,Text" },
      invalidJson: "{"
    };
    for (const [name, body] of Object.entries(invalid)) expectDocumented(await call("POST", "/api/compliance/sets", typeof body === "string" ? { body } : json(body)), "POST", "/api/compliance/sets", 400, { example: name });
    expectDocumented(await call("POST", "/api/compliance/sets", { body: "id=x", headers: { "Content-Type": "application/x-www-form-urlencoded" } }), "POST", "/api/compliance/sets", 400, { example: "required" });
    expectDocumented(await call("POST", "/api/compliance/sets", json([])), "POST", "/api/compliance/sets", 400, { example: "id" });
    expectDocumented(await call("POST", "/api/compliance/sets", json({ id: "custom", title: "T", items: ["text item"] })), "POST", "/api/compliance/sets", 400, { example: "item" });
    expectDocumented(await call("POST", "/api/compliance/sets", json({ id: "custom", title: "T", items: [null] })), "POST", "/api/compliance/sets", 500, { example: "nullItem" });
    const updated = expectDocumented(await call("GET", "/api/compliance/sets"), "GET", "/api/compliance/sets", 200);
    assert.equal(updated.sets.find((set) => set.id === "csv-set").builtIn, false);

    const view = expectDocumented(await call("GET", reportPath("/compliance")), "GET", "/api/reports/{id}/compliance", 200);
    assert.equal(view.sets.find((set) => set.id === "gigw-3.0").items.find((entry) => entry.id === "3-3-1").status, "met");
    expectDocumented(await call("GET", reportPath("/compliance", "missing-report")), "GET", "/api/reports/{id}/compliance", 404, { examplePattern: ENOENT });
    const csv = await call("GET", reportPath("/compliance/export.csv"));
    assert.ok(expectDocumented(csv, "GET", "/api/reports/{id}/compliance/export.csv", 200).startsWith("﻿Checklist,Reference,Requirement"));
    assert.equal(csv.headers["content-disposition"], `attachment; filename="compliance-checklists-${CURRENT}.csv"`);
    expectDocumented(await call("GET", reportPath("/compliance/export.csv", "bad.id")), "GET", "/api/reports/{id}/compliance/export.csv", 400, { example: "invalidId" });

    // Documented caveat: a VPAT profile saved into reports/_compliance breaks the catalogue.
    expectDocumented(await call("POST", reportPath("/vpat-profile", "_compliance"), json({ productName: "x" })), "POST", "/api/reports/{id}/vpat-profile", 200);
    expectDocumented(await call("GET", "/api/compliance/sets"), "GET", "/api/compliance/sets", 500, { example: "example" });
    expectDocumented(await call("GET", reportPath("/compliance")), "GET", "/api/reports/{id}/compliance", 500, { example: "customSetWithoutItems" });
    expectDocumented(await call("GET", reportPath("/compliance/export.csv")), "GET", "/api/reports/{id}/compliance/export.csv", 500, { example: "customSetWithoutItems" });
    await fs.rm(path.join(reportsDir, "_compliance", "vpat-profile.json"));
    expectDocumented(await call("GET", "/api/compliance/sets"), "GET", "/api/compliance/sets", 200);
    expectDocumented(await call("GET", reportPath("/compliance")), "GET", "/api/reports/{id}/compliance", 200);
  });

  await t.test("remediation backlog", async () => {
    const empty = expectDocumented(await call("GET", `/api/backlog/${HOST.toUpperCase()}`), "GET", "/api/backlog/{host}", 200);
    assert.deepEqual([empty.host, empty.items.length], [HOST, 0]);
    expectDocumented(await call("GET", "/api/backlog/bad_host"), "GET", "/api/backlog/{host}", 400, { example: "invalidHost" });
    const emptyCsv = await call("GET", `/api/backlog/${HOST}/export.csv`);
    assert.equal(expectDocumented(emptyCsv, "GET", "/api/backlog/{host}/export.csv", 200), "Status,Issue,Rule,WCAG,Impact,Page,Element,Owner,Due,Latest scan,First seen,Last seen,Notes");
    const csvError = await call("GET", "/api/backlog/bad_host/export.csv");
    expectDocumented(csvError, "GET", "/api/backlog/{host}/export.csv", 400, { example: "example" });
    assert.equal(csvError.headers["content-disposition"], 'attachment; filename="remediation-backlog-bad_host.csv"');

    const syncBody = requestExample(`/api/backlog/{host}/sync`, "post", "example");
    assert.equal(syncBody.reportId, CURRENT);
    const first = expectDocumented(await call("POST", `/api/backlog/${HOST}/sync`, json(syncBody)), "POST", "/api/backlog/{host}/sync", 200);
    assert.deepEqual([first.added, first.alreadySynced], [2, false]);
    const second = expectDocumented(await call("POST", `/api/backlog/${HOST}/sync`, json(syncBody)), "POST", "/api/backlog/{host}/sync", 200);
    assert.equal(second.alreadySynced, true);
    expectDocumented(await call("POST", `/api/backlog/${HOST}/sync`, json({ reportId: OTHER_SITE })), "POST", "/api/backlog/{host}/sync", 409, { example: "differentSite" });
    expectDocumented(await call("POST", `/api/backlog/${HOST}/sync`, json({ reportId: RUNNING })), "POST", "/api/backlog/{host}/sync", 409, { example: "notComplete" });
    expectDocumented(await call("POST", `/api/backlog/${HOST}/sync`), "POST", "/api/backlog/{host}/sync", 400, { example: "invalidId" });
    expectDocumented(await call("POST", `/api/backlog/${HOST}/sync`, { body: "{" }), "POST", "/api/backlog/{host}/sync", 400, { example: "invalidJson" });
    expectDocumented(await call("POST", `/api/backlog/${HOST}/sync`, json({ reportId: "missing-report" })), "POST", "/api/backlog/{host}/sync", 404, { examplePattern: ENOENT });

    const trackBody = requestExample(`/api/backlog/{host}/track`, "post", "example");
    const tracked = expectDocumented(await call("POST", `/api/backlog/${HOST}/track`, json(trackBody)), "POST", "/api/backlog/{host}/track", 201);
    assert.equal(tracked.category, "needs-review");
    expectDocumented(await call("POST", `/api/backlog/${HOST}/track`, json({ reportId: CURRENT, findingId: "nope" })), "POST", "/api/backlog/{host}/track", 400, { example: "foreignFinding" });
    expectDocumented(await call("POST", `/api/backlog/${HOST}/track`, json({ reportId: OTHER_SITE, findingId: "i-1" })), "POST", "/api/backlog/{host}/track", 409, { example: "differentSite" });
    expectDocumented(await call("POST", `/api/backlog/${HOST}/track`, json({ reportId: "missing-report", findingId: "i-1" })), "POST", "/api/backlog/{host}/track", 404, { examplePattern: ENOENT });

    const backlog = expectDocumented(await call("GET", `/api/backlog/${HOST}`), "GET", "/api/backlog/{host}", 200);
    assert.equal(backlog.items.length, 3);
    const confirmed = backlog.items.find((entry) => entry.ruleId === "image-alt");
    const itemPath = `/api/backlog/${HOST}/items/${confirmed.key}`;
    const patched = expectDocumented(await call("PATCH", itemPath, json(requestExample("/api/backlog/{host}/items/{key}", "patch", "example"))), "PATCH", "/api/backlog/{host}/items/{key}", 200);
    assert.deepEqual([patched.status, patched.dueDate], ["in-progress", "2026-12-31"]);
    const invalid = { noObject: [], status: { status: "done" }, stillPresent: { status: "verified" }, dueDate: { dueDate: "31/12/2026" }, invalidJson: "{" };
    for (const [name, body] of Object.entries(invalid)) expectDocumented(await call("PATCH", itemPath, typeof body === "string" ? { body } : json(body)), "PATCH", "/api/backlog/{host}/items/{key}", 400, { example: name });
    expectDocumented(await call("PATCH", `/api/backlog/bad_host/items/${confirmed.key}`, json({ owner: "x" })), "PATCH", "/api/backlog/{host}/items/{key}", 400, { example: "invalidHost" });
    expectDocumented(await call("PATCH", `/api/backlog/${HOST}/items/0000000000000000`, json({ owner: "x" })), "PATCH", "/api/backlog/{host}/items/{key}", 404, { example: "itemNotFound" });
    const csv = expectDocumented(await call("GET", `/api/backlog/${HOST}/export.csv`), "GET", "/api/backlog/{host}/export.csv", 200);
    assert.equal(csv.split("\r\n").length, 4);
  });

  await t.test("journeys", async () => {
    const journeys = expectDocumented(await call("GET", "/api/journeys"), "GET", "/api/journeys", 200);
    assert.deepEqual(journeys.map((entry) => [entry.file, entry.valid]).sort(), [["example-sandbox.json", true], ["invalid.json", false]]);
    const job = expectDocumented(await call("POST", "/api/journeys/run", json(requestExample("/api/journeys/run", "post", "example"))), "POST", "/api/journeys/run", 202);
    assert.equal(job.status, "running");
    let final;
    for (let attempt = 0; attempt < 100 && (!final || final.status === "running"); attempt += 1) {
      final = expectDocumented(await call("GET", `/api/jobs/${job.id}`), "GET", "/api/jobs/{id}", 200);
      if (final.status === "running") await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(final.status, "complete");
    const before = runnerCalls.journey;
    const invalid = {
      fileName: { file: "../outside.json" }, invalidJourney: { file: "invalid.json" },
      exclusionsType: { file: "example-sandbox.json", excludeActionLabels: 5 },
      exclusionsCount: { file: "example-sandbox.json", excludeActionLabels: Array.from({ length: 100 }, (_, index) => `Entry ${index}`) },
      invalidJson: "{"
    };
    for (const [name, body] of Object.entries(invalid)) expectDocumented(await call("POST", "/api/journeys/run", typeof body === "string" ? { body } : json(body)), "POST", "/api/journeys/run", 400, { example: name });
    expectDocumented(await call("POST", "/api/journeys/run", json({ file: "missing.json" })), "POST", "/api/journeys/run", 404, { example: "notFound" });
    assert.equal(runnerCalls.journey, before, "a rejected journey request must not start the runner");
  });

  await t.test("static report files", async () => {
    const image = await call("GET", `/reports/${CURRENT}/evidence/001-image-alt.png`);
    expectDocumented(image, "GET", "/reports/{reportId}/{filePath}", 200);
    assert.deepEqual(image.buffer, PNG);
    const raw = expectDocumented(await call("GET", `/reports/${CURRENT}/vpat_draft.json`), "GET", "/reports/{reportId}/{filePath}", 200);
    assert.equal(raw.audit, undefined, "static files are served without API processing");
    const redirect = await call("GET", `/reports/${CURRENT}`);
    expectDocumented(redirect, "GET", "/reports/{reportId}/{filePath}", 301);
    assert.equal(redirect.headers.location, `/reports/${CURRENT}/`);
    const missing = expectDocumented(await call("GET", `/reports/${CURRENT}/missing.json`), "GET", "/reports/{reportId}/{filePath}", 404);
    assert.match(missing, new RegExp(`Cannot GET /reports/${CURRENT}/missing\\.json`));
  });

  await t.test("every documented operation was exercised with a 2xx response", () => {
    const missing = operations.filter(({ method, route, operation }) => !Object.keys(operation.responses).some((status) => /^2/.test(status) && verified.has(`${method.toUpperCase()} ${route} ${status}`)));
    assert.deepEqual(missing.map((entry) => entry.name), []);
  });
});
