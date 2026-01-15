// Section Isolator for Bounded Incremental Compilation
// Generates isolated LaTeX documents for section-only compilation
// Optimized for memory and performance

import { extractPreamble, getSectionContent } from './section-parser.js';
import { CounterState } from './compilation-cache.js';

// Precompiled patterns
const BEGIN_DOC_REGEX = /\\begin\{document\}[\s\S]*$/;
const LABEL_REGEX = /\\newlabel\{([^}]+)\}\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
const BIBCITE_REGEX = /\\bibcite\{([^}]+)\}\{([^}]*)\}/g;
const BIBDATA_REGEX = /\\bibdata\{([^}]+)\}/g;

// Feasibility check patterns - precompiled
const LONGTABLE_REGEX = /\\begin\{longtable\}/;
const FLOAT_REGEX = /\\begin\{(figure|table)\}\[!?h!?\]/;
const FLOAT_COUNT_REGEX = /\\begin\{(figure|table)\}/g;
const PAGEBREAK_REGEX = /\\(clearpage|cleardoublepage|newpage)\b/;
const COUNTER_MANIP_REGEX = /\\setcounter\{(section|chapter|page)\}/;

/**
 * Generate an isolated LaTeX document for single section compilation
 * @param {Object} options
 * @returns {string}
 */
export function generateIsolatedDocument(options) {
    const {
        originalSource,
        section,
        counterState,
        auxContent,
        startPage = 1,
    } = options;

    if (!originalSource || !section) {
        return '';
    }

    const preamble = extractPreamble(originalSource);
    const sectionContent = getSectionContent(originalSource, section);

    // Build document efficiently with string array
    const parts = [
        preamble.replace(BEGIN_DOC_REGEX, '').trim(),
        '',
        '% Bounded Incremental Compilation',
        '\\begin{document}',
    ];

    // Counter restoration
    if (counterState && counterState.counters && counterState.counters.size > 0) {
        parts.push('% Counter restoration');
        parts.push(counterState.toLatex());
    }

    // Page counter
    if (startPage > 1) {
        parts.push(`\\setcounter{page}{${startPage}}`);
    }

    // Cross-reference restoration
    if (auxContent) {
        const crossRefs = extractCrossRefCommands(auxContent);
        if (crossRefs.length > 0) {
            parts.push('% Cross-references');
            parts.push(crossRefs);
        }
    }

    // Section content
    parts.push('');
    parts.push(sectionContent);
    parts.push('');
    parts.push('\\end{document}');

    return parts.join('\n');
}

/**
 * Extract cross-reference commands from aux file
 * Returns single string for efficiency
 * @param {string} auxContent
 * @returns {string}
 */
function extractCrossRefCommands(auxContent) {
    if (!auxContent) return '';

    const commands = [];

    LABEL_REGEX.lastIndex = 0;
    let m;
    while ((m = LABEL_REGEX.exec(auxContent)) !== null) {
        commands.push(m[0]);
    }

    BIBCITE_REGEX.lastIndex = 0;
    while ((m = BIBCITE_REGEX.exec(auxContent)) !== null) {
        commands.push(m[0]);
    }

    BIBDATA_REGEX.lastIndex = 0;
    while ((m = BIBDATA_REGEX.exec(auxContent)) !== null) {
        commands.push(m[0]);
    }

    return commands.join('\n');
}

/**
 * Generate minimal isolated document for quick preview
 * @param {Object} options
 * @returns {string}
 */
export function generateMinimalIsolatedDocument(options) {
    const { originalSource, section, startPage = 1 } = options;

    if (!originalSource || !section) return '';

    const preamble = extractPreamble(originalSource);
    const content = getSectionContent(originalSource, section);
    const preambleClean = preamble.replace(BEGIN_DOC_REGEX, '').trim();

    return `${preambleClean}
\\begin{document}
\\setcounter{page}{${startPage}}
${content}
\\end{document}`;
}

/**
 * Extract counter state for a section from aux file
 * @param {string} auxContent
 * @param {Object} section
 * @param {Object} pageMapping
 * @returns {CounterState}
 */
export function extractSectionCounterState(auxContent, section, pageMapping) {
    const state = new CounterState();

    const pageRange = pageMapping?.getSection(section.id);
    if (pageRange) {
        state.set('page', pageRange.startPage);
    }

    if (!auxContent) return state;

    // Parse section numbers from labels using precompiled regex
    SECTION_LABEL_REGEX.lastIndex = 0;
    let m;
    while ((m = SECTION_LABEL_REGEX.exec(auxContent)) !== null) {
        const pageNum = parseInt(m[3], 10);

        if (pageRange && pageNum === pageRange.startPage) {
            const parts = m[2].split('.');
            const counterNames = ['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph'];
            const level = section.level;

            for (let i = 0; i <= level && i < parts.length; i++) {
                const val = parseInt(parts[i], 10);
                if (!isNaN(val) && counterNames[i]) {
                    state.set(counterNames[i], val);
                }
            }
            break;  // Found matching page, done
        }
    }

    return state;
}

/**
 * Determine compile order for changed sections
 * @param {Array} sections
 * @returns {Array}
 */
export function determineCompileOrder(sections) {
    if (sections.length <= 1) return sections;
    return sections.slice().sort((a, b) => a.startOffset - b.startOffset);
}

/**
 * Check if isolated compilation is feasible for a section
 * @param {Object} section
 * @param {string} sectionContent
 * @returns {Object}
 */
export function checkIsolationFeasibility(section, sectionContent) {
    if (!sectionContent) {
        return { feasible: false, reason: 'empty-content' };
    }

    // Longtable check
    if (LONGTABLE_REGEX.test(sectionContent)) {
        return { feasible: false, reason: 'longtable-may-affect-pagination' };
    }

    // Too many floats check
    if (FLOAT_REGEX.test(sectionContent)) {
        FLOAT_COUNT_REGEX.lastIndex = 0;
        let count = 0;
        while (FLOAT_COUNT_REGEX.exec(sectionContent) !== null) count++;
        if (count > 5) {
            return { feasible: false, reason: 'too-many-floats' };
        }
    }

    // Page break commands
    if (PAGEBREAK_REGEX.test(sectionContent)) {
        return { feasible: false, reason: 'explicit-page-break' };
    }

    // Counter manipulation
    if (COUNTER_MANIP_REGEX.test(sectionContent)) {
        return { feasible: false, reason: 'counter-manipulation' };
    }

    return { feasible: true };
}

// Precompiled pattern for extractSectionCounterState
const SECTION_LABEL_REGEX = /\\newlabel\{([^}]+)\}\{\{([\d.]+)\}\{(\d+)\}/g;

// Precompiled patterns for page estimation
const FLOAT_EST_REGEX = /\\begin\{(figure|table)\}/g;
const MATH_EST_REGEX = /\\begin\{(equation|align|gather|multline)\}/g;
const COMMAND_STRIP_REGEX = /\\[a-zA-Z]+(?:\{[^}]*\})?/g;
const BRACE_STRIP_REGEX = /[{}]/g;
const COMMENT_STRIP_REGEX = /%[^\n]*\n/g;

/**
 * Estimate page count for a section
 * @param {string} sectionContent
 * @param {number} charsPerPage
 * @returns {number}
 */
export function estimatePageCount(sectionContent, charsPerPage = 3000) {
    if (!sectionContent) return 1;

    // Remove comments
    let content = sectionContent.replace(COMMENT_STRIP_REGEX, '\n');

    // Count floats and math
    FLOAT_EST_REGEX.lastIndex = 0;
    let floatCount = 0;
    while (FLOAT_EST_REGEX.exec(content) !== null) floatCount++;

    MATH_EST_REGEX.lastIndex = 0;
    let mathCount = 0;
    while (MATH_EST_REGEX.exec(content) !== null) mathCount++;

    // Strip commands for character count
    content = content
        .replace(COMMAND_STRIP_REGEX, '')
        .replace(BRACE_STRIP_REGEX, '');

    const basePages = content.length / charsPerPage;
    const floatPages = floatCount * 0.5;
    const mathPages = mathCount * 0.1;

    return Math.max(1, Math.ceil(basePages + floatPages + mathPages));
}
