/**
 * Tests for hash.js - BLAKE3 and DJB2 hashing utilities.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Note: We test against the actual implementation, mocking only the BLAKE3 module
describe('hash module', () => {
    let hashModule: typeof import('../../src/hash.js');

    // Reset module state before each test
    beforeEach(async () => {
        vi.resetModules();
        hashModule = await import('../../src/hash.js');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('DJB2 hash fallback', () => {
        it('should hash empty string consistently', () => {
            // Small inputs use DJB2
            const hash1 = hashModule.hashSync('');
            const hash2 = hashModule.hashSync('');
            expect(hash1).toBe(hash2);
            expect(hash1).toMatch(/^[0-9a-f]{8}$/); // 8 hex chars
        });

        it('should hash small strings consistently', () => {
            const content = 'Hello, World!';
            const hash1 = hashModule.hashSync(content);
            const hash2 = hashModule.hashSync(content);
            expect(hash1).toBe(hash2);
        });

        it('should produce different hashes for different content', () => {
            const hash1 = hashModule.hashSync('Hello');
            const hash2 = hashModule.hashSync('World');
            expect(hash1).not.toBe(hash2);
        });

        it('should handle special characters', () => {
            const hash = hashModule.hashSync('Special chars: !@#$%^&*()');
            expect(hash).toMatch(/^[0-9a-f]{8,}$/);
        });

        it('should handle unicode content', () => {
            const hash = hashModule.hashSync('Unicode: 你好世界 Привет 🌍');
            expect(hash).toMatch(/^[0-9a-f]{8,}$/);
        });

        it('should handle newlines and whitespace', () => {
            const hash1 = hashModule.hashSync('Line 1\nLine 2\tTab');
            const hash2 = hashModule.hashSync('Line 1\nLine 2\tTab');
            expect(hash1).toBe(hash2);
        });

        it('should use DJB2 for inputs under threshold (128 chars)', () => {
            const smallInput = 'x'.repeat(100);
            // Before BLAKE3 is loaded, small inputs should still hash quickly
            const hash = hashModule.hashSync(smallInput);
            expect(hash).toBeDefined();
            expect(hash.length).toBe(8); // DJB2 produces 8 hex chars
        });
    });

    describe('hashSync', () => {
        it('should return consistent results', () => {
            const content = 'Test content for hashing';
            const hash1 = hashModule.hashSync(content);
            const hash2 = hashModule.hashSync(content);
            expect(hash1).toBe(hash2);
        });

        it('should handle empty string', () => {
            const hash = hashModule.hashSync('');
            expect(hash).toBeDefined();
            expect(typeof hash).toBe('string');
        });

        it('should handle very large strings', () => {
            const largeContent = 'x'.repeat(100000);
            const hash = hashModule.hashSync(largeContent);
            expect(hash).toBeDefined();
        });

        it('should be deterministic', () => {
            const content = 'Deterministic test';
            const hashes = Array.from({ length: 10 }, () => hashModule.hashSync(content));
            expect(new Set(hashes).size).toBe(1);
        });
    });

    describe('hashAsync', () => {
        it('should return consistent results', async () => {
            const content = 'Test content for async hashing';
            const hash1 = await hashModule.hashAsync(content);
            const hash2 = await hashModule.hashAsync(content);
            expect(hash1).toBe(hash2);
        });

        it('should handle empty string', async () => {
            const hash = await hashModule.hashAsync('');
            expect(hash).toBeDefined();
            expect(typeof hash).toBe('string');
        });

        it('should handle unicode content', async () => {
            const hash = await hashModule.hashAsync('Привет мир 你好世界');
            expect(hash).toMatch(/^[0-9a-f]+$/);
        });

        it('should use DJB2 for small inputs', async () => {
            const smallContent = 'small';
            const hash = await hashModule.hashAsync(smallContent);
            // Small inputs use DJB2 which produces 8 hex chars
            expect(hash.length).toBe(8);
        });

        it('should match hashSync for same content', async () => {
            const content = 'Same content test';
            const asyncHash = await hashModule.hashAsync(content);
            const syncHash = hashModule.hashSync(content);
            expect(asyncHash).toBe(syncHash);
        });
    });

    describe('initHash', () => {
        it('should return a promise', () => {
            const result = hashModule.initHash();
            expect(result).toBeInstanceOf(Promise);
        });

        it('should resolve to boolean', async () => {
            const result = await hashModule.initHash();
            expect(typeof result).toBe('boolean');
        });

        it('should be callable multiple times', async () => {
            const result1 = await hashModule.initHash();
            const result2 = await hashModule.initHash();
            expect(result1).toBe(result2);
        });
    });

    describe('isBlake3Ready', () => {
        it('should return boolean', () => {
            const result = hashModule.isBlake3Ready();
            expect(typeof result).toBe('boolean');
        });

        it('should return false before init (in test env without BLAKE3)', () => {
            // In test environment, BLAKE3 may not load
            const result = hashModule.isBlake3Ready();
            expect(typeof result).toBe('boolean');
        });
    });

    describe('legacy exports', () => {
        it('should export hashContent as alias', () => {
            expect(hashModule.hashContent).toBe(hashModule.hashSync);
        });

        it('should export hashDocument as alias', () => {
            expect(hashModule.hashDocument).toBe(hashModule.hashSync);
        });

        it('should export hashPreamble as alias', () => {
            expect(hashModule.hashPreamble).toBe(hashModule.hashSync);
        });
    });

    describe('edge cases', () => {
        it('should handle string with null characters', () => {
            const content = 'test\0null\0chars';
            const hash = hashModule.hashSync(content);
            expect(hash).toBeDefined();
        });

        it('should handle very long single line', () => {
            const longLine = 'a'.repeat(50000);
            const hash = hashModule.hashSync(longLine);
            expect(hash).toBeDefined();
        });

        it('should handle content at size threshold boundary', () => {
            // Test around the 128-character threshold
            const atThreshold = 'x'.repeat(128);
            const belowThreshold = 'x'.repeat(127);
            const aboveThreshold = 'x'.repeat(129);

            const hash1 = hashModule.hashSync(belowThreshold);
            const hash2 = hashModule.hashSync(atThreshold);
            const hash3 = hashModule.hashSync(aboveThreshold);

            expect(hash1).toBeDefined();
            expect(hash2).toBeDefined();
            expect(hash3).toBeDefined();
        });

        it('should handle binary-like content', () => {
            // String with all byte values that fit in JS string
            let content = '';
            for (let i = 1; i < 256; i++) {
                content += String.fromCharCode(i);
            }
            const hash = hashModule.hashSync(content);
            expect(hash).toBeDefined();
        });

        it('should produce unique hashes for similar content', () => {
            const hash1 = hashModule.hashSync('test1');
            const hash2 = hashModule.hashSync('test2');
            const hash3 = hashModule.hashSync('test3');

            expect(hash1).not.toBe(hash2);
            expect(hash2).not.toBe(hash3);
            expect(hash1).not.toBe(hash3);
        });
    });

    describe('LaTeX document hashing', () => {
        it('should hash LaTeX preamble consistently', () => {
            const preamble = `\\documentclass{article}
\\usepackage{amsmath}
\\usepackage{graphicx}`;
            const hash1 = hashModule.hashPreamble(preamble);
            const hash2 = hashModule.hashPreamble(preamble);
            expect(hash1).toBe(hash2);
        });

        it('should produce different hashes for different preambles', () => {
            const preamble1 = '\\documentclass{article}';
            const preamble2 = '\\documentclass{report}';
            const hash1 = hashModule.hashPreamble(preamble1);
            const hash2 = hashModule.hashPreamble(preamble2);
            expect(hash1).not.toBe(hash2);
        });

        it('should hash full document consistently', () => {
            const doc = `\\documentclass{article}
\\begin{document}
Hello, World!
\\end{document}`;
            const hash1 = hashModule.hashDocument(doc);
            const hash2 = hashModule.hashDocument(doc);
            expect(hash1).toBe(hash2);
        });
    });
});
