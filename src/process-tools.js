import { createProjectFileReader } from './auxiliary-tools.js';

/** @typedef {{command: string, args: readonly string[]}} ProcessRequest */
/** @typedef {{signal: AbortSignal, sessionSignal: AbortSignal, readFile: (path: string) => Promise<Uint8Array>, readProjectFile: (path: string) => Uint8Array}} ProcessContext */
/** @typedef {{exitCode?: number, files?: Array<{path: string, bytes: Uint8Array}>, removed?: string[], log?: string | string[], stdout?: string, stderr?: string}} ProcessResult */
/** @typedef {{command: string, revision?: string, kind?: 'process', run: (request: ProcessRequest, context: ProcessContext) => ProcessResult | Promise<ProcessResult>} | {command: string, revision?: string, kind: 'auxiliary', run: (request: {tool: string, input: Uint8Array}, context: {signal: AbortSignal, sessionSignal: AbortSignal, readProjectFile: (path: string) => Uint8Array}) => {bytes: Uint8Array, log?: string | string[]} | Promise<{bytes: Uint8Array, log?: string | string[]}>}} ToolProvider */

// One transport per compiler worker; large files stream through this fixed buffer.
export const PROCESS_TOOL_MAILBOX_BYTES = 256 * 1024 + 32;
export const PROCESS_TOOL_LIMITS = Object.freeze({ bytes: 16 * 1024 * 1024, files: 128, args: 128, timeoutMs: 45000 });
const WAIT = 0, DONE = 1, READ = 2, MANIFEST = 3, CHUNK = 4, FAILED = 5;
const encoder = new TextEncoder();
const commandName = value => typeof value === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,63}$/.test(value);

/** Explicit, immutable registrations. The engine never guesses a program from a package. */
/** @param {ToolProvider[]} providers */
export function createToolRegistry(providers = []) {
    if (!Array.isArray(providers)) throw new Error('Tools must be an array of providers.');
    const registry = new Map();
    for (const entry of providers) {
        if (!entry || !commandName(entry.command) || typeof entry.run !== 'function'
            || !['process', 'auxiliary'].includes(entry.kind || 'process')
            || (entry.revision != null && (typeof entry.revision !== 'string'
                || !/^[A-Za-z0-9._-]{1,128}$/.test(entry.revision)))) {
            throw new Error('Invalid tool provider.');
        }
        if (registry.has(entry.command)) throw new Error('Duplicate tool command: ' + entry.command);
        registry.set(entry.command, Object.freeze({ command: entry.command, run: entry.run,
            kind: entry.kind || 'process', revision: entry.revision || null }));
    }
    return registry;
}

function outputPath(path) {
    if (typeof path !== 'string' || !path || path.length > 4096 || /[\\\0\r\n:]/.test(path)
        || path.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error('Tool outputs require a canonical relative path.');
    }
    return path;
}

/** Validate and copy the whole result before any virtual filesystem writes occur. */
export function validateProcessResult(result) {
    if (!result || typeof result !== 'object') throw new Error('Missing tool result.');
    const exitCode = result.exitCode ?? 0;
    if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) throw new Error('Invalid tool exit code.');
    const input = result.files || [], removed = result.removed || [];
    if (!Array.isArray(input) || !Array.isArray(removed)
        || input.length + removed.length > PROCESS_TOOL_LIMITS.files) throw new Error('Too many tool outputs.');
    const paths = new Set();
    let total = 0;
    const files = input.map(file => {
        const path = outputPath(file?.path);
        if (paths.has(path) || !(file.bytes instanceof Uint8Array)) throw new Error('Invalid or duplicate tool output.');
        paths.add(path); total += file.bytes.byteLength;
        if (total > PROCESS_TOOL_LIMITS.bytes) throw new Error('Tool output byte limit exceeded.');
        return { path, bytes: file.bytes.slice() };
    });
    const removals = removed.map(value => {
        const path = outputPath(value);
        if (paths.has(path)) throw new Error('Overlapping tool outputs.');
        paths.add(path); return path;
    });
    const log = [result.log, result.stdout, result.stderr].filter(x => x != null)
        .map(x => Array.isArray(x) ? x.map(String).join('\n') : String(x)).join('\n').slice(0, 16000);
    return { exitCode, files, removed: removals, log, total };
}

/** Main-thread half of a dedicated worker's synchronous virtual process call. */
export class ProcessToolSession {
    constructor({ worker, buffer, compileId, registry, projectFiles, mainFile, signal, current }) {
        Object.assign(this, { worker, buffer, compileId, registry, projectFiles, mainFile, signal, current });
        this.header = new Int32Array(buffer, 0, 8);
        this.area = new Uint8Array(buffer, 32);
        this.active = null;
    }

    onMessage(message) {
        const active = this.active;
        if (!active || !this.current() || message.compileId !== this.compileId
            || message.sequence !== active.sequence) return;
        const item = active.frames.get(message.frame);
        if (!item) return;
        active.frames.delete(message.frame);
        if (message.error) item.reject(new Error(message.error));
        else item.resolve(message.bytes);
    }

    async _frame(state, bytes, offset = 0) {
        const active = this.active;
        if (!active || active.controller.signal.aborted || !this.current()
            || Atomics.load(this.header, 1) !== active.sequence) throw new Error('Tool session cancelled.');
        if (bytes.byteLength > this.area.length || Atomics.load(this.header, 0) !== WAIT) {
            throw new Error('Invalid tool mailbox state.');
        }
        const frame = ++active.frame;
        const reply = new Promise((resolve, reject) => active.frames.set(frame, { resolve, reject }));
        this.area.set(bytes);
        Atomics.store(this.header, 2, bytes.byteLength);
        Atomics.store(this.header, 3, frame);
        Atomics.store(this.header, 4, offset);
        Atomics.store(this.header, 0, state);
        Atomics.notify(this.header, 0);
        return await reply;
    }

    async execute(message) {
        if (!this.current() || this.active || message.compileId !== this.compileId
            || Atomics.load(this.header, 1) !== message.sequence) return;
        const controller = new AbortController();
        const active = { sequence: message.sequence, controller, frames: new Map(), frame: 0 };
        this.active = active;
        const cancel = () => controller.abort();
        const aborted = () => {
            for (const frame of active.frames.values()) frame.reject(new Error('Tool session cancelled.'));
            active.frames.clear();
            if (this.current() && Atomics.load(this.header, 1) === active.sequence) {
                Atomics.store(this.header, 0, FAILED); Atomics.notify(this.header, 0);
            }
        };
        controller.signal.addEventListener('abort', aborted, { once: true });
        if (this.signal?.aborted) cancel();
        else this.signal?.addEventListener('abort', cancel, { once: true });
        if (controller.signal.aborted) { this.active = null; return; }
        let timer, rejectDeadline, io = Promise.resolve(), inputBytes = 0;
        const deadline = new Promise((_, reject) => {
            rejectDeadline = () => reject(new Error('Tool session cancelled.'));
            controller.signal.addEventListener('abort', rejectDeadline, { once: true });
            timer = setTimeout(() => { reject(new Error('Tool timed out.')); controller.abort(); }, PROCESS_TOOL_LIMITS.timeoutMs);
        });
        const count = bytes => {
            if (controller.signal.aborted) throw new Error('Tool session cancelled.');
            inputBytes += bytes.byteLength;
            if (inputBytes > PROCESS_TOOL_LIMITS.bytes) throw new Error('Tool input byte limit exceeded.');
            return bytes;
        };
        const readProject = createProjectFileReader(this.projectFiles, this.mainFile, count);
        const context = {
            signal: controller.signal, sessionSignal: this.signal,
            readProjectFile: path => readProject(path),
            readFile: path => {
                // Reads share the mailbox: serialize even if a provider uses Promise.all.
                const next = io.then(async () => {
                    if (typeof path !== 'string' || !path || path.length > 4096 || /[\\\0\r\n:]/.test(path)
                        || path.startsWith('/')) throw new Error('Tools require a relative input path.');
                    const bytes = await this._frame(READ, encoder.encode(JSON.stringify({ path })));
                    if (!(bytes instanceof Uint8Array)) throw new Error('Invalid tool file response.');
                    return count(bytes);
                });
                io = next.then(() => undefined, () => undefined);
                return next;
            },
        };
        try {
            const provider = this.registry.get(message.command);
            if (!provider || provider.kind !== 'process' || !Array.isArray(message.args)
                || message.args.length > PROCESS_TOOL_LIMITS.args
                || message.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || /[\0\r\n]/.test(arg))) {
                throw new Error('Tool command is not registered or has invalid arguments.');
            }
            const value = await Promise.race([Promise.resolve().then(() => provider.run({
                command: message.command, args: Object.freeze([...message.args]),
            }, context)), deadline]);
            await io;
            const result = validateProcessResult(value);
            if (result.exitCode !== 0) {
                this._finish(active, { exitCode: result.exitCode, log: result.log });
                return;
            }
            const manifest = encoder.encode(JSON.stringify({ files: result.files.map(file => ({ path: file.path, size: file.bytes.byteLength })), removed: result.removed }));
            await this._frame(MANIFEST, manifest);
            // Files are concatenated only on the wire, never as another large JS allocation.
            let used = 0, offset = 0;
            const chunk = new Uint8Array(this.area.length);
            for (const file of result.files) {
                let position = 0;
                while (position < file.bytes.length) {
                    const length = Math.min(chunk.length - used, file.bytes.length - position);
                    chunk.set(file.bytes.subarray(position, position + length), used);
                    used += length; position += length;
                    if (used === chunk.length) { await this._frame(CHUNK, chunk, offset); offset += used; used = 0; }
                }
            }
            if (used) await this._frame(CHUNK, chunk.subarray(0, used), offset);
            this._finish(active, { exitCode: result.exitCode, log: result.log });
        } catch (error) {
            this._finish(active, { exitCode: 1, log: 'Tool failed: ' + error.message, error: error.message });
        } finally {
            clearTimeout(timer);
            this.signal?.removeEventListener('abort', cancel);
            controller.signal.removeEventListener('abort', rejectDeadline);
            controller.signal.removeEventListener('abort', aborted);
            controller.abort();
            for (const frame of active.frames.values()) frame.reject(new Error('Tool request finished.'));
            active.frames.clear();
            if (this.active === active) this.active = null;
        }
    }

    _finish(active, result) {
        if (!this.current() || active.controller.signal.aborted || Atomics.load(this.header, 1) !== active.sequence) return;
        const bytes = encoder.encode(JSON.stringify(result));
        this.area.set(bytes); Atomics.store(this.header, 2, bytes.byteLength);
        Atomics.store(this.header, 0, DONE); Atomics.notify(this.header, 0);
    }
}
