const state = JSON.parse(document.getElementById("buildcmp-state").textContent);
const fileIndex = new Map(state.files.map((file) => [file.path, file]));
const dockviewRoot = document.getElementById("workbench");
const { createDockview, themeVisualStudio } = window.dockview;

const monaco = await loadMonaco();
let dockview;

function initializeWorkbench() {
  dockview.addPanel({
    id: "explorer",
    component: "explorer",
    title: "Explorer",
    initialWidth: 320,
    minimumWidth: 240
  });

  dockview.addPanel({
    id: "welcome",
    component: "welcome",
    title: "Start",
    minimumWidth: 420,
    position: {
      referencePanel: "explorer",
      direction: "right"
    }
  });

  if (state.initialFile) {
    openFile(state.initialFile);
  }
}

function openFile(filePath) {
  const existingPanel = dockview.getPanel(`file:${filePath}`);
  if (existingPanel) {
    existingPanel.api.setActive();
    return;
  }

  const welcomePanel = dockview.getPanel("welcome");
  if (welcomePanel) {
    welcomePanel.api.close();
  }

  const record = fileIndex.get(filePath);
  const referencePanel = findReferenceEditorPanel();

  dockview.addPanel({
    id: `file:${filePath}`,
    component: "editor",
    title: basename(filePath),
    params: {
      path: filePath,
      status: record?.status ?? "neither"
    },
    minimumWidth: 420,
    position: referencePanel
      ? {
          referencePanel: referencePanel.id,
          direction: "within"
        }
      : {
          referencePanel: "explorer",
          direction: "right"
        }
  });
}

function findReferenceEditorPanel() {
  const editorPanel = dockview.panels.find((panel) => panel.id.startsWith("file:"));
  return editorPanel ?? undefined;
}

function basename(filePath) {
  const parts = filePath.split("/");
  return parts[parts.length - 1];
}

function loadMonaco() {
  return new Promise((resolve, reject) => {
    if (!window.require) {
      reject(new Error("Monaco loader was not found."));
      return;
    }

    window.require.config({
      paths: {
        vs: "/vendor/monaco-editor/min/vs"
      }
    });

    window.require(["vs/editor/editor.main"], () => {
      resolve(window.monaco);
    }, reject);
  });
}

class ExplorerPanel {
  constructor({ nodes, onOpenFile }) {
    this.nodes = nodes;
    this.onOpenFile = onOpenFile;
    this.element = document.createElement("div");
    this.element.className = "explorer-panel";
  }

  init() {
    this.element.innerHTML = `
      <div class="explorer-head">
        <span>Project</span>
        <span class="explorer-count">${state.summary.total} files</span>
      </div>
      <div class="explorer-legend">
        <span class="config-pill config-pill-1">1</span>
        <span class="legend-text">first compile database</span>
        <span class="config-pill config-pill-2">2</span>
        <span class="legend-text">second compile database</span>
      </div>
      <label class="explorer-toggle">
        <input type="checkbox" id="line-summary-toggle">
        <span>Show line stats</span>
      </label>
      <div class="explorer-tree" id="explorer-tree"></div>
    `;

    const treeElement = this.element.querySelector("#explorer-tree");
    const summaryToggle = this.element.querySelector("#line-summary-toggle");

    summaryToggle.addEventListener("change", () => {
      this.element.classList.toggle("show-line-summary", summaryToggle.checked);
    });

    window.jQuery(treeElement)
      .jstree({
        core: {
          data: this.nodes,
          multiple: false,
          force_text: false,
          themes: {
            variant: "large",
            dots: false
          }
        },
        plugins: ["wholerow", "types"],
        types: {
          folder: { icon: "tree-icon tree-icon-folder" },
          file: { icon: "tree-icon tree-icon-file" }
        }
      })
      .on("select_node.jstree", (_event, data) => {
        if (data.node?.data?.kind === "file") {
          this.onOpenFile(data.node.data.path);
          return;
        }

        if (data.node?.data?.kind === "directory") {
          data.instance.toggle_node(data.node);
        }
      });
  }

  dispose() {}
}

class WelcomePanel {
  constructor() {
    this.element = document.createElement("div");
    this.element.className = "welcome-panel";
  }

  init() {
    this.element.innerHTML = `
      <div class="welcome-card">
        <p class="eyebrow">Workbench ready</p>
        <h2>Open a file from the explorer</h2>
        <p>The left panel comes from jsTree. File tabs and pane layout come from Dockview. The editor on the right uses Monaco.</p>
      </div>
    `;
  }

  dispose() {}
}

class EditorPanel {
  constructor(monacoInstance) {
    this.monaco = monacoInstance;
    this.model = null;
    this.editor = null;
    this.decorationsCollection = null;
    this.path = null;
    this.element = document.createElement("div");
    this.element.className = "editor-panel";
    this.header = document.createElement("div");
    this.header.className = "editor-header";
    this.body = document.createElement("div");
    this.body.className = "editor-body";
    this.element.append(this.header, this.body);
  }

  init({ params }) {
    this.renderLoading(params.path, params.status);
    this.loadFile(params.path);
  }

  layout(width, height) {
    if (this.editor) {
      this.editor.layout({ width, height: Math.max(height - this.header.offsetHeight, 120) });
    }
  }

  focus() {
    this.editor?.focus();
  }

  async loadFile(filePath) {
    this.path = filePath;
    const response = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
    const payload = await response.json();

    if (!response.ok) {
      this.renderError(filePath, payload.error ?? "Unable to load file.");
      return;
    }

    this.renderHeader(payload.path, payload.status, payload.inFirst, payload.inSecond);

    if (!payload.isText) {
      this.body.innerHTML = `
        <div class="binary-card">
          <p>This file does not look like plain text.</p>
          <p>Size: ${payload.size} bytes</p>
        </div>
      `;
      return;
    }

    if (!this.editor) {
      this.body.innerHTML = "";
      this.editor = this.monaco.editor.create(this.body, {
        value: payload.content,
        language: payload.language,
        readOnly: true,
        minimap: { enabled: false },
        glyphMargin: false,
        lineDecorationsWidth: 38,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        fontSize: 13,
        wordWrap: "off",
        theme: "vs-dark"
      });
      this.model = this.editor.getModel();
      this.decorationsCollection = this.editor.createDecorationsCollection(
        buildLineDecorations(this.monaco, payload.lineRanges)
      );
      return;
    }

    if (this.model) {
      this.model.dispose();
    }

    this.model = this.monaco.editor.createModel(payload.content, payload.language);
    this.editor.setModel(this.model);
    this.decorationsCollection?.set(buildLineDecorations(this.monaco, payload.lineRanges));
  }

  renderLoading(filePath, status) {
    this.renderHeader(filePath, status, null, null);
    this.body.innerHTML = `<div class="loading-card">Loading ${escapeHtml(filePath)}...</div>`;
  }

  renderError(filePath, message) {
    this.renderHeader(filePath, "neither", null, null);
    this.body.innerHTML = `<div class="binary-card">${escapeHtml(message)}</div>`;
  }

  renderHeader(filePath, status, inFirst, inSecond) {
    const statusLabel = statusToLabel(status);
    const details = [];

    if (typeof inFirst === "boolean") {
      details.push(inFirst ? "first db" : "not in first db");
    }
    if (typeof inSecond === "boolean") {
      details.push(inSecond ? "second db" : "not in second db");
    }

    this.header.innerHTML = `
      <div>
        <div class="editor-path">${escapeHtml(filePath)}</div>
        <div class="editor-subtitle">${details.join(" | ")}</div>
      </div>
      <span class="legend-pill ${statusToClass(status)}">${escapeHtml(statusLabel)}</span>
    `;
  }

  dispose() {
    if (this.decorationsCollection) {
      this.decorationsCollection.clear();
    }
    if (this.model) {
      this.model.dispose();
    }
    if (this.editor) {
      this.editor.dispose();
    }
  }
}

function buildLineDecorations(monaco, lineRanges) {
  const maskByLine = new Map();

  applyLineMask(maskByLine, lineRanges?.first ?? [], 1);
  applyLineMask(maskByLine, lineRanges?.second ?? [], 2);

  const sortedLines = [...maskByLine.keys()].sort((left, right) => left - right);
  const decorations = [];

  if (sortedLines.length === 0) {
    return decorations;
  }

  let start = sortedLines[0];
  let end = sortedLines[0];
  let currentMask = maskByLine.get(sortedLines[0]);

  for (let index = 1; index < sortedLines.length; index += 1) {
    const line = sortedLines[index];
    const mask = maskByLine.get(line);

    if (line === end + 1 && mask === currentMask) {
      end = line;
      continue;
    }

    decorations.push(makeLineDecoration(monaco, start, end, currentMask));
    start = line;
    end = line;
    currentMask = mask;
  }

  decorations.push(makeLineDecoration(monaco, start, end, currentMask));
  return decorations;
}

function applyLineMask(maskByLine, ranges, bit) {
  for (const [start, end] of ranges) {
    for (let line = start; line <= end; line += 1) {
      maskByLine.set(line, (maskByLine.get(line) ?? 0) | bit);
    }
  }
}

function makeLineDecoration(monaco, start, end, mask) {
  return {
    range: new monaco.Range(start, 1, end, 1),
    options: {
      isWholeLine: true,
      linesDecorationsClassName: lineBadgeClass(mask)
    }
  };
}

function lineBadgeClass(mask) {
  if (mask === 3) {
    return "line-badge-both";
  }
  if (mask === 1) {
    return "line-badge-1";
  }
  if (mask === 2) {
    return "line-badge-2";
  }
  return "";
}

function statusToLabel(status) {
  return {
    both: "Both",
    "first-only": "First only",
    "second-only": "Second only",
    neither: "Neither"
  }[status] ?? "Neither";
}

function statusToClass(status) {
  return {
    both: "status-both",
    "first-only": "status-first-only",
    "second-only": "status-second-only",
    neither: "status-neither"
  }[status] ?? "status-neither";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

dockview = createDockview(dockviewRoot, {
  theme: themeVisualStudio,
  className: "buildcmp-dockview",
  noPanelsOverlay: "watermark",
  createComponent: (options) => {
    if (options.name === "explorer") {
      return new ExplorerPanel({
        nodes: state.treeNodes,
        onOpenFile: openFile
      });
    }

    if (options.name === "welcome") {
      return new WelcomePanel();
    }

    if (options.name === "editor") {
      return new EditorPanel(monaco);
    }

    throw new Error(`Unknown component: ${options.name}`);
  }
});

initializeWorkbench();
