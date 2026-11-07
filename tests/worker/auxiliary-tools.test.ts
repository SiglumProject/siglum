import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(resolve(__dirname, '../../src/worker.js'), 'utf8');
let context: ReturnType<typeof createContext>;
let timeout: () => void;
let clear: ReturnType<typeof vi.fn>;
let post: ReturnType<typeof vi.fn>;

beforeEach(() => {
    clear = vi.fn();
    post = vi.fn();
    context = createContext({ self: { postMessage: post }, TextDecoder, Uint8Array,
        setTimeout: (callback: () => void) => { timeout = callback; return 7; }, clearTimeout: clear });
    runInContext(source, context);
});

describe('worker auxiliary-tool lifecycle', () => {
    it('invalidates TeX-only checkpoints without switching to the combined runtime', async () => {
        const drop = vi.fn();
        context.drop = drop;
        context.job = {};
        runInContext("checkpointDriver = { drop }; activeRuntimeKind = 'checkpoint';", context);
        const pending = runInContext("requestAuxiliaryTool('build-1', 'biber', new Uint8Array([1]), job)", context);
        expect(context.job.captureDisabled).toBe(true);
        expect(drop).toHaveBeenCalledWith('Auxiliary tool dependencies require a full build');
        expect(runInContext('activeRuntimeKind', context)).toBe('checkpoint');
        const message = post.mock.calls[0][0];
        expect(message.compileId).toBe('build-1');
        await context.self.onmessage({ data: { type: 'auxiliary-tool-response', requestId: message.requestId,
            success: true, bytes: new Uint8Array([2]) } });
        await expect(pending).resolves.toMatchObject({ success: true });
        expect(clear).toHaveBeenCalledWith(7);
        expect(runInContext('pendingToolRequests.size', context)).toBe(0);
    });

    it('rejects failed tools and releases the pending request', async () => {
        const pending = runInContext("requestAuxiliaryTool('build-1', 'biber', new Uint8Array([1]))", context);
        const rejected = expect(pending).rejects.toThrow('tool failed');
        const message = post.mock.calls[0][0];
        await context.self.onmessage({ data: { type: 'auxiliary-tool-response', requestId: message.requestId,
            success: false, error: 'tool failed' } });
        await rejected;
        expect(runInContext('pendingToolRequests.size', context)).toBe(0);
    });

    it('bounds an unanswered request', async () => {
        const pending = runInContext("requestAuxiliaryTool('build-1', 'biber', new Uint8Array([1]))", context);
        const rejected = expect(pending).rejects.toThrow('timed out');
        timeout();
        await rejected;
        expect(runInContext('pendingToolRequests.size', context)).toBe(0);
    });
});
