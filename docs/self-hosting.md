# Self-hosting Siglum Engine

The npm package contains JavaScript and TypeScript declarations. TeX binaries,
formats, bundles, and package indexes are separate runtime assets. Cloudflare
is optional: the engine uses the HTTP endpoints configured by the application.

## Use Siglum's hosted runtime

A hosted integration can resolve its matching runtime without copying a release
ID into application configuration.

```sh
npm install @siglum/engine
```

```js
import { SiglumCompiler, resolveRuntime } from '@siglum/engine';
import workerUrl from '@siglum/engine/worker?url';

const runtime = await resolveRuntime();
const compiler = new SiglumCompiler({ ...runtime, workerUrl });
await compiler.init();
```

Apply the [bundler configuration](usage.md#usage-with-bundlers-vite-webpack-etc),
including the optional BLAKE3 dependency workaround. `resolveRuntime()` selects
`/engines/<installed-sdk-version>/latest.json` from the package service and
verifies the referenced manifest. Keep its returned immutable URLs for the
compiler's lifetime. `https://packages.siglum.org/latest` redirects to the
current manifest; `/latest.json` provides global discovery metadata.

The resolver caches the verified descriptor and manifest as one pair for offline
metadata reopen. The engine and document dependencies must also be cached before
offline compilation. A new package or font can still require a network connection.

## Host the runtime yourself

Download the runtime archive and checksums from the
[latest engine release](https://github.com/SiglumProject/siglum/releases/latest).
Check that the archive's `runtime.json` has the same `engineVersion` as your
installed package. Extract the matching archive and verify it from this
repository.

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

const RUNTIME_BASE = import.meta.env.VITE_SIGLUM_RUNTIME_BASE;
const compiler = new SiglumCompiler({
  workerUrl,
  wasmUrl: `${RUNTIME_BASE}/wasm/busytex.wasm`,
  bundlesUrl: `${RUNTIME_BASE}/bundles`,
  ctanProxyUrl: RUNTIME_BASE,
  xzwasmUrl: `${RUNTIME_BASE}/xzwasm.js`,
});
await compiler.init();
```

Set `VITE_SIGLUM_RUNTIME_BASE` to your own immutable runtime URL without a trailing slash, such as
`https://your-host.example/releases/<releaseId>`, using the selected manifest's
release ID. See [bundler configuration](usage.md#usage-with-bundlers-vite-webpack-etc)
for the optional BLAKE3 dependency workaround. Serve WASM as
`application/wasm`, preserve binary bytes, and provide CORS headers for any
cross-origin assets. Use HTTPS outside localhost.

A self-hosted discovery adapter can expose the same descriptor routes and use
`resolveRuntime({ baseUrl: 'https://your-host.example' })`. The reference
Cloudflare adapter implements those routes; the standalone Bun package proxy
does not create release descriptors.

## Proxy contract

| Route relative to `ctanProxyUrl` | Response |
| --- | --- |
| `/api/fetch/<pkg>?tlYear=<year>` | Normalized package JSON, including file contents |
| `/api/texlive/<pkg>?tlYear=<year>` | Raw TeX Live `.tar.xz` archive |
| `/api/ctan-pkg/<pkg>` | CTAN package metadata |

Use the `texLiveYear` from the selected runtime manifest. The shared resolver
in `src/texlive.js` configures the default and supported package years. It checks
the current repository's marker for the configured year before using it. Once
that marker is unavailable, it uses that year's historic `tlnet-final` archive.
Explicit compatibility years use separate archives and caches.

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
