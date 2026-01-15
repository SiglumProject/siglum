// Bounded Incremental Compiler
// Main orchestrator for bounded incremental compilation
// Optimized for performance and memory efficiency

import { parseSections, hashContent } from './section-parser.js';
import { classifyChange, ChangeType } from './change-classifier.js';
import {
    CompilationCache,
    PageMapping,
    CounterState,
    getGlobalCache,
    extractCounterStates,
} from './compilation-cache.js';
import {
    generateIsolatedDocument,
    checkIsolationFeasibility,
    determineCompileOrder,
} from './section-isolator.js';
import {
    validatePageCount,
    ValidationStatus,
    shouldTriggerFullRecompile,
    analyzePagesFromSynctex,
} from './page-validator.js';
import {
    initializePdfLib,
    isPdfLibAvailable,
    buildReplacementPlan,
    executeReplacementPlan,
    MergeStatus,
} from './pdf-merger.js';

/**
 * Compilation mode enum
 */
export const CompilationMode = Object.freeze({
    FULL: 'full',
    BOUNDED: 'bounded',
    CACHED: 'cached',
});

/**
 * Bounded Incremental Compiler
 * Orchestrates compilation with automatic fallback to full compilation
 */
export class BoundedIncrementalCompiler {
    constructor(options = {}) {
        this.cache = options.cache || getGlobalCache();
        this.compileFunction = options.compileFunction;
        this.documentId = options.documentId || 'default';

        // Configuration - use defaults for most settings
        this.config = {
            enableBoundedCompilation: options.enableBoundedCompilation !== false,
            maxSectionsForBounded: options.maxSectionsForBounded || 3,
            allowPageOverflow: options.allowPageOverflow || false,
            fallbackOnError: options.fallbackOnError !== false,
            ...options.config,
        };

        // Metrics - reuse object to avoid allocations
        this.metrics = {
            totalCompiles: 0,
            boundedCompiles: 0,
            fullCompiles: 0,
            cachedReturns: 0,
            boundedFallbacks: 0,
        };

        // Initialize pdf-lib if provided
        if (options.pdfLib) {
            initializePdfLib(options.pdfLib);
        }
    }

    /**
     * Main compilation entry point
     * @param {Object} request
     * @returns {Promise<Object>}
     */
    async compile(request) {
        const { source, files, options = {} } = request;

        if (!source || !this.compileFunction) {
            return {
                success: false,
                mode: CompilationMode.FULL,
                error: 'Missing source or compile function',
            };
        }

        this.metrics.totalCompiles++;

        // Get cached state
        const cachedState = this.cache.get(this.documentId);

        // No cache - full compilation
        if (!cachedState?.pdfData) {
            return this._doFullCompilation(request, 'no-cache');
        }

        // Classify the change
        const classification = this._classifyChange(cachedState.sourceHash, source);

        // Handle based on classification
        switch (classification.type) {
            case ChangeType.TRIVIAL:
                return this._returnCached(cachedState, classification);

            case ChangeType.STRUCTURAL:
                return this._doFullCompilation(request, classification.reason);

            case ChangeType.BOUNDED:
                if (!this.config.enableBoundedCompilation) {
                    return this._doFullCompilation(request, 'bounded-disabled');
                }
                return this._doBoundedCompilation(request, cachedState, classification);

            default:
                return this._doFullCompilation(request, 'unknown-classification');
        }
    }

    /**
     * Classify change using cached sections when available
     */
    _classifyChange(cachedSourceHash, newSource) {
        const cachedEntry = this.cache.get(this.documentId);
        if (!cachedEntry?.sections) {
            return { type: ChangeType.STRUCTURAL, reason: 'no-cache' };
        }

        const newSourceHash = hashContent(newSource);

        // Fast path: identical
        if (cachedSourceHash === newSourceHash) {
            return { type: ChangeType.TRIVIAL, reason: 'identical', sections: [] };
        }

        // Parse new sections
        const newSections = parseSections(newSource);
        const oldSections = cachedEntry.sections;

        // Check section count
        if (oldSections.length !== newSections.length) {
            return { type: ChangeType.STRUCTURAL, reason: 'section-count-changed' };
        }

        // Find changed sections
        const changedSections = [];
        for (let i = 0; i < newSections.length; i++) {
            const oldSec = oldSections[i];
            const newSec = newSections[i];

            // Structural changes
            if (oldSec.command !== newSec.command ||
                oldSec.level !== newSec.level ||
                oldSec.isStarred !== newSec.isStarred ||
                oldSec.title !== newSec.title) {
                return { type: ChangeType.STRUCTURAL, reason: 'section-structure-changed' };
            }

            // Content changes
            if (oldSec.contentHash !== newSec.contentHash) {
                changedSections.push(newSec);
            }
        }

        if (changedSections.length === 0) {
            return { type: ChangeType.TRIVIAL, reason: 'no-content-change', sections: [] };
        }

        return {
            type: ChangeType.BOUNDED,
            reason: `${changedSections.length} section(s) modified`,
            sections: changedSections,
        };
    }

    /**
     * Return cached PDF for trivial changes
     */
    _returnCached(cachedState, classification) {
        this.metrics.cachedReturns++;

        return {
            success: true,
            mode: CompilationMode.CACHED,
            pdfData: cachedState.pdfData,
            auxData: cachedState.auxData,
            syncTexData: cachedState.syncTexData,
            classification,
            fromCache: true,
            metrics: this.metrics,
        };
    }

    /**
     * Perform full compilation
     */
    async _doFullCompilation(request, reason) {
        const { source, files, options } = request;
        this.metrics.fullCompiles++;

        try {
            const result = await this.compileFunction({ source, files, options });

            if (!result.success) {
                return {
                    success: false,
                    mode: CompilationMode.FULL,
                    error: result.error,
                    log: result.log,
                    reason,
                };
            }

            // Parse sections for caching
            const sections = parseSections(source);

            // Build page mapping from SyncTeX
            let pageMapping = null;
            if (result.syncTexData) {
                const mapping = analyzePagesFromSynctex(result.syncTexData, sections);
                pageMapping = new PageMapping();
                for (const [sectionId, range] of mapping) {
                    pageMapping.setSection(sectionId, range.startPage, range.endPage);
                }
            }

            // Extract counter states
            let counterStates = null;
            if (result.auxData && pageMapping) {
                counterStates = extractCounterStates(result.auxData, sections);
            }

            // Cache the result
            this.cache.set(this.documentId, {
                sourceHash: hashContent(source),
                pdfData: result.pdfData,
                auxData: result.auxData,
                syncTexData: result.syncTexData,
                sections,
                pageMapping,
                counterStates,
            });

            return {
                success: true,
                mode: CompilationMode.FULL,
                pdfData: result.pdfData,
                auxData: result.auxData,
                syncTexData: result.syncTexData,
                log: result.log,
                reason,
                metrics: this.metrics,
            };
        } catch (error) {
            return {
                success: false,
                mode: CompilationMode.FULL,
                error: error.message,
                reason,
            };
        }
    }

    /**
     * Perform bounded incremental compilation
     */
    async _doBoundedCompilation(request, cachedState, classification) {
        const { source, files, options } = request;
        const { sections: changedSections } = classification;

        // Too many sections changed
        if (changedSections.length > this.config.maxSectionsForBounded) {
            return this._doFullCompilation(request, 'too-many-sections-changed');
        }

        // Check feasibility
        for (let i = 0; i < changedSections.length; i++) {
            const section = changedSections[i];
            const content = source.slice(section.startOffset, section.endOffset);
            const feasibility = checkIsolationFeasibility(section, content);
            if (!feasibility.feasible) {
                return this._doFullCompilation(request, `section-${section.id}-${feasibility.reason}`);
            }
        }

        // Check pdf-lib availability
        if (!isPdfLibAvailable()) {
            return this._doFullCompilation(request, 'pdf-lib-not-available');
        }

        this.metrics.boundedCompiles++;

        try {
            const compiledSections = [];
            const orderedSections = determineCompileOrder(changedSections);

            // Compile each changed section
            for (let i = 0; i < orderedSections.length; i++) {
                const section = orderedSections[i];
                const counterState = cachedState.counterStates?.get(section.id) || new CounterState();
                const pageRange = cachedState.pageMapping?.getSection(section.id);
                const startPage = pageRange?.startPage || 1;

                // Generate isolated document
                const isolatedSource = generateIsolatedDocument({
                    originalSource: source,
                    section,
                    counterState,
                    auxContent: cachedState.auxData,
                    startPage,
                });

                // Compile - avoid spread allocation by mutating copy once per bounded compilation
                const sectionOptions = options ? Object.assign({}, options) : {};
                sectionOptions.isolatedSection = true;
                const sectionResult = await this.compileFunction({
                    source: isolatedSource,
                    files,
                    options: sectionOptions,
                });

                if (!sectionResult.success) {
                    if (this.config.fallbackOnError) {
                        this.metrics.boundedFallbacks++;
                        return this._doFullCompilation(request, `section-compile-error-${section.id}`);
                    }
                    return {
                        success: false,
                        mode: CompilationMode.BOUNDED,
                        error: `Failed to compile section ${section.id}: ${sectionResult.error}`,
                    };
                }

                // Validate page count
                const expectedPageCount = pageRange ? pageRange.endPage - pageRange.startPage + 1 : 1;
                const validation = validatePageCount({
                    pdfData: sectionResult.pdfData,
                    expectedPageCount,
                    tolerance: 0,
                });

                if (shouldTriggerFullRecompile(validation, { allowOverflow: this.config.allowPageOverflow })) {
                    this.metrics.boundedFallbacks++;
                    return this._doFullCompilation(request, `page-count-mismatch-${section.id}`);
                }

                compiledSections.push({
                    id: section.id,
                    pdfData: sectionResult.pdfData,
                    startPage,
                    endPage: startPage + validation.actualPageCount - 1,
                    pageCount: validation.actualPageCount,
                });
            }

            // Build and execute replacement plan
            const plan = buildReplacementPlan(cachedState, compiledSections);

            if (!plan.canMerge) {
                this.metrics.boundedFallbacks++;
                return this._doFullCompilation(request, `merge-plan-invalid: ${plan.warnings.join(', ')}`);
            }

            const mergeResult = await executeReplacementPlan(cachedState.pdfData, plan);

            if (!mergeResult.success) {
                this.metrics.boundedFallbacks++;
                return this._doFullCompilation(request, `merge-failed: ${mergeResult.reason}`);
            }

            // Update cache
            const newSections = parseSections(source);
            this.cache.update(this.documentId, {
                sourceHash: hashContent(source),
                pdfData: mergeResult.pdfData,
                sections: newSections,
            });

            return {
                success: true,
                mode: CompilationMode.BOUNDED,
                pdfData: mergeResult.pdfData,
                auxData: cachedState.auxData,
                syncTexData: cachedState.syncTexData,
                sectionsCompiled: compiledSections.length,
                pagesReplaced: mergeResult.pagesReplaced,
                classification,
                metrics: this.metrics,
            };
        } catch (error) {
            if (this.config.fallbackOnError) {
                this.metrics.boundedFallbacks++;
                return this._doFullCompilation(request, `bounded-error: ${error.message}`);
            }
            return {
                success: false,
                mode: CompilationMode.BOUNDED,
                error: error.message,
            };
        }
    }

    /**
     * Get compilation metrics
     */
    getMetrics() {
        const total = this.metrics.totalCompiles || 1;
        const bounded = this.metrics.boundedCompiles || 1;
        return {
            ...this.metrics,
            boundedRate: this.metrics.boundedCompiles / total,
            cacheHitRate: this.metrics.cachedReturns / total,
            fallbackRate: this.metrics.boundedFallbacks / bounded,
        };
    }

    /**
     * Reset metrics
     */
    resetMetrics() {
        this.metrics.totalCompiles = 0;
        this.metrics.boundedCompiles = 0;
        this.metrics.fullCompiles = 0;
        this.metrics.cachedReturns = 0;
        this.metrics.boundedFallbacks = 0;
    }

    /**
     * Clear cache for this document
     */
    clearCache() {
        this.cache.delete(this.documentId);
    }

    /**
     * Invalidate cache
     */
    invalidateCache() {
        this.clearCache();
    }
}

/**
 * Create a bounded compiler with default settings
 */
export function createBoundedCompiler(options) {
    return new BoundedIncrementalCompiler(options);
}

// Re-export for convenience
export {
    ChangeType,
    CompilationCache,
    PageMapping,
    CounterState,
    initializePdfLib,
    isPdfLibAvailable,
};
