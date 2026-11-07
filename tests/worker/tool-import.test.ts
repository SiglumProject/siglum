import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const source = readFileSync(resolve(__dirname, '../../src/worker.js'), 'utf8');
let context;
beforeEach(() => {
    context = createContext({ self: { postMessage: vi.fn() }, TextDecoder, Uint8Array, setTimeout, clearTimeout });
    runInContext(source, context);
});
describe('explicit WebAssembly tool capabilities', () => {
    it('denies the original host system import when no provider is connected', () => {
        const hostShell = vi.fn();
        context.imports = { env: { system: hostShell, untouched: 19 } };
        expect(runInContext('installToolSystemImport(imports, () => null)', context)).toBe(true);
        expect(context.imports.env.system(0)).toBe(0);
        expect(context.imports.env.system(123)).toBe(-1);
        expect(hostShell).not.toHaveBeenCalled();
        expect(context.imports.env.untouched).toBe(19);
    });
    it('resolves the current module and returns the configured tool exit status', () => {
        const decode = vi.fn(() => 'latexminted config');
        const runner = vi.fn(() => 127);
        context.imports = { env: { system: vi.fn() } };
        context.module = { UTF8ToString: decode };
        runInContext('installToolSystemImport(imports, () => module)', context);
        expect(context.imports.env.system(123)).toBe(-1);
        context.module.siglumRunTool = runner;
        expect(context.imports.env.system(0)).toBe(1);
        expect(context.imports.env.system(123)).toBe(127 << 8);
        expect(decode).toHaveBeenCalledWith(123);
        expect(runner).toHaveBeenCalledWith('latexminted config');
        delete context.module.siglumRunTool;
        expect(context.imports.env.system(123)).toBe(-1);
    });
    it('leaves modules without a system import alone', () => {
        context.imports = { env: { memory: 42 }, empty: null };
        expect(runInContext('installToolSystemImport(imports, () => null)', context)).toBe(false);
        expect(context.imports.env.memory).toBe(42);
    });
});

describe('process callback lifetime', () => {
    it('detaches callbacks before destroying the WASM module', () => {
        const disconnect = vi.fn();
        context.module = { __siglumDisconnectProcessTool: disconnect };
        runInContext('destroyModule(module)', context);
        expect(disconnect).toHaveBeenCalledOnce();
    });
});
