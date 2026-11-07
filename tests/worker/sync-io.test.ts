import { Worker as NodeWorker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SYNC_IO_BYTES, respondSyncInput } from '../../src/checkpoint/sync-io.mjs';

describe('bounded native input transport', () => {
    it('streams exact multipart bytes, empty files, and provider failures through a real worker', async () => {
        const buffer = new SharedArrayBuffer(SYNC_IO_BYTES);
        const large = Uint8Array.from({ length: 840000 }, (_, i) => i % 251);
        const worker = new NodeWorker(resolve(__dirname, '../fixtures/sync-io-receiver.mjs'), { workerData: { buffer } });
        const acks = new Map<string, (value: boolean) => void>();
        const results: any[] = [];
        const pending: Promise<unknown>[] = [];
        try {
            await new Promise<void>((resolve, reject) => {
                worker.on('error', reject);
                worker.on('message', message => {
                    if (message.type === 'sync-input-request') {
                        const files = message.fileName === 'missing.sty' ? null : new Map([
                            ['/texlive/texmf-dist/tex/latex/test/' + message.fileName,
                                message.fileName === 'large.sty' ? large : new Uint8Array()],
                        ]);
                        pending.push(respondSyncInput({ buffer, sequence: message.sequence, files,
                            waitAck: (sequence: number, frame: number) => new Promise<boolean>(resolve => acks.set(sequence + ':' + frame, resolve)),
                        }).catch(reject));
                    } else if (message.type === 'sync-input-ack') {
                        const key = message.sequence + ':' + message.frame;
                        acks.get(key)?.(true);
                        acks.delete(key);
                    } else if (message.type === 'case') {
                        results.push(message);
                        if (results.length === 3) resolve();
                    }
                });
            });
            await Promise.all(pending);
            expect(results[0].accepted).toBe(1);
            expect(results[0].files[0].sha256).toBe(createHash('sha256').update(large).digest('hex'));
            expect(results[1].accepted).toBe(1);
            expect(results[1].files.find((file: any) => file.path.endsWith('/empty.sty')).bytes).toBe(0);
            expect(results[2].accepted).toBe(0);
            expect(acks.size).toBe(0);
        } finally { await worker.terminate(); }
    });

    it('does not publish an old response into a newer request or an aborted mailbox', async () => {
        const buffer = new SharedArrayBuffer(SYNC_IO_BYTES), header = new Int32Array(buffer, 0, 8);
        const waitAck = vi.fn();
        const files = new Map([['/texlive/test.sty', new Uint8Array([1])]]);
        header[1] = 2;
        expect(await respondSyncInput({ buffer, sequence: 1, files, waitAck })).toBe(false);
        expect(header[0]).toBe(0);
        header[0] = 3;
        expect(await respondSyncInput({ buffer, sequence: 2, files, waitAck })).toBe(false);
        expect(header[0]).toBe(3);
        expect(waitAck).not.toHaveBeenCalled();
    });

    it('rejects paths outside the runtime tree before sending any bytes', async () => {
        const buffer = new SharedArrayBuffer(SYNC_IO_BYTES), header = new Int32Array(buffer, 0, 8);
        const waitAck = vi.fn();
        header[1] = 1;
        expect(await respondSyncInput({ buffer, sequence: 1, files: new Map([
            ['/texlive/../project/document.tex', new Uint8Array([1])],
        ]), waitAck })).toBe(false);
        expect(header[0]).toBe(3);
        expect(waitAck).not.toHaveBeenCalled();
    });
});
