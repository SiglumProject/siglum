# Optional browser tools

The compiler's normal VFS and package resolver load TeX dependencies. A missing style, font or archive member is a resolver problem; adding an external-tool adapter is not its fix.

Some documents genuinely require another program, such as a syntax highlighter or bibliography processor. Register that program explicitly:

```js
const compiler = new SiglumCompiler({
    // The usual bundles, worker and runtime configuration goes here.
    tools: [{
        command: 'my-program',
        kind: 'process',
        revision: assetDigest,
        async run({ args }, context) {
            const input = await context.readFile(args[0]);
            const output = await runIsolatedProgram(input, context.signal);
            return { exitCode: 0, files: [{ path: 'result.dat', bytes: output }] };
        },
    }],
});
```

This registers a virtual process. It never launches a host shell. Programs receive literal parsed arguments. Unregistered commands are denied. Providers must load executable assets from a trusted application configuration; document text cannot install a program.

`readFile` reads the live compilation's project inputs and files written by TeX or an earlier tool. The engine tracks write provenance rather than guessing package-specific filenames. It denies access to unrelated immutable compiler files. `readProjectFile` remains available for caller-supplied project data. Providers receive copies and never see the Emscripten module or browser storage handles.

The engine validates every output path, count and byte size before applying results. Supplied project inputs and immutable compiler files cannot be overwritten. An output failure rolls back earlier writes. Results stream through a fixed 256 KiB shared mailbox, including outputs larger than that mailbox; no base64 expansion is required. Time, aggregate bytes, arguments and file counts are bounded. The synchronous bridge requires cross-origin isolation and SharedArrayBuffer.

A process provider returns a normal exit code. The native import converts it to `system()` wait-status encoding. A nonzero exit is a failure, not a successful fallback output. Generated files survive convergence passes, and changed tool outputs trigger another TeX pass. Compiler success alone is insufficient when a program can leave placeholders: regression checks must verify the actual content.

`kind: 'auxiliary'` registers an asynchronous compiler workflow provider. Its request contains `tool` and generated input bytes; it returns validated output bytes and optional logs. The optional earlier `toolRunner` callback remains compatible. Protocol-specific parsing belongs in the provider. Standard bibliography pass orchestration remains in the compiler.

Per-request cancellation is separate from the outer compile session. A provider may reuse its isolated worker within one compile and must terminate it when that session ends. Native process callbacks and file observers are detached before replacing the WASM module, so cleanup cannot retain old heaps. Tool-dependent jobs currently use full compilation; a TeX checkpoint alone does not account for inputs read by another program.

The editor's `tools/providers.json` describes its installed providers. Its build computes a digest from each descriptor and every adapter, runtime, data and notice file, emits immutable URLs, registers providers lazily, and derives worker CSP rules from the descriptor. Changing an asset changes its URL and cache identity automatically. Ordinary documents do not fetch optional tool runtimes. PDF, format and auxiliary build caches include the registered tool identities; providers without a revision are scoped to the compiler instance. TeX package and bundle URLs remain unchanged.

## Root cause policy

Before adding compatibility behavior:

1. Reproduce the unchanged input and compare against the matching native TeX/runtime when available.
2. Classify the fault: engine/ABI, VFS/path handling, package resolution, external program, unsupported source, or absent project data.
3. Fix an engine, ABI, VFS or resolver defect in that component and add a regression for the whole failure class. Adapters must not conceal it.
4. Use a provider only for a real external program and keep its protocol, filenames and asset details outside the engine.
5. Report absent inputs and unsupported source accurately. Do not invent figures, substitute fonts, alter fixtures, suppress errors or silently rewrite source to increase pass counts. Source migrations must be explicit and separately documented.
6. Verify actual output content, ordinary documents, cold loading, offline reload/edit, desktop and mobile WebKit, cancellation and memory lifetime. Preserve a full-build fallback.

The pre-existing legacy source compatibility routines are separate from this tool API. They are not a pattern for adding new engine fixes and need their own migration-policy review.

A nonzero process exit is a compilation failure. Partial generated files and removals are discarded before any VFS mutation; they cannot turn a failed plot or code generator into a misleading successful PDF. Registered process commands use the native restricted-command configuration for pdfLaTeX and XeLaTeX. The native host shell remains denied.
