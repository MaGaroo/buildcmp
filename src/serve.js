import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import {
  assertDirectory,
  assertFile,
  buildTree,
  detectLanguage,
  escapeHtml,
  isTextBuffer,
  loadComparisonData,
  normalizeProjectPath,
  usage
} from "./lib.js";

const VENDOR_ROOT = path.resolve("node_modules");
const STATIC_ROUTES = new Map([
  ["/assets/app.css", { filePath: path.resolve("src/app.css"), contentType: "text/css; charset=utf-8" }],
  ["/assets/app.js", { filePath: path.resolve("src/client.js"), contentType: "text/javascript; charset=utf-8" }]
]);

function main() {
  const [projectRootArg, dataFileArg, portArg] = process.argv.slice(2);

  if (!projectRootArg || !dataFileArg) {
    usage(
      "Missing required arguments.",
      "node src/serve.js <project-root> <comparison-data.json> [port]"
    );
    process.exitCode = 1;
    return;
  }

  const projectRoot = path.resolve(projectRootArg);
  const dataFile = path.resolve(dataFileArg);
  const port = Number.parseInt(portArg ?? "4173", 10);

  assertDirectory(projectRoot, "Project root");
  assertFile(dataFile, "Comparison data");

  const comparison = loadComparisonData(dataFile);
  const fileMap = new Map(comparison.files.map((record) => [record.path, record]));
  const tree = buildTree(comparison.files.map((record) => record.path));
  const treeNodes = buildJsTreeNodes(tree, fileMap);
  const summary = buildSummary(comparison.files);

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (serveStatic(url.pathname, response)) {
      return;
    }

    if (url.pathname.startsWith("/vendor/")) {
      serveVendor(url.pathname, response);
      return;
    }

    if (url.pathname === "/" || url.pathname === "/file") {
      const requestedPath = url.searchParams.get("path");
      const initialFile = resolveKnownFile(projectRoot, fileMap, requestedPath);
      const state = {
        generatedAt: comparison.generatedAt ?? null,
        files: comparison.files,
        treeNodes,
        summary,
        initialFile
      };

      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderShell(state));
      return;
    }

    if (url.pathname === "/api/file") {
      const requestedPath = url.searchParams.get("path");
      const resolvedPath = resolveKnownFile(projectRoot, fileMap, requestedPath);

      if (!resolvedPath) {
        writeJson(response, 404, { error: "Unknown file." });
        return;
      }

      const record = fileMap.get(resolvedPath);
      const absolutePath = path.resolve(projectRoot, resolvedPath);
      const buffer = fs.readFileSync(absolutePath);
      const isText = isTextBuffer(buffer);

      writeJson(response, 200, {
        path: resolvedPath,
        status: record.status,
        inFirst: record.inFirst,
        inSecond: record.inSecond,
        isText,
        size: buffer.length,
        language: detectLanguage(resolvedPath),
        content: isText ? buffer.toString("utf8") : null
      });
      return;
    }

    writeNotFound(response, "Page not found.");
  });

  server.listen(port, () => {
    console.log(`Dashboard listening on http://localhost:${port}`);
  });
}

function serveStatic(pathname, response) {
  const route = STATIC_ROUTES.get(pathname);
  if (!route) {
    return false;
  }

  response.writeHead(200, { "content-type": route.contentType });
  response.end(fs.readFileSync(route.filePath));
  return true;
}

function serveVendor(pathname, response) {
  const relativePath = pathname.slice("/vendor/".length);
  const filePath = path.resolve(VENDOR_ROOT, relativePath);

  if (!filePath.startsWith(VENDOR_ROOT)) {
    writeNotFound(response, "Invalid asset path.");
    return;
  }

  const stat = fs.statSync(filePath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) {
    writeNotFound(response, "Asset not found.");
    return;
  }

  response.writeHead(200, { "content-type": guessContentType(filePath) });
  response.end(fs.readFileSync(filePath));
}

function resolveKnownFile(projectRoot, fileMap, requestedPath) {
  if (!requestedPath) {
    return null;
  }

  const normalizedRequest = requestedPath.replaceAll("\\", "/");
  const absolutePath = path.resolve(projectRoot, normalizedRequest);
  const normalizedPath = normalizeProjectPath(projectRoot, absolutePath);

  if (!normalizedPath || !fileMap.has(normalizedPath)) {
    return null;
  }

  return normalizedPath;
}

function renderShell(state) {
  const safeState = JSON.stringify(state).replaceAll("<", "\\u003c");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>buildcmp</title>
    <link rel="stylesheet" href="/vendor/dockview/dist/styles/dockview.css">
    <link rel="stylesheet" href="/vendor/jstree/dist/themes/default-dark/style.min.css">
    <link rel="stylesheet" href="/assets/app.css">
  </head>
  <body>
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">Compilation coverage explorer</p>
          <h1>buildcmp</h1>
        </div>
        <div class="summary-strip">
          <span>${state.summary.total} files</span>
          <span>${state.summary.both} in both</span>
          <span>${state.summary.firstOnly} only in 1</span>
          <span>${state.summary.secondOnly} only in 2</span>
          <span>${state.summary.neither} in neither</span>
        </div>
      </header>
      <main class="workspace-page">
        <div id="workbench" class="workbench"></div>
      </main>
    </div>
    <script id="buildcmp-state" type="application/json">${safeState}</script>
    <script src="/vendor/dockview/dist/dockview.js"></script>
    <script src="/vendor/jstree/node_modules/jquery/dist/jquery.min.js"></script>
    <script src="/vendor/jstree/dist/jstree.min.js"></script>
    <script src="/vendor/monaco-editor/min/vs/loader.js"></script>
    <script type="module" src="/assets/app.js"></script>
  </body>
</html>`;
}

function buildSummary(files) {
  const summary = {
    total: files.length,
    both: 0,
    firstOnly: 0,
    secondOnly: 0,
    neither: 0
  };

  for (const record of files) {
    if (record.status === "both") summary.both += 1;
    if (record.status === "first-only") summary.firstOnly += 1;
    if (record.status === "second-only") summary.secondOnly += 1;
    if (record.status === "neither") summary.neither += 1;
  }

  return summary;
}

function buildJsTreeNodes(tree, fileMap) {
  const nodes = [];
  walkTree(tree, "#", nodes, fileMap);
  return nodes;
}

function walkTree(node, parentId, nodes, fileMap) {
  for (const directory of node.directories.values()) {
    const directoryName = directory.relativePath.split("/").at(-1) ?? "";
    const directoryId = `dir:${directory.relativePath}`;
    const aggregate = summarizeDirectory(directory, fileMap);

    nodes.push({
      id: directoryId,
      parent: parentId,
      text: renderTreeNodeLabel(directoryName, aggregate, "folder"),
      type: "folder",
      state: { opened: parentId === "#" },
      data: {
        kind: "directory",
        path: directory.relativePath,
        inFirst: aggregate.inFirst,
        inSecond: aggregate.inSecond
      },
      a_attr: {
        class: "tree-anchor",
        "data-dir-path": directory.relativePath
      }
    });

    walkTree(directory, directoryId, nodes, fileMap);
  }

  for (const file of node.files) {
    const record = fileMap.get(file.path);

    nodes.push({
      id: `file:${file.path}`,
      parent: parentId,
      text: renderTreeNodeLabel(file.name, record, "file"),
      type: "file",
      data: {
        kind: "file",
        path: file.path,
        inFirst: record.inFirst,
        inSecond: record.inSecond
      },
      a_attr: {
        class: "tree-anchor",
        "data-file-path": file.path
      }
    });
  }
}

function renderTreeNodeLabel(label, record, kind) {
  const badges = [];
  const iconClass = kind === "folder" ? "tree-inline-icon-folder" : "tree-inline-icon-file";

  if (record?.inFirst) {
    badges.push('<span class="config-pill config-pill-1">1</span>');
  }

  if (record?.inSecond) {
    badges.push('<span class="config-pill config-pill-2">2</span>');
  }

  if (badges.length === 0) {
    return `<span class="tree-label-wrap"><span class="tree-inline-icon ${iconClass}" aria-hidden="true"></span><span class="tree-label">${escapeHtml(label)}</span></span>`;
  }

  return `<span class="tree-label-wrap"><span class="tree-inline-icon ${iconClass}" aria-hidden="true"></span><span class="tree-label">${escapeHtml(label)}</span><span class="tree-badges">${badges.join("")}</span></span>`;
}

function summarizeDirectory(node, fileMap) {
  let inFirst = false;
  let inSecond = false;

  for (const file of node.files) {
    const record = fileMap.get(file.path);
    if (!record) {
      continue;
    }

    inFirst ||= Boolean(record.inFirst);
    inSecond ||= Boolean(record.inSecond);
  }

  for (const child of node.directories.values()) {
    const childSummary = summarizeDirectory(child, fileMap);
    inFirst ||= childSummary.inFirst;
    inSecond ||= childSummary.inSecond;
  }

  return { inFirst, inSecond };
}

function guessContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const byExtension = {
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".ttf": "font/ttf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".png": "image/png",
    ".gif": "image/gif",
    ".svg": "image/svg+xml"
  };

  return byExtension[extension] ?? "application/octet-stream";
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function writeNotFound(response, message) {
  response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="en"><body><p>${escapeHtml(message)}</p></body></html>`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
