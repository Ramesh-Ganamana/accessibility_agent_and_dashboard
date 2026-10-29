const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const svgNs = "http://www.w3.org/2000/svg";

function element(tag, className = "") { const node = document.createElement(tag); if (className) node.className = className; return node; }
function textElement(tag, text, className = "") { const node = element(tag, className); node.textContent = text; return node; }
function formatTarget(target) { return Array.isArray(target) ? target.flat(Infinity).join(" → ") : String(target || "Unknown node"); }
function countBy(items, key) { return items.reduce((result, item) => ({ ...result, [item[key]]: (result[item[key]] || 0) + 1 }), {}); }
function sum(pages, key) { return pages.reduce((total, page) => total + Number(page.technology?.[key] || 0), 0); }
function truncate(value, max) { return String(value).length > max ? `${String(value).slice(0, max - 1)}…` : String(value); }
function shortGraphId(value) { let hash = 2166136261; for (const char of String(value)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 10); }
function capitalize(value) { return value ? value[0].toUpperCase() + value.slice(1) : ""; }
// The crawler may store the session's {code, message} or a plain string.
function stopReasonText(value) { return typeof value === "string" ? value : value?.message || ""; }
function safeHostname(url) { try { return new URL(url).hostname; } catch { return url || "Unknown target"; } }
function shortPath(url) { try { const parsed = new URL(url); return parsed.pathname || "/"; } catch { return url; } }
function formatDuration(ms) { return ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.max(1, Math.round(ms / 1000))}s`; }
function formatElapsed(ms) { const seconds = Math.max(0, Math.floor(ms / 1000)); return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`; }
function formatDate(value) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "In progress"; }
function formatTime(value) { return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)); }
async function fetchJson(url) { const response = await fetch(url); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Request failed."); return data; }
function productStatus(value) {
  return String(value || "not-run") === "not-run" ? "Not run" : capitalize(String(value).replaceAll("-", " "));
}

export { $, $$, svgNs, element, textElement, formatTarget, countBy, sum, truncate, shortGraphId, capitalize, stopReasonText, safeHostname, shortPath, formatDuration, formatElapsed, formatDate, formatTime, fetchJson, productStatus };
