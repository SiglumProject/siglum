// Page Validator for Bounded Incremental Compilation
// Validates that compiled sections maintain expected page counts
// Optimized for performance

/**
 * Validation result statuses
 */
export const ValidationStatus = Object.freeze({
    VALID: 'valid',
    PAGE_OVERFLOW: 'overflow',
    PAGE_UNDERFLOW: 'underflow',
    INVALID: 'invalid',
});

/**
 * Validate that a compiled section produces expected page count
 * @param {Object} options
 * @returns {Object}
 */
export function validatePageCount(options) {
    const { pdfData, expectedPageCount, tolerance = 0 } = options;

    if (!pdfData || pdfData.length === 0) {
        return {
            status: ValidationStatus.INVALID,
            reason: 'empty-pdf',
            actualPageCount: 0,
            expectedPageCount,
        };
    }

    const actualPageCount = extractPageCount(pdfData);

    if (actualPageCount === null) {
        return {
            status: ValidationStatus.INVALID,
            reason: 'cannot-determine-page-count',
            actualPageCount: null,
            expectedPageCount,
        };
    }

    const diff = actualPageCount - expectedPageCount;

    if (Math.abs(diff) <= tolerance) {
        return {
            status: ValidationStatus.VALID,
            actualPageCount,
            expectedPageCount,
            difference: diff,
        };
    }

    return {
        status: diff > 0 ? ValidationStatus.PAGE_OVERFLOW : ValidationStatus.PAGE_UNDERFLOW,
        actualPageCount,
        expectedPageCount,
        difference: diff,
        reason: diff > 0
            ? `Section produced ${diff} extra page(s)`
            : `Section produced ${-diff} fewer page(s)`,
    };
}

// PDF parsing patterns - precompiled as byte sequences
const CATALOG_BYTES = [0x2F, 0x54, 0x79, 0x70, 0x65, 0x20, 0x2F, 0x43, 0x61, 0x74, 0x61, 0x6C, 0x6F, 0x67]; // /Type /Catalog
const PAGES_BYTES = [0x2F, 0x54, 0x79, 0x70, 0x65, 0x20, 0x2F, 0x50, 0x61, 0x67, 0x65, 0x73]; // /Type /Pages
const COUNT_PREFIX = [0x2F, 0x43, 0x6F, 0x75, 0x6E, 0x74, 0x20]; // /Count

/**
 * Extract page count from PDF data using binary search
 * Optimized to avoid full text conversion
 * @param {Uint8Array} pdfData
 * @returns {number|null}
 */
export function extractPageCount(pdfData) {
    if (!pdfData || pdfData.length < 100) return null;

    try {
        // Search for /Type /Pages followed by /Count
        const pagesIdx = findBytes(pdfData, PAGES_BYTES, 0);
        if (pagesIdx === -1) return null;

        // Look for /Count after /Pages within reasonable range
        const searchEnd = Math.min(pagesIdx + 200, pdfData.length);
        const countIdx = findBytes(pdfData, COUNT_PREFIX, pagesIdx);

        if (countIdx === -1 || countIdx >= searchEnd) {
            // Fallback: count /Type /Page occurrences
            return countPageObjects(pdfData);
        }

        // Parse the number after /Count
        let numStart = countIdx + COUNT_PREFIX.length;
        let numEnd = numStart;

        // Skip whitespace
        while (numStart < pdfData.length && isWhitespace(pdfData[numStart])) {
            numStart++;
        }
        numEnd = numStart;

        // Read digits
        while (numEnd < pdfData.length && isDigit(pdfData[numEnd])) {
            numEnd++;
        }

        if (numEnd === numStart) return null;

        // Parse the number
        let count = 0;
        for (let i = numStart; i < numEnd; i++) {
            count = count * 10 + (pdfData[i] - 0x30);
        }

        return count > 0 ? count : null;
    } catch (e) {
        return null;
    }
}

/**
 * Find byte sequence in array
 * @param {Uint8Array} data
 * @param {number[]} pattern
 * @param {number} start
 * @returns {number}
 */
function findBytes(data, pattern, start) {
    const len = data.length - pattern.length;
    outer: for (let i = start; i <= len; i++) {
        for (let j = 0; j < pattern.length; j++) {
            if (data[i + j] !== pattern[j]) continue outer;
        }
        return i;
    }
    return -1;
}

function isWhitespace(byte) {
    return byte === 0x20 || byte === 0x09 || byte === 0x0A || byte === 0x0D;
}

function isDigit(byte) {
    return byte >= 0x30 && byte <= 0x39;
}

// Pattern for /Type /Page (not /Pages)
const PAGE_TYPE = [0x2F, 0x54, 0x79, 0x70, 0x65, 0x20, 0x2F, 0x50, 0x61, 0x67, 0x65];

/**
 * Count /Type /Page occurrences (fallback method)
 * @param {Uint8Array} pdfData
 * @returns {number}
 */
function countPageObjects(pdfData) {
    let count = 0;
    let pos = 0;
    const len = pdfData.length;

    while (pos < len) {
        const idx = findBytes(pdfData, PAGE_TYPE, pos);
        if (idx === -1) break;

        // Verify it's /Page not /Pages (check next byte isn't 's')
        const nextPos = idx + PAGE_TYPE.length;
        if (nextPos < len && pdfData[nextPos] !== 0x73) {
            count++;
        }
        pos = idx + 1;
    }

    return count > 0 ? count : null;
}

// Precompiled patterns for SyncTeX parsing
const SYNCTEX_LINE_REGEX = /^l\s+(\d+)/;
const SYNCTEX_V_REGEX = /^v:(\d+):(\d+)/;

/**
 * Analyze page boundaries using SyncTeX data
 * @param {string} synctexContent
 * @param {Array} sections
 * @returns {Map<string, {startPage, endPage}>}
 */
export function analyzePagesFromSynctex(synctexContent, sections) {
    const pageMapping = new Map();

    if (!synctexContent || !sections || sections.length === 0) {
        return pageMapping;
    }

    // Build line-to-page mapping efficiently
    const lineToPage = new Map();
    let currentPage = 0;
    const lines = synctexContent.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const firstChar = line.charCodeAt(0);

        // Page marker
        if (firstChar === 0x7B) { // '{'
            const num = parseInt(line.slice(1), 10);
            if (!isNaN(num)) currentPage = num;
            continue;
        }

        // Line marker
        if (firstChar === 0x6C) { // 'l'
            const match = SYNCTEX_LINE_REGEX.exec(line);
            if (match) {
                const lineNum = parseInt(match[1], 10);
                if (!lineToPage.has(lineNum) || currentPage < lineToPage.get(lineNum)) {
                    lineToPage.set(lineNum, currentPage);
                }
            }
            continue;
        }

        // Alt format
        if (firstChar === 0x76) { // 'v'
            const match = SYNCTEX_V_REGEX.exec(line);
            if (match) {
                const lineNum = parseInt(match[2], 10);
                if (!lineToPage.has(lineNum)) {
                    lineToPage.set(lineNum, currentPage);
                }
            }
        }
    }

    // Map sections to pages
    for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        let startPage = null;
        let endPage = null;

        for (let line = section.startLine; line <= section.endLine; line++) {
            const page = lineToPage.get(line);
            if (page !== undefined) {
                if (startPage === null) startPage = page;
                endPage = page;
            }
        }

        if (startPage !== null) {
            pageMapping.set(section.id, { startPage, endPage });
        }
    }

    return pageMapping;
}

/**
 * Determine if validation failure should trigger full recompile
 * @param {Object} validationResult
 * @param {Object} options
 * @returns {boolean}
 */
export function shouldTriggerFullRecompile(validationResult, options = {}) {
    const {
        allowOverflow = false,
        allowUnderflow = true,
        maxOverflowPages = 0,
    } = options;

    const status = validationResult.status;

    if (status === ValidationStatus.VALID) return false;
    if (status === ValidationStatus.INVALID) return true;

    if (status === ValidationStatus.PAGE_OVERFLOW) {
        return !allowOverflow || validationResult.difference > maxOverflowPages;
    }

    if (status === ValidationStatus.PAGE_UNDERFLOW) {
        return !allowUnderflow;
    }

    return true;
}

/**
 * Build expected page ranges for sections
 * @param {Array} sections
 * @param {Object} cachedPageMapping
 * @returns {Map<string, number>}
 */
export function buildExpectedPageCounts(sections, cachedPageMapping) {
    const expected = new Map();

    for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        const range = cachedPageMapping.getSection(section.id);
        expected.set(
            section.id,
            range ? range.endPage - range.startPage + 1 : 1
        );
    }

    return expected;
}
