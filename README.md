# Siglum

[![npm version](https://img.shields.io/npm/v/@siglum/engine)](https://www.npmjs.com/package/@siglum/engine)
[![weekly npm downloads](https://img.shields.io/npm/dw/@siglum/engine)](https://www.npmjs.com/package/@siglum/engine)
[![license](https://img.shields.io/npm/l/@siglum/engine)](LICENSE)

A WebAssembly LaTeX compiler for browser applications. Runs TeX Live locally
with pdfLaTeX and XeLaTeX, fetches packages on demand, and caches dependencies
for offline compilation.

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

Built on [BusyTeX](https://github.com/busytex/busytex), using
[Siglum's compiler fork](https://github.com/SiglumProject/busytex).

[MIT license](LICENSE).
