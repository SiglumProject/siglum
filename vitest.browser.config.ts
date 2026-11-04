import { defineConfig, type Plugin } from 'vitest/config';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'node:child_process';

// Plugin to serve dist directory at /dist path
function serveDistPlugin(): Plugin {
    const distDir = path.resolve(__dirname, 'dist');
    return {
        name: 'serve-dist',
        configureServer(server) {
            // fontspec is fetched on demand in the current bundle layout. Keep
            // this offline font-name test independent of CTAN/network availability
            // by serving the installed TeX Live package as project files.
            server.middlewares.use('/fixtures/fontspec.json', (_req, res) => {
                try {
                    const archiveDir = path.resolve(__dirname, 'busytex/source/texmfrepo/archive');
                    const archiveName = fs.readdirSync(archiveDir)
                        .filter(name => /^fontspec\.r\d+\.tar\.xz$/.test(name))
                        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
                    if (!archiveName) throw new Error('Missing local fontspec TeX Live archive');
                    const archive = path.join(archiveDir, archiveName);
                    const files: Record<string, string> = {};
                    for (const name of ['fontspec.sty', 'fontspec-xetex.sty', 'fontspec.cfg']) {
                        files[name] = execFileSync('tar', ['-xOf', archive, `tex/latex/fontspec/${name}`], { encoding: 'utf8' });
                    }
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify(files));
                } catch (error) {
                    res.statusCode = 500;
                    res.end(String(error));
                }
            });
            // Exercise real package downloads offline against the installed 2026 archives.
            server.middlewares.use('/fixtures/api/texlive/', (req, res) => {
                const pkg = (req.url || '').split('?')[0].replace(/^\//, '');
                if (!/^[a-zA-Z0-9._-]+$/.test(pkg)) { res.statusCode=400;res.end();return; }
                const dir=path.resolve(__dirname,'busytex/source/texmfrepo/archive');
                const name=fs.readdirSync(dir).filter(name=>name.startsWith(pkg+'.r') && /^r\d+\.tar\.xz$/.test(name.slice(pkg.length+1)))
                    .sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}))[0];
                if (!name) {res.statusCode=404;res.end();return;}
                res.setHeader('Content-Type','application/x-xz');fs.createReadStream(path.join(dir,name)).pipe(res);
            });
            server.middlewares.use('/fixtures/xzwasm.js', (_req,res) => {
                res.setHeader('Content-Type','application/javascript');
                fs.createReadStream(path.resolve(__dirname,'node_modules/xzwasm/dist/package/xzwasm.js')).pipe(res);
            });
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
        // The package server uses packages/packages as a compatibility symlink
        // back to packages. Vite must not follow it recursively in browser tests.
        watch: { ignored: ['**/packages/packages'] },
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
