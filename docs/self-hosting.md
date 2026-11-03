# Self-hosting Siglum Engine

The npm package contains JavaScript and TypeScript declarations. TeX binaries,
formats, bundles, and package indexes are separate runtime assets. Cloudflare
is optional: the engine uses the HTTP endpoints configured by the application.

## Install and configure

Install `@siglum/engine@0.2.0`. It depends on `@siglum/filesystem@^0.3.0`.
Use the matching runtime archive from the [engine releases](https://github.com/SiglumProject/siglum/releases).
Do not combine the older v0.1.0 assets with the TeX Live 2026 package.

Extract `siglum-runtime-v0.2.0.tar.gz` and verify it from this repository:

```sh
node scripts/verify-runtime.mjs /path/to/extracted/runtime
```

Serve the entire directory under `/releases/<releaseId>/`, where `releaseId`
is recorded in `runtime.json`. Configure `/bundles/` under that prefix to serve
bundle files from the runtime directory root. The proxy routes under the same
prefix need a server; static hosting alone cannot provide on-demand packages.

```js
import { SiglumCompiler } from '@siglum/engine';
import workerUrl from '@siglum/engine/worker?url'; // Vite asset import

const base = 'https://your-host.example/releases/<releaseId>';
const compiler = new SiglumCompiler({
  workerUrl,
  wasmUrl: `${base}/wasm/busytex.wasm`,
  bundlesUrl: `${base}/bundles`,
  ctanProxyUrl: base,
  xzwasmUrl: `${base}/xzwasm.js`,
});
await compiler.init();
```

See [bundler configuration](../README.md#usage-with-bundlers-vite-webpack-etc)
for the optional BLAKE3 dependency workaround. Serve WASM as
`application/wasm`, preserve binary bytes, and provide CORS headers for any
cross-origin assets. Use HTTPS outside localhost.

## Proxy contract

| Route relative to `ctanProxyUrl` | Response |
| --- | --- |
| `/api/fetch/<pkg>?tlYear=2026` | Normalized package JSON, including file contents |
| `/api/texlive/<pkg>?tlYear=2026` | Raw TeX Live `.tar.xz` archive |
| `/api/ctan-pkg/<pkg>` | CTAN package metadata |

The default package year is **2026**. The shared resolver in `src/texlive.js`
checks the current repository's `TEXLIVE_2026` marker before using it. Once
that marker is unavailable, it uses the historic 2026 `tlnet-final` archive;
it does not silently upgrade a 2026 engine to next year's packages. Explicit
compatibility years 2025, 2024, and 2023 are also supported.

Omitting `ctanProxyUrl` disables on-demand package fetching. Bundled packages
remain available. See the [proxy guide](ctan-proxy.md) for caches and routes.

## Reference servers

Both reference servers require Bun and are run from a source checkout:

```sh
# Development server: runtime, examples, and all engine-facing proxy routes.
SIGLUM_DEV_PORT=8787 bun serve-local.ts

# Optional standalone package proxy with persistent disk cache.
CTAN_PROXY_PORT=8081 bun packages/ctan-proxy.ts
```

The development server includes source/example routes; use a reverse proxy or
a dedicated adapter for production. The standalone proxy implements raw
archives, normalized JSON, metadata, dependencies, and stats. It also needs
`src/texlive.js`, the other `packages/` modules, indexes, and installed dependencies;
copying only `ctan-proxy.ts` and `ctan-core.ts` is insufficient.

Siglum's production adapter is maintained in
[siglum-web/worker](https://github.com/SiglumProject/siglum-web/tree/main/worker).
It serves immutable runtime assets from R2. The historical `cloudflare/`
directory in this engine checkout is not the deployed adapter.

## Runtime inventory

`runtime.json` records the engine version, TeX Live year, file sizes, and SHA-256
checksums. The archive includes `wasm/`, the worker, `xzwasm.js`, compressed
and raw bundle data, lookup indexes, and normalized build-required packages.
Keep all files from one manifest together and retain older immutable runtimes
for existing clients. Publishing npm or merging GitHub branches does not
upload these assets or deploy the web app.
