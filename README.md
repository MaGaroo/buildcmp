# buildcmp

`buildcmp` is a two-step project for comparing two `compile_commands.json` files against a project root.

Step 1 extracts only the file-level visibility data into a compact JSON artifact.
Step 2 starts a server-rendered web dashboard that uses that artifact plus the original project root to browse files.

The dashboard now uses open-source UI components instead of a hand-built viewer:

- `jsTree` for the explorer tree on the left
- `Dockview` for the IDE-like split layout and tabs
- `Monaco Editor` for the read-only code view

## Why two tools

- `extract`: reads the project root and two compilation databases, then emits normalized file membership data.
- `serve`: reads the generated comparison file and serves a request-time-rendered dashboard with a VS Code-style file tree and plain file viewer.

## Usage

```bash
npm run extract -- /path/to/project /path/to/first/compile_commands.json /path/to/second/compile_commands.json /tmp/comparison.json
npm run serve -- /path/to/project /tmp/comparison.json 4173
```

Then open `http://localhost:4173`.

## Output format

The extractor currently writes JSON like this:

```json
{
  "version": 1,
  "generatedAt": "2026-08-05T13:00:00.000Z",
  "files": [
    {
      "path": "src/main.cpp",
      "inFirst": true,
      "inSecond": false,
      "status": "first-only"
    }
  ]
}
```

The dashboard intentionally reads actual file contents from the project root at request time, so the intermediate file only stores the comparison data we need.

## UI behavior

- The left side shows a VS Code-like explorer tree.
- Clicking a file opens it in a tab on the right instead of navigating to a separate page.
- File contents are fetched on demand from the server, so the shell can be rendered first and each file tab fills in when requested.

## Sample

```bash
npm run sample:extract
npm run sample:serve
```

That will serve the sample fixture at `http://localhost:4173`.
