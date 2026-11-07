import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, test, vi } from 'vitest';

const context = createContext({ self: { postMessage() {} }, TextDecoder, URL });
runInContext(readFileSync(resolve(__dirname, '../../src/worker.js'), 'utf8'), context);
const finish = context.finishNativeFonts as (...args: unknown[]) => Promise<number>;

describe('native PDF finalization', () => {
    it.each([0, 3])('finishes a paused native handoff reported with status %s', async status => {
        const resume = vi.fn(() => 0);
        const flush = vi.fn();
        const fetch = vi.fn(async () => false);
        const module = {
            _siglum_finalize_paused: () => 1,
            _siglum_finalize_request_count: () => 0,
            _siglum_finalize_request_overflow: () => 0,
            _siglum_finalize_unsupported_count: () => 0,
            _siglum_finalize_resume: resume,
            _flush_streams: flush,
        };
        const result = await finish(module, { bundleCache: new Map() }, status, fetch, new Map());
        expect(result).toBe(0);
        expect(resume).toHaveBeenCalledOnce();
        expect(flush).toHaveBeenCalledOnce();
    });

    it('preserves a completed or failed run that is not paused', async () => {
        const resume = vi.fn();
        const module = { _siglum_finalize_paused: () => 0, _siglum_finalize_resume: resume };
        expect(await finish(module, {}, 1)).toBe(1);
        expect(resume).not.toHaveBeenCalled();
    });
});

describe('standalone runtime exit handling', () => {
    const run = context.callTexMain as (module: unknown, args: string[]) => number;
    it('returns an Emscripten exit code to the normal package resolver', () => {
        expect(run({ callMain() { throw { name: 'ExitStatus', status: 1 }; } }, [])).toBe(1);
    });
    it('does not turn a WebAssembly trap into a source error', () => {
        const trap = new WebAssembly.RuntimeError('unreachable');
        expect(() => run({ callMain() { throw trap; } }, [])).toThrow(trap);
    });
});

describe('PDF publication guard', () => {
    const complete = context.hasCompletePdf as (data: Uint8Array) => boolean;
    it('rejects incomplete finalization without scanning the document body', () => {
        expect(complete(new TextEncoder().encode('%PDF-1.7\nunfinished stream'))).toBe(false);
        expect(complete(new TextEncoder().encode('%PDF-1.7\nstartxref\n20\n%%EOF\n'))).toBe(true);
        expect(complete(new TextEncoder().encode('%PDF-1.7\n%%EOF\ntruncated continuation'))).toBe(false);
    });
});

describe('native runtime asset cache', () => {
    it('persists a completed asset before returning and isolates runtime identities', async () => {
        const stored = new Map<string, Response>();
        const request = vi.fn(async () => new Response('native glue'));
        context.fetch = request;
        context.caches = { open: async () => ({
            match: async (key: string) => stored.get(key)?.clone(),
            put: async (key: string, response: Response) => { await Promise.resolve(); stored.set(key, response); },
        }) };
        runInContext(`checkpointRuntimeConfig = { identity: 'runtime-a' }`, context);
        const asset = context.fetchCheckpointAsset as (url: string) => Promise<Response>;
        expect(await (await asset('https://fixture.invalid/runtime.js')).text()).toBe('native glue');
        expect(stored.size).toBe(1);
        request.mockRejectedValue(new Error('offline'));
        expect(await (await asset('https://fixture.invalid/runtime.js')).text()).toBe('native glue');
        expect(request).toHaveBeenCalledTimes(1);
        runInContext(`checkpointRuntimeConfig = { identity: 'runtime-b' }`, context);
        await expect(asset('https://fixture.invalid/runtime.js')).rejects.toThrow('offline');
    });
});

describe('native continuation exits', () => {
    it('returns TeX errors raised after a checkpoint or PDF handoff to the resolver', () => {
        const run = context.callNativeEntry as (callback: () => number) => number;
        expect(run(() => { throw { name: 'ExitStatus', status: 1 }; })).toBe(1);
        expect(run(() => 3)).toBe(3);
    });
});


describe('demand-driven runtime ownership lookup', () => {
    const resolveInput = context.shouldResolveRuntimeInput as (name: string, runtime: Map<string, unknown>, stems: Set<string>, catalog?: Set<string>) => boolean;
    it('keeps generated project auxiliaries out of the package resolver', () => {
        const runtime = new Map(), stems = new Set(['main', 'chapter-1']);
        expect(resolveInput('main.aux', runtime, stems)).toBe(false);
        expect(resolveInput('chapter-1.aux', runtime, stems)).toBe(false);
        expect(resolveInput('main-blx.bib', runtime, stems)).toBe(false);
        expect(resolveInput('other.aux', runtime, stems, new Set(['other.aux']))).toBe(true);
    });
    it('allows dynamic runtime discovery without a copied filename catalog', () => {
        const runtime = new Map(), stems = new Set(['article']);
        expect(resolveInput('article.cls', runtime, stems, new Set(['article.cls']))).toBe(true);
        expect(resolveInput('unknown-library.sty', runtime, stems, new Set(['unknown-library.sty']))).toBe(true);
        expect(resolveInput('cmr10.vf', runtime, stems)).toBe(false);
        runtime.set('article.aux', {});
        expect(resolveInput('article.aux', runtime, stems)).toBe(true);
    });
});


describe('optional native allocation diagnostics', () => {
    const read = context.nativeFontMemoryStats as (module: unknown) => unknown;
    it('reports the actual allocation separately from its configured upper limit', () => {
        expect(read({
            _siglum_font_memory_capacity: () => 1000000,
            _siglum_font_memory_limit: () => 8000000,
            _siglum_font_memory_growth_count: () => 2,
        })).toEqual({ fontInfoCapacityWords: 1000000, fontInfoLimitWords: 8000000, fontInfoGrowths: 2 });
    });
    it('keeps older runtimes and unavailable diagnostics compatible', () => {
        expect(read(null)).toEqual({});
        expect(read({})).toEqual({});
        expect(read({ _siglum_font_memory_capacity: () => { throw Error('released module'); } })).toEqual({});
    });
});


describe('worker-owned input catalog', () => {
    const load = context.loadWorkerInputCatalog as (url: string) => Promise<Set<string>>;
    it('persists authoritative membership and reuses it offline', async () => {
        const saved = new Map<string, Response>();
        context.AbortController = AbortController;
        context.setTimeout = setTimeout;
        context.clearTimeout = clearTimeout;
        context.caches = { open: async () => ({
            match: async (url: string) => saved.get(url)?.clone(),
            put: async (url: string, response: Response) => { saved.set(url, response); },
        }) };
        const request = vi.fn(async () => new Response(JSON.stringify({ 'library.sty': 'library', 'virtual.vf': 'virtual', invalid: 2 })));
        context.fetch = request;
        const url = 'https://fixture.invalid/releases/tl2026-0123456789abcdef/bundles/file-to-package.json';
        expect([...await load(url)]).toEqual(['library.sty', 'virtual.vf']);
        request.mockRejectedValue(new Error('offline'));
        expect([...await load(url)]).toEqual(['library.sty', 'virtual.vf']);
        expect(request).toHaveBeenCalledOnce();
    });
    it('leaves ordinary resolution available when no valid catalog can be read', async () => {
        context.caches = { open: async () => ({ match: async () => undefined, put: async () => {} }) };
        context.fetch = vi.fn(async () => new Response('[]'));
        expect([...await load('https://fixture.invalid/releases/tl2026-abcdef0123456789/bundles/file-to-package.json')]).toEqual([]);
    });
});


describe('formatted source and checkpoint input', () => {
    const prepare = context.prepareCompileSource as (source: string, engine: string, format?: unknown) => string;
    const format = { fmtName: 'fixture-format', fmtData: new Uint8Array([1]) };
    it('uses exactly the line-padded body for both TeX and its checkpoint guard', () => {
        const source = '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nÉditable body.\n\\end{document}';
        const prepared = prepare(source, 'pdflatex', format);
        expect(prepared).toBe('%\n%\n\\begin{document}\nÉditable body.\n\\end{document}');
        expect(prepared.split('\n').length).toBe(source.split('\n').length);
    });
    it('keeps the full source if the format buffer is unavailable', () => {
        const source = '\\documentclass{article}\n\\begin{document}Hello\\end{document}';
        expect(prepare(source, 'pdflatex', { fmtData: new Uint8Array() })).toBe(source);
        expect(prepare(source, 'xelatex', format)).toBe(source);
    });
    it('preserves the existing preamble preprocessing on an ordinary full pass', () => {
        const source = '\\documentclass{article}\n\\usepackage{microtype}\n\\begin{document}Hello\\end{document}';
        expect(prepare(source, 'pdflatex')).toContain('\\PassOptionsToPackage{expansion=false}{microtype}\\documentclass');
        expect(prepare(source, 'pdflatex', format)).toBe('%\n%\n\\begin{document}Hello\\end{document}');
    });
});


describe('authoritative source pass analysis', () => {
    it('reports the same existing pass plan without running TeX', async () => {
        const worker = (context as any).self;
        const previous = worker.postMessage;
        const sent = vi.fn();
        worker.postMessage = sent;
        try {
            for (const [source, passes] of [['plain', 1], ['\\ref{a}', 2], ['\\tableofcontents', 3]] as const) {
                await worker.onmessage({ data: { type: 'analyze-source', id: source, source } });
                expect(sent).toHaveBeenLastCalledWith({ type: 'source-analysis-response', id: source, passes });
            }
        } finally { worker.postMessage = previous; }
    });
});


test('prepared source uses the SDK boundary rather than a delimiter in a comment', () => {
    const prepare = context.prepareCompileSource as (source: string, engine: string, format: unknown) => string;
    const prefix = '% example \\begin{document}\n\\documentclass{article}\n';
    const source = prefix + '\\begin {document}\nActual body.\\end{document}';
    expect(prepare(source, 'pdflatex', { fmtData: new Uint8Array([1]), preambleLength: prefix.length }))
        .toBe('%\n%\n\\begin {document}\nActual body.\\end{document}');
});
