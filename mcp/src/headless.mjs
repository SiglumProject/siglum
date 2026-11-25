// Runs the unmodified @siglum/engine inside a hidden Chromium page.
//
// The engine depends on Web Workers, OPFS/IndexedDB and Cache Storage, so the
// fastest route to a faithful headless compiler is a real (but invisible)
// browser rather than a partial Node port. Callers only see compile(): the
// browser, local static server and runtime resolution are internal.

import { createServer } from 'node:http';
import { readFile, stat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_DIR = join(HERE, 'host');
const DEFAULT_PORT = 47787;

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json',
    '.map': 'application/json',
    '.wasm': 'application/wasm',
};

const ISOLATION_HEADERS = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
};

function log(message) {
    process.stderr.write(`[siglum-mcp] ${message}\n`);
}

/** Engine source directory: explicit override, this checkout, or the installed package. */
export function resolveEngineSrc() {
    if (process.env.SIGLUM_ENGINE_SRC) return resolve(process.env.SIGLUM_ENGINE_SRC);
    const repoRoot = resolve(HERE, '..', '..');
    try {
        const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
        if (pkg.name === '@siglum/engine' && existsSync(join(repoRoot, 'src', 'index.js'))) {
            return join(repoRoot, 'src');
        }
    } catch { /* not inside the engine checkout */ }
    return dirname(fileURLToPath(import.meta.resolve('@siglum/engine')));
}

function resolveFilesystemEntry() {
    const entry = fileURLToPath(import.meta.resolve('@siglum/filesystem'));
    return { dir: dirname(entry), file: basename(entry) };
}

function defaultCacheDir() {
    if (process.env.SIGLUM_MCP_CACHE_DIR) return resolve(process.env.SIGLUM_MCP_CACHE_DIR);
    const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
    return join(base, 'siglum-mcp');
}

async function serveFile(res, root, relativePath) {
    let decoded;
    try {
        decoded = decodeURIComponent(relativePath);
    } catch {
        res.writeHead(400, ISOLATION_HEADERS).end();
        return;
    }
    const target = resolve(root, '.' + sep + decoded);
    if (target !== root && !target.startsWith(root + sep)) {
        res.writeHead(403, ISOLATION_HEADERS).end();
        return;
    }
    try {
        if (!(await stat(target)).isFile()) throw new Error('not a file');
        const body = await readFile(target);
        res.writeHead(200, {
            ...ISOLATION_HEADERS,
            'Content-Type': CONTENT_TYPES[extname(target)] || 'application/octet-stream',
        }).end(body);
    } catch {
        res.writeHead(404, ISOLATION_HEADERS).end();
    }
}

function createHostServer({ engineSrc, fsEntry, settings }) {
    const indexHtml = readFileSync(join(HOST_DIR, 'index.html'), 'utf8').replace('__FS_ENTRY__', fsEntry.file);
    // Any local process or web page can reach this port, so a bad request must
    // never take down the MCP server.
    return createServer((req, res) => {
        handle(req, res).catch(() => {
            if (!res.headersSent) res.writeHead(500, ISOLATION_HEADERS);
            res.end();
        });
    });

    async function handle(req, res) {
        const path = new URL(req.url, 'http://localhost').pathname;
        if (path === '/' || path === '/index.html') {
            res.writeHead(200, { ...ISOLATION_HEADERS, 'Content-Type': CONTENT_TYPES['.html'] }).end(indexHtml);
        } else if (path === '/host.js') {
            await serveFile(res, HOST_DIR, 'host.js');
        } else if (path === '/config.json') {
            res.writeHead(200, { ...ISOLATION_HEADERS, 'Content-Type': CONTENT_TYPES['.json'] }).end(JSON.stringify(settings));
        } else if (path.startsWith('/engine/')) {
            await serveFile(res, engineSrc, path.slice('/engine/'.length));
        } else if (path.startsWith('/fs/')) {
            await serveFile(res, fsEntry.dir, path.slice('/fs/'.length));
        } else {
            res.writeHead(404, ISOLATION_HEADERS).end();
        }
    }
}

function listen(server, port) {
    return new Promise((resolvePromise, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            server.off('error', reject);
            resolvePromise(server.address().port);
        });
    });
}

export class HeadlessSiglum {
    constructor(options = {}) {
        this.options = options;
        this.queue = Promise.resolve();
        this.startPromise = null;
        this.runtime = null;
    }

    start() {
        if (!this.startPromise) {
            this.startPromise = this._start().catch(async (error) => {
                await this.close();
                this.startPromise = null;
                throw error;
            });
        }
        return this.startPromise;
    }

    async _start() {
        const { chromium } = await import('playwright');
        const settings = {
            runtimeServiceUrl: this.options.runtimeServiceUrl ?? process.env.SIGLUM_RUNTIME_SERVICE_URL ?? null,
            runtimeConfigUrl: this.options.runtimeConfigUrl ?? process.env.SIGLUM_RUNTIME_CONFIG_URL ?? null,
        };
        const engineSrc = resolveEngineSrc();
        this.server = createHostServer({ engineSrc, fsEntry: resolveFilesystemEntry(), settings });

        // A stable origin and profile let OPFS/IndexedDB keep downloaded bundles
        // and packages between runs. A second concurrent server falls back to a
        // throwaway port and profile, since Chromium locks a profile per process.
        const requestedPort = Number(this.options.port ?? process.env.SIGLUM_MCP_PORT ?? DEFAULT_PORT);
        let persistent = true;
        let port;
        try {
            port = await listen(this.server, requestedPort);
        } catch {
            persistent = false;
            port = await listen(this.server, 0);
        }

        // Prefer Playwright's bundled Chromium; fall back to an installed Chrome
        // so `npx playwright install` is optional. SIGLUM_MCP_BROWSER_CHANNEL
        // (e.g. "chrome", "msedge") forces a specific installed browser.
        const channels = process.env.SIGLUM_MCP_BROWSER_CHANNEL
            ? [process.env.SIGLUM_MCP_BROWSER_CHANNEL]
            : [undefined, 'chrome', 'msedge'];
        const launch = async (profileDir) => {
            let lastError;
            for (const channel of channels) {
                try {
                    return await chromium.launchPersistentContext(profileDir, { headless: true, channel });
                } catch (error) {
                    lastError = error;
                    if (!/Executable doesn't exist|is not found|not installed/i.test(error.message)) throw error;
                }
            }
            throw new Error('No Chromium-based browser found. Run `npx playwright install chromium` ' +
                `or install Google Chrome. (${lastError?.message.split('\n')[0]})`);
        };

        if (persistent) {
            const profileDir = join(defaultCacheDir(), 'profile');
            await mkdir(profileDir, { recursive: true });
            try {
                this.context = await launch(profileDir);
            } catch (error) {
                if (/No Chromium-based browser/.test(error.message)) throw error;
                log(`Persistent profile unavailable (${error.message.split('\n')[0]}); using a temporary one.`);
                persistent = false;
            }
        }
        if (!persistent) {
            this.tempProfileDir = await mkdtemp(join(tmpdir(), 'siglum-mcp-'));
            this.context = await launch(this.tempProfileDir);
        }
        // If Chromium dies (crash, OOM, killed), start a fresh one on the next call.
        const context = this.context;
        context.on('close', () => {
            if (this.context === context) this._reset();
        });

        this.page = this.context.pages()[0] || await this.context.newPage();
        if (process.env.SIGLUM_MCP_DEBUG) {
            this.page.on('console', (message) => log(`[page:${message.type()}] ${message.text()}`));
        }
        this.page.on('pageerror', (error) => log(`[page error] ${error.message}`));

        await this.page.goto(`http://127.0.0.1:${port}/`);
        await this.page.waitForFunction(() => window.siglumHostLoaded === true, null, { timeout: 30_000 });
        log(`Initializing engine from ${engineSrc} (${persistent ? 'persistent' : 'temporary'} cache)...`);
        this.runtime = await this.page.evaluate(() => window.siglumHost.init());
        log(`Engine ready (runtime ${this.runtime.releaseId || this.runtime.source}).`);
        return this.runtime;
    }

    /** Serializes calls: the engine owns one worker and compiles one document at a time. */
    _enqueue(task) {
        const run = this.queue.then(task, task);
        this.queue = run.catch(() => {});
        return run;
    }

    /**
     * @param {{source: string, mainFile?: string, engine?: string,
     *   files?: Array<{path: string, text?: string, base64?: string}>, timeoutMs?: number}} request
     */
    compile(request) {
        return this._enqueue(async () => {
            try {
                return await this._compileOnce(request);
            } catch (error) {
                // A crashed renderer or browser is replaced by _reset(); retry once
                // on the fresh one so a single crash doesn't fail the agent's call.
                if (!/Target crashed|Target page, context or browser has been closed/.test(error.message)) throw error;
                log(`Browser crashed (${error.message.split('\n')[0]}); retrying once.`);
                return await this._compileOnce(request);
            }
        });
    }

    async _compileOnce(request) {
        await this.start();
        const timeoutMs = request.timeoutMs ?? 300_000;
        const { timeoutMs: _ignored, ...payload } = request;
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Compilation timed out after ${timeoutMs} ms`)), timeoutMs);
        });
        try {
            const result = await Promise.race([
                this.page.evaluate((req) => window.siglumHost.compile(req), payload),
                timeout,
            ]);
            return {
                success: result.success,
                error: result.error,
                log: result.log,
                elapsedMs: result.elapsedMs,
                pdf: result.pdfBase64 ? Buffer.from(result.pdfBase64, 'base64') : null,
            };
        } catch (error) {
            // A timeout may leave the worker wedged, and a crashed page or
            // browser can't recover. Restart on the next call; with the
            // persistent cache that costs a few seconds.
            await this._reset();
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    clearCache() {
        return this._enqueue(async () => {
            await this.start();
            try {
                await this.page.evaluate(() => window.siglumHost.clearCache());
            } catch (error) {
                await this._reset();
                throw error;
            }
        });
    }

    async _reset() {
        this.startPromise = null;
        await this.close();
    }

    async close() {
        const context = this.context;
        const server = this.server;
        const tempProfileDir = this.tempProfileDir;
        this.context = null;
        this.server = null;
        this.page = null;
        this.tempProfileDir = null;
        if (context) await context.close().catch(() => {});
        if (server) await new Promise((r) => server.close(() => r()));
        if (tempProfileDir) await rm(tempProfileDir, { recursive: true, force: true }).catch(() => {});
    }
}
