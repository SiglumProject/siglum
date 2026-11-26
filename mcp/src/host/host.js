// Runs inside the headless Chromium page. Owns one SiglumCompiler and exposes a
// small, serializable API on window.siglumHost for the Node side to call
// through page.evaluate(). Nothing here is visible to the agent.
import { SiglumCompiler, resolveRuntime } from '/engine/index.js';

let compiler = null;
let initPromise = null;
let runtimeInfo = null;

async function runtimeConfig() {
    const settings = await (await fetch('/config.json')).json();
    if (settings.runtimeConfigUrl) {
        const response = await fetch(settings.runtimeConfigUrl);
        const config = await response.json();
        if (!response.ok) throw new Error(config.error || `Runtime config unavailable: ${response.status}`);
        return { config, source: settings.runtimeConfigUrl };
    }
    const config = await resolveRuntime(settings.runtimeServiceUrl ? { baseUrl: settings.runtimeServiceUrl } : {});
    return { config, source: settings.runtimeServiceUrl || 'https://packages.siglum.org' };
}

function init() {
    if (!initPromise) {
        initPromise = (async () => {
            const { config, source } = await runtimeConfig();
            compiler = new SiglumCompiler({
                ...config,
                workerUrl: '/engine/worker.js',
                eagerBundles: { pdflatex: ['cm-super'] },
                onLog: (message) => console.debug(message),
            });
            await compiler.init();
            runtimeInfo = { source, releaseId: config.releaseId || null, wasmUrl: config.wasmUrl };
            return runtimeInfo;
        })().catch((error) => {
            initPromise = null;
            throw error;
        });
    }
    return initPromise;
}

function decodeBase64(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function encodeBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

async function compile({ source, mainFile, engine, files }) {
    await init();
    const additionalFiles = {};
    for (const file of files || []) {
        additionalFiles[file.path] = file.base64 !== undefined ? decodeBase64(file.base64) : file.text;
    }
    const started = performance.now();
    const result = await compiler.compile(source, {
        // compile() auto-detects only when engine is omitted; a literal 'auto'
        // is passed through as an engine name, so translate it here.
        engine: engine && engine !== 'auto' ? engine : undefined,
        mainFile: mainFile || 'document.tex',
        additionalFiles,
    });
    const pdf = result.success && result.pdf ? new Uint8Array(result.pdf) : null;
    return {
        success: !!result.success,
        error: result.error || null,
        log: result.log || '',
        pdfBase64: pdf ? encodeBase64(pdf) : null,
        elapsedMs: Math.round(performance.now() - started),
    };
}

async function clearCache() {
    await init();
    await compiler.clearCache();
}

window.siglumHost = { init, compile, clearCache };
window.siglumHostLoaded = true;
