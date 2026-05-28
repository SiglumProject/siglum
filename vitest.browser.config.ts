import { defineConfig, type Plugin } from 'vitest/config';
import path from 'path';
import fs from 'fs';

// Plugin to serve dist directory at /dist path
function serveDistPlugin(): Plugin {
    const distDir = path.resolve(__dirname, 'dist');
    return {
        name: 'serve-dist',
        configureServer(server) {
            server.middlewares.use('/dist', (req, res, next) => {
                const filePath = path.join(distDir, req.url || '');
                if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                    const ext = path.extname(filePath);
                    const contentTypes: Record<string, string> = {
                        '.wasm': 'application/wasm',
                        '.js': 'application/javascript',
                        '.json': 'application/json',
                        '.gz': 'application/gzip',
                    };
                    res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    fs.createReadStream(filePath).pipe(res);
                } else {
                    next();
                }
            });
        },
    };
}

export default defineConfig({
    plugins: [serveDistPlugin()],
    test: {
        // Browser mode configuration
        browser: {
            enabled: true,
            provider: 'playwright',
            name: 'chromium',
            headless: true,
        },
        // Only run browser-specific tests
        include: ['tests/browser/**/*.test.ts'],
        // Longer timeouts for real WASM compilation
        testTimeout: 60000,
        hookTimeout: 60000,
        globals: true,
    },
    // Serve static files for WASM and bundles
    server: {
        fs: {
            // Allow serving files from parent directories for linked packages
            allow: ['..'],
            strict: false,
        },
    },
    // Pre-bundle dependencies for browser
    optimizeDeps: {
        include: ['fflate'],
        // Exclude packages with complex WASM bindings
        exclude: ['blake3-wasm'],
    },
    resolve: {
        alias: {
            fflate: 'fflate',
        },
    },
});
