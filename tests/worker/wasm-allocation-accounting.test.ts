import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync('src/worker.js', 'utf8');
function ledger() {
    const start = source.indexOf('// Count observed native memory allocations');
    const end = source.indexOf('// End native allocation accounting.', start);
    if (start < 0 || end < start) throw new Error('Missing worker allocation ledger');
    return runInNewContext(source.slice(start, end) + '\n({observeWasmMemory,observeModuleMemory,wasmAllocationStats,setWorkerId(id){wasmAllocationWorkerId=id}})', { WebAssembly, WeakMap, Number });
}
describe('native allocation budget observations', () => {
    it('counts each memory once, adds only growth, and includes intermediate or failed passes', () => {
        const stats = ledger(), first = new WebAssembly.Memory({ initial: 1, maximum: 8 });
        const module = { asm: { memory: first } };
        stats.setWorkerId(7);
        stats.observeWasmMemory(first);
        expect(stats.wasmAllocationStats(module)).toMatchObject({ workerId: 7, wasmAllocatedBytes: 65536, wasmAllocationCount: 1, wasmAllocationComplete: true });
        first.grow(1);
        expect(stats.wasmAllocationStats(module).wasmAllocatedBytes).toBe(131072);
        const second = new WebAssembly.Memory({ initial: 3, maximum: 8 });
        stats.observeWasmMemory(second);
        expect(stats.wasmAllocationStats({ asm: { memory: second } }).wasmAllocatedBytes).toBe(327680);
        expect(stats.wasmAllocationStats({ asm: { memory: second } }).wasmAllocationCount).toBe(2);
        first.grow(1);
        stats.observeModuleMemory(module);
        expect(stats.wasmAllocationStats(null).wasmAllocatedBytes).toBe(393216);
    });
    it('deduplicates new native instances that import the same arena', () => {
        const stats = ledger(), memory = new WebAssembly.Memory({ initial: 2 });
        stats.observeModuleMemory({ asm: { memory } });
        stats.observeModuleMemory({ asm: { memory } });
        expect(stats.wasmAllocationStats(null)).toMatchObject({ wasmAllocatedBytes: 131072, wasmAllocationCount: 1 });
    });
    it('marks unavailable observations incomplete without breaking compilation', () => {
        const stats = ledger();
        stats.observeWasmMemory(new WebAssembly.Memory({ initial: 1 }));
        stats.observeModuleMemory({});
        expect(stats.wasmAllocationStats(null).wasmAllocationComplete).toBe(false);
        stats.observeModuleMemory({ get asm() { throw new Error('Unavailable'); } });
        expect(stats.wasmAllocationStats(null).wasmAllocationComplete).toBe(false);
    });
});
