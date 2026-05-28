import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'happy-dom',
        setupFiles: ['./tests/setup/vitest.setup.ts'],
        include: ['tests/**/*.test.ts'],
        // tests/browser/** require a real browser (WASM + Workers); they run under
        // vitest.browser.config.ts, not this node/happy-dom config.
        exclude: ['tests/browser/**', 'node_modules/**'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            include: ['src/**/*.js'],
            exclude: ['src/worker.js'], // Worker has separate testing strategy
            thresholds: {
                lines: 80,
                functions: 80,
                branches: 75,
                statements: 80,
            },
        },
        globals: true,
        testTimeout: 30000,
        hookTimeout: 30000,
    },
});
