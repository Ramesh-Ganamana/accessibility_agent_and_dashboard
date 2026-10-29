import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

async function modules(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory()
    ? modules(path.join(directory, entry.name))
    : entry.name.endsWith(".js") ? [path.join(directory, entry.name)] : []))).flat();
}

test("API, dashboard, crawler and NVDA modules have resolvable, acyclic internal dependencies", async () => {
  for (const directories of [["src/api"], ["public"], ["src/scanner/crawl", "src/assistive-technology"]]) {
    const files = (await Promise.all(directories.map((directory) => modules(path.join(root, directory))))).flat();
    assert.ok(files.length > 5, "the feature modules must be present");
    const graph = new Map();
    for (const file of files) {
      const source = await fs.readFile(file, "utf8");
      const imports = [...source.matchAll(/^(?:import|export)\s+[^;]*?\sfrom\s+["'](\.[^"']+)["']/gm)];
      const targets = imports.map((match) => path.resolve(path.dirname(file), match[1]));
      for (const target of targets) assert.ok((await fs.stat(target)).isFile(), `Missing dependency: ${target}`);
      graph.set(file, targets);
    }
    const visited = new Set();
    function visit(file, stack = []) {
      assert.ok(!stack.includes(file), `Import cycle: ${[...stack, file].map((item) => path.relative(root, item)).join(" -> ")}`);
      if (visited.has(file) || !graph.has(file)) return;
      for (const target of graph.get(file)) visit(target, [...stack, file]);
      visited.add(file);
    }
    for (const file of files) visit(file);
  }
});

test("engine implementations do not import their public compatibility facades", async () => {
  for (const directory of ["src/scanner/crawl", "src/assistive-technology/nvda"]) {
    for (const file of await modules(path.join(root, directory))) {
      const source = await fs.readFile(file, "utf8");
      assert.doesNotMatch(source, /from\s+["'][^"']*\/(?:crawler|nvda)\.js["']/, path.relative(root, file));
    }
  }
});

test("dashboard feature modules can be imported without a DOM or dashboard startup", async () => {
  // Node has no document: top-level rendering or event binding in a feature
  // would fail here. Only public/app.js may bootstrap the dashboard.
  for (const file of await modules(path.join(root, "public/features"))) await import(pathToFileURL(file).href);
});

test("shared modules and routers cannot import application entry points", async () => {
  for (const directory of ["public/features", "public/shared", "src/api/routes", "src/api/jobs", "src/api/middleware"]) {
    for (const file of await modules(path.join(root, directory))) {
      const source = await fs.readFile(file, "utf8");
      assert.doesNotMatch(source, /from\s+["'][^"']*\/(?:app|server)\.js["']/, path.relative(root, file));
    }
  }
});
