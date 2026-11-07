import { describe, it, expect } from 'vitest';
import { capture } from '../../src/checkpoint/compact-memory.mjs';

const options = { maximumBytes: 2 * 1024 * 1024, pageBytes: 4096 };
function fixture() {
    let memory = new WebAssembly.Memory({ initial: 16, maximum: 32 });
    let allocations = 0;
    return {
        get allocations() { return allocations; },
        asm: { get memory() { return memory; }, set memory(value) { memory = value; } },
        _malloc(bytes: number) { allocations++; if (bytes > 4096) throw new Error('Unexpected scratch growth'); return 4096; },
        get HEAPU8() { return new Uint8Array(memory.buffer); },
    };
}

describe('forward-only compact snapshot ownership', () => {
    it('keeps the default one-capture guard and requires a successful restore before transfer', () => {
        const module = fixture(), snapshot = capture(module, options);
        expect(() => snapshot.takeScratchLease()).toThrow(/live restored/);
        snapshot.dispose();
        expect(() => capture(module, options)).toThrow(/fresh engine/);
        expect(module.allocations).toBe(1);
    });

    it('rejects foreign, policy-mismatched and consumed leases', () => {
        const module = fixture(), other = fixture(), snapshot = capture(module, options);
        snapshot.restore();
        const lease = snapshot.takeScratchLease();
        expect(() => capture(other, { ...options, scratchLease: lease })).toThrow(/foreign/);
        expect(() => capture(module, { ...options, pageBytes: 16384, scratchLease: lease })).toThrow(/foreign/);
        const next = capture(module, { ...options, scratchLease: lease });
        expect(() => capture(module, { ...options, scratchLease: lease })).toThrow(/consumed/);
        next.dispose();
        expect(module.allocations).toBe(1);
    });

    it('transfers twelve times and after growth with one allocation and no stale-handle interference', () => {
        const module = fixture();
        module.HEAPU8[16000] = 21;
        let snapshot = capture(module, options);
        for (let cycle = 0; cycle < 12; cycle++) {
            module.HEAPU8[16000] = 99;
            snapshot.restore();
            expect(module.HEAPU8[16000]).toBe(cycle || 21);
            const old = snapshot, lease = old.takeScratchLease();
            expect(() => old.restore()).toThrow(/disposed/);
            expect(() => old.takeScratchLease()).toThrow(/live restored/);
            module.HEAPU8[16000] = cycle + 1;
            snapshot = capture(module, { ...options, scratchLease: lease });
            old.dispose();
            module.HEAPU8[16000] = 89;
            snapshot.restore();
            expect(module.HEAPU8[16000]).toBe(cycle + 1);
            expect(module.allocations).toBe(1);
        }
        const lease = snapshot.takeScratchLease();
        module.asm.memory.grow(8);
        module.HEAPU8[1100000] = 73;
        snapshot = capture(module, { ...options, scratchLease: lease });
        module.HEAPU8[1100000] = 99;
        snapshot.restore();
        expect(module.HEAPU8[1100000]).toBe(73);
        expect(module.allocations).toBe(1);
        snapshot.dispose();
    });

    it('rejects memory replacement rather than reusing a stale native address', () => {
        const module = fixture(), snapshot = capture(module, options);
        snapshot.restore();
        const lease = snapshot.takeScratchLease();
        module.asm.memory = new WebAssembly.Memory({ initial: 16, maximum: 32 });
        expect(() => capture(module, { ...options, scratchLease: lease })).toThrow(/foreign/);
    });
});
