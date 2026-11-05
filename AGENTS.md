# Working in this repository

This repository publishes `@siglum/engine`. The browser editor and production
Cloudflare adapter live in [siglum-web](https://github.com/SiglumProject/siglum-web).
See the [repository map](docs/usage.md#project-repositories) for the shared filesystem,
Git integration, and BusyTeX compiler fork.

## Layout

- `src/` contains the JavaScript API, compiler orchestration, worker, bundle
  loader, package resolver, and browser storage integration.
- `types/` contains declarations generated from `src/` by TypeScript.
- `packages/` contains bundle tooling, package indexes, and the shared CTAN
  proxy implementation. `serve-local.ts` serves the local runtime and proxy.
- `busytex/` is the pinned Siglum BusyTeX submodule. Compiler build changes
  belong in that fork, with its reviewed commit pinned here.
- `tests/` separates unit/integration tests from real-browser worker/WASM tests.
- `docs/` covers building, hosting, and runtime upgrades. `examples/`
  contains consumer integrations.

## Setup and checks

The default install uses the published filesystem package. A single checkout
can run the playground with `bun run dev`; it resolves a matching hosted runtime
when a complete local runtime has not been staged. Read [building](docs/building.md)
before preparing a compiler runtime. Coordinated library/editor source changes
can use the optional [source workspace](https://github.com/SiglumProject/siglum-web/blob/main/docs/development.md#workspace).

```sh
bun install --frozen-lockfile
bun run build:types
bun run test:run
bun run test:types
```

Use `bun run test:browser:run` for real Chromium, Workers, and WASM. It requires
Playwright, the local TeX Live package archives, and runtime files in `dist/`
prepared with `bun run prepare:runtime`. Run `bun run test:proxy` for proxy changes
and `bun run test:bun-parity` for provider changes. The default unit suite uses
happy-dom and does not establish browser compilation or offline correctness.

Keep exported API behavior and generated declarations aligned. Resolve package,
font, and project-path issues through the existing loaders and providers, with
regressions covering the failing input. Preserve offline cache behavior and
multi-file project handling when changing compile orchestration.

## Runtime compatibility

The npm package contains JavaScript and declarations. WASM, glue, formats,
bundles, and indexes are distributed as a separate immutable runtime. Keep
assets from one `runtime.json` together. Generate formats with the exact WASM
that loads them. Read compiler source, ISO, package, and format pins from the
BusyTeX submodule's build inputs and lockfiles.

Use the pinned Podman/Emscripten wrapper in `busytex/build-wasm.sh` for compiler
builds. Stage a combined runtime with
`node scripts/stage-runtime.mjs --combined-only` and verify it with
`node scripts/verify-runtime.mjs <directory-or-URL>`. Follow
[building](docs/building.md) for the required inputs and checks. Keep maintainer
publication procedures in ignored local notes, outside public documentation.
Builds, npm publication, runtime uploads, and web deployment are separate
operations.
