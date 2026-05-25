/**
 * Comprehensive compilation tests for the Siglum compiler.
 * Tests real document compilation with hash verification and timing constraints.
 *
 * DESIGN: Uses a single shared compiler instance to avoid loading 150MB WASM
 * multiple times. Tests are ordered to avoid state dependencies.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SiglumCompiler } from '../../src/compiler.js';

interface TestProject {
    name: string;
    description: string;
    files: Record<string, string | Uint8Array>;
    mainFile: string;
    engine?: 'pdflatex' | 'xelatex';
    expectedHash?: string;
    maxTimeMs?: number;
    shouldSucceed: boolean;
    tags: string[];
}

// Test projects defined inline to avoid module resolution issues
const PROJECT_HELLO_WORLD: TestProject = {
    name: 'hello-world',
    description: 'Minimal document - baseline compilation test',
    files: {
        'document.tex': `\\documentclass{article}
\\begin{document}
Hello, World!
\\end{document}`,
    },
    mainFile: 'document.tex',
    engine: 'pdflatex',
    maxTimeMs: 5000,
    shouldSucceed: true,
    tags: ['basic', 'fast'],
};

const PROJECT_MATH_PAPER: TestProject = {
    name: 'math-paper',
    description: 'Mathematical paper with equations and theorems',
    files: {
        'document.tex': `\\documentclass{article}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage{amsthm}

\\newtheorem{theorem}{Theorem}

\\title{On Prime Numbers}
\\author{Test Author}

\\begin{document}
\\maketitle

\\section{Introduction}
The study of prime numbers has fascinated mathematicians.

\\begin{theorem}[Euclid]
There are infinitely many prime numbers.
\\end{theorem}

\\begin{proof}
Suppose finitely many primes $p_1, \\ldots, p_n$. Consider:
\\[
N = p_1 \\cdot p_2 \\cdot \\ldots \\cdot p_n + 1
\\]
Contradiction.
\\end{proof}

The quadratic formula:
\\begin{equation}
x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}
\\end{equation}

\\end{document}`,
    },
    mainFile: 'document.tex',
    engine: 'pdflatex',
    maxTimeMs: 8000,
    shouldSucceed: true,
    tags: ['math', 'amsmath'],
};

const PROJECT_CROSS_REFS: TestProject = {
    name: 'cross-refs',
    description: 'Document with cross-references',
    files: {
        'document.tex': `\\documentclass{article}
\\begin{document}

\\tableofcontents

\\section{Introduction}
\\label{sec:intro}
See Section~\\ref{sec:methods}.

\\section{Methods}
\\label{sec:methods}
Back to Section~\\ref{sec:intro}.

\\end{document}`,
    },
    mainFile: 'document.tex',
    engine: 'pdflatex',
    maxTimeMs: 10000,
    shouldSucceed: true,
    tags: ['refs', 'toc'],
};

const PROJECT_TABLES: TestProject = {
    name: 'tables',
    description: 'Document with tables',
    files: {
        'document.tex': `\\documentclass{article}

\\begin{document}
\\section{Data}
\\begin{table}[h]
\\centering
\\begin{tabular}{|l|r|r|}
\\hline
Item & Qty & Price \\\\
\\hline
Apples & 10 & 2.50 \\\\
Oranges & 15 & 3.00 \\\\
\\hline
\\end{tabular}
\\caption{Inventory}
\\end{table}
\\end{document}`,
    },
    mainFile: 'document.tex',
    engine: 'pdflatex',
    maxTimeMs: 6000,
    shouldSucceed: true,
    tags: ['tables'],
};

const PROJECT_CODE_LISTINGS: TestProject = {
    name: 'code-listings',
    description: 'Document with code',
    files: {
        'document.tex': `\\documentclass{article}

\\begin{document}
\\section{Code}
\\begin{verbatim}
def hello():
    print("Hello, World!")
\\end{verbatim}
\\end{document}`,
    },
    mainFile: 'document.tex',
    engine: 'pdflatex',
    maxTimeMs: 8000,
    shouldSucceed: true,
    tags: ['code'],
};

const PROJECT_BIBLIOGRAPHY: TestProject = {
    name: 'bibliography',
    description: 'Document with citations',
    files: {
        'document.tex': `\\documentclass{article}
\\begin{document}
Citation~\\cite{knuth1984}.

\\begin{thebibliography}{9}
\\bibitem{knuth1984}
Donald Knuth. \\textit{The TeXbook}. 1984.
\\end{thebibliography}
\\end{document}`,
    },
    mainFile: 'document.tex',
    engine: 'pdflatex',
    maxTimeMs: 8000,
    shouldSucceed: true,
    tags: ['bibliography'],
};

const PROJECT_UNICODE: TestProject = {
    name: 'unicode',
    description: 'International text',
    files: {
        'document.tex': `\\documentclass{article}

\\begin{document}
German: Gr\\"{u}\\ss{} Gott!
French: Ca va?
Spanish: Hola!
\\end{document}`,
    },
    mainFile: 'document.tex',
    engine: 'pdflatex',
    maxTimeMs: 6000,
    shouldSucceed: true,
    tags: ['unicode'],
};

const PROJECT_MULTI_FILE: TestProject = {
    name: 'multi-file',
    description: 'Multi-file project',
    files: {
        'main.tex': `\\documentclass{article}
\\begin{document}
\\input{chapter1.tex}
\\end{document}`,
        'chapter1.tex': `\\section{Chapter One}
This is chapter content.`,
    },
    mainFile: 'main.tex',
    engine: 'pdflatex',
    maxTimeMs: 8000,
    shouldSucceed: true,
    tags: ['multifile'],
};

// Plain xelatex (no fontspec — avoids needing system fonts). Exercises the
// xdvipdfmx two-step path and the finalize cache under a non-pdflatex engine.
const PROJECT_XELATEX: TestProject = {
    name: 'xelatex-basic',
    description: 'Minimal xelatex document',
    files: {
        'document.tex': `\\documentclass{article}
\\begin{document}
Hello XeLaTeX. $x^2 + y^2 = z^2$.
\\end{document}`,
    },
    mainFile: 'document.tex',
    engine: 'xelatex',
    maxTimeMs: 10000,
    shouldSucceed: true,
    tags: ['xelatex'],
};

// XeLaTeX with a fontspec font requested *by name*. Latin Modern is already in
// the fonts-lm-otf bundle, so no CTAN fetch is needed — but requesting it by
// name still drives XeTeX through fontconfig, which is exactly the path that
// previously hard-crashed ("Fontconfig error: Cannot load default config file"
// / "internal error; cannot read font names"). Regression guard for that crash;
// the CTAN-fetch side of the named-font path is covered by ctan.test.ts.
//
// This also guards XeTeX's ICU converter init (XeTeXFontMgr_FC::initialize →
// ucnv_open "macintosh"/"UTF16BE"/"UTF8"). That init runs once per engine
// startup before *any* font name is read, so if ICU common-data access broke
// for the font manager, this test would fail for *every* fontspec doc — a
// bundled font is enough to catch it; no CTAN-fetched font is required.
const PROJECT_NAMED_FONT: TestProject = {
    name: 'named-font',
    description: 'XeLaTeX with a fontspec font requested by name (fontconfig path)',
    files: {
        'document.tex': `\\documentclass{article}
\\usepackage{fontspec}
\\setmainfont{Latin Modern Roman}
\\begin{document}
Named font via fontspec. $x^2 + y^2 = z^2$.
\\end{document}`,
    },
    mainFile: 'document.tex',
    engine: 'xelatex',
    maxTimeMs: 30000,
    shouldSucceed: true,
    tags: ['xelatex', 'fontspec'],
};

const PROJECT_SYNTAX_ERROR: TestProject = {
    name: 'syntax-error',
    description: 'Should fail',
    files: {
        'document.tex': `\\documentclass{article}
\\begin{document}
$x = \\frac{1}{2
\\end{document}`,
    },
    mainFile: 'document.tex',
    engine: 'pdflatex',
    shouldSucceed: false,
    tags: ['error'],
};

// Base URL for serving static files
const getBaseUrl = () => {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173';
    return `${origin}/dist`;
};

// Simple hash function for PDF verification (first 64KB)
async function hashPdf(pdf: Uint8Array): Promise<string> {
    const chunk = pdf.slice(0, 65536);
    const hashBuffer = await crypto.subtle.digest('SHA-256', chunk);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Compile a test project
async function compileProject(
    compiler: SiglumCompiler,
    project: TestProject,
    options: { useCache?: boolean } = {}
): Promise<{
    success: boolean;
    pdf?: Uint8Array;
    timeMs: number;
    error?: string;
    log?: string;
    stats?: { compileTimeMs?: number; wasmHeapBytes?: number; memory?: { wasmHeapBytes?: number } };
}> {
    const mainSource = project.files[project.mainFile] as string;
    const additionalFiles: Record<string, string | Uint8Array> = {};

    for (const [path, content] of Object.entries(project.files)) {
        if (path !== project.mainFile) {
            additionalFiles[path] = content;
        }
    }

    const start = performance.now();
    const result = await compiler.compile(mainSource, {
        engine: project.engine,
        additionalFiles: Object.keys(additionalFiles).length > 0 ? additionalFiles : undefined,
        useCache: options.useCache ?? false,
    });
    const timeMs = performance.now() - start;

    return {
        success: result.success,
        pdf: result.pdf,
        timeMs,
        error: result.error,
        log: result.log,
        stats: result.stats,
    };
}

// Worker-side compile time (excludes bundle I/O + main-thread overhead). This is the
// metric the perf goal is defined against (result.stats.compileTimeMs).
function workerTimeMs(r: { stats?: { compileTimeMs?: number }; timeMs: number }): number {
    return r.stats?.compileTimeMs ?? r.timeMs;
}

// Heap reading for the bounded-memory invariant (#5). The worker exposes both a flat
// field and a nested one; accept either.
function heapBytes(r: { stats?: { wasmHeapBytes?: number; memory?: { wasmHeapBytes?: number } } }): number {
    return r.stats?.memory?.wasmHeapBytes ?? r.stats?.wasmHeapBytes ?? 0;
}

// ============================================================================
// SHARED COMPILER INSTANCE
// Loading WASM is expensive (~150MB). We share one instance across all tests.
// ============================================================================

let sharedCompiler: SiglumCompiler | null = null;
let initPromise: Promise<void> | null = null;

async function getSharedCompiler(): Promise<SiglumCompiler> {
    if (sharedCompiler && initPromise) {
        await initPromise;
        return sharedCompiler;
    }

    const BASE_URL = getBaseUrl();
    sharedCompiler = new SiglumCompiler({
        wasmUrl: `${BASE_URL}/busytex.wasm`,
        jsUrl: `${BASE_URL}/busytex.js`,
        bundlesUrl: `${BASE_URL}/bundles`,
        enableCtan: false,
        enableLazyFS: false,
        onLog: () => {},
        onProgress: () => {},
    });

    initPromise = sharedCompiler.init();
    await initPromise;
    return sharedCompiler;
}

function terminateSharedCompiler(): void {
    if (sharedCompiler) {
        sharedCompiler.terminate();
        sharedCompiler = null;
        initPromise = null;
    }
}

// ============================================================================
// COMPILATION TESTS
// ============================================================================

describe('Compilation Tests', () => {
    let compiler: SiglumCompiler;
    const timingResults: Array<{
        project: string;
        timeMs: number;
        success: boolean;
        pdfSize?: number;
        pdfHash?: string;
    }> = [];

    beforeAll(async () => {
        compiler = await getSharedCompiler();
    }, 60000);

    afterAll(() => {
        // Log timing summary (don't terminate - other suites may use it)
        if (timingResults.length > 0) {
            console.log('\n=== Compilation Timing Summary ===');
            for (const result of timingResults) {
                const status = result.success ? 'PASS' : 'FAIL';
                const size = result.pdfSize ? `${(result.pdfSize / 1024).toFixed(1)}KB` : 'N/A';
                console.log(`${status} ${result.project}: ${result.timeMs.toFixed(0)}ms (${size})`);
            }
        }
    });

    describe('Core Projects', () => {
        it('should compile hello-world document', async () => {
            const project = PROJECT_HELLO_WORLD;
            const result = await compileProject(compiler, project);

            timingResults.push({
                project: project.name,
                timeMs: result.timeMs,
                success: result.success,
                pdfSize: result.pdf?.length,
                pdfHash: result.pdf ? await hashPdf(result.pdf) : undefined,
            });

            expect(result.success).toBe(true);
            expect(result.pdf).toBeDefined();
            expect(result.pdf!.length).toBeGreaterThan(1000);

            // Verify PDF magic bytes
            expect(result.pdf![0]).toBe(0x25); // %
            expect(result.pdf![1]).toBe(0x50); // P
            expect(result.pdf![2]).toBe(0x44); // D
            expect(result.pdf![3]).toBe(0x46); // F

            if (project.maxTimeMs) {
                expect(result.timeMs).toBeLessThan(project.maxTimeMs);
            }
        }, 30000);

        it('should compile math-paper document', async () => {
            const project = PROJECT_MATH_PAPER;
            const result = await compileProject(compiler, project);

            timingResults.push({
                project: project.name,
                timeMs: result.timeMs,
                success: result.success,
                pdfSize: result.pdf?.length,
                pdfHash: result.pdf ? await hashPdf(result.pdf) : undefined,
            });

            expect(result.success).toBe(true);
            expect(result.pdf).toBeDefined();
            expect(result.pdf!.length).toBeGreaterThan(5000);

            if (project.maxTimeMs) {
                expect(result.timeMs).toBeLessThan(project.maxTimeMs);
            }
        }, 30000);

        it('should compile cross-refs document', async () => {
            const project = PROJECT_CROSS_REFS;
            const result = await compileProject(compiler, project);

            timingResults.push({
                project: project.name,
                timeMs: result.timeMs,
                success: result.success,
                pdfSize: result.pdf?.length,
                pdfHash: result.pdf ? await hashPdf(result.pdf) : undefined,
            });

            expect(result.success).toBe(true);
            expect(result.pdf).toBeDefined();

            if (project.maxTimeMs) {
                expect(result.timeMs).toBeLessThan(project.maxTimeMs);
            }
        }, 30000);

        it('should compile tables document', async () => {
            const project = PROJECT_TABLES;
            const result = await compileProject(compiler, project);

            timingResults.push({
                project: project.name,
                timeMs: result.timeMs,
                success: result.success,
                pdfSize: result.pdf?.length,
                pdfHash: result.pdf ? await hashPdf(result.pdf) : undefined,
            });

            expect(result.success).toBe(true);
            expect(result.pdf).toBeDefined();

            if (project.maxTimeMs) {
                expect(result.timeMs).toBeLessThan(project.maxTimeMs);
            }
        }, 30000);

        it('should fail on syntax-error document', async () => {
            const project = PROJECT_SYNTAX_ERROR;
            const result = await compileProject(compiler, project);

            timingResults.push({
                project: project.name,
                timeMs: result.timeMs,
                success: result.success,
            });

            expect(result.success).toBe(false);
        }, 30000);
    });

    describe('Extended Projects', () => {
        it('should compile code-listings document', async () => {
            const project = PROJECT_CODE_LISTINGS;
            const result = await compileProject(compiler, project);

            timingResults.push({
                project: project.name,
                timeMs: result.timeMs,
                success: result.success,
                pdfSize: result.pdf?.length,
                pdfHash: result.pdf ? await hashPdf(result.pdf) : undefined,
            });

            expect(result.success).toBe(true);
            expect(result.pdf).toBeDefined();

            if (project.maxTimeMs) {
                expect(result.timeMs).toBeLessThan(project.maxTimeMs);
            }
        }, 30000);

        it('should compile bibliography document', async () => {
            const project = PROJECT_BIBLIOGRAPHY;
            const result = await compileProject(compiler, project);

            timingResults.push({
                project: project.name,
                timeMs: result.timeMs,
                success: result.success,
                pdfSize: result.pdf?.length,
                pdfHash: result.pdf ? await hashPdf(result.pdf) : undefined,
            });

            expect(result.success).toBe(true);
            expect(result.pdf).toBeDefined();

            if (project.maxTimeMs) {
                expect(result.timeMs).toBeLessThan(project.maxTimeMs);
            }
        }, 30000);

        it('should compile unicode document', async () => {
            const project = PROJECT_UNICODE;
            const result = await compileProject(compiler, project);

            timingResults.push({
                project: project.name,
                timeMs: result.timeMs,
                success: result.success,
                pdfSize: result.pdf?.length,
                pdfHash: result.pdf ? await hashPdf(result.pdf) : undefined,
            });

            expect(result.success).toBe(true);
            expect(result.pdf).toBeDefined();

            if (project.maxTimeMs) {
                expect(result.timeMs).toBeLessThan(project.maxTimeMs);
            }
        }, 30000);

        it('should compile multi-file document', async () => {
            const project = PROJECT_MULTI_FILE;
            const result = await compileProject(compiler, project);

            timingResults.push({
                project: project.name,
                timeMs: result.timeMs,
                success: result.success,
                pdfSize: result.pdf?.length,
                pdfHash: result.pdf ? await hashPdf(result.pdf) : undefined,
            });

            expect(result.success).toBe(true);
            expect(result.pdf).toBeDefined();

            if (project.maxTimeMs) {
                expect(result.timeMs).toBeLessThan(project.maxTimeMs);
            }
        }, 30000);

        it('should compile a fontspec font requested by name', async () => {
            const project = PROJECT_NAMED_FONT;
            const result = await compileProject(compiler, project);

            timingResults.push({
                project: project.name,
                timeMs: result.timeMs,
                success: result.success,
                pdfSize: result.pdf?.length,
                pdfHash: result.pdf ? await hashPdf(result.pdf) : undefined,
            });

            expect(result.success).toBe(true);
            expect(result.pdf).toBeDefined();

            if (project.maxTimeMs) {
                expect(result.timeMs).toBeLessThan(project.maxTimeMs);
            }
        }, 45000);
    });

    describe('State Isolation', () => {
        it('should not leak state between different documents', async () => {
            // Compile document A
            const resultA = await compileProject(compiler, PROJECT_HELLO_WORLD);
            expect(resultA.success).toBe(true);
            const hashA = await hashPdf(resultA.pdf!);

            // Compile document B (different)
            const resultB = await compileProject(compiler, PROJECT_MATH_PAPER);
            expect(resultB.success).toBe(true);

            // Compile document A again - should produce identical output
            const resultA2 = await compileProject(compiler, PROJECT_HELLO_WORLD);
            expect(resultA2.success).toBe(true);
            const hashA2 = await hashPdf(resultA2.pdf!);

            expect(hashA).toBe(hashA2);
        }, 60000);
    });
});

// ============================================================================
// PERFORMANCE BENCHMARKS
// ============================================================================

describe('Performance Benchmarks', () => {
    let compiler: SiglumCompiler;

    beforeAll(async () => {
        compiler = await getSharedCompiler();
    }, 60000);

    it('should compile hello-world under 2 seconds after warmup', async () => {
        // First compile is warmup (bundles already loaded from previous tests)
        await compileProject(compiler, PROJECT_HELLO_WORLD);

        // Timed compilation
        const result = await compileProject(compiler, PROJECT_HELLO_WORLD);

        expect(result.success).toBe(true);
        expect(result.timeMs).toBeLessThan(2000);

        console.log(`Hello-world (warmed): ${result.timeMs.toFixed(0)}ms`);
    }, 30000);

    it('should compile math-paper under 4 seconds after warmup', async () => {
        await compileProject(compiler, PROJECT_MATH_PAPER);
        const result = await compileProject(compiler, PROJECT_MATH_PAPER);

        expect(result.success).toBe(true);
        expect(result.timeMs).toBeLessThan(4000);

        console.log(`Math-paper (warmed): ${result.timeMs.toFixed(0)}ms`);
    }, 30000);

    it('should show consistent timing across multiple runs', async () => {
        const times: number[] = [];

        // Warmup
        await compileProject(compiler, PROJECT_HELLO_WORLD);

        // 5 timed runs
        for (let i = 0; i < 5; i++) {
            const result = await compileProject(compiler, PROJECT_HELLO_WORLD);
            expect(result.success).toBe(true);
            times.push(result.timeMs);
        }

        const avg = times.reduce((a, b) => a + b, 0) / times.length;
        const stdDev = Math.sqrt(
            times.map(t => (t - avg) ** 2).reduce((a, b) => a + b, 0) / times.length
        );

        console.log(`Hello-world 5 runs: avg=${avg.toFixed(0)}ms, stdDev=${stdDev.toFixed(0)}ms`);
        console.log(`  Individual times: ${times.map(t => t.toFixed(0)).join(', ')}ms`);

        // Standard deviation should be less than 50% of average
        expect(stdDev).toBeLessThan(avg * 0.5);
    }, 60000);
});

// ============================================================================
// OUTPUT VERIFICATION
// ============================================================================

describe('Output Verification', () => {
    let compiler: SiglumCompiler;

    beforeAll(async () => {
        compiler = await getSharedCompiler();
    }, 60000);

    it('should produce consistent PDF hash for same input', async () => {
        const result1 = await compileProject(compiler, PROJECT_HELLO_WORLD);
        const result2 = await compileProject(compiler, PROJECT_HELLO_WORLD);

        expect(result1.success).toBe(true);
        expect(result2.success).toBe(true);

        const hash1 = await hashPdf(result1.pdf!);
        const hash2 = await hashPdf(result2.pdf!);

        console.log(`Hash 1: ${hash1}, Hash 2: ${hash2}`);
        expect(hash1).toBe(hash2);
    }, 30000);

    it('should produce reasonable PDF sizes', async () => {
        const testCases = [
            { project: PROJECT_HELLO_WORLD, minSize: 1000, maxSize: 50000 },
            { project: PROJECT_MATH_PAPER, minSize: 5000, maxSize: 200000 },
        ];

        for (const { project, minSize, maxSize } of testCases) {
            const result = await compileProject(compiler, project);
            expect(result.success).toBe(true);

            const size = result.pdf!.length;
            console.log(`${project.name}: ${(size / 1024).toFixed(1)}KB`);

            expect(size).toBeGreaterThan(minSize);
            expect(size).toBeLessThan(maxSize);
        }
    }, 60000);
});

// ============================================================================
// GOAL-MODE CONJUNCTION (compile-perf)
// Guards the COMPILE_PERF_PLAN.md success conjunction. A fix is accepted only if
// all five invariants hold simultaneously. See COMPILE_PERF_PLAN.md §2.
// ============================================================================

describe('Compile-perf goal conjunction', () => {
    let compiler: SiglumCompiler;

    // Warm-speed gate. Measured baselines (local, headless chromium):
    //   regressed warm compile ~312ms (stats.compileTimeMs); after the 4A
    //   finalize-cache fix, steady-state warm compile ~90ms. The gate sits above the
    //   fixed value with headroom but well below the regression it guards.
    const T_WARM_MS = 150;
    // Single live WASM module is ~150MB. The module is destroyed+recreated every
    // compile, so peak heap must stay near one module's worth, not grow with N.
    const HEAP_CEILING_BYTES = 280 * 1024 * 1024;

    beforeAll(async () => {
        compiler = await getSharedCompiler();
    }, 60000);

    // Invariant #1 — Warm speed (the regression gate).
    // The finalize cache makes the dominant ~210ms font-map step deterministically
    // free on warm compiles; the residual (~module + mount + TeX run) jitters, so we
    // gate the steady-state warm latency (min of several warm compiles) rather than a
    // single sample. The min sits ~90ms; the gate is far below the ~312ms regression.
    it('#1 warm: warm hello-world compile stays under the warm gate', async () => {
        // First compile primes the finalize cache for this bundle set.
        await compileProject(compiler, PROJECT_HELLO_WORLD);

        const warmTimes: number[] = [];
        for (let i = 0; i < 4; i++) {
            const warm = await compileProject(compiler, PROJECT_HELLO_WORLD);
            expect(warm.success).toBe(true);
            warmTimes.push(workerTimeMs(warm));
        }
        const best = Math.min(...warmTimes);
        console.log(`#1 warm hello-world: stats.compileTimeMs min=${best.toFixed(0)}ms of [${warmTimes.map(t => t.toFixed(0)).join(', ')}] (gate ${T_WARM_MS}ms)`);
        expect(best).toBeLessThanOrEqual(T_WARM_MS);
    }, 60000);

    // Invariant #2 — Single-pass correctness.
    it('#2 single-pass: produces a valid PDF', async () => {
        const r = await compileProject(compiler, PROJECT_HELLO_WORLD);
        expect(r.success).toBe(true);
        expect(r.pdf).toBeDefined();
        expect(r.pdf!.length).toBeGreaterThan(1024);
        // %PDF magic
        expect(r.pdf![0]).toBe(0x25);
        expect(r.pdf![1]).toBe(0x50);
        expect(r.pdf![2]).toBe(0x44);
        expect(r.pdf![3]).toBe(0x46);
    }, 30000);

    // Invariant #3 — Multi-pass correctness (cross-refs actually resolved).
    it('#3 multi-pass: cross-references resolve (no undefined refs)', async () => {
        const r = await compileProject(compiler, PROJECT_CROSS_REFS);
        expect(r.success).toBe(true);
        expect(r.pdf).toBeDefined();
        expect(r.pdf!.length).toBeGreaterThan(1024);
        // Final-pass log must show fully resolved references — neither an
        // outstanding "undefined references" warning nor a pending rerun request.
        const log = r.log ?? '';
        expect(/there were undefined references/i.test(log)).toBe(false);
        expect(/rerun to get|label\(s\) may have changed/i.test(log)).toBe(false);
    }, 30000);

    // Invariant #4 — Cross-doc correctness (no stale state via the cache or module).
    it('#4 cross-doc: A then B then A back-to-back all stay valid', async () => {
        const a1 = await compileProject(compiler, PROJECT_HELLO_WORLD);
        expect(a1.success).toBe(true);
        expect(a1.pdf![0]).toBe(0x25); // %PDF

        const b = await compileProject(compiler, PROJECT_MATH_PAPER);
        expect(b.success).toBe(true);
        expect(b.pdf![0]).toBe(0x25); // %PDF
        expect(b.pdf!.length).toBeGreaterThan(5000);

        const a2 = await compileProject(compiler, PROJECT_HELLO_WORLD);
        expect(a2.success).toBe(true);
        expect(a2.pdf![0]).toBe(0x25); // %PDF

        // A's output must be unchanged by B running in between (no cache/global bleed).
        // Output is reproducible (SOURCE_DATE_EPOCH is pinned), so stale pdfTeX C-globals
        // or finalize-cache cross-talk would surface as a PDF byte difference here.
        const hashA1 = await hashPdf(a1.pdf!);
        const hashA2 = await hashPdf(a2.pdf!);
        expect(hashA2).toBe(hashA1);
    }, 90000);

    // Engine coverage — the headline warm gate (#1) is pdflatex (custom .fmt fast
    // path). xelatex has no format dump, so it can't reach that latency, but the
    // finalize cache and reproducibility must still apply. Cold ~645ms; warm ~325ms
    // (finalize cached). Gate guards that the cache benefit holds for xelatex too.
    const T_WARM_XELATEX_MS = 480;
    it('#1x warm (xelatex): finalize cache benefit + reproducible output', async () => {
        const cold = await compileProject(compiler, PROJECT_XELATEX);
        expect(cold.success).toBe(true);
        expect(cold.pdf![0]).toBe(0x25); // %PDF

        const w1 = await compileProject(compiler, PROJECT_XELATEX);
        const w2 = await compileProject(compiler, PROJECT_XELATEX);
        expect(w1.success && w2.success).toBe(true);

        const best = Math.min(workerTimeMs(w1), workerTimeMs(w2));
        console.log(`#1x xelatex warm: cold=${workerTimeMs(cold).toFixed(0)}ms warm-min=${best.toFixed(0)}ms (gate ${T_WARM_XELATEX_MS}ms)`);
        expect(best).toBeLessThanOrEqual(T_WARM_XELATEX_MS);

        // Reproducible output for the xelatex/xdvipdfmx path too.
        expect(await hashPdf(w2.pdf!)).toBe(await hashPdf(w1.pdf!));
    }, 90000);

    // Invariant #5 — Bounded memory across many compiles.
    it('#5 bounded memory: heap stays bounded across 20 compiles', async () => {
        const heaps: number[] = [];
        for (let i = 0; i < 20; i++) {
            const r = await compileProject(compiler, PROJECT_HELLO_WORLD);
            expect(r.success).toBe(true);
            heaps.push(heapBytes(r));
        }

        const peak = Math.max(...heaps);
        const first = heaps[0];
        const last = heaps[heaps.length - 1];
        console.log(`#5 heap peak=${(peak / 1048576).toFixed(0)}MB first=${(first / 1048576).toFixed(0)}MB last=${(last / 1048576).toFixed(0)}MB`);

        // Peak must stay near one module's footprint, not accumulate per compile.
        expect(peak).toBeLessThan(HEAP_CEILING_BYTES);
        // And must not trend upward across the run (no per-compile leak).
        expect(last).toBeLessThanOrEqual(first * 1.5);
    }, 120000);
});

// ============================================================================
// CLEANUP - Must be last
// ============================================================================

describe('Cleanup', () => {
    afterAll(() => {
        terminateSharedCompiler();
    });

    it('should terminate shared compiler', () => {
        // This test exists to ensure afterAll runs
        expect(true).toBe(true);
    });
});
