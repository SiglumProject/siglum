import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { createSyncInputReceiver } from '../../src/checkpoint/sync-io.mjs';
const installed = new Map();
const module = { stringToUTF8(path) { this.path = path; } };
const receiver = createSyncInputReceiver({
    buffer: workerData.buffer,
    postMessage: message => parentPort.postMessage(message),
    install: (path, data) => installed.set(path, data),
    known: () => true,
    lookup: () => null,
});
for (const name of ['large.sty', 'empty.sty', 'missing.sty']) {
    const accepted = receiver.resolve(name, module, 4, 4096);
    parentPort.postMessage({ type: 'case', name, accepted,
        files: [...installed].map(([path, data]) => ({ path, bytes: data.length,
            sha256: createHash('sha256').update(data).digest('hex') })),
    });
}
parentPort.close();
