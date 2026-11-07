import { describe, expect, it } from 'vitest';
import { runAuxiliaryTool } from '../../src/auxiliary-tools.js';
const job = { tool: 'latexminted', input: new Uint8Array([1]) };
const run = runner => runAuxiliaryTool(runner, job, new Map(), 'main.tex');
describe('browser tool file output boundary', () => {
    it('copies outputs and keeps the compile session separate from request cleanup', async () => {
        const session = new AbortController();
        const bytes = new Uint8Array([1, 2]);
        let requestSignal;
        const result = await runAuxiliaryTool((_, context) => {
            requestSignal = context.signal;
            expect(context.sessionSignal).toBe(session.signal);
            return { files: [{ path: '_minted/source.highlight.minted', bytes }], removed: ['old.minted'] };
        }, job, new Map(), 'main.tex', session.signal);
        expect(result.files[0].bytes).toEqual(bytes);
        expect(result.files[0].bytes).not.toBe(bytes);
        expect(result.removed).toEqual(['old.minted']);
        expect(requestSignal.aborted).toBe(true);
        expect(session.signal.aborted).toBe(false);
    });
    it.each(['../outside', '/absolute', 'a/../b', 'a//b', './file', 'bad\\file', 'bad\0file', 'bad\nfile'])('rejects noncanonical output %s', async path => {
        await expect(run(() => ({ files: [{ path, bytes: new Uint8Array([1]) }] }))).rejects.toThrow();
        await expect(run(() => ({ files: [], removed: [path] }))).rejects.toThrow();
    });
    it('rejects excessive generated files and bytes', async () => {
        await expect(run(() => ({ files: Array.from({length:129}, (_, i) => ({path: String(i), bytes: new Uint8Array()})) }))).rejects.toThrow('Too many');
        await expect(run(() => ({ files: [{path:'output', bytes: new Uint8Array(16*1024*1024+1)}] }))).rejects.toThrow('limit');
    });
    it('rejects a malformed tool identity before invoking the runner', async () => {
        let calls=0;
        await expect(runAuxiliaryTool(() => {calls++;}, {...job,tool:'latexminted;sh'}, new Map(), 'main.tex')).rejects.toThrow('Invalid');
        expect(calls).toBe(0);
    });
});
