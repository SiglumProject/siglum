# Runtime selection and preloading

`initialEngine` is a startup hint for `SiglumCompiler`. It defaults to `pdflatex`.
Pass `xelatex` when the initial document needs that engine so its required bundles
are preloaded. With an explicitly configured experimental checkpoint runtime, the
hint also selects which native payload to load first. It does not enable that
experimental runtime by itself.

```js
const compiler = new SiglumCompiler({
  ...runtimeOptions,
  initialEngine: 'xelatex',
})
await compiler.init()
const result = await compiler.compile(source, { engine: 'xelatex' })
```

Later `compile()` calls can select another engine. The hint does not restrict the
compiler. A host editor should detect its document engine before initialization
and defer initialization on welcome/recovery screens with no document to compile.

The local experimental runtimes support guarded native checkpoints for pdfTeX
and XeTeX. The worker selects the split binary for pdfTeX and the combined binary
for XeTeX and its XDV converter. Selecting `combined` does not disable XeTeX
checkpointing. The matching combined binary must export the XeTeX continuation
ABI; an older binary completes a normal full build and reports the missing
capability in `stats.checkpoint.reason`. Configure `checkpointRuntime.engines`
explicitly for the supported engines and retain the matching immutable runtime.

The host retains one guarded native checkpoint across both engines. Switching
engine/runtime or changing consumed inputs invalidates the saved state. Reuse
skips a validated source prefix and still typesets the remaining suffix.

When a pdfTeX checkpoint already retains the preamble, automatic format generation
must not discard it to serialize a duplicate. Existing serialized formats and
explicit `generateFormat()` calls remain supported. pdfTeX format generation uses
the configured split runtime when available. XeTeX format dumping with native fonts
remains unsupported; ordinary full compilation remains available.

A valid checkpoint can move forward during an existing replay. Candidate input
boundaries come from the project graph, then the native safe-point and consumed-
input guards validate them. An overshot point keeps the old checkpoint. A valid
move releases the old snapshot before capturing its replacement under the same
budget. Scanner scratch is transferred with an opaque one-use lease after a
successful restore; it is never freed through a rewound native allocator.

Font discovery inventories already resident fonts. Deferred virtual files do not
become downloads just because fontconfig scans a directory. Filename requests use
the normal resolver. Optional external tools use the separately registered process
protocol; the engine never rewrites source to pretend a missing tool ran.

`stats.memory.wasmHeapBytes` reports logical linear memory, not browser resident
memory. Growable native font tables report capacity separately from the configured
upper limit when that native runtime exports the diagnostics. Process-tree RSS,
checkpoint bytes, network transfer and visible-preview latency are separate metrics.

When `stats.memory.wasmAllocationComplete` is true, `wasmAllocatedBytes` reports
observed native allocations and growth across the worker, including intermediate
or failed passes. `workerId` scopes that counter to the SDK worker lifetime.
Reusing a checkpoint does not charge its whole heap again. Hosts should reject
incomplete or decreasing counters and retain a conservative legacy fallback.
These totals are an allocation budget, not a measurement of retained RAM.
