// Change Classifier for Bounded Incremental Compilation
// Classifies changes into TRIVIAL, BOUNDED, or STRUCTURAL
// Optimized for memory and performance

import { parseSections, hashContent } from './section-parser.js';

/**
 * Change type enum - frozen for immutability
 */
export const ChangeType = Object.freeze({
    TRIVIAL: 'trivial',
    BOUNDED: 'bounded',
    STRUCTURAL: 'structural',
});

// Precompiled structural patterns with both test and global versions
// This avoids creating new RegExp objects inside loops
const STRUCTURAL_PATTERN_SOURCES = [
    '\\\\newcommand\\b',
    '\\\\renewcommand\\b',
    '\\\\def\\\\',
    '\\\\usepackage\\b',
    '\\\\documentclass\\b',
    '\\\\begin\\{document\\}',
    '\\\\end\\{document\\}',
    '\\\\tableofcontents\\b',
    '\\\\listoffigures\\b',
    '\\\\listoftables\\b',
    '\\\\bibliography\\b',
    '\\\\printbibliography\\b',
    '\\\\include\\{',
    '\\\\input\\{',
    '\\\\newtheorem\\b',
    '\\\\theoremstyle\\b',
    '\\\\newcounter\\b',
    '\\\\setcounter\\{(?:page|section|chapter)\\}',
    '\\\\addtocounter\\{(?:page|section|chapter)\\}',
    '\\\\part\\*?(?:\\[[^\\]]*\\])?\\{',
    '\\\\chapter\\*?(?:\\[[^\\]]*\\])?\\{',
    '\\\\appendix\\b',
    '\\\\frontmatter\\b',
    '\\\\mainmatter\\b',
    '\\\\backmatter\\b',
];

// Pre-create both test and global versions at module load
const STRUCTURAL_PATTERNS = STRUCTURAL_PATTERN_SOURCES.map(src => ({
    test: new RegExp(src),
    global: new RegExp(src, 'g'),
}));

const BEGIN_DOC_INDEX = /\\begin\{document\}/;

/**
 * Fast preamble hash comparison
 * @param {string} oldSource
 * @param {string} newSource
 * @returns {boolean}
 */
function preambleChanged(oldSource, newSource) {
    const oldIdx = oldSource.indexOf('\\begin{document}');
    const newIdx = newSource.indexOf('\\begin{document}');

    if (oldIdx === -1 || newIdx === -1) return true;

    // Fast length check before hashing
    if (oldIdx !== newIdx) return true;

    // Only hash if lengths match (likely same preamble)
    return hashContent(oldSource.slice(0, oldIdx)) !== hashContent(newSource.slice(0, newIdx));
}

/**
 * Check if section structures are equivalent
 * @param {Array} oldSections
 * @param {Array} newSections
 * @returns {boolean}
 */
function sectionsStructureChanged(oldSections, newSections) {
    const len = oldSections.length;
    if (len !== newSections.length) return true;

    for (let i = 0; i < len; i++) {
        const o = oldSections[i];
        const n = newSections[i];

        if (o.command !== n.command ||
            o.level !== n.level ||
            o.isStarred !== n.isStarred ||
            o.title !== n.title) {
            return true;
        }
    }
    return false;
}

/**
 * Count pattern occurrences without creating arrays
 * @param {string} source
 * @param {RegExp} pattern
 * @returns {number}
 */
function countMatches(source, pattern) {
    let count = 0;
    pattern.lastIndex = 0;
    while (pattern.exec(source) !== null) count++;
    return count;
}

/**
 * Check if structural patterns have changed
 * Optimized to bail out early on first difference
 * Uses pre-compiled patterns to avoid allocation
 * @param {string} oldSource
 * @param {string} newSource
 * @returns {boolean}
 */
function containsStructuralPattern(oldSource, newSource) {
    if (oldSource === newSource) return false;

    for (let i = 0; i < STRUCTURAL_PATTERNS.length; i++) {
        const { test: testPattern, global: globalPattern } = STRUCTURAL_PATTERNS[i];
        const oldHas = testPattern.test(oldSource);
        const newHas = testPattern.test(newSource);

        // Pattern added or removed
        if (oldHas !== newHas) return true;

        // If pattern exists in both, check if count changed
        if (oldHas && newHas) {
            const oldCount = countMatches(oldSource, globalPattern);
            const newCount = countMatches(newSource, globalPattern);
            if (oldCount !== newCount) return true;
        }
    }
    return false;
}

/**
 * Find sections with changed content
 * @param {Array} oldSections
 * @param {Array} newSections
 * @returns {Array}
 */
function findAffectedSections(oldSections, newSections) {
    const affected = [];
    const len = newSections.length;

    for (let i = 0; i < len; i++) {
        if (oldSections[i].contentHash !== newSections[i].contentHash) {
            affected.push(newSections[i]);
        }
    }
    return affected;
}

// Whitespace/comment normalization pattern - precompiled
const COMMENT_PATTERN = /(?<!\\)%[^\n]*/g;
const WHITESPACE_PATTERN = /\s+/g;

/**
 * Normalize source by removing comments and collapsing whitespace
 * Hoisted outside for performance (avoids closure creation per call)
 * @param {string} s
 * @returns {string}
 */
function normalizeSource(s) {
    COMMENT_PATTERN.lastIndex = 0;
    WHITESPACE_PATTERN.lastIndex = 0;
    return s
        .replace(COMMENT_PATTERN, '')
        .replace(WHITESPACE_PATTERN, ' ')
        .trim();
}

/**
 * Fast whitespace-only change detection
 * Uses hash comparison to avoid full normalization when possible
 * @param {string} oldSource
 * @param {string} newSource
 * @returns {boolean}
 */
function isWhitespaceOnly(oldSource, newSource) {
    // Fast path: same length often means same content
    if (oldSource.length === newSource.length) {
        return oldSource === newSource;
    }

    // Normalize and compare
    return normalizeSource(oldSource) === normalizeSource(newSource);
}

/**
 * Classify a change between two versions of source code
 * @param {string} oldSource - Previous version
 * @param {string} newSource - New version
 * @param {Array} [oldSections] - Cached sections from previous parse
 * @param {Array} [newSections] - Cached sections from new parse
 * @returns {Object} Classification result
 */
export function classifyChange(oldSource, newSource, oldSections = null, newSections = null) {
    // Input validation
    if (!oldSource || !newSource) {
        return { type: ChangeType.STRUCTURAL, reason: 'missing-source' };
    }

    // Fast path: identical sources
    if (oldSource === newSource) {
        return { type: ChangeType.TRIVIAL, sections: [], reason: 'identical' };
    }

    // Fast path: check lengths differ significantly (likely structural)
    const lenDiff = Math.abs(oldSource.length - newSource.length);
    const lenRatio = lenDiff / Math.max(oldSource.length, newSource.length);
    if (lenRatio > 0.3) {
        return { type: ChangeType.STRUCTURAL, reason: 'significant-length-change' };
    }

    // Whitespace-only changes
    if (isWhitespaceOnly(oldSource, newSource)) {
        return { type: ChangeType.TRIVIAL, sections: [], reason: 'whitespace-only' };
    }

    // Preamble changes
    if (preambleChanged(oldSource, newSource)) {
        return { type: ChangeType.STRUCTURAL, reason: 'preamble-changed' };
    }

    // Structural pattern changes
    if (containsStructuralPattern(oldSource, newSource)) {
        return { type: ChangeType.STRUCTURAL, reason: 'structural-pattern' };
    }

    // Parse sections if not provided
    const oldSecs = oldSections || parseSections(oldSource);
    const newSecs = newSections || parseSections(newSource);

    // Section structure changes
    if (sectionsStructureChanged(oldSecs, newSecs)) {
        return { type: ChangeType.STRUCTURAL, reason: 'section-structure-changed' };
    }

    // Find affected sections
    const affected = findAffectedSections(oldSecs, newSecs);

    if (affected.length === 0) {
        return { type: ChangeType.TRIVIAL, sections: [], reason: 'no-content-change' };
    }

    return {
        type: ChangeType.BOUNDED,
        sections: affected,
        reason: `${affected.length} section(s) modified`,
    };
}

// Precompiled patterns for cross-reference detection
const LABEL_PATTERN = /\\label\{([^}]+)\}/g;
const REF_PATTERN = /\\(?:eq)?ref\{([^}]+)\}|\\pageref\{([^}]+)\}/g;
const CITE_PATTERN = /\\cite(?:\[[^\]]*\])?\{([^}]+)\}/g;

/**
 * Check if a change affects cross-references
 * @param {string} oldSource
 * @param {string} newSource
 * @returns {Object}
 */
export function affectsCrossReferences(oldSource, newSource) {
    if (!oldSource || !newSource) {
        return { affects: true, reason: 'missing-source' };
    }

    // Extract and compare labels
    const extractLabels = (source) => {
        const labels = new Set();
        LABEL_PATTERN.lastIndex = 0;
        let m;
        while ((m = LABEL_PATTERN.exec(source)) !== null) {
            labels.add(m[1]);
        }
        return labels;
    };

    const oldLabels = extractLabels(oldSource);
    const newLabels = extractLabels(newSource);

    if (oldLabels.size !== newLabels.size) {
        return { affects: true, reason: 'label-count-changed' };
    }

    for (const label of oldLabels) {
        if (!newLabels.has(label)) {
            return { affects: true, reason: 'label-changed', label };
        }
    }

    // Extract and compare refs
    const countRefs = (source) => {
        REF_PATTERN.lastIndex = 0;
        let count = 0;
        while (REF_PATTERN.exec(source) !== null) count++;
        return count;
    };

    if (countRefs(oldSource) !== countRefs(newSource)) {
        return { affects: true, reason: 'ref-count-changed' };
    }

    // Extract and compare citations
    const countCites = (source) => {
        CITE_PATTERN.lastIndex = 0;
        let count = 0;
        while (CITE_PATTERN.exec(source) !== null) count++;
        return count;
    };

    if (countCites(oldSource) !== countCites(newSource)) {
        return { affects: true, reason: 'cite-count-changed' };
    }

    return { affects: false };
}
