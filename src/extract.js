import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  assertDirectory,
  assertFile,
  classifyFile,
  collectProjectFiles,
  readCompilationDatabase,
  resolveCompileCommandAbsolutePath,
  resolveCompileCommandEntry,
  usage
} from "./lib.js";

function main() {
  const [projectRootArg, firstDbArg, secondDbArg, outputArg] = process.argv.slice(2);

  if (!projectRootArg || !firstDbArg || !secondDbArg || !outputArg) {
    usage(
      "Missing required arguments.",
      "node src/extract.js <project-root> <first-compile-commands.json> <second-compile-commands.json> <output.json>"
    );
    process.exitCode = 1;
    return;
  }

  const projectRoot = path.resolve(projectRootArg);
  const firstDbPath = path.resolve(firstDbArg);
  const secondDbPath = path.resolve(secondDbArg);
  const outputPath = path.resolve(outputArg);

  assertDirectory(projectRoot, "Project root");
  assertFile(firstDbPath, "First compilation database");
  assertFile(secondDbPath, "Second compilation database");

  const firstEntries = readCompilationDatabase(firstDbPath);
  const secondEntries = readCompilationDatabase(secondDbPath);

  const firstLineRanges = collectLineRangesForDatabase(projectRoot, firstEntries, "first");
  const secondLineRanges = collectLineRangesForDatabase(projectRoot, secondEntries, "second");

  const firstSet = new Set(
    firstEntries
      .map((entry) => resolveCompileCommandEntry(projectRoot, entry))
      .filter(Boolean)
  );
  const secondSet = new Set(
    secondEntries
      .map((entry) => resolveCompileCommandEntry(projectRoot, entry))
      .filter(Boolean)
  );

  const projectFiles = collectProjectFiles(projectRoot);
  const allPaths = new Set([...projectFiles, ...firstSet, ...secondSet]);
  const files = [...allPaths]
    .sort((left, right) => left.localeCompare(right))
    .map((relativePath) => {
      const inFirst = firstSet.has(relativePath);
      const inSecond = secondSet.has(relativePath);
      const lineRanges = {
        first: firstLineRanges.get(relativePath) ?? [],
        second: secondLineRanges.get(relativePath) ?? []
      };
      return {
        path: relativePath,
        inFirst,
        inSecond,
        status: classifyFile(inFirst, inSecond),
        lineRanges,
        lineCounts: computeLineCounts(lineRanges.first, lineRanges.second)
      };
    });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      {
        version: 3,
        generatedAt: new Date().toISOString(),
        files
      },
      null,
      2
    )
  );

  console.log(`Wrote ${files.length} file records to ${outputPath}`);
}

function collectLineRangesForDatabase(projectRoot, entries, label) {
  const lineSets = new Map();

  for (const entry of entries) {
    const relativePath = resolveCompileCommandEntry(projectRoot, entry);
    const absolutePath = resolveCompileCommandAbsolutePath(projectRoot, entry);

    if (!relativePath || !absolutePath) {
      continue;
    }

    const activeLines = extractActiveLinesForEntry(projectRoot, entry, absolutePath, label);
    if (!lineSets.has(relativePath)) {
      lineSets.set(relativePath, new Set());
    }

    const bucket = lineSets.get(relativePath);
    for (const lineNumber of activeLines) {
      bucket.add(lineNumber);
    }
  }

  return new Map(
    [...lineSets.entries()].map(([relativePath, lines]) => [
      relativePath,
      compressLineSet(lines)
    ])
  );
}

function extractActiveLinesForEntry(projectRoot, entry, targetAbsolutePath, label) {
  const invocation = buildPreprocessInvocation(entry);
  const cwd =
    typeof entry.directory === "string" && entry.directory.length > 0
      ? path.resolve(entry.directory)
      : path.resolve(projectRoot);

  const result = spawnSync(invocation.executable, invocation.args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });

  if (result.error) {
    throw new Error(
      `Failed to preprocess ${entry.file} for ${label} database: ${result.error.message}`
    );
  }

  if (result.status !== 0) {
    throw new Error(
      `Preprocessing failed for ${entry.file} in ${label} database:\n${result.stderr || result.stdout}`
    );
  }

  return parseActiveLinesFromPreprocessorOutput(result.stdout, cwd, targetAbsolutePath);
}

function buildPreprocessInvocation(entry) {
  const tokens = Array.isArray(entry.arguments)
    ? [...entry.arguments]
    : splitCommand(entry.command);

  if (tokens.length === 0) {
    throw new Error(`Compilation database entry has no command for ${entry.file}`);
  }

  const executable = tokens[0];
  const args = sanitizeCompileArguments(tokens.slice(1));
  args.push("-E");

  return { executable, args };
}

function sanitizeCompileArguments(args) {
  const sanitized = [];
  const dropNextValueFlags = new Set([
    "-o",
    "-MF",
    "-MT",
    "-MQ",
    "-MJ",
    "-dependency-file",
    "--output"
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (
      arg === "-c" ||
      arg === "-S" ||
      arg === "-E" ||
      arg === "-M" ||
      arg === "-MM" ||
      arg === "-MD" ||
      arg === "-MMD" ||
      arg === "-MP"
    ) {
      continue;
    }

    if (dropNextValueFlags.has(arg)) {
      index += 1;
      continue;
    }

    if (
      arg.startsWith("-o") ||
      arg.startsWith("-MF") ||
      arg.startsWith("-MT") ||
      arg.startsWith("-MQ") ||
      arg.startsWith("-MJ")
    ) {
      continue;
    }

    sanitized.push(arg);
  }

  return sanitized;
}

function parseActiveLinesFromPreprocessorOutput(output, cwd, targetAbsolutePath) {
  const activeLines = new Set();
  const targetPath = path.resolve(targetAbsolutePath);
  const lines = output.split("\n");
  let currentFile = null;
  let currentLine = 1;

  for (const line of lines) {
    const marker = parseLineMarker(line);
    if (marker) {
      currentFile = resolveMarkerPath(cwd, marker.filePath);
      currentLine = marker.lineNumber;
      continue;
    }

    if (currentFile === targetPath && line.trim().length > 0) {
      activeLines.add(currentLine);
    }

    currentLine += 1;
  }

  return activeLines;
}

function parseLineMarker(line) {
  const match = line.match(/^#(?:line)?\s+(\d+)\s+"((?:[^"\\]|\\.)+)"/);
  if (!match) {
    return null;
  }

  return {
    lineNumber: Number.parseInt(match[1], 10),
    filePath: unescapeQuotedPath(match[2])
  };
}

function resolveMarkerPath(cwd, markerPath) {
  if (
    markerPath.startsWith("<") ||
    markerPath.length === 0
  ) {
    return null;
  }

  return path.resolve(cwd, markerPath);
}

function unescapeQuotedPath(value) {
  return value.replace(/\\(["\\])/g, "$1");
}

function compressLineSet(lineSet) {
  const sorted = [...lineSet].sort((left, right) => left - right);
  if (sorted.length === 0) {
    return [];
  }

  const ranges = [];
  let start = sorted[0];
  let end = sorted[0];

  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    if (current === end + 1) {
      end = current;
      continue;
    }

    ranges.push([start, end]);
    start = current;
    end = current;
  }

  ranges.push([start, end]);
  return ranges;
}

function computeLineCounts(firstRanges, secondRanges) {
  let firstOnly = 0;
  let secondOnly = 0;
  let both = 0;
  let firstIndex = 0;
  let secondIndex = 0;

  while (firstIndex < firstRanges.length && secondIndex < secondRanges.length) {
    const [firstStart, firstEnd] = firstRanges[firstIndex];
    const [secondStart, secondEnd] = secondRanges[secondIndex];
    const overlapStart = Math.max(firstStart, secondStart);
    const overlapEnd = Math.min(firstEnd, secondEnd);

    if (overlapStart <= overlapEnd) {
      both += overlapEnd - overlapStart + 1;
    }

    if (firstEnd < secondEnd) {
      firstIndex += 1;
    } else {
      secondIndex += 1;
    }
  }

  for (const [start, end] of firstRanges) {
    firstOnly += end - start + 1;
  }

  for (const [start, end] of secondRanges) {
    secondOnly += end - start + 1;
  }

  firstOnly -= both;
  secondOnly -= both;

  return {
    both,
    firstOnly,
    secondOnly
  };
}

function splitCommand(command) {
  if (typeof command !== "string" || command.trim().length === 0) {
    return [];
  }

  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const character of command) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
