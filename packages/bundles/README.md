# TeX Live bundles

Siglum loads these TeX Live bundles as the document needs them. Keep the
data files, indexes, formats, and BusyTeX WASM from the same immutable runtime.

## Get the bundles

Download the matching runtime from the
[latest engine release](https://github.com/SiglumProject/siglum/releases/latest) or follow
the [build and restore instructions](../../docs/building.md). The release
includes a manifest for checking each artifact's size and SHA-256 hash.

Resolve the runtime for the installed SDK and fetch its bundle registry:

```js
import { resolveRuntime } from '@siglum/engine';

const runtime = await resolveRuntime();
const response = await fetch(`${runtime.bundlesUrl}/bundles.json`);
if (!response.ok) throw new Error(`Bundle registry request failed: HTTP ${response.status}`);
const registry = await response.json();
```

The resolver automatically chooses
`/engines/<installed-sdk-version>/latest.json`, verifies its descriptor and
manifest, and returns immutable asset URLs. Keep those URLs together for the
compiler's lifetime. `https://packages.siglum.org/latest` redirects
readers to the current manifest; `/latest.json` provides global discovery.

Cached verified metadata supports offline resolution after a network failure.
The document's engine, bundles, packages, and fonts must also be cached for
offline compilation. See the [public package API](../../docs/ctan-proxy.md#public-package-api)
for discovery and package requests.

## Files

- `*.data.gz` contains compressed concatenated bundle files.
- `*.raw` serves the same data for byte-range requests.
- `bundles.json` lists bundle sizes, file counts, package aliases, and
  dependencies. Its optional `sourceCommands` object maps TeX control-word
  names without the leading backslash to package names. The splitter preserves
  this field.
- `file-manifest.json` maps each `/texlive/` path to a bundle and byte range.
- `file-to-package.json` maps filenames to TeX Live package names.
- `package-deps.json` lists package dependencies.

See [self-hosting](../../docs/self-hosting.md) for serving an immutable runtime.
