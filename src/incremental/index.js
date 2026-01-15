// Bounded Incremental Compilation Module
// Export all components for use by the compiler

export {
    parseSections,
    extractPreamble,
    extractDocumentBody,
    getSectionContent,
    findIncludedFiles,
    hashContent,
} from './section-parser.js';

export {
    classifyChange,
    ChangeType,
    affectsCrossReferences,
} from './change-classifier.js';

export {
    CompilationCache,
    PageMapping,
    CounterState,
    getGlobalCache,
    resetGlobalCache,
    extractCounterStates,
} from './compilation-cache.js';

export {
    generateIsolatedDocument,
    generateMinimalIsolatedDocument,
    extractSectionCounterState,
    determineCompileOrder,
    checkIsolationFeasibility,
    estimatePageCount,
} from './section-isolator.js';

export {
    validatePageCount,
    extractPageCount,
    ValidationStatus,
    analyzePagesFromSynctex,
    shouldTriggerFullRecompile,
    buildExpectedPageCounts,
} from './page-validator.js';

export {
    initializePdfLib,
    isPdfLibAvailable,
    mergeSectionPdfs,
    replacePages,
    extractPages,
    getPageCount,
    validatePdf,
    buildReplacementPlan,
    executeReplacementPlan,
    MergeStatus,
} from './pdf-merger.js';

export {
    BoundedIncrementalCompiler,
    createBoundedCompiler,
    CompilationMode,
} from './bounded-compiler.js';
