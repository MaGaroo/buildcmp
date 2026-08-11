import fs from "node:fs";
import path from "node:path";
import {
  assertDirectory,
  assertFile,
  classifyFile,
  collectProjectFiles,
  readCompilationDatabase,
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
      return {
        path: relativePath,
        inFirst,
        inSecond,
        status: classifyFile(inFirst, inSecond)
      };
    });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      {
        version: 1,
        generatedAt: new Date().toISOString(),
        files
      },
      null,
      2
    )
  );

  console.log(`Wrote ${files.length} file records to ${outputPath}`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
