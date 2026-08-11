import fs from "node:fs";
import path from "node:path";

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  "node_modules",
  "dist",
  "build",
  "out"
]);

export function usage(message, example) {
  if (message) {
    console.error(message);
    console.error("");
  }
  console.error(`Usage: ${example}`);
}

export function assertDirectory(dirPath, label) {
  const stat = fs.statSync(dirPath, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${dirPath}`);
  }
}

export function assertFile(filePath, label) {
  const stat = fs.statSync(filePath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) {
    throw new Error(`${label} is not a file: ${filePath}`);
  }
}

export function normalizeProjectPath(projectRoot, candidatePath) {
  const absoluteRoot = path.resolve(projectRoot);
  const absoluteCandidate = path.resolve(candidatePath);
  const relative = path.relative(absoluteRoot, absoluteCandidate);

  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    return null;
  }

  return normalizeSlashes(relative);
}

export function normalizeSlashes(value) {
  return value.split(path.sep).join("/");
}

export function readCompilationDatabase(dbPath) {
  const raw = fs.readFileSync(dbPath, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error(`Compilation database must be an array: ${dbPath}`);
  }

  return parsed;
}

export function collectProjectFiles(projectRoot, ignoredDirs = DEFAULT_IGNORED_DIRS) {
  const discovered = [];

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) {
          continue;
        }
        walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const relativePath = normalizeProjectPath(projectRoot, absolutePath);
      if (relativePath) {
        discovered.push(relativePath);
      }
    }
  }

  walk(path.resolve(projectRoot));
  return discovered;
}

export function resolveCompileCommandEntry(projectRoot, entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  if (typeof entry.file !== "string" || entry.file.length === 0) {
    return null;
  }

  const baseDir =
    typeof entry.directory === "string" && entry.directory.length > 0
      ? entry.directory
      : projectRoot;

  const absoluteFile = path.resolve(baseDir, entry.file);
  return normalizeProjectPath(projectRoot, absoluteFile);
}

export function classifyFile(inFirst, inSecond) {
  if (inFirst && inSecond) {
    return "both";
  }
  if (inFirst) {
    return "first-only";
  }
  if (inSecond) {
    return "second-only";
  }
  return "neither";
}

export function loadComparisonData(dataPath) {
  const raw = fs.readFileSync(dataPath, "utf8");
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.files)) {
    throw new Error(`Invalid comparison data file: ${dataPath}`);
  }

  return parsed;
}

export function buildTree(paths) {
  const root = makeDirectoryNode("");

  for (const filePath of paths) {
    const parts = filePath.split("/").filter(Boolean);
    let current = root;

    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      const isLeaf = index === parts.length - 1;
      const currentPath = parts.slice(0, index + 1).join("/");

      if (isLeaf) {
        current.files.push({ name, path: currentPath });
        continue;
      }

      if (!current.directories.has(name)) {
        current.directories.set(name, makeDirectoryNode(currentPath));
      }
      current = current.directories.get(name);
    }
  }

  sortTree(root);
  return root;
}

function makeDirectoryNode(relativePath) {
  return {
    relativePath,
    directories: new Map(),
    files: []
  };
}

function sortTree(node) {
  node.files.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of node.directories.values()) {
    sortTree(child);
  }
  node.directories = new Map(
    [...node.directories.entries()].sort((left, right) =>
      left[0].localeCompare(right[0])
    )
  );
}

export function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function isTextBuffer(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let suspicious = 0;

  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) {
      continue;
    }
    if (byte === 0 || byte < 32) {
      suspicious += 1;
    }
  }

  return suspicious === 0;
}

export function detectLanguage(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  const basename = path.basename(relativePath).toLowerCase();

  const byExtension = {
    ".c": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".cxx": "cpp",
    ".h": "cpp",
    ".hh": "cpp",
    ".hpp": "cpp",
    ".hxx": "cpp",
    ".m": "objective-c",
    ".mm": "objective-cpp",
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".json": "json",
    ".md": "markdown",
    ".txt": "plaintext",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".xml": "xml",
    ".html": "html",
    ".css": "css",
    ".scss": "scss",
    ".sh": "shell",
    ".bash": "shell",
    ".cmake": "cmake",
    ".java": "java",
    ".rs": "rust",
    ".go": "go"
  };

  if (basename === "cmakelists.txt") {
    return "cmake";
  }

  return byExtension[extension] ?? "plaintext";
}
