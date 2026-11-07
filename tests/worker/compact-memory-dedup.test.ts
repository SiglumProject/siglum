import { Buffer } from 'node:buffer';
import { describe, it, expect } from 'vitest';
import { capture } from '../../src/checkpoint/compact-memory.mjs';
import { createPageComparator } from '../../src/checkpoint/page-comparator.mjs';

function sameBytes(actual: Uint8Array, expected: Uint8Array) {
    expect(Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength)
        .equals(Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength))).toBe(true);
}
const pageBytes = 4096;
const maximumBytes = 2 * 1024 * 1024;
function fixture() {
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 32 });
    return { asm: { memory }, _malloc: () => 4096, get HEAPU8() { return new Uint8Array(memory.buffer); } };
}

for (const simdAvailable of [false, true]) describe('exact repeated-page storage, SIMD=' + simdAvailable, () => {
    it('shares identical nonzero pages and restores exact bytes repeatedly after growth', async () => {
        const module = fixture();
        for (let page = 2; page < 128; page++) module.HEAPU8.fill(page % 3 + 1, page * pageBytes, (page + 1) * pageBytes);
        const comparator = await createPageComparator(module.asm.memory, { simdAvailable });
        const snapshot = capture(module, { pageBytes, maximumBytes, comparator });
        const expected = module.HEAPU8.slice();
        expect(snapshot.deduplicatedBytes).toBeGreaterThan(120 * pageBytes);
        expect(snapshot.retainedBytes).toBeLessThan(10 * pageBytes);
        module.asm.memory.grow(1);
        for (let cycle = 0; cycle < 3; cycle++) {
            module.HEAPU8.fill(173);
            snapshot.restore();
            sameBytes(module.HEAPU8.subarray(0, expected.length), expected);
            expect(module.HEAPU8.subarray(expected.length).every(value => value === 0)).toBe(true);
        }
        snapshot.dispose();
        expect(snapshot.retainedBytes).toBe(0);
        expect(() => snapshot.restore()).toThrow(/disposed/);
    });

    it('never merges a fingerprint collision and keeps both native kernels read-only', async () => {
        const module = fixture(), memory = module.asm.memory;
        module.HEAPU8.fill(7, 2 * pageBytes, 4 * pageBytes);
        module.HEAPU8[2 * pageBytes + 123] = 8;
        const comparator = await createPageComparator(memory, { simdAvailable });
        const expected = module.HEAPU8.slice();
        expect(comparator.fingerprint(2 * pageBytes, pageBytes)).toBe(comparator.fingerprint(3 * pageBytes, pageBytes));
        expect(comparator.equal(2 * pageBytes, 3 * pageBytes, pageBytes)).toBe(false);
        sameBytes(module.HEAPU8, expected);
        const snapshot = capture(module, { pageBytes, maximumBytes, comparator: { ...comparator, fingerprint: () => 1 } });
        const captured = module.HEAPU8.slice();
        module.HEAPU8.fill(12);
        snapshot.restore();
        sameBytes(module.HEAPU8, captured);
        snapshot.dispose();
    });

    it('validates ranges and memory identity without corrupting compiler state', async () => {
        const module = fixture();
        const comparator = await createPageComparator(module.asm.memory, { simdAvailable });
        const expected = module.HEAPU8.slice();
        for (const at of [-1, 1.5, 3, maximumBytes]) expect(() => comparator.fingerprint(at, pageBytes)).toThrow(/range/);
        expect(() => comparator.equal(0, 0, maximumBytes)).toThrow(/range/);
        sameBytes(module.HEAPU8, expected);
        expect(() => capture(fixture(), { pageBytes, maximumBytes, comparator })).toThrow(/same engine/);
    });

    it('supports forward recapture without duplicating the allocator reservation', async () => {
        const module = fixture();
        const comparator = await createPageComparator(module.asm.memory, { simdAvailable });
        module.HEAPU8.fill(9, pageBytes * 2, pageBytes * 12);
        let snapshot = capture(module, { pageBytes, maximumBytes, comparator });
        snapshot.restore();
        const scratchLease = snapshot.takeScratchLease();
        module.HEAPU8[pageBytes * 7] = 10;
        snapshot = capture(module, { pageBytes, maximumBytes, comparator, scratchLease });
        module.HEAPU8.fill(88);
        snapshot.restore();
        expect(module.HEAPU8[pageBytes * 7]).toBe(10);
        expect(module.HEAPU8[pageBytes * 8]).toBe(9);
        snapshot.dispose();
    });
});
