import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

it('retains the ordered CTAN base on the real worker and rejects a missing or stale revision', async () => {
    const path = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/worker.js');
    const workerSource = readFileSync(path, 'utf8');
    const worker = {
        postMessage: vi.fn(),
        onmessage: undefined as ((event: { data: Record<string, unknown> }) => Promise<void>) | undefined,
    };
    const context = createContext({ performance, self: worker, Uint8Array, TextDecoder, TextEncoder });
    runInContext(workerSource, context);

    async function send(data: Record<string, unknown>) {
        await worker.onmessage!({ data });
        await runInContext('operationQueue', context);
        return worker.postMessage.mock.calls.at(-1)?.[0];
    }

    const first = '/texlive/first.sty';
    const second = '/texlive/second.sty';
    const third = '/texlive/third.sty';
    const entries = () => Array.from(runInContext('ctanFileSnapshot.files', context) as Map<string, Uint8Array>,
        ([path, data]) => [path, Array.from(data)]);

    // Snapshot negotiation happens before the worker requires a WASM module.
    await send({
        type: 'compile', id: 'one',
        ctanFilesDelta: { baseRevision: null, paths: [first, second],
            changed: { [first]: new Uint8Array([1]), [second]: new Uint8Array([2]) } },
    });
    expect(entries()).toEqual([[first, [1]], [second, [2]]]);
    await send({ type: 'compile', id: 'two', ctanFilesDelta: { baseRevision: 'one' } });
    expect(runInContext('ctanFileSnapshot.revision', context)).toBe('one');

    const stale = await send({ type: 'compile', id: 'three', ctanFilesDelta: { baseRevision: 'wrong' } });
    expect(stale).toMatchObject({ type: 'compile-response', id: 'three', ctanFilesNeedReset: true });
    expect(entries()).toEqual([[first, [1]], [second, [2]]]);

    await send({
        type: 'compile', id: 'four',
        ctanFilesDelta: { baseRevision: 'one', paths: [third, second], changed: { [third]: new Uint8Array([3]) } },
    });
    expect(entries()).toEqual([[third, [3]], [second, [2]]]);

    await send({ type: 'ctan-files-clear' });
    const cleared = await send({ type: 'compile', id: 'five', ctanFilesDelta: { baseRevision: 'four' } });
    expect(cleared).toMatchObject({ type: 'compile-response', id: 'five', ctanFilesNeedReset: true });
});
