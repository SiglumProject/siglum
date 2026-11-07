# Browser compilation optimizations

The `performance-optimization` branch is local development work. The published
npm packages and production runtime are separate. Normal full builds remain
available; these experiments do not promise single-digit-millisecond full books.

## Native compilation

The SDK uses a split pdfTeX binary for pdfLaTeX and the combined binary for
XeLaTeX and its XDV converter. Both can use the same guarded checkpoint driver.
`combined` describes a binary, not a checkpoint bypass. An incompatible native
binary completes a full build and exposes its missing capability in
`stats.checkpoint.reason`.

A same-instance checkpoint preserves native memory, mutable files and streams.
Reuse requires matching runtime, consumed source/dependencies and auxiliary
state. It skips a validated source prefix and still typesets the remaining
suffix. Earlier dependency changes, new resources, external tool dependencies
and unsafe source edits use the ordinary full-build resolver. No package names
select a special checkpoint path.

Sparse snapshots skip zero pages. Tiny read-only Rust helpers scan and compare
pages; Xe snapshots additionally share repeated pages only after full byte
comparison. Fingerprints select candidates and cannot substitute unequal data.
Only one checkpoint is retained. Its heap-plus-mutable-files budget excludes
other worker/browser allocations and temporary capture storage. An oversized
candidate can be discarded while its valid native pass finishes.

The native fork also contains growable font storage, packed XeTeX tables and
file-backed ICU data. It retains the full matching ICU resource pack. These
changes need the corresponding native build, formats, resource index and SDK.
See [runtime selection](runtime-selection.md) and [native data](native-assets.md).

## Loading, passes and output

The worker loads bundles and resolves missing files through the existing VFS and
package system. Large font bundles support range loading, resolved font maps are
cached, and project updates transfer changed files. Package discovery derives
bundled style/class ownership from metadata; an unambiguous bundled file does
not require a duplicate package download.

Auxiliary state and TeX rerun requests determine convergence. PDF/SyncTeX output
is collected after the final pass. The editor defers SyncTeX indexing until the
first page is drawn or an explicit jump needs it. Forward/inverse/page navigation
uses indexes shared with the mobile lens. The engine returns SyncTeX data; the
editor's navigation index is not a separate engine SDK API.

## Local integration

Use the editor's optional source workspace when changing libraries together.
A source checkout alone does not replace a native WASM build. Keep compiled
assets and formats from a matching manifest together.

`stage:experimental` assembles and verifies an immutable local runtime from an
existing manifest configuration and optional replacement files. Its resulting
`server-config.json` uses relative paths, so the complete directory can move
without depending on a benchmark workspace. It uses the same manifest identity
rules as the public SDK and performs no uploads.

The editor's `preview:experimental` command serves a built editor and the
selected runtime with Range responses, cross-origin isolation, tool-worker
policies and the local package API. Set `SIGLUM_PREVIEW_CONFIG` to the staged
`server-config.json` and `SIGLUM_PREVIEW_DIR` to the matching editor build.
The build must use `/engine` as its API base and the staged manifest's release
ID. Old immutable runtime and app paths can be supplied as explicit fallbacks;
do not clear browser document storage when switching builds.

## Separate rendering laboratory

The editor retains a separately gated plain-paragraph rendering experiment.
It supports a restricted syntax/layout and uses a full build when its eligibility
checks reject an edit. It is not the native checkpoint implementation and does
not provide general XeLaTeX paragraph-only PDFs.

Its worker assets are generated with `prepare:paragraph` from a complete matching
local runtime. The generator extracts required metrics/outlines from the runtime
file manifest, rejects ambiguous resource names and records hashes. This avoids
relying on files from a past benchmark directory. The laboratory remains opt-in;
its packaging and rendering behavior are separate from production activation.

## Validation and remaining limits

Compare full text, page counts, selected rasters, references and normalized
SyncTeX against a full build. Exercise consumed/future dependencies, pagination,
new resource demand, cancellation, memory retention and fresh offline workers.
Test desktop and small-screen WebKit, and distinguish browser emulation from a
physical iPhone check.

Measure native work, output conversion, visible preview and browser process
memory separately. Logical WASM bytes and retained snapshot size are not RSS.
A faster repeated edit can cost retained memory or a slower first build; publish
matched measurements rather than claiming a universal speed or memory win.
