# Optional auxiliary tools

A successful TeX pass can produce input for another program. When a document
emits a Biber control file (`.bcf`), the compiler can invoke an application-owned
`toolRunner`. The default compiler does not download or bundle Biber.

```js
const compiler = new SiglumCompiler({
  // Other runtime options...
  async toolRunner(job, { readProjectFile, signal }) {
    // job.tool is 'biber'; job.input contains the generated BCF bytes.
    // Delegate to an isolated Biber provider and return { bytes, log }.
    return biberProvider(job.input, readProjectFile, signal);
  },
});
```

`readProjectFile(path)` resolves relative to the main TeX file. It permits parent
references within the project, rejects paths outside it, and returns a copy of
an explicitly supplied project input. It does not search browser storage or
package caches. Inputs and output are bounded; cancellation propagates when the
compile is terminated. A fresh bibliography is followed by TeX reruns. Tool invocation invalidates
TeX-only checkpoints for that build, since the tool can read dependencies TeX
never opens. It keeps the small pdfTeX runtime and uses the full-build pipeline.
A project-supplied `.bbl` remains usable without a tool provider.

The callback is trusted application code, not a sandbox. A provider must isolate
its runtime, honour cancellation, terminate its worker, validate control files
and output, and restrict network access and JavaScript string evaluation. Keep
tool assets pinned and cache them for offline use. Nothing should be uploaded to
a bibliography service. Tool binaries and their licensing are separate from the
engine package. The local Biber provider remains an opt-in integration.
