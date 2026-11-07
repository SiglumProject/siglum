import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

it('checks the same resolved assets for legacy and delta transfers before checkpoint reuse', async () => {
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../src/worker.js'), 'utf8');
    const worker = { postMessage: vi.fn(), onmessage: undefined as ((event: { data: object }) => Promise<void>) | undefined };
    const ended = vi.fn();
    const jobs: Array<{ assets: Map<string, Uint8Array> }> = [];
    const context = createContext({ performance, self: worker, Uint8Array, TextDecoder, TextEncoder, Map,
        recordEnd: ended, recordJob: (job: { assets: Map<string, Uint8Array> }) => jobs.push(job) });
    runInContext(source, context);
    // Stop after the actual worker constructs and guards its checkpoint job;
    // this exercises transport resolution without requiring a native engine.
    runInContext(`fileManifest = {}; checkpointRuntimeConfig = { engines: ['xelatex'] };
        checkpointDriver = { begin: recordJob, endRequest: recordEnd, tryResume() { throw new Error('stop-before-native'); } };`, context);
    async function send(extra: object) {
        await worker.onmessage!({ data: { type: 'compile', id: String(jobs.length), source: 'test', engine: 'xelatex', ...extra } });
        await runInContext('operationQueue', context);
    }
    const name = '/texlive/example.sty', data = new Uint8Array([1, 4, 9]);
    await send({ ctanFiles: { [name]: data } });
    expect(Array.from(jobs.at(-1)!.assets)).toEqual([[name, data]]);
    await send({ ctanFilesDelta: { baseRevision: null, paths: [name], changed: { [name]: data } } });
    expect(Array.from(jobs.at(-1)!.assets)).toEqual([[name, data]]);
    // A source file taking precedence is not a runtime package dependency.
    await send({ ctanFiles: new Map([[name, data]]), projectFiles: {
        baseRevision: null, paths: [name], changed: { [name]: new Uint8Array([6]) } } });
    expect(jobs.at(-1)!.assets.size).toBe(0);
    expect(ended).toHaveBeenCalledTimes(3);
    // Cleanup also runs after a successful queued operation, without native work.
    runInContext('handleCompile = async () => undefined', context);
    await send({});
    expect(ended).toHaveBeenCalledTimes(4);
});
