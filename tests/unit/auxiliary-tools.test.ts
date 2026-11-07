import { describe, expect, it, vi } from 'vitest';
import { runAuxiliaryTool } from '../../src/auxiliary-tools.js';

const job = { tool: 'biber', input: new TextEncoder().encode('<controlfile/>') };

describe('isolated auxiliary-tool project access', () => {
    it('resolves nested project inputs and copies provider output', async () => {
        const bytes = new TextEncoder().encode('bibliography');
        const project = new Map([['refs.bib', bytes]]);
        let signal;
        const result = await runAuxiliaryTool(async (_, context) => {
            signal = context.signal;
            const input = context.readProjectFile('../refs.bib');
            expect(input).toEqual(bytes);
            expect(input).not.toBe(bytes);
            return { bytes, log: ['first line', 'second line'] };
        }, job, project, 'chapter/main.tex');
        expect(result.log).toBe('first line\nsecond line');
        expect(result.bytes).toEqual(bytes);
        expect(result.bytes).not.toBe(bytes);
        expect(signal.aborted).toBe(true);
        expect(bytes.byteLength).toBeGreaterThan(0);
    });

    it.each(['../../secret.bib', '/secret.bib', 'https://host/file.bib', '..\\secret.bib', 'bad\0.bib'])(
        'rejects input outside the project: %s', async path => {
            await expect(runAuxiliaryTool((_, context) => {
                context.readProjectFile(path);
            }, job, new Map(), 'chapter/main.tex')).rejects.toThrow();
        });

    it('does not read missing files from browser storage or CTAN', async () => {
        await expect(runAuxiliaryTool((_, context) => {
            context.readProjectFile('absent.bib');
        }, job, new Map(), 'main.tex')).rejects.toThrow('Missing project input');
    });

    it('rejects invalid outputs and oversized requests', async () => {
        await expect(runAuxiliaryTool(() => ({ bytes: new Uint8Array() }), job, new Map(), 'main.tex'))
            .rejects.toThrow('Invalid auxiliary-tool output');
        await expect(runAuxiliaryTool(vi.fn(), { ...job, input: new Uint8Array(16 * 1024 * 1024 + 1) }, new Map(), 'main.tex'))
            .rejects.toThrow('Invalid auxiliary-tool request');
    });

    it('cancels a tool when its compilation is terminated', async () => {
        const parent = new AbortController();
        let workerSignal;
        const pending = runAuxiliaryTool((_, context) => {
            workerSignal = context.signal;
            return new Promise(() => {});
        }, job, new Map(), 'main.tex', parent.signal);
        const rejected = expect(pending).rejects.toThrow('cancelled');
        await Promise.resolve();
        parent.abort();
        await rejected;
        expect(workerSignal.aborted).toBe(true);
    });

    it('bounds a stalled tool and signals cancellation', async () => {
        vi.useFakeTimers();
        try {
            let signal;
            const pending = runAuxiliaryTool((_, context) => {
                signal = context.signal;
                return new Promise(() => {});
            }, job, new Map(), 'main.tex');
            const rejected = expect(pending).rejects.toThrow('timed out');
            await vi.advanceTimersByTimeAsync(45000);
            await rejected;
            expect(signal.aborted).toBe(true);
        } finally { vi.useRealTimers(); }
    });
});
