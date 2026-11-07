import { beforeEach, describe, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({ capture: vi.fn(), arm: vi.fn(), backend: vi.fn() }));
vi.mock('../../src/checkpoint/session.mjs', () => ({ capturePaused: hooks.capture,
    armCheckpoint: hooks.arm, protectImmutableRoots: vi.fn(), trackProjectAccesses: vi.fn(), installResolvedAsset: vi.fn() }));
vi.mock('../../src/checkpoint/simd-memory.mjs', () => ({ createPreferredMemoryBackend: hooks.backend }));
vi.mock('../../src/checkpoint/planner.mjs', () => ({
    createCheckpointPlanner: () => Object.assign(() => ({ targets: [], candidates: [
        { path: 'project/late.tex', line: 2, editLine: 3 } ] }), { clear() {}, cacheInfo: { retainedBytes: 0 } }),
    targetProbeFiles: (files: object) => files, initialCheckpointCandidate: () => null,
}));
vi.mock('../../src/checkpoint/placement.mjs', () => ({ placementCandidates: (plan: { candidates: object[] }) => plan.candidates, recordOvershoot() {} }));
import { createCheckpointDriver } from '../../src/checkpoint-api.js';

function handle(memoryBytes: number) {
    return { memoryBytes, captureMs: 1, dispose: vi.fn(), check: vi.fn((): { accepted: boolean; reason?: string } => ({ accepted: true })),
        disposeForRecapture: vi.fn(() => ({})), restoreAndResume: vi.fn(() => ({ accepted: true,
            nativeStatus: 1, guardMs: 1, restoreMs: 1, texMs: 1 })) };
}
function setup() {
    const driver = createCheckpointDriver({ maximumBytes: 64 });
    const job = { key: 'project', signature: 'runtime', engine: 'xelatex', main: 'project/main.tex',
        files: { 'project/main.tex': Array(20).fill('main').join('\n'), 'project/late.tex': 'one\ntwo\nthree\n' },
        assets: new Map(), aux: {}, focus: { path: 'project/late.tex', line: 3 },
        collectAux: () => ({}), finishFonts: vi.fn(async () => 0), finishOutput: vi.fn(async () => 0) };
    const vfs = { mountedFiles: new Set(), getPendingDeferredFiles: () => [] };
    const module = { FS: { __siglumNativeResourceRoots: new Set() }, HEAPU8: new Uint8Array(128),
        __siglumInstanceId: 1, UTF8ToString: vi.fn(() => '/project/main.tex'),
        _siglum_checkpoint_arm: vi.fn(() => 0), _siglum_checkpoint_engine: () => 2,
        _siglum_checkpoint_paused: () => 1, _siglum_checkpoint_next_line: vi.fn(() => 14),
        _siglum_checkpoint_filename: () => 0, _siglum_checkpoint_total_pages: () => 25,
        _siglum_checkpoint_resume: vi.fn(() => 0), __siglumPendingCheckpoint: undefined as object | undefined };
    const pending = (targets: object[] = []) => { module.__siglumPendingCheckpoint = {
        candidate: { path: job.main, line: 14, editLine: 14 }, plan: { targets }, aux: {},
        vfs, immutableRoots: [], backend: {} }; };
    driver.begin(job);
    return { driver, job, module, vfs, pending };
}
beforeEach(() => { hooks.capture.mockReset(); hooks.arm.mockReset().mockReturnValue(0);
    hooks.backend.mockReset().mockResolvedValue({ memoryCapture() {} }); });

describe('checkpoint retention policy preserves valid native work', () => {
    it('finishes a complete paused pass after a budget rejection', () => {
        const f = setup(), captured = handle(128); hooks.capture.mockReturnValue(captured); f.pending();
        expect(f.driver.afterPass(f.module, 1)).toBe(0);
        expect(f.module._siglum_checkpoint_resume).toHaveBeenCalledTimes(1);
        expect(captured.dispose).toHaveBeenCalledTimes(1);
        expect(f.driver.metadata()).toMatchObject({ mode: 'full', retained: false, snapshotBytes: 0 });
    });
    it('finishes after a post-capture source-placement rejection', () => {
        const f = setup(), captured = handle(32);
        captured.check.mockReturnValue({ accepted: false, reason: 'prefix consumed' });
        hooks.capture.mockReturnValue(captured); f.pending([{}]);
        expect(f.driver.afterPass(f.module, 1)).toBe(0);
        expect(f.module._siglum_checkpoint_resume).toHaveBeenCalledTimes(1);
        expect(captured.dispose).toHaveBeenCalledTimes(1);
    });
    it('keeps fresh-module fallback for a real capture failure', () => {
        const f = setup(); hooks.capture.mockImplementation(() => { throw new Error('Scanner ABI mismatch'); }); f.pending();
        expect(() => f.driver.afterPass(f.module, 1)).toThrow(/Checkpoint capture failed/);
        expect(f.module._siglum_checkpoint_resume).not.toHaveBeenCalled();
    });
    it('completes an oversized promotion without re-running the source prefix and remembers a smaller point', async () => {
        const f = setup(), first = handle(32), oversized = handle(128);
        hooks.capture.mockReturnValueOnce(first).mockReturnValueOnce(oversized); f.pending();
        f.driver.afterPass(f.module, 1); f.driver.confirm(f.module, {}, [], true); f.driver.endRequest();
        f.module._siglum_checkpoint_resume.mockClear();
        f.module._siglum_checkpoint_next_line.mockReturnValue(3); f.module.UTF8ToString.mockReturnValue('/project/late.tex');
        f.driver.begin({ ...f.job, files: { ...f.job.files, 'project/late.tex': 'one\ntwo\nchanged\n' } });
        const result = await f.driver.tryResume();
        expect(result).not.toBeNull(); expect(result!.module).toBe(f.module);
        expect(result!.metadata).toMatchObject({ mode: 'reuse', retained: false, snapshotBytes: 0,
            retentionRejected: { policy: 'memory', bytes: 128, maximumBytes: 64 } });
        expect(first.restoreAndResume).toHaveBeenCalledTimes(1);
        expect(first.disposeForRecapture).toHaveBeenCalledTimes(1);
        expect(oversized.dispose).toHaveBeenCalledTimes(1);
        expect(f.module._siglum_checkpoint_resume).toHaveBeenCalledTimes(1);
        expect(f.job.finishOutput).toHaveBeenCalledTimes(1);
        await f.driver.preparePass(f.module, f.vfs, {});
        expect(f.module.__siglumPendingCheckpoint).toMatchObject({ candidate: { path: f.job.main, line: 14 } });
    });
});


describe('native checkpoint capability selection', () => {
    it('arms XeTeX through its combined-runtime continuation ABI', async () => {
        const f = setup();
        await f.driver.preparePass(f.module, f.vfs, {});
        expect(hooks.arm).toHaveBeenCalledWith(f.module, '/project/late.tex', 2);
        expect(f.module.__siglumPendingCheckpoint).toMatchObject({
            candidate: { path: 'project/late.tex', line: 2 },
        });
    });
    it('explains a combined runtime without checkpoint exports', async () => {
        const f = setup();
        Reflect.deleteProperty(f.module, '_siglum_checkpoint_arm');
        await f.driver.preparePass(f.module, f.vfs, {});
        expect(hooks.arm).not.toHaveBeenCalled();
        expect(hooks.backend).not.toHaveBeenCalled();
        expect(f.driver.metadata()).toMatchObject({ mode: 'full', retained: false,
            reason: 'The selected xelatex runtime has no native checkpoint exports' });
    });
    it('rejects a different native engine ABI instead of treating it as XeTeX', async () => {
        const f = setup();
        f.module._siglum_checkpoint_engine = () => 1;
        await f.driver.preparePass(f.module, f.vfs, {});
        expect(hooks.arm).not.toHaveBeenCalled();
        expect(f.driver.metadata()).toMatchObject({ mode: 'full', retained: false,
            reason: 'The selected runtime does not expose the XeTeX checkpoint ABI' });
    });
    it('preserves an explicit full-build request', async () => {
        const f = setup();
        f.driver.begin({ ...f.job, forceFull: true });
        await f.driver.preparePass(f.module, f.vfs, {});
        expect(hooks.arm).not.toHaveBeenCalled();
        expect(f.driver.metadata().reason).toBe('Explicit full build requested');
    });
});
