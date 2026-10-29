// Validates docs/openapi.json without extra dependencies:
//   1. OpenAPI 3.0.3 structure: $refs resolve, operationIds are unique, tags are
//      declared, path parameters match the path templates, 3.1-only keywords are absent.
//   2. Every example is valid against its schema (OpenAPI 3.0 schema subset).
//   3. Route parity: every Express route registered by createDashboardApp() is
//      documented, and every documented operation exists (no port is opened).
// Usage: npm run test:openapi
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(await fs.readFile(path.join(root, "docs", "openapi.json"), "utf8"));
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const errors = [];
const fail = (where, message) => errors.push(`${where}: ${message}`);
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const FORBIDDEN_SCHEMA_KEYS = ["const", "examples", "prefixItems", "$schema", "if", "then", "else", "unevaluatedProperties", "dependentRequired", "contentMediaType"];

function resolve(ref) {
  if (!ref.startsWith("#/")) return undefined;
  return ref.slice(2).split("/").reduce((node, key) => node?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], spec);
}

// ---- 1. structure
if (spec.openapi !== "3.0.3") fail("openapi", `expected 3.0.3, found ${spec.openapi}`);
if (!spec.info?.title || !spec.info?.version) fail("info", "title and version are required");
if (spec.info?.version !== pkg.version) fail("info.version", `${spec.info?.version} differs from package.json ${pkg.version}`);
if (!Array.isArray(spec.servers) || !spec.servers.length) fail("servers", "at least one server is expected");

(function walkRefs(node, where) {
  if (Array.isArray(node)) return node.forEach((item, index) => walkRefs(item, `${where}[${index}]`));
  if (!node || typeof node !== "object") return;
  if (typeof node.$ref === "string") {
    if (resolve(node.$ref) === undefined) fail(where, `unresolved $ref ${node.$ref}`);
    if (Object.keys(node).length > 1) fail(where, "$ref has sibling keys, which OpenAPI 3.0 ignores");
  }
  for (const [key, value] of Object.entries(node)) walkRefs(value, `${where}/${key}`);
})(spec, "#");

const declaredTags = new Set((spec.tags || []).map((tag) => tag.name));
const operationIds = new Set();
const operations = [];
for (const [route, item] of Object.entries(spec.paths || {})) {
  if (!route.startsWith("/")) fail(route, "path must start with /");
  const templateParams = [...route.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  for (const method of METHODS.filter((name) => item[name])) {
    const operation = item[method];
    const where = `${method.toUpperCase()} ${route}`;
    operations.push({ method, route, operation, where });
    if (!operation.operationId) fail(where, "operationId is missing");
    else if (operationIds.has(operation.operationId)) fail(where, `duplicate operationId ${operation.operationId}`);
    operationIds.add(operation.operationId);
    if (!operation.summary || !operation.description) fail(where, "summary and description are expected");
    for (const tag of operation.tags || []) if (!declaredTags.has(tag)) fail(where, `tag "${tag}" is not declared`);
    const parameters = [...(item.parameters || []), ...(operation.parameters || [])].map((parameter) => (parameter.$ref ? resolve(parameter.$ref) : parameter));
    const pathParams = parameters.filter((parameter) => parameter?.in === "path");
    for (const name of templateParams) {
      const parameter = pathParams.find((entry) => entry.name === name);
      if (!parameter) fail(where, `path parameter {${name}} is not declared`);
      else if (parameter.required !== true) fail(where, `path parameter {${name}} must be required`);
    }
    for (const parameter of pathParams) if (!templateParams.includes(parameter.name)) fail(where, `path parameter "${parameter.name}" is not in the path`);
    const responses = Object.entries(operation.responses || {});
    if (!responses.length) fail(where, "responses are missing");
    if (!responses.some(([status]) => /^2\d\d$/.test(status))) fail(where, "no 2xx response");
    for (const [status, response] of responses) {
      const resolved = response.$ref ? resolve(response.$ref) : response;
      if (!resolved?.description) fail(`${where} ${status}`, "response description is missing");
    }
  }
}

// ---- 2. schemas and examples
const typeOf = (value) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function check(schema, value, where, out) {
  if (!schema || typeof schema !== "object") return;
  if (schema.$ref) return check(resolve(schema.$ref), value, where, out);
  if (value === null) {
    if (schema.nullable === true) return;
    if (schema.type) return out.push(`${where}: null is not allowed (add nullable)`);
  }
  if (schema.enum && !schema.enum.some((option) => deepEqual(option, value))) out.push(`${where}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  if (schema.type && value !== null) {
    const actual = typeOf(value);
    const ok = schema.type === "integer" ? Number.isInteger(value) : schema.type === "number" ? actual === "number" : actual === schema.type;
    if (!ok) return out.push(`${where}: expected ${schema.type}, found ${actual}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${where}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${where}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) out.push(`${where}: does not match ${schema.pattern}`);
    if (schema.format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value)))) out.push(`${where}: not an RFC 3339 date-time`);
    if (schema.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) out.push(`${where}: not a UUID`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${where}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${where}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${where}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${where}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => check(schema.items, item, `${where}[${index}]`, out));
  }
  if (typeOf(value) === "object") {
    for (const key of schema.required || []) if (!(key in value)) out.push(`${where}: missing required "${key}"`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) check(schema.properties[key], item, `${where}.${key}`, out);
      else if (schema.additionalProperties === false && (schema.properties || schema.type === "object")) out.push(`${where}: unexpected property "${key}"`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") check(schema.additionalProperties, item, `${where}.${key}`, out);
    }
  }
  for (const part of schema.allOf || []) check(part, value, where, out);
  if (schema.anyOf && !schema.anyOf.some((part) => { const inner = []; check(part, value, where, inner); return !inner.length; })) out.push(`${where}: matches none of anyOf`);
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((part) => { const inner = []; check(part, value, where, inner); return !inner.length; }).length;
    if (matches !== 1) out.push(`${where}: matches ${matches} oneOf alternatives (expected exactly 1)`);
  }
}

const validateExample = (schema, value, where) => { const out = []; check(schema, value, where, out); errors.push(...out); };
let examplesChecked = 0;

function visitSchema(schema, where) {
  if (!schema || typeof schema !== "object" || schema.$ref) return;
  for (const key of FORBIDDEN_SCHEMA_KEYS) if (key in schema) fail(where, `"${key}" is not an OpenAPI 3.0 schema keyword`);
  if (Array.isArray(schema.type)) fail(where, "type arrays are not allowed in OpenAPI 3.0");
  if (schema.type === "null") fail(where, "type null is not allowed in OpenAPI 3.0");
  if (schema.nullable && !schema.type) fail(where, "nullable needs an explicit type in OpenAPI 3.0.3");
  if ("example" in schema) { validateExample(schema, schema.example, `${where} (example)`); examplesChecked += 1; }
  for (const [key, child] of Object.entries(schema.properties || {})) visitSchema(child, `${where}.${key}`);
  if (schema.items) visitSchema(schema.items, `${where}[]`);
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") visitSchema(schema.additionalProperties, `${where}{}`);
  for (const key of ["allOf", "oneOf", "anyOf"]) (schema[key] || []).forEach((child, index) => visitSchema(child, `${where}/${key}/${index}`));
}

function visitExamples(holder, where) {
  if (!holder?.schema) return;
  visitSchema(holder.schema, `${where} schema`);
  if ("example" in holder && holder.examples) fail(where, "example and examples are mutually exclusive");
  if ("example" in holder) { validateExample(holder.schema, holder.example, `${where} (example)`); examplesChecked += 1; }
  for (const [name, example] of Object.entries(holder.examples || {})) {
    const resolved = example.$ref ? resolve(example.$ref) : example;
    if (resolved && "value" in resolved) { validateExample(holder.schema, resolved.value, `${where} (examples.${name})`); examplesChecked += 1; }
  }
}

function visitResponse(response, where) {
  const resolved = response?.$ref ? resolve(response.$ref) : response;
  for (const [type, media] of Object.entries(resolved?.content || {})) visitExamples(media, `${where} ${type}`);
  for (const [name, header] of Object.entries(resolved?.headers || {})) visitExamples(header, `${where} header ${name}`);
}

for (const [name, schema] of Object.entries(spec.components?.schemas || {})) visitSchema(schema, `#/components/schemas/${name}`);
for (const [name, parameter] of Object.entries(spec.components?.parameters || {})) visitExamples(parameter, `#/components/parameters/${name}`);
for (const [name, response] of Object.entries(spec.components?.responses || {})) visitResponse(response, `#/components/responses/${name}`);
for (const { operation, where } of operations) {
  for (const parameter of operation.parameters || []) if (!parameter.$ref) visitExamples(parameter, `${where} parameter ${parameter.name}`);
  const body = operation.requestBody?.$ref ? resolve(operation.requestBody.$ref) : operation.requestBody;
  for (const [type, media] of Object.entries(body?.content || {})) visitExamples(media, `${where} requestBody ${type}`);
  for (const [status, response] of Object.entries(operation.responses || {})) visitResponse(response, `${where} ${status}`);
}

// ---- 3. route parity with the Express application
const { createDashboardApp } = await import(pathToFileURL(path.join(root, "src", "api", "app.js")).href);
const app = createDashboardApp({ jobs: new Map(), nvdaCapability: () => ({}), scanRunner: async () => ({}), journeyRunner: async () => ({}), allowedHosts: "" });
const registered = new Set();
(function collect(stack) {
  for (const layer of stack || []) {
    if (layer.route) for (const method of Object.keys(layer.route.methods)) { if (method !== "_all") registered.add(`${method.toUpperCase()} ${layer.route.path}`); }
    else if (layer.handle?.stack) collect(layer.handle.stack);
  }
})(app.router.stack);
const documented = new Set();
for (const { method, route, operation } of operations) {
  const express = operation["x-express-route"] || `${method.toUpperCase()} ${route.replace(/\{([^}]+)\}/g, ":$1")}`;
  if (!express.startsWith("STATIC ")) documented.add(express);
}
for (const route of registered) if (!documented.has(route)) fail("route parity", `${route} is registered in Express but not documented`);
for (const route of documented) if (!registered.has(route)) fail("route parity", `${route} is documented but not registered in Express`);

// ---- report
const operationCount = operations.length;
console.log(`OpenAPI ${spec.openapi} "${spec.info?.title}" ${spec.info?.version}`);
console.log(`${Object.keys(spec.paths || {}).length} paths, ${operationCount} operations, ${Object.keys(spec.components?.schemas || {}).length} schemas, ${examplesChecked} examples checked`);
console.log(`${registered.size} Express routes registered, ${documented.size} documented (static mounts excluded)`);
if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log("docs/openapi.json is valid.");
}
