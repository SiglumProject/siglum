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
): Promise<{ success: boolean; pdf?: Uint8Array; timeMs: number; error?: string }> {
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
    };
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
