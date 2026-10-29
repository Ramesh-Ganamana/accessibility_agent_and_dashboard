import { $, svgNs, textElement, truncate, shortGraphId } from "../shared/ui.js";
import { state } from "../state.js";
import { renderIssues } from "./findings.js";

export function createGraphView({ showIssues }) {
  function renderGraph(report) {
    const svg = $("#crawl-graph"); svg.replaceChildren();
    const nodes = report.graph?.nodes || [];
    const edges = report.graph?.edges || [];
    if (!nodes.length) return;

    const definitions = document.createElementNS(svgNs, "defs");
    const marker = document.createElementNS(svgNs, "marker");
    marker.setAttribute("id", "graph-arrow");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9"); marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "7"); marker.setAttribute("markerHeight", "7");
    marker.setAttribute("orient", "auto-start-reverse");
    const arrow = document.createElementNS(svgNs, "path");
    arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    marker.append(arrow); definitions.append(marker); svg.append(definitions);

    const layers = new Map();
    nodes.forEach((node) => {
      const depth = Number(node.depth || 0);
      if (!layers.has(depth)) layers.set(depth, []);
      layers.get(depth).push(node);
    });
    const columns = Math.min(3, Math.max(...[...layers.values()].map((items) => items.length)));
    const width = Math.max(980, columns * 330 + 100);
    const layerRows = new Map();
    let nextRow = 0;
    [...layers.entries()].sort(([a], [b]) => a - b).forEach(([depth, items]) => {
      layerRows.set(depth, nextRow);
      nextRow += Math.max(1, Math.ceil(items.length / columns));
    });
    const height = Math.max(600, nextRow * 165 + 90);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const positions = new Map();
    [...layers.entries()].sort(([a], [b]) => a - b).forEach(([depth, items]) => {
      const baseRow = layerRows.get(depth);
      items.forEach((node, index) => {
        const row = baseRow + Math.floor(index / columns);
        const itemsInRow = Math.min(columns, items.length - Math.floor(index / columns) * columns);
        const column = index % columns;
        const rowWidth = itemsInRow * 280 + Math.max(0, itemsInRow - 1) * 50;
        const startX = (width - rowWidth) / 2;
        positions.set(node.id, { x: startX + column * 330, y: 45 + row * 165 });
      });
    });

    edges.forEach((edge, index) => {
      const start = positions.get(edge.source); const end = positions.get(edge.target);
      if (!start || !end) return;
      const path = document.createElementNS(svgNs, "path");
      const sx = start.x + 140; const sy = start.y + 92; const ex = end.x + 140; const ey = end.y; const midY = (sy + ey) / 2;
      const edgeId = `graph-edge-${index}`;
      path.setAttribute("id", edgeId);
      path.setAttribute("d", `M ${sx} ${sy} C ${sx} ${midY}, ${ex} ${midY}, ${ex} ${ey}`);
      path.setAttribute("class", `graph-edge ${edge.type === "popup" ? "popup" : ""}`);
      path.setAttribute("marker-end", "url(#graph-arrow)");
      const title = document.createElementNS(svgNs, "title");
      title.textContent = `${edge.label || edge.type || "navigate"}${edge.selector ? ` · ${edge.selector}` : ""}`;
      path.append(title);
      svg.append(path);
      const label = document.createElementNS(svgNs, "text");
      label.setAttribute("class", "graph-edge-label");
      const textPath = document.createElementNS(svgNs, "textPath");
      textPath.setAttribute("href", `#${edgeId}`);
      textPath.setAttribute("startOffset", "50%");
      textPath.setAttribute("text-anchor", "middle");
      textPath.textContent = truncate(edge.label || edge.type || "navigate", 34);
      label.append(textPath); svg.append(label);
    });
    for (const node of nodes) {
      const position = positions.get(node.id);
      const group = document.createElementNS(svgNs, "g");
      const status = ["failed", "error"].includes(node.status) ? "failed" : node.status === "blocked" ? "blocked" : "scanned";
      group.setAttribute("class", `graph-node ${status}${state.selectedGraphNode?.id === node.id ? " selected" : ""}`);
      group.setAttribute("transform", `translate(${position.x},${position.y})`);
      group.setAttribute("tabindex", "0"); group.setAttribute("role", "button");
      group.setAttribute("aria-label", `${node.label}, ${status}, ${node.issueCount} findings`);
      const rect = document.createElementNS(svgNs, "rect"); rect.setAttribute("width", "280"); rect.setAttribute("height", "92"); rect.setAttribute("rx", "12");
      const title = document.createElementNS(svgNs, "text"); title.setAttribute("x", "16"); title.setAttribute("y", "27"); title.setAttribute("class", "node-title"); title.textContent = truncate(node.label, 32);
      const stateLine = document.createElementNS(svgNs, "text"); stateLine.setAttribute("x", "16"); stateLine.setAttribute("y", "52"); stateLine.setAttribute("class", "node-state"); stateLine.textContent = `${node.stateId || shortGraphId(node.id)} · ${status}${node.issueCount ? ` · ${node.issueCount} findings` : ""}`;
      const url = document.createElementNS(svgNs, "text"); url.setAttribute("x", "16"); url.setAttribute("y", "75"); url.setAttribute("class", "node-url"); url.textContent = truncate(node.url, 43);
      const tooltip = document.createElementNS(svgNs, "title"); tooltip.textContent = `${node.label}\n${node.url}\n${node.state || "page"} · ${status}${node.terminationReason ? `\nReason: ${node.terminationReason.replaceAll("_", " ")}` : ""}`;
      const select = () => selectGraphNode(node);
      group.addEventListener("click", select);
      group.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); select(); } });
      group.append(rect, title, stateLine, url, tooltip); svg.append(group);
    }
  }

  function selectGraphNode(node) {
    state.selectedGraphNode = state.selectedGraphNode?.id === node.id ? null : node;
    state.selectedPage = state.selectedGraphNode?.url || null;
    $("#graph-detail").replaceChildren(textElement("span", state.selectedPage ? `Selected ${node.state === "page" || !node.state ? "route" : "state"}: ${node.label}` : "Selection cleared"), textElement("strong", state.selectedPage || "Showing the complete crawl"));
    renderGraph(state.report);
    renderIssues();
    if (state.selectedPage) {
      showIssues();
    }
  }
  return { renderGraph };
}
