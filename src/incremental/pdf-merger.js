// PDF Merger for Bounded Incremental Compilation
// Merges compiled section PDFs into cached base PDF
// Optimized for memory efficiency

let PDFDocument = null;

/**
 * Initialize pdf-lib
 * @param {Object} pdfLib
 */
export function initializePdfLib(pdfLib) {
    PDFDocument = pdfLib.PDFDocument;
}

/**
 * Check if pdf-lib is available
 * @returns {boolean}
 */
export function isPdfLibAvailable() {
    return PDFDocument !== null;
}

/**
 * Merge result status
 */
export const MergeStatus = Object.freeze({
    SUCCESS: 'success',
    PARTIAL: 'partial',
    FAILED: 'failed',
    NO_PDF_LIB: 'no-pdf-lib',
});

/**
 * Merge compiled section pages into base PDF
 * @param {Object} options
 * @returns {Promise<Object>}
 */
export async function mergeSectionPdfs(options) {
    const { basePdf, sections } = options;

    if (!isPdfLibAvailable()) {
        return {
            status: MergeStatus.NO_PDF_LIB,
            error: 'pdf-lib not initialized',
            pdfData: basePdf,
        };
    }

    try {
        const baseDoc = await PDFDocument.load(basePdf, { ignoreEncryption: true });
        const basePageCount = baseDoc.getPageCount();
        const results = [];

        for (let i = 0; i < sections.length; i++) {
            const section = sections[i];
            try {
                const result = await mergeSection(baseDoc, section, basePageCount);
                results.push({ sectionId: section.sectionId, ...result });
            } catch (e) {
                results.push({ sectionId: section.sectionId, success: false, error: e.message });
            }
        }

        const mergedBytes = await baseDoc.save();
        const allSuccess = results.every(r => r.success);
        const anySuccess = results.some(r => r.success);

        return {
            status: allSuccess ? MergeStatus.SUCCESS : (anySuccess ? MergeStatus.PARTIAL : MergeStatus.FAILED),
            pdfData: new Uint8Array(mergedBytes),
            results,
        };
    } catch (e) {
        return {
            status: MergeStatus.FAILED,
            error: e.message,
            pdfData: basePdf,
        };
    }
}

/**
 * Merge single section into base document
 * @param {PDFDocument} baseDoc
 * @param {Object} section
 * @param {number} basePageCount
 * @returns {Promise<Object>}
 */
async function mergeSection(baseDoc, section, basePageCount) {
    const { pdfData, startPage, endPage } = section;

    if (startPage < 1 || endPage > basePageCount) {
        return {
            success: false,
            error: `Invalid page range ${startPage}-${endPage} for ${basePageCount} pages`,
        };
    }

    const sectionDoc = await PDFDocument.load(pdfData, { ignoreEncryption: true });
    const sectionPageCount = sectionDoc.getPageCount();
    const expectedCount = endPage - startPage + 1;

    const copiedPages = await baseDoc.copyPages(
        sectionDoc,
        Array.from({ length: sectionPageCount }, (_, i) => i)
    );

    let pagesReplaced = 0;
    const limit = Math.min(copiedPages.length, expectedCount);

    for (let i = 0; i < limit; i++) {
        const pageIndex = startPage - 1 + i;
        if (pageIndex < baseDoc.getPageCount()) {
            baseDoc.removePage(pageIndex);
            baseDoc.insertPage(pageIndex, copiedPages[i]);
            pagesReplaced++;
        }
    }

    return {
        success: true,
        pagesReplaced,
        sectionPageCount,
        expectedPageCount: expectedCount,
    };
}

/**
 * Replace specific pages in PDF
 * @param {Uint8Array} targetPdf
 * @param {Uint8Array} sourcePdf
 * @param {Array<{targetPage, sourcePage}>} pageMapping
 * @returns {Promise<Uint8Array>}
 */
export async function replacePages(targetPdf, sourcePdf, pageMapping) {
    if (!isPdfLibAvailable()) {
        throw new Error('pdf-lib not initialized');
    }

    const targetDoc = await PDFDocument.load(targetPdf, { ignoreEncryption: true });
    const sourceDoc = await PDFDocument.load(sourcePdf, { ignoreEncryption: true });

    // Sort descending for safe removal
    const sorted = pageMapping.slice().sort((a, b) => b.targetPage - a.targetPage);

    for (let i = 0; i < sorted.length; i++) {
        const { targetPage, sourcePage } = sorted[i];
        const [copiedPage] = await targetDoc.copyPages(sourceDoc, [sourcePage - 1]);
        targetDoc.removePage(targetPage - 1);
        targetDoc.insertPage(targetPage - 1, copiedPage);
    }

    return new Uint8Array(await targetDoc.save());
}

/**
 * Extract specific pages from PDF
 * @param {Uint8Array} pdfData
 * @param {Array<number>} pageNumbers
 * @returns {Promise<Uint8Array>}
 */
export async function extractPages(pdfData, pageNumbers) {
    if (!isPdfLibAvailable()) {
        throw new Error('pdf-lib not initialized');
    }

    const sourceDoc = await PDFDocument.load(pdfData, { ignoreEncryption: true });
    const newDoc = await PDFDocument.create();

    const indices = pageNumbers.map(p => p - 1);
    const copiedPages = await newDoc.copyPages(sourceDoc, indices);

    for (let i = 0; i < copiedPages.length; i++) {
        newDoc.addPage(copiedPages[i]);
    }

    return new Uint8Array(await newDoc.save());
}

/**
 * Get page count from PDF
 * @param {Uint8Array} pdfData
 * @returns {Promise<number>}
 */
export async function getPageCount(pdfData) {
    if (!isPdfLibAvailable()) {
        throw new Error('pdf-lib not initialized');
    }

    const doc = await PDFDocument.load(pdfData, { ignoreEncryption: true });
    return doc.getPageCount();
}

/**
 * Validate PDF can be loaded
 * @param {Uint8Array} pdfData
 * @returns {Promise<Object>}
 */
export async function validatePdf(pdfData) {
    if (!isPdfLibAvailable()) {
        return { valid: false, error: 'pdf-lib not initialized' };
    }

    try {
        const doc = await PDFDocument.load(pdfData, { ignoreEncryption: true });
        return { valid: true, pageCount: doc.getPageCount() };
    } catch (e) {
        return { valid: false, error: e.message };
    }
}

/**
 * Build page replacement plan
 * @param {Object} cachedState
 * @param {Array} compiledSections
 * @returns {Object}
 */
export function buildReplacementPlan(cachedState, compiledSections) {
    const plan = {
        replacements: [],
        warnings: [],
        canMerge: true,
    };

    for (let i = 0; i < compiledSections.length; i++) {
        const section = compiledSections[i];
        const cachedRange = cachedState.pageMapping?.getSection(section.id);

        if (!cachedRange) {
            plan.warnings.push(`No cached page range for section ${section.id}`);
            plan.canMerge = false;
            continue;
        }

        const expected = cachedRange.endPage - cachedRange.startPage + 1;
        const actual = section.pageCount;

        if (actual !== expected) {
            plan.warnings.push(`Section ${section.id}: expected ${expected} pages, got ${actual}`);
            plan.canMerge = false;
            continue;
        }

        for (let j = 0; j < actual; j++) {
            plan.replacements.push({
                targetPage: cachedRange.startPage + j,
                sourcePdf: section.pdfData,
                sourcePage: j + 1,
                sectionId: section.id,
            });
        }
    }

    return plan;
}

/**
 * Execute replacement plan
 * @param {Uint8Array} basePdf
 * @param {Object} plan
 * @returns {Promise<Object>}
 */
export async function executeReplacementPlan(basePdf, plan) {
    if (!plan.canMerge) {
        return {
            success: false,
            reason: 'Plan indicates merge is not possible',
            warnings: plan.warnings,
        };
    }

    if (!isPdfLibAvailable()) {
        return { success: false, reason: 'pdf-lib not initialized' };
    }

    try {
        const baseDoc = await PDFDocument.load(basePdf, { ignoreEncryption: true });

        // Group by section for efficient batch loading
        const groups = new Map();
        for (let i = 0; i < plan.replacements.length; i++) {
            const r = plan.replacements[i];
            if (!groups.has(r.sectionId)) {
                groups.set(r.sectionId, { sourcePdf: r.sourcePdf, replacements: [] });
            }
            groups.get(r.sectionId).replacements.push(r);
        }

        // Process each group
        for (const [, group] of groups) {
            const sourceDoc = await PDFDocument.load(group.sourcePdf, { ignoreEncryption: true });

            // Sort descending for safe removal/insertion
            group.replacements.sort((a, b) => b.targetPage - a.targetPage);

            for (let i = 0; i < group.replacements.length; i++) {
                const r = group.replacements[i];
                const [copiedPage] = await baseDoc.copyPages(sourceDoc, [r.sourcePage - 1]);
                baseDoc.removePage(r.targetPage - 1);
                baseDoc.insertPage(r.targetPage - 1, copiedPage);
            }
        }

        return {
            success: true,
            pdfData: new Uint8Array(await baseDoc.save()),
            pagesReplaced: plan.replacements.length,
        };
    } catch (e) {
        return { success: false, reason: e.message };
    }
}
