import { normalizeProjectPath } from './project-paths.js';

const MAX_TOOL_BYTES = 16 * 1024 * 1024;

/** Project reads are independent of any tool or package protocol. */
export function createProjectFileReader(projectFiles, mainFile, onRead = () => {}) {
    const directory = mainFile.slice(0, mainFile.lastIndexOf('/') + 1);
    return path => {
        if (typeof path !== 'string' || /^(?:\/|[a-z][a-z0-9+.-]*:)/i.test(path)
            || path.includes('\\') || path.includes('\0')) {
            throw new Error('Auxiliary tools require a relative project path.');
        }
        const parts = directory.split('/').filter(Boolean);
        for (const part of path.split('/')) {
            if (!part || part === '.') continue;
            if (part === '..') {
                if (!parts.length) throw new Error('Auxiliary input escapes the project root.');
                parts.pop();
            } else parts.push(part);
        }
        const normalized = normalizeProjectPath(parts.join('/'));
        const data = projectFiles?.get(normalized);
        if (data == null) throw new Error('Missing project input: ' + normalized);
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        if (!(bytes instanceof Uint8Array)) throw new Error('Invalid auxiliary input bytes.');
        onRead(bytes);
        return bytes.slice();
    };
}

/** Run a configured tool with read access limited to this compilation's project. */
export async function runAuxiliaryTool(runner, job, projectFiles, mainFile, signal) {
    if (typeof runner !== 'function' || !(/^[a-z][a-z0-9-]{0,63}$/.test(job.tool))
        || !(job.input instanceof Uint8Array) || job.input.byteLength > MAX_TOOL_BYTES) {
        throw new Error('Invalid auxiliary-tool request.');
    }
    if (signal?.aborted) throw new Error('Auxiliary tool cancelled.');
    const controller = new AbortController();
    let inputBytes = job.input.byteLength;
    let timeout;
    let cancel;
    const deadline = new Promise((_, reject) => {
        cancel = () => { controller.abort(); reject(new Error('Auxiliary tool cancelled.')); };
        if (signal?.aborted) cancel();
        else signal?.addEventListener('abort', cancel, { once: true });
        timeout = setTimeout(() => {
            controller.abort();
            reject(new Error('Auxiliary tool timed out.'));
        }, 45000);
    });
    try {
        const result = await Promise.race([Promise.resolve().then(() => runner({
            tool: job.tool,
            input: job.input,
        }, {
            signal: controller.signal,
            sessionSignal: signal,
            readProjectFile: createProjectFileReader(projectFiles, mainFile, bytes => {
                if (controller.signal.aborted) throw new Error('Auxiliary tool cancelled.');
                inputBytes += bytes.byteLength;
                if (inputBytes > MAX_TOOL_BYTES) throw new Error('Auxiliary input size exceeds the limit.');
            }),
        })), deadline]);
        if (Array.isArray(result?.files)) {
            let outputBytes=0;
            if(result.files.length>128) throw new Error('Too many generated files.');
            const files=result.files.map(file=>{
                if(typeof file.path!=='string'||file.path.startsWith('/')||normalizeProjectPath(file.path)!==file.path||!(file.bytes instanceof Uint8Array)) throw new Error('Invalid generated file.');
                outputBytes+=file.bytes.length;
                if(outputBytes>MAX_TOOL_BYTES) throw new Error('Tool output exceeds the limit.');
                return {path:file.path,bytes:file.bytes.slice()};
            });
            const removed=result.removed||[];
            if(!Array.isArray(removed)||removed.length>128||removed.some(path=>typeof path!=='string'||path.startsWith('/')||normalizeProjectPath(path)!==path)) throw new Error('Invalid removed file list.');
            return {files,removed,log:String(result.log||'').slice(0,16000)};
        }
        if (!(result?.bytes instanceof Uint8Array) || !result.bytes.byteLength
            || result.bytes.byteLength > MAX_TOOL_BYTES) throw new Error('Invalid auxiliary-tool output.');
        // Transfer a copy: a provider can retain its own output or views of its heap.
        const log = Array.isArray(result.log) ? result.log.map(String).join('\n') : String(result.log || '');
        return { bytes: result.bytes.slice(), log: log.slice(0, 16000) };
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', cancel);
        controller.abort();
    }
}
