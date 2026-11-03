// Headless busytex TexBuildEngine — runs docstrip (`*.ins`/self-extracting
// `*.dtx`) on the same busytex WASM the compiler ships, in the proxy/Bun, with
// no system TeX (plan §4.3).
//
// Critical detail (see plan §9 spike findings): TeX overflows emscripten's
// default 64 KB stack, so this MUST load a busytex binary linked with a larger
// stack (`-sSTACK_SIZE=5242880`). The build output at
// `busytex/build/wasm/busytex.wasm` is such a binary; the repo-root
// `busytex.wasm` is NOT (it reports 64 KB and overflows on any real run).
//
// docstrip is self-contained, so a build needs only `docstrip.tex` + a
// `texmf.cnf` on the search path — not the full texmf or any font/format
// assets. We therefore run `pdftex -ini` (no format), which is what makes this
// cheap and dependency-light.

import { createRequire } from 'module';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

import type { RawFiles, TexBuildEngine } from './types.ts';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url)); // packages/providers
const REPO_ROOT = join(HERE, '..', '..');

// Asset locations (overridable for deployment). Defaults point at the in-repo
// 5 MB-stack build output and the basic texmf tree.
const BUSYTEX_JS =
  process.env.SIGLUM_BUSYTEX_JS || join(REPO_ROOT, 'busytex/build/wasm/busytex.js');
const BUSYTEX_WASM =
  process.env.SIGLUM_BUSYTEX_WASM || join(REPO_ROOT, 'busytex/build/wasm/busytex.wasm');
const TEXMF =
  process.env.SIGLUM_BUSYTEX_TEXMF ||
  join(REPO_ROOT, 'busytex/build/texlive-basic/texmf-dist');

const DOCSTRIP = join(TEXMF, 'tex/latex/base/docstrip.tex');
const TEXMF_CNF = join(TEXMF, 'web2c/texmf.cnf');

// Everything the engine needs must be present, or we report "no engine" so
// build-requiring providers fail with a structured error rather than crash.
export function busytexAssetsAvailable(): boolean {
  return [BUSYTEX_JS, BUSYTEX_WASM, DOCSTRIP, TEXMF_CNF].every(existsSync);
}

// Cache the 30 MB wasm bytes and the loader factory across builds.
let cachedWasm: Uint8Array | undefined;
let cachedFactory: ((cfg: any) => Promise<any>) | undefined;

function loadFactory() {
  if (!cachedFactory) cachedFactory = require(BUSYTEX_JS);
  if (!cachedWasm) cachedWasm = new Uint8Array(readFileSync(BUSYTEX_WASM));
  return { factory: cachedFactory!, wasmBinary: cachedWasm! };
}

const WORK = '/work';
const RUNNER = '__siglum_run.tex'; // catcode-bootstrap wrapper we \input the entry from

export function createBusytexEngine(): TexBuildEngine | undefined {
  if (!busytexAssetsAvailable()) return undefined;

  return {
    name: 'busytex',
    async run({ entry, inputs, command }) {
      const { factory, wasmBinary } = loadFactory();
      // docstrip runs under iniTeX with our own catcode bootstrap (below), so we
      // always invoke pdftex regardless of the requested `command`.
      void command;
      const tool = 'pdftex';

      const log: string[] = [];
      // Fresh Module per build: pdfTeX has C globals that don't reset between
      // runs (the compiler worker recreates the module for the same reason).
      const Module = await factory({
        thisProgram: '/bin/busytex',
        noInitialRun: true,
        noExitRuntime: true,
        wasmBinary,
        print: (t: string) => log.push(t),
        printErr: (t: string) => log.push(t),
        locateFile: (p: string) => p,
      });
      const FS = Module.FS;
      const mkdirp = (p: string) => {
        let cur = '';
        for (const part of p.split('/').filter(Boolean)) {
          cur += '/' + part;
          try {
            FS.mkdir(cur);
          } catch {
            /* exists */
          }
        }
      };

      try {
        FS.mkdir('/bin');
      } catch {}
      try {
        FS.writeFile('/bin/busytex', '');
      } catch {}

      // texmf.cnf so kpathsea works at all. docstrip.tex is dropped directly in
      // the work dir (next to the .ins) and `.` is on TEXINPUTS, so `\input
      // docstrip.tex` resolves without ls-R; we skip it when harvesting below.
      mkdirp('/texlive/texmf-dist/web2c');
      FS.writeFile('/texlive/texmf-dist/web2c/texmf.cnf', readFileSync(TEXMF_CNF));

      mkdirp(WORK);
      FS.chdir(WORK);
      FS.writeFile(`${WORK}/docstrip.tex`, readFileSync(DOCSTRIP));
      for (const [path, data] of Object.entries(inputs)) {
        FS.writeFile(`${WORK}/${basename(path)}`, data);
      }

      // We run iniTeX with NO format, so the standard category codes are not set
      // up — under raw iniTeX `{`/`}` are catcode 12, and real `.ins` files do
      // `\def\batchfile{...}` BEFORE `\input docstrip`, which runs away. Bootstrap
      // the catcodes a format would normally provide, then \input the installer.
      // (docstrip.tex sets up the rest of what it needs once loaded.)
      const bootstrap =
        '\\catcode`\\{=1 \\catcode`\\}=2 \\catcode`\\#=6 \\catcode`\\^=7 ' +
        '\\catcode`\\_=8 \\catcode`\\&=4 \\catcode`\\$=3 ' +
        `\\input ${basename(entry)}\n`;
      FS.writeFile(`${WORK}/${RUNNER}`, bootstrap);

      const ENV = (Module.ENV = Module.ENV || {});
      ENV.TEXMFCNF = '/texlive/texmf-dist/web2c';
      ENV.TEXMFROOT = '/texlive';
      ENV.TEXMFDIST = '/texlive/texmf-dist';
      ENV.TEXMF = '/texlive/texmf-dist';
      ENV.TEXINPUTS = '.:';

      Module.thisProgram = `/bin/${tool}`;
      let exitCode: number | undefined;
      try {
        exitCode = Module.callMain([tool, '-ini', '-interaction=batchmode', RUNNER]);
      } catch (e: any) {
        // docstrip often exits non-zero / the runtime may throw at exit; the
        // caller decides success by whether runtime files were harvested.
        log.push(`[exit] ${e?.message || e}`);
      }
      try {
        (Module as any)._flush_streams?.();
      } catch {}

      // Harvest everything now in the work dir, except the docstrip.tex and the
      // runner we injected (neither is part of the package's runtime output).
      const files: RawFiles = {};
      for (const name of FS.readdir(WORK)) {
        if (name === '.' || name === '..' || name === 'docstrip.tex' || name === RUNNER) continue;
        try {
          files[name] = new Uint8Array(FS.readFile(`${WORK}/${name}`));
        } catch {
          /* directory entry */
        }
      }

      return { files, log: `busytex(${tool} -ini ${basename(entry)}) exit=${exitCode}\n${log.join('\n')}` };
    },
  };
}
