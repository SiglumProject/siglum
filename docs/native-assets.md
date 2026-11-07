# Optional native runtime data

The runtime can keep immutable native-library data outside WebAssembly and load
only the files a compilation opens. The normal compiler API remains the same.
This is separate from LaTeX package discovery: the native library opens its own
files through the same Emscripten filesystem.

Runtime builders declare `nativeResources` in `bundles.json`. Each descriptor has
schema `version: 1`, an applicable runtime kind, an absolute filesystem directory,
an exported zero-argument initializer, and a relative resource-index URL. The
initializer configures its native library to read from the declared directory.

The versioned index names an immutable data pack and gives each file's name,
offset, length and SHA-256. Names must be safe relative paths; offsets must be
ordered, nonoverlapping and in bounds. The loader currently accepts at most
8,192files in a64MiB pack. These are explicit resource bounds, not locale filters.

The worker creates directory metadata first. Individual MEMFS nodes appear on
lookup, with known sizes, and bytes load on read or mmap. A synchronous range
request preserves the native call stack. Servers that ignore Range can return
the bounded complete pack; requested slices still receive integrity checks.
Read-only nodes protect the shared byte cache across fresh native instances.

Verified bytes and the used-file set persist in a separate Cache Storage namespace.
A fresh worker restores previously used files before entering native code. Cache
writes and digest checks settle before a successful output is published, so a
successful online build can reopen with those dependencies offline. A new,
uncached dependency still requires the network. Browser eviction or failed disk
storage can remove offline availability. The index and resources are scoped to
their complete immutable URLs, keeping runtime releases isolated.

The helper is loaded only when the combined runtime needs it. The checkpoint
pdfTeX startup path does not fetch native data. Checksum verification uses
SubtleCrypto where available and a bounded standard SHA-256 implementation on
HTTP LAN previews. See [FIPS180-4](https://csrc.nist.gov/pubs/fips/180-4/upd1/final).

ICU is the first integration. Its full matching data package is indexed; no
languages or converters are removed. ICU already supports file-backed data;
see its [data guide](https://unicode-org.github.io/icu/userguide/icu_data/).
The BusyTeX fork's `experimental/checkpoint/native-preview/native-data/` recipe
records how to pair the matching stubdata link, initializer, data pack and index.

Pair this optional runtime with a compatible SDK/worker. Preserve the embedded
combined runtime at its immutable URL, and establish a compatible selection or
fallback path before moving public aliases used by older clients. This local
integration does not change existing production runtime URLs.
