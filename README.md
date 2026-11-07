# Siglum

[![npm version](https://img.shields.io/npm/v/@siglum/engine)](https://www.npmjs.com/package/@siglum/engine)
[![weekly npm downloads](https://img.shields.io/npm/dw/@siglum/engine)](https://www.npmjs.com/package/@siglum/engine)
[![license](https://img.shields.io/npm/l/@siglum/engine)](LICENSE)

Siglum is an open-source LaTeX compiler and editor built on BusyTeX and TeX
Live. pdfLaTeX and XeLaTeX run locally in a browser worker. A virtual filesystem
fetches missing TeX files and fonts on demand and caches them for offline use.

The optimization branch combines a small split pdfTeX runtime, cached font maps,
auxiliary-state convergence checks and guarded native checkpoints for both
engines. Checkpoints reuse an unchanged source prefix; unsafe edits take the full
build path. Rust-assisted sparse snapshots bound retained checkpoint storage.
XeTeX also uses packed tables, growable font storage and demand-loaded ICU data.
The matching editor collects final-pass PDF and SyncTeX output, then defers and
indexes source/PDF navigation. The compiler, filesystem and Git integration are
available as separate packages.

These optimizations are local work in progress. Checkpoint reuse still typesets
the remaining document; performance and memory depend on the document and runtime.

Try the [Siglum editor](https://siglum.org/) or use the engine in your own app.

## Quick start

```sh
git clone https://github.com/SiglumProject/siglum.git
cd siglum
bun install --frozen-lockfile
bun run dev
```

Open [localhost:8787](http://localhost:8787/) to try the playground. It uses a
complete matching local runtime when one has been staged, otherwise it loads
compatible runtime assets from Siglum's public service. The first hosted run
needs an internet connection.

## Use it in your application

```sh
npm install @siglum/engine
```

See [usage and bundler setup](docs/usage.md) for a small integration example and
the API. Offline compilation requires the engine and document dependencies to
have been cached.

## Documentation

- [Usage, API, and bundlers](docs/usage.md)
- [Playground tutorial](examples/README.md)
- [Hosted runtime and self-hosting](docs/self-hosting.md)
- [Package API](docs/ctan-proxy.md)
- [Building](docs/building.md)
- [Performance branch](docs/performance.md)

Built on [BusyTeX](https://github.com/busytex/busytex), using
[Siglum's compiler fork](https://github.com/SiglumProject/busytex).

[MIT license](LICENSE).
