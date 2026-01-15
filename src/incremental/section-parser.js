// Section Parser for Bounded Incremental Compilation
// Extracts section boundaries from LaTeX source
// Optimized for memory and performance

/**
 * DJB2 hash - fast, good distribution, uses unsigned 32-bit arithmetic
 * @param {string} content
 * @returns {string} hex hash
 */
function hashContent(content) {
    let hash = 5381 >>> 0;
    const len = content.length;
    for (let i = 0; i < len; i++) {
        hash = ((hash * 33) ^ content.charCodeAt(i)) >>> 0;
    }
    return hash.toString(16);
}

// Precompiled regex patterns - created once at module load
const SECTION_PATTERNS = Object.freeze([
    { regex: /\\part(\*)?(?:\[([^\]]*)\])?\{([^}]*)\}/g, level: 0, name: 'part' },
    { regex: /\\chapter(\*)?(?:\[([^\]]*)\])?\{([^}]*)\}/g, level: 1, name: 'chapter' },
    { regex: /\\section(\*)?(?:\[([^\]]*)\])?\{([^}]*)\}/g, level: 2, name: 'section' },
    { regex: /\\subsection(\*)?(?:\[([^\]]*)\])?\{([^}]*)\}/g, level: 3, name: 'subsection' },
    { regex: /\\subsubsection(\*)?(?:\[([^\]]*)\])?\{([^}]*)\}/g, level: 4, name: 'subsubsection' },
    { regex: /\\paragraph(\*)?(?:\[([^\]]*)\])?\{([^}]*)\}/g, level: 5, name: 'paragraph' },
]);

const BEGIN_DOC_REGEX = /\\begin\{document\}/;
const END_DOC_REGEX = /\\end\{document\}/;

/**
 * Build line offset index for O(log n) offset-to-line lookups
 * @param {string} source
 * @returns {number[]} array of line start offsets
 */
function buildLineIndex(source) {
    const offsets = [0];
    const len = source.length;
    for (let i = 0; i < len; i++) {
        if (source.charCodeAt(i) === 10) { // '\n'
            offsets.push(i + 1);
        }
    }
    return offsets;
}

/**
 * Binary search for line number from offset
 * @param {number[]} lineIndex
 * @param {number} offset
 * @returns {number} 1-based line number
 */
function offsetToLine(lineIndex, offset) {
    let lo = 0;
    let hi = lineIndex.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (lineIndex[mid] <= offset) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    return lo + 1; // 1-based
}

/**
 * Find all section matches, sorted by position
 * Reuses regex objects by resetting lastIndex
 * @param {string} source
 * @returns {Array} sorted section matches
 */
function findAllSections(source) {
    const matches = [];

    for (let i = 0; i < SECTION_PATTERNS.length; i++) {
        const { regex, level, name } = SECTION_PATTERNS[i];
        regex.lastIndex = 0; // Reset for reuse
        let match;
        while ((match = regex.exec(source)) !== null) {
            matches.push({
                command: name,
                isStarred: match[1] === '*',
                title: match[3] || match[2] || '',
                level,
                offset: match.index,
                length: match[0].length,
            });
        }
    }

    // Sort by position - use simple comparison for speed
    if (matches.length > 1) {
        matches.sort((a, b) => a.offset - b.offset);
    }
    return matches;
}

/**
 * Find document boundaries
 * @param {string} source
 * @returns {{preambleEnd: number, documentStart: number, documentEnd: number}}
 */
function findDocumentBoundaries(source) {
    const beginMatch = BEGIN_DOC_REGEX.exec(source);
    const endMatch = END_DOC_REGEX.exec(source);

    return {
        preambleEnd: beginMatch ? beginMatch.index + beginMatch[0].length : 0,
        documentStart: beginMatch ? beginMatch.index : 0,
        documentEnd: endMatch ? endMatch.index : source.length,
    };
}

/**
 * Parse LaTeX source and extract sections with their boundaries
 * @param {string} source - LaTeX source code
 * @returns {Array<Object>} Array of section objects
 */
export function parseSections(source) {
    if (!source || typeof source !== 'string') {
        return [];
    }

    const boundaries = findDocumentBoundaries(source);
    const sectionMatches = findAllSections(source);
    const lineIndex = buildLineIndex(source);

    if (sectionMatches.length === 0) {
        // No sections - treat entire document body as one section
        const startOffset = boundaries.preambleEnd;
        const endOffset = boundaries.documentEnd;
        return [{
            id: 'document-0-1',
            command: 'document',
            title: '',
            level: -1,
            isStarred: false,
            startLine: offsetToLine(lineIndex, startOffset),
            endLine: offsetToLine(lineIndex, endOffset),
            startOffset,
            endOffset,
            contentHash: hashContent(source.slice(startOffset, endOffset)),
        }];
    }

    const sections = new Array(sectionMatches.length);
    const docEnd = boundaries.documentEnd;

    for (let i = 0; i < sectionMatches.length; i++) {
        const current = sectionMatches[i];
        const startOffset = current.offset + current.length;

        // Find end: next section of same or higher level, or document end
        let endOffset = docEnd;
        for (let j = i + 1; j < sectionMatches.length; j++) {
            if (sectionMatches[j].level <= current.level) {
                endOffset = sectionMatches[j].offset;
                break;
            }
        }

        sections[i] = {
            id: `${current.command}-${i}-${offsetToLine(lineIndex, current.offset)}`,
            command: current.command,
            title: current.title,
            level: current.level,
            isStarred: current.isStarred,
            startLine: offsetToLine(lineIndex, current.offset),
            endLine: offsetToLine(lineIndex, endOffset),
            startOffset: current.offset,
            endOffset,
            contentHash: hashContent(source.slice(startOffset, endOffset)),
        };
    }

    return sections;
}

/**
 * Extract the preamble (everything before \begin{document})
 * @param {string} source
 * @returns {string}
 */
export function extractPreamble(source) {
    if (!source) return '';
    const match = BEGIN_DOC_REGEX.exec(source);
    return match ? source.slice(0, match.index + match[0].length) : source;
}

/**
 * Extract the document body (between \begin{document} and \end{document})
 * @param {string} source
 * @returns {string}
 */
export function extractDocumentBody(source) {
    if (!source) return '';
    const boundaries = findDocumentBoundaries(source);
    return source.slice(boundaries.preambleEnd, boundaries.documentEnd);
}

/**
 * Get content of a specific section
 * @param {string} source
 * @param {Object} section
 * @returns {string}
 */
export function getSectionContent(source, section) {
    if (!source || !section) return '';
    return source.slice(section.startOffset, section.endOffset);
}

// Precompiled patterns for include/input detection
const INCLUDE_REGEX = /\\include\{([^}]+)\}/g;
const INPUT_REGEX = /\\input\{([^}]+)\}/g;

/**
 * Find \include and \input files in source
 * @param {string} source
 * @returns {Array<{file: string, type: string, offset: number}>}
 */
export function findIncludedFiles(source) {
    if (!source) return [];

    const files = [];

    INCLUDE_REGEX.lastIndex = 0;
    let match;
    while ((match = INCLUDE_REGEX.exec(source)) !== null) {
        files.push({ file: match[1], type: 'include', offset: match.index });
    }

    INPUT_REGEX.lastIndex = 0;
    while ((match = INPUT_REGEX.exec(source)) !== null) {
        files.push({ file: match[1], type: 'input', offset: match.index });
    }

    if (files.length > 1) {
        files.sort((a, b) => a.offset - b.offset);
    }
    return files;
}

export { hashContent };
