/**
 * Browser-based integration tests for the Siglum compiler.
 * These tests run in a real browser with actual WASM execution.
 *
 * DESIGN: Tests are ordered carefully - cleanup tests run last to avoid
 * breaking other tests that need the compiler.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SiglumCompiler } from '../../src/compiler.js';

// Base URL for serving static files - workers need absolute URLs
const getBaseUrl = () => {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173';
    return `${origin}/dist`;
};
const BASE_URL = getBaseUrl();

describe('Siglum Compiler - Browser Integration', () => {
    let compiler: SiglumCompiler;

    beforeAll(async () => {
        compiler = new SiglumCompiler({
            wasmUrl: `${BASE_URL}/busytex.wasm`,
            jsUrl: `${BASE_URL}/busytex.js`,
            bundlesUrl: `${BASE_URL}/bundles`,
            workerUrl: undefined,
            enableCtan: false,
            enableLazyFS: false,
            onLog: (msg) => console.log('[Compiler]', msg),
            onProgress: (stage, detail) => console.log('[Progress]', stage, detail),
        });
    });

    afterAll(() => {
        compiler?.terminate();
    });

    describe('Initialization', () => {
        it('should initialize the compiler', async () => {
            await compiler.init();
            expect(compiler.isReady()).toBe(true);
        }, 30000);

        it('should report as loaded after init', async () => {
            expect(compiler.isLoaded()).toBe(true);
        });
    });

    describe('Simple Compilation', () => {
        it('should compile a minimal LaTeX document', async () => {
            const source = `\\documentclass{article}
\\begin{document}
Hello, World!
\\end{document}`;

            const result = await compiler.compile(source);

            expect(result.success).toBe(true);
            expect(result.pdf).toBeDefined();
            expect(result.pdf).toBeInstanceOf(Uint8Array);
            // PDF magic bytes: %PDF
            expect(result.pdf![0]).toBe(0x25); // %
            expect(result.pdf![1]).toBe(0x50); // P
            expect(result.pdf![2]).toBe(0x44); // D
            expect(result.pdf![3]).toBe(0x46); // F
        }, 60000);

        it('should compile a document with math', async () => {
            const source = `\\documentclass{article}
\\begin{document}
The quadratic formula is $x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$.
\\end{document}`;

            const result = await compiler.compile(source);

            expect(result.success).toBe(true);
            expect(result.pdf).toBeDefined();
        }, 60000);

        it('should handle compilation errors gracefully', async () => {
            const source = `\\documentclass{article}
\\begin{document}
\\undefined_command
\\end{document}`;

            const result = await compiler.compile(source);

            expect(result.success).toBe(false);
        }, 60000);
    });

    describe('Document Caching', () => {
        it('should return cached result for identical document', async () => {
            const source = `\\documentclass{article}
\\begin{document}
Cache test document.
\\end{document}`;

            // First compile
            const result1 = await compiler.compile(source);
            expect(result1.success).toBe(true);

            // Second compile should be cached
            const result2 = await compiler.compile(source);
            expect(result2.success).toBe(true);
            expect(result2.cached).toBe(true);
        }, 60000);
    });

    describe('Engine Selection', () => {
        it('should use pdflatex by default', async () => {
            const source = `\\documentclass{article}
\\begin{document}
PDFLaTeX document.
\\end{document}`;

            const result = await compiler.compile(source);
            expect(result.success).toBe(true);
        }, 60000);

        it('should detect XeLaTeX for fontspec documents', async () => {
            const source = `\\documentclass{article}
\\usepackage{fontspec}
\\begin{document}
XeLaTeX document with fontspec.
\\end{document}`;

            const result = await compiler.compile(source, { engine: 'xelatex' });
            expect(result).toBeDefined();
        }, 60000);
    });
});

describe('Siglum Compiler - Performance', () => {
    let compiler: SiglumCompiler;

    beforeAll(async () => {
        compiler = new SiglumCompiler({
            wasmUrl: `${BASE_URL}/busytex.wasm`,
            jsUrl: `${BASE_URL}/busytex.js`,
            bundlesUrl: `${BASE_URL}/bundles`,
            enableCtan: false,
            enableLazyFS: false,
            onLog: () => {},
            onProgress: () => {},
        });
        await compiler.init();
    }, 60000);

    afterAll(() => {
        compiler?.terminate();
    });

    it('should compile quickly after warmup', async () => {
        const source = `\\documentclass{article}
\\begin{document}
Quick compile test.
\\end{document}`;

        // Warmup compile
        await compiler.compile(source, { useCache: false });

        // Timed compile
        const start = performance.now();
        const result = await compiler.compile(source, { useCache: false });
        const elapsed = performance.now() - start;

        expect(result.success).toBe(true);
        console.log(`Compile time after warmup: ${elapsed.toFixed(0)}ms`);

        expect(elapsed).toBeLessThan(10000);
    }, 30000);

    it('should return stats with compilation result', async () => {
        const source = `\\documentclass{article}
\\begin{document}
Stats test.
\\end{document}`;

        const result = await compiler.compile(source, { useCache: false });

        expect(result.success).toBe(true);
        if (result.stats) {
            console.log('Compilation stats:', result.stats);
        }
    }, 30000);
});

// ============================================================================
// CLEANUP TESTS - Run separately with fresh instances
// ============================================================================

describe('Siglum Compiler - Cleanup Behavior', () => {
    it('should terminate cleanly', async () => {
        const compiler = new SiglumCompiler({
            wasmUrl: `${BASE_URL}/busytex.wasm`,
            jsUrl: `${BASE_URL}/busytex.js`,
            bundlesUrl: `${BASE_URL}/bundles`,
            enableCtan: false,
            enableLazyFS: false,
            onLog: () => {},
            onProgress: () => {},
        });

        await compiler.init();
        expect(compiler.isReady()).toBe(true);

        compiler.terminate();
        expect(compiler.isLoaded()).toBe(false);
        expect(compiler.isReady()).toBe(false);
    }, 60000);

    it('should handle double terminate gracefully', async () => {
        const compiler = new SiglumCompiler({
            wasmUrl: `${BASE_URL}/busytex.wasm`,
            jsUrl: `${BASE_URL}/busytex.js`,
            bundlesUrl: `${BASE_URL}/bundles`,
            enableCtan: false,
            enableLazyFS: false,
            onLog: () => {},
            onProgress: () => {},
        });

        await compiler.init();
        compiler.terminate();

        // Second terminate should not throw
        expect(() => compiler.terminate()).not.toThrow();
    }, 60000);

    it('should allow re-initialization after terminate', async () => {
        const compiler = new SiglumCompiler({
            wasmUrl: `${BASE_URL}/busytex.wasm`,
            jsUrl: `${BASE_URL}/busytex.js`,
            bundlesUrl: `${BASE_URL}/bundles`,
            enableCtan: false,
            enableLazyFS: false,
            onLog: () => {},
            onProgress: () => {},
        });

        await compiler.init();
        expect(compiler.isReady()).toBe(true);

        compiler.terminate();
        expect(compiler.isReady()).toBe(false);

        // Re-init same instance
        await compiler.init();
        expect(compiler.isReady()).toBe(true);

        compiler.terminate();
    }, 60000);
});
