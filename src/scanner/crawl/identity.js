import { createHash } from "node:crypto";

export function globalStateKey(action, before, after) {
  const added = (key) => (after[key] || []).filter((value) => !(before[key] || []).includes(value));
  return createHash("sha1").update(JSON.stringify([action.label, action.path, after.dialogs, added("expanded"), added("selectedTabs")])).digest("hex");
}

export function shortStateId(value) {
  return createHash("sha1").update(String(value)).digest("hex").slice(0, 10);
}

export function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "page";
}
