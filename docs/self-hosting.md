# Self-hosting siglum-engine (without Cloudflare)

**Status:** Reference
**Audience:** anyone running the engine on their own infrastructure.

---

## The engine is host-agnostic

The published package is just `src/` (`"files": ["src/", "types/"]`). It runs in
the browser and **never talks to CTAN, R2, or Cloudflare directly** — it talks to
an HTTP **proxy** over a fixed contract, configured by URL. Cloudflare is one
deployment of that proxy (Siglum's); it is not required.

You configure three URLs on the `Compiler`:

```js
import { Compiler } from '@siglum/engine/compiler';

const compiler = new Compiler({
  wasmUrl:      'https://cdn.example.com/busytex.wasm', // the TeX WASM binary
  bundlesUrl:   'https://cdn.example.com/bundles',      // bundle data + font maps
  ctanProxyUrl: 'https://proxy.example.com',            // the CTAN proxy (below)
});
```

If `ctanProxyUrl` is omitted, on-demand CTAN fetching is simply disabled
(`enableCtan` defaults to `ctanProxyUrl !== null`); bundled packages still work.

## The proxy contract

`ctanProxyUrl` must answer these routes (see `src/ctan.js`):

| Route | Returns |
|------|---------|
| `GET /api/fetch/<pkg>[?tlYear=YYYY]` | Processed package JSON — **this is where on-demand package + font-stem resolution and the normalized-artifact cache live** |
| `GET /api/texlive/<pkg>` | Raw TeX Live `.tar.xz` (client decompresses) |
| `GET /api/ctan-pkg/<pkg>` | CTAN package info passthrough |

`bundlesUrl` serves static files: the bundle data (`*.data.gz`), `bundles.json`,
`file-manifest.json`, and the font maps (`font-file-to-package.json`,
`font-name-to-package.json`, …). It can be the same origin as the proxy or a
plain CDN.

## What the repo ships to implement the contract

Two **host-neutral** Bun/Node servers (pure `fs` + `fetch`, zero Cloudflare):

- **`serve-local.ts`** — implements the *full* engine-facing contract (`/bundles`,
  `/api/texlive`, `/api/ctan-pkg`, `/api/fetch`) plus dev conveniences. It is
  dev-oriented (also serves `/src`, `/examples`, …), so for production you would
  run it behind a reverse proxy / strip the dev routes, or port its handlers.
  Port via `SIGLUM_DEV_PORT` (default 8787).
- **`packages/ctan-proxy.ts`** — a focused CTAN fetch + **disk cache** service
  (`/api/fetch`, `/api/pkg`, `/api/deps`, `/api/stats`). `serve-local.ts`
  forwards to it on `localhost:8081` when present, so running both gives you a
  persistent on-disk package cache. Port via `CTAN_PROXY_PORT`, cache dir via
  `CTAN_PROXY_CACHE_DIR`.

`cloudflare/worker.ts` is a third implementation — the **serverless port** of the
same contract (R2 instead of `fs`, embedded manifest instead of `readdir`),
needed only because a Worker can't run the Bun server. It is Siglum's deployment,
kept out of the engine. If your platform is also serverless, port the contract
the same way; the engine doesn't change.

### Minimal setup

```sh
# 1. Obtain the bundle artifacts (see below) into ./packages/bundles
# 2. Run the reference server
SIGLUM_DEV_PORT=8787 bun serve-local.ts
#    (optional) persistent disk cache backend:
CTAN_PROXY_PORT=8081 bun packages/ctan-proxy.ts
# 3. Point the engine at it: ctanProxyUrl: 'http://your-host:8787'
```

## Where the data comes from

`packages/bundles/` holds two kinds of artifact, handled differently:

- **Derived index / lookup tables** — `file-manifest.json`, `file-to-package.json`,
  `font-file-to-package.json`, `font-name-to-package.json`, `bundles.json`,
  `package-deps.json`. These are **committed** (moderate-size, rarely-changing
  lookups the proxy and engine need) and served at `bundlesUrl`.
  `font-file-to-package.json` is what makes font-stem resolution work on any host
  — it's built from the TLPDB by `scripts/build-font-file-index.js`, so every TeX
  Live font file resolves to its package.
- **Bulk payloads + content caches** — the bundle data (`*.data.gz`), the
  `busytex.wasm` binary, and the build-required `prebuilt/<pkg>.json` artifacts —
  are **gitignored** (large and/or regeneratable). Fetch from GitHub releases, or
  regenerate: bundles with the bundling scripts, prebuilt with `bun
  scripts/prebuild-packages.js`, the WASM from the busytex submodule build. Serve
  the data + WASM at `bundlesUrl` / `wasmUrl`. The dev/proxy servers read prebuilt
  from disk; a serverless adapter ships them to its object store and gates on the
  generated `_index.json` manifest.

## Summary

The browser engine is genuinely host-agnostic: it speaks an HTTP contract and
nothing more. To self-host, stand up any server that answers that contract — the
repo's `serve-local.ts` / `ctan-proxy.ts` do, with no Cloudflare — supply the
bundle/WASM artifacts from releases, and point `ctanProxyUrl` / `bundlesUrl` /
`wasmUrl` at your endpoints. Cloudflare + R2 is one such backend, not a
requirement.
