# Siglum MCP server

An [MCP](https://modelcontextprotocol.io) server that lets agents (Claude Code,
Claude Desktop, Cursor, and others) compile LaTeX with the Siglum engine. The agent
calls a tool and gets a PDF on disk. It never opens or drives a browser UI.

![A two-page resume compiled by an agent through this server](docs/example-resume.png)

## How it works

`@siglum/engine` targets browsers: it compiles in a Web Worker and caches
bundles in OPFS, IndexedDB and Cache Storage. Instead of porting those layers to
Node, this server runs the **unchanged engine** in a hidden headless Chromium:

```text
agent ──stdio/MCP──▶ siglum-mcp (Node)
                       ├─ 127.0.0.1 static server: engine src + tiny host page
                       └─ headless Chromium ──▶ SiglumCompiler ──▶ hosted runtime (packages.siglum.org)
```

- Same code path and results as the Siglum editor.
- A persistent browser profile (`~/.cache/siglum-mcp/profile`) keeps the runtime,
  bundles and packages, so later compiles take about 1 s and work offline once cached.
- Compiles are serialized. A compile that hangs past its timeout restarts the browser.

The `compile_latex` tool is independent of the backend. A native Node/Bun backend can
replace `HeadlessSiglum` later without changing what agents see.

## Install

```sh
cd mcp
npm install
```

The server uses Playwright's Chromium if it is installed (`npx playwright install chromium`).
Otherwise it falls back to an installed Google Chrome or Microsoft Edge.

### Claude Code

```sh
claude mcp add siglum -- node /path/to/siglum/mcp/src/server.mjs
```

### Other MCP clients

```json
{
  "mcpServers": {
    "siglum": { "command": "node", "args": ["/path/to/siglum/mcp/src/server.mjs"] }
  }
}
```

## Tools

### `compile_latex`

| Argument | Description |
| --- | --- |
| `path` | Main `.tex` file on disk. The files in its directory (or in `projectRoot`) are included: `\input` chapters, images, `.bib`, local `.sty`/`.cls`. |
| `source` | Inline LaTeX, used instead of `path` for quick snippets. `files` adds extra text files. |
| `engine` | `auto` (default), `pdflatex`, or `xelatex`. |
| `outputPath` | PDF destination. Defaults to `<main>.pdf` next to the source, like `pdflatex`. |
| `logLines` | Number of trailing TeX log lines returned (default 40). The full log is always written next to the PDF. |

The tool returns text for the agent plus `structuredContent`
(`success`, `error`, `pdfPath`, `pdfBytes`, `logPath`, `elapsedMs`, `skippedFiles`).
A failed compile sets `isError` and returns the engine's first error, for example
`/main.tex:3: Undefined control sequence.`

Hidden directories, `node_modules`, and build output (`.aux`, `.log`, the previous PDF, and so on)
are not sent. Limits: 2,000 files, 50 MB per file, 200 MB per project.

### `clear_cache`

Clears cached packages and PDFs.

## CLI

The same backend is available without MCP:

```sh
node src/cli.mjs paper.tex -o paper.pdf --engine pdflatex
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `SIGLUM_RUNTIME_SERVICE_URL` | Runtime discovery service passed to `resolveRuntime()` (default `https://packages.siglum.org`). |
| `SIGLUM_RUNTIME_CONFIG_URL` | URL returning a full `SiglumCompiler` config, e.g. `http://localhost:8787/runtime-config.json` from `bun run dev` to use a locally staged runtime. |
| `SIGLUM_ENGINE_SRC` | Engine `src/` to serve. Defaults to this checkout, then the installed `@siglum/engine`. |
| `SIGLUM_MCP_CACHE_DIR` | Browser profile and cache location. |
| `SIGLUM_MCP_PORT` | Local host port (default 47787). Storage is per-origin, so a fixed port keeps the cache. A second instance uses a temporary port and profile. |
| `SIGLUM_MCP_BROWSER_CHANNEL` | Force an installed browser (`chrome`, `msedge`). |
| `SIGLUM_MCP_WARM` | Start the engine when the server starts instead of on the first compile. |
| `SIGLUM_MCP_DEBUG` | Forward engine and page logs to stderr. |

## Tests

```sh
npm test                                   # project loading (no browser)
npm run smoke                              # full MCP round-trip: spawn server, compile, check errors
node test/smoke.mjs test/fixtures/resume/resume.tex
```

The smoke test needs a Chromium-based browser, plus network access on its first run.
