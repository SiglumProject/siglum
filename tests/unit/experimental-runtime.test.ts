import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash, webcrypto } from 'node:crypto';
import { stageExperimentalRuntime } from '../../scripts/stage-experimental-runtime.mjs';
import { resolveRuntime } from '../../src/runtime.js';
import { ENGINE_VERSION } from '../../src/package-metadata.js';
const directories: string[] = [];
async function fixture() {
    const root = await mkdtemp(resolve(tmpdir(), 'siglum-runtime-stage-')); directories.push(root);
    const bytes = Buffer.from('synthetic native runtime');
    await mkdir(resolve(root, 'source/wasm'), { recursive: true });
    await writeFile(resolve(root, 'source/wasm/busytex.wasm'), bytes);
    const files: Record<string, { size: number; sha256: string }> = {};
    for (const name of ['wasm/busytex.wasm', 'wasm/busytex.js', 'bundles.json', 'file-manifest.json', 'xzwasm.js']) {
        const contents = name.endsWith('.wasm') ? bytes : Buffer.from('synthetic ' + name);
        await writeFile(resolve(root, 'source', name), contents);
        files[name] = { size: contents.length, sha256: createHash('sha256').update(contents).digest('hex') };
    }
    const manifest = { releaseId: 'tl2026-1111111111111111', texLiveYear: 2026, engineVersion: ENGINE_VERSION, files };
    await writeFile(resolve(root, 'source/manifest.json'), JSON.stringify(manifest));
    const configPath = resolve(root, 'source/server-config.json');
    await writeFile(configPath, JSON.stringify({ runtimeRoot: '.', manifest: 'manifest.json', files: {} }));
    return { root, configPath, output: resolve(root, 'output'), manifest };
}
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe('self-contained experimental runtime staging', () => {
    it('resolves through the ordinary SDK manifest verifier without a special experimental bypass', async () => {
        vi.stubGlobal('crypto', webcrypto);
        const f = await fixture(), result = await stageExperimentalRuntime(f);
        const text = await readFile(resolve(result.directory, 'manifest.json'), 'utf8');
        const baseUrl = 'http://runtime.local/releases/' + result.releaseId;
        const descriptor = { schemaVersion: 1, engineVersion: ENGINE_VERSION, releaseId: result.releaseId,
            baseUrl, manifestUrl: baseUrl + '/runtime.json', manifestSha256: createHash('sha256').update(text).digest('hex') };
        const resolved = await resolveRuntime({ baseUrl: 'http://runtime.local', cacheStorage: null,
            fetch: async (input: any) => new Response(String(input).endsWith('/latest.json') ? JSON.stringify(descriptor) : text) });
        expect(resolved.releaseId).toBe(result.releaseId);
        expect(resolved.wasmUrl).toBe(baseUrl + '/wasm/busytex.wasm');
    });

    it('writes a movable relative config and reuses verified immutable output', async () => {
        const f = await fixture();
        const result = await stageExperimentalRuntime(f);
        expect(await readFile(resolve(result.directory, 'wasm/busytex.wasm'), 'utf8')).toBe('synthetic native runtime');
        const config = JSON.parse(await readFile(resolve(result.directory, 'server-config.json'), 'utf8'));
        expect(config).toEqual({ runtimeRoot: '.', manifest: 'manifest.json', files: {} });
        expect((await stageExperimentalRuntime(f)).reused).toBe(true);
        expect(await readFile(resolve(result.directory, 'manifest.json'), 'utf8')).not.toContain(f.root);
    });
    it('rejects a mismatched input without modifying source', async () => {
        const f = await fixture();
        await writeFile(resolve(f.root, 'source/wasm/busytex.wasm'), 'changed');
        await expect(stageExperimentalRuntime(f)).rejects.toThrow('Source artifact mismatch');
        expect(await readFile(resolve(f.root, 'source/wasm/busytex.wasm'), 'utf8')).toBe('changed');
    });
    it('includes replacement bytes in the identity and refuses damaged immutable output', async () => {
        const f = await fixture(), original = await stageExperimentalRuntime(f);
        const worker = resolve(f.root, 'worker.js'); await writeFile(worker, '// synthetic worker');
        const next = await stageExperimentalRuntime({ ...f, replacements: { 'worker.js': worker } });
        expect(next.releaseId).not.toBe(original.releaseId);
        await writeFile(resolve(next.directory, 'worker.js'), 'damaged');
        await expect(stageExperimentalRuntime({ ...f, replacements: { 'worker.js': worker } })).rejects.toThrow('Immutable artifact mismatch');
        expect(await readFile(resolve(next.directory, 'worker.js'), 'utf8')).toBe('damaged');
    });
    it('rejects escaping and reserved artifact names', async () => {
        const f = await fixture(), worker = resolve(f.root, 'worker.js'); await writeFile(worker, 'synthetic');
        for (const name of ['../escape', '/escape', 'manifest.json', 'server-config.json', 'a/../b', 'a\\b']) {
            await expect(stageExperimentalRuntime({ ...f, replacements: { [name]: worker } })).rejects.toThrow('Invalid replacement path');
        }
    });
});
