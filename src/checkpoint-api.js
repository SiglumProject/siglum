export { createSyncInputReceiver } from './checkpoint/sync-io.mjs';
import { placementCandidates, recordOvershoot } from './checkpoint/placement.mjs';
import { prepareDefaultMap } from './checkpoint/default-map.mjs';
import { planCompleteFontRanges } from './checkpoint/font-ranges.mjs';
import { createUsedFontPinScope } from './checkpoint/font-pins.mjs';
import * as session from './checkpoint/session.mjs';
import * as compact from './checkpoint/compact-memory.mjs';
import { createCheckpointPlanner, targetProbeFiles, initialCheckpointCandidate } from './checkpoint/planner.mjs';
import { createPreferredMemoryBackend } from './checkpoint/simd-memory.mjs';
export { readPagePacket, readLiveFonts, checkCachedFonts } from './checkpoint/page-packet.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const now = () => performance.now();
function bytes(value) {
    if (typeof value === 'string') return encoder.encode(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return new Uint8Array(value);
}
function equal(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return false;
    const left = bytes(a), right = bytes(b);
    return left.length === right.length && left.every((value, i) => value === right[i]);
}
function sameMap(a, b) {
    return !!a && !!b && a.size === b.size && [...a].every(([key, value]) => b.has(key) && equal(value, b.get(key)));
}
function sameAux(a = {}, b = {}) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}

// Retention policy runs after a complete native/FS capture. Rejecting storage
// does not invalidate the paused native pass or justify repeating its work.
class CheckpointRetentionError extends Error {
    constructor(message, policy, bytes = 0) {
        super(message);
        this.name = 'CheckpointRetentionError';
        this.policy = policy;
        this.bytes = bytes;
    }
}

/** A single checkpoint inside the ordinary worker. No fetching or package rules. */
export function createCheckpointDriver({ log = () => {}, maximumBytes = 48 * 1024 * 1024 } = {}) {
    const planner = createCheckpointPlanner();
    let saved = null, lastFiles = null, lastKey = null, job = null;
    let lastReason = 'No reusable checkpoint', nextPlan = null, retentionFallback = null;
    const placements = new Map(), placementHints = new Map();
    const copiedFiles = files => Object.fromEntries(Object.entries(files).map(([name, value]) =>
        [name, typeof value === 'string' ? value : bytes(value).slice()]));
    function drop(reason) {
        saved?.handle.dispose();
        saved = null;
        if (reason) lastReason = reason;
    }
    function captureAtPoint(module, vfs, { candidate, plan, aux, immutableRoots, backend, fontRanges = [] }) {
        let handle;
        try {
            const actualLine = module._siglum_checkpoint_next_line();
            // Native libraries can materialize their read-only data during
            // initialization. Pin the now-existing tree at the actual pause.
            session.protectImmutableRoots(module.FS, immutableRoots);
            handle = session.capturePaused(module, job.files, {
                root: '/', checkpointFile: candidate.path, nextLine: actualLine,
                pdfPath: job.pdfPath, immutableRoots, pruneImmutable: true,
                memoryCapture: backend.memoryCapture,
                resumeNative: value => value._siglum_checkpoint_resume(),
                readResumedOutput: (_value, nativeStatus) => ({ nativeStatus }),
            });
            if (handle.memoryBytes > maximumBytes) throw new CheckpointRetentionError('Checkpoint exceeds the retained memory budget: ' + handle.memoryBytes + ' > ' + maximumBytes + ' bytes', 'memory', handle.memoryBytes);
            if (plan.targets.length) {
                const probe = handle.check(targetProbeFiles(job.files, plan.targets));
                if (!probe.accepted) throw new CheckpointRetentionError('Edited input already consumed: ' + probe.reason, 'placement');
            }
            return { handle, module, vfs, aux: { ...aux }, assets: new Map(job.assets),
                signature: job.signature, key: job.key, actualLine, path: candidate.path,
                pages: module._siglum_checkpoint_total_pages(), fontRanges, immutableRoots };
        } catch (error) { handle?.dispose(); throw error; }
    }
    return {
        prepareDefaultMap,
        installResolvedAsset: session.installResolvedAsset,
        planFontRanges: planCompleteFontRanges,
        pinFonts: createUsedFontPinScope,
        begin(request) {
            job = request;
            nextPlan = null;
            if (lastKey !== job.key) {
                drop('Document changed'); lastFiles = null; retentionFallback = null; planner.clear(); placements.clear(); placementHints.clear();
            }
            if (job.forceFull) drop('Explicit full build requested');
        },
        // A retained checkpoint owns its native/FS snapshot, not the completed
        // transport request and its package buffers or per-request callbacks.
        endRequest() { job = null; nextPlan = null; },
        get module() { return saved?.module; },
        get vfs() { return saved?.vfs; },
        drop,
        async tryResume() {
            if (!saved || job.forceFull) return null;
            if (saved.key !== job.key || saved.signature !== job.signature || !sameMap(saved.assets, job.assets)
                || !sameAux(saved.aux, job.aux)) {
                log('[Checkpoint] Guard inputs: ' + JSON.stringify({ key: saved.key === job.key, signature: saved.signature === job.signature, assets: sameMap(saved.assets, job.assets), aux: sameAux(saved.aux, job.aux), savedAssets: saved.assets.size, assetsNow: job.assets.size }));
                log('[Checkpoint] Runtime inputs or auxiliary state changed');
                drop('Runtime inputs or auxiliary state changed');
                return null;
            }
            const editPlan = planner({ main: job.main, files: job.files }, {
                previousFiles: lastFiles, focus: job.focus, maxCandidates: 3,
            });
            // Keep an already-valid checkpoint while typing. Moving it closer
            // must not turn a safe resume into a slower full-document build.
            // A rejected guard or a required full pass can prepare a new point.
            nextPlan = editPlan;
            const start = now();
            try {
                job.beforeResume?.(saved.module, saved.vfs);
                saved.module.__siglumResetOutput?.();
                const current = saved;
                const candidate = placementCandidates(editPlan, placementHints).find(value =>
                    !(value.path === job.main && value.line === 1)
                    && !placements.has(value.path + ':' + value.line + ':' + value.editLine)
                    && (value.path !== current.path || value.line > current.actualLine));
                const result = current.handle.restoreAndResume(job.files, candidate ? {
                    allowCheckpointPause: true,
                    resumeNative(module) {
                        if (session.armCheckpoint(module, '/' + candidate.path, candidate.line) !== 0) {
                            throw new Error('Checkpoint advance arm rejected');
                        }
                        return module._siglum_checkpoint_resume();
                    },
                } : undefined);
                if (result.accepted && candidate && result.nativeStatus === 1 && current.module._siglum_checkpoint_paused() === 1) {
                    const module = current.module, vfs = current.vfs;
                    const actualLine = module._siglum_checkpoint_next_line();
                    const path = module.UTF8ToString(module._siglum_checkpoint_filename());
                    if (path !== '/' + candidate.path || actualLine > candidate.editLine) {
                        if (path === '/' + candidate.path) recordOvershoot(placementHints, candidate, actualLine);
                        placements.set(candidate.path + ':' + candidate.line + ':' + candidate.editLine, true);
                        while (placements.size > 16) placements.delete(placements.keys().next().value);
                        log('[Checkpoint] Advance overshot edit; retaining the original checkpoint');
                    } else {
                        const oldPages = current.pages;
                        // The old replay is complete and its JS call has returned. Release
                        // its sole snapshot before capturing the new paused boundary.
                        const scratchLease = current.handle.disposeForRecapture(); saved = null;
                        const backend = await createPreferredMemoryBackend(module, { compact, scratchLease, deduplicate: job.engine === 'xelatex' });
                        try {
                            saved = captureAtPoint(module, vfs, { candidate, plan: editPlan, aux: current.aux,
                                immutableRoots: current.immutableRoots, backend, fontRanges: current.fontRanges });
                            result.promotion = { fromPages: oldPages, toPages: saved.pages, captureMs: saved.handle.captureMs };
                            log('[Checkpoint] Advanced the sole checkpoint from page ' + oldPages + ' to ' + saved.pages);
                        } catch (error) {
                            if (!(error instanceof CheckpointRetentionError)) throw error;
                            placements.set(candidate.path + ':' + candidate.line + ':' + candidate.editLine, true);
                            while (placements.size > 16) placements.delete(placements.keys().next().value);
                            retentionFallback = error.policy === 'memory' ? { key: current.key, signature: current.signature,
                                path: current.path, line: current.actualLine, editLine: current.actualLine } : null;
                            result.retentionRejected = { policy: error.policy, bytes: error.bytes, maximumBytes };
                            lastReason = error.message;
                            log('[Checkpoint] Finishing the valid replay without retaining the larger checkpoint: ' + error.message);
                        }
                    }
                    const resumedAt = now();
                    result.nativeStatus = current.module._siglum_checkpoint_resume();
                    result.texMs += now() - resumedAt;
                } else if (result.accepted && candidate) {
                    placements.set(candidate.path + ':' + candidate.line + ':' + candidate.editLine, true);
                    while (placements.size > 16) placements.delete(placements.keys().next().value);
                }
                if (!result.accepted) { log('[Checkpoint] Guard rejected: ' + result.reason); drop(result.reason); return null; }
                const active = saved || current;
                const status = await job.finishFonts(active.module, active.vfs, result.nativeStatus);
                if (status !== 0 || active.vfs.getPendingDeferredFiles().length) {
                    drop('A resumed run needs new resources; using the normal resolver'); return null;
                }
                const conversionStart = now();
                if (job.finishOutput && await job.finishOutput(active.module, active.vfs) !== 0) {
                    drop('Output conversion did not complete; using a full build'); return null;
                }
                const conversionMs = now() - conversionStart;
                active.module._flush_streams?.();
                const aux = job.collectAux(active.module.FS);
                const auxChanged = !sameAux(active.aux, aux);
                const needsConvergence = auxChanged && (job.needsRerun?.(active.module.FS, aux) ?? true);
                lastFiles = copiedFiles(job.files); lastKey = job.key;
                const metadata = { mode: 'reuse', reason: result.retentionRejected ? 'Native checkpoint reused; larger checkpoint not retained' : 'Native checkpoint reused',
                    retained: !!saved, snapshotBytes: saved?.handle.memoryBytes || 0, heapBytes: active.module.HEAPU8.byteLength,
                    actualLine: active.actualLine, path: active.path, pagesAtCheckpoint: active.pages,
                    guardMs: result.guardMs, restoreMs: result.restoreMs, texMs: result.texMs, conversionMs,
                    totalMs: now() - start, instanceId: active.module.__siglumInstanceId,
                    ...(result.retentionRejected ? { retentionRejected: result.retentionRejected } : {}),
                    ...(result.promotion ? { promotion: result.promotion } : {}) };
                log(`[Checkpoint] reuse: ${metadata.totalMs.toFixed(1)}ms; ${Math.round(metadata.snapshotBytes / 1048576)} MiB snapshot`);
                const completed = { module: active.module, aux, fontRanges: active.fontRanges, metadata, needsConvergence };
                if (auxChanged) {
                    metadata.retained = false;
                    metadata.snapshotBytes = 0;
                    drop(needsConvergence ? 'References changed; continuing from completed auxiliary files'
                        : 'Auxiliary state changed without a TeX rerun request; publishing the valid pass');
                    log(needsConvergence ? '[Checkpoint] References changed; preserving this completed pass for convergence'
                        : '[Checkpoint] Auxiliary bytes changed without a rerun request; no extra TeX pass');
                }
                return completed;
            } catch (error) {
                log('[Checkpoint] Saved state could not resume: ' + error.message); drop('Saved state could not resume: ' + error.message);
                return null;
            }
        },
        async preparePass(module, vfs, aux, eligible = true) {
            drop();
            // Binary selection and checkpoint eligibility are separate. XeTeX
            // lives in the combined runtime; a matching build exposes its own
            // continuation ABI. Report an incompatible artifact instead of
            // silently presenting it as an ordinary no-checkpoint compilation.
            const unavailable = !eligible ? 'This pass is not checkpoint-safe'
                : job.forceFull ? 'Explicit full build requested'
                : typeof module._siglum_checkpoint_arm !== 'function'
                    ? 'The selected ' + job.engine + ' runtime has no native checkpoint exports'
                : job.engine === 'xelatex' && module._siglum_checkpoint_engine?.() !== 2
                    ? 'The selected runtime does not expose the XeTeX checkpoint ABI' : null;
            if (unavailable) {
                lastReason = unavailable;
                log('[Checkpoint] Full build: ' + unavailable);
                return;
            }
            let focus = job.focus;
            if (!focus || focus.offset === 0) {
                const path = focus?.path && Object.hasOwn(job.files, focus.path) ? focus.path : job.main;
                focus = { path, offset: bytes(job.files[path]).byteLength };
            }
            nextPlan ??= planner({ main: job.main, files: job.files }, {
                previousFiles: lastKey === job.key ? lastFiles : undefined, focus, maxCandidates: 3,
            });
            if (!lastFiles) {
                const initial = initialCheckpointCandidate(job.main, job.files[job.main]);
                if (initial) nextPlan = { ...nextPlan, candidates: [initial, ...nextPlan.candidates] };
            }
            const fallback = retentionFallback?.key === job.key && retentionFallback.signature === job.signature
                && Object.hasOwn(job.files, retentionFallback.path) ? retentionFallback : null;
            const candidate = [...(fallback ? [fallback] : []), ...placementCandidates(nextPlan, placementHints)].find(value =>
                !placements.has(value.path + ':' + value.line + ':' + value.editLine));
            if (!candidate) { lastReason = nextPlan.reason || 'No safe checkpoint candidate'; return; }
            const backend = await createPreferredMemoryBackend(module, { compact, deduplicate: job.engine === 'xelatex' });
            const immutableRoots = ['/texlive', '/bin', ...module.FS.__siglumNativeResourceRoots || [], ...(module.__siglumDefaultMapPath ? [module.__siglumDefaultMapPath] : []), ...[...vfs.mountedFiles].filter(path =>
                !Object.hasOwn(job.files, path.replace(/^\/+/, '')) && !path.startsWith('/texlive/') && !path.startsWith('/bin/'))];
            const nativeRoots = module.FS.__siglumNativeResourceRoots || new Set();
            session.protectImmutableRoots(module.FS, immutableRoots.filter(root => !nativeRoots.has(root)));
            session.trackProjectAccesses(module.FS, '/', { projectPaths: Object.keys(job.files) });
            const status = session.armCheckpoint(module, '/' + candidate.path, candidate.line);
            if (status !== 0) { lastReason = 'Native checkpoint arm rejected'; return; }
            module.__siglumPendingCheckpoint = { candidate, backend, aux, vfs, plan: nextPlan, immutableRoots };
        },
        afterPass(module, status) {
            const pending = module.__siglumPendingCheckpoint;
            module.__siglumPendingCheckpoint = null;
            if (!module._siglum_checkpoint_paused?.()) return status;
            if (pending) {
                const { candidate, backend, aux, vfs, plan, immutableRoots } = pending;
                const actualLine = module._siglum_checkpoint_next_line();
                const path = module.UTF8ToString(module._siglum_checkpoint_filename());
                if (path !== '/' + candidate.path || actualLine > candidate.editLine) {
                    if (path === '/' + candidate.path) recordOvershoot(placementHints, candidate, actualLine);
                    placements.set(candidate.path + ':' + candidate.line + ':' + candidate.editLine, true);
                    while (placements.size > 16) placements.delete(placements.keys().next().value);
                    lastReason = 'Native safe point overshot the edit; completing the normal pass';
                    return module._siglum_checkpoint_resume();
                }
                try {
                    saved = captureAtPoint(module, vfs, { candidate, plan, aux, immutableRoots, backend });
                    lastReason = 'Native checkpoint prepared';
                } catch (error) {
                    placements.set(candidate.path + ':' + candidate.line + ':' + candidate.editLine, true);
                    while (placements.size > 16) placements.delete(placements.keys().next().value);
                    lastReason = error.message;
                    if (error instanceof CheckpointRetentionError) {
                        if (error.policy === 'placement') retentionFallback = null;
                        log('[Checkpoint] Completing the native pass without retaining this checkpoint: ' + error.message);
                        return module._siglum_checkpoint_resume();
                    }
                    log('[Checkpoint] Full build retained: ' + error.message);
                    throw Object.assign(new Error('Checkpoint capture failed: ' + error.message), { checkpointCaptureFailed: true });
                }
            }
            return module._siglum_checkpoint_resume();
        },
        confirm(module, aux, fontRanges, success) {
            if (!success) { drop('Full compilation did not succeed'); return this.metadata(); }
            lastFiles = copiedFiles(job.files); lastKey = job.key;
            if (saved && (saved.module !== module || !sameAux(saved.aux, aux))) {
                drop('Checkpoint auxiliary state predates convergence');
            }
            if (saved) saved.fontRanges = fontRanges;
            return this.metadata();
        },
        metadata() {
            return { mode: saved ? 'prepared' : 'full', retained: !!saved, reason: lastReason,
                snapshotBytes: saved?.handle.memoryBytes || 0, actualLine: saved?.actualLine,
                path: saved?.path, pagesAtCheckpoint: saved?.pages,
                plannerCacheBytes: planner.cacheInfo?.retainedBytes || 0 };
        },
    };
}
