import { describe, expect, it } from 'vitest';
import { placementCandidates, recordOvershoot } from '../../src/checkpoint/placement.mjs';
describe('native checkpoint placement feedback', () => {
    const candidate = { path: 'book.tex', line: 1253, editLine: 1255, reason: 'paragraph' };
    it('tries a nearby measured earlier point before the file-start fallback', () => {
        const hints = new Map();
        expect(recordOvershoot(hints, candidate, 1256)).toBe(true);
        const options = placementCandidates({ candidates: [candidate, { ...candidate, line: 1 }] }, hints);
        expect(options.map(value => value.line)).toEqual([1250, 1253, 1]);
        expect(options[0].editLine).toBe(1255);
    });
    it('moves farther back if native read-ahead still crosses the target', () => {
        const hints = new Map();
        recordOvershoot(hints, candidate, 1281);
        const first = placementCandidates({ candidates: [candidate] }, hints)[0];
        expect(first.line).toBe(1225);
        recordOvershoot(hints, first, 1281);
        expect(placementCandidates({ candidates: [candidate] }, hints)[0].line).toBeLessThan(first.line);
    });
    it('does not adjust accepted points and bounds retained feedback', () => {
        const hints = new Map();
        expect(recordOvershoot(hints, candidate, 1255)).toBe(false);
        for (let i = 0; i < 30; i++) recordOvershoot(hints, { ...candidate, path: 'file-' + i }, 1256);
        expect(hints.size).toBe(16);
        expect(recordOvershoot(hints, { ...candidate, line: 1 }, 1256)).toBe(false);
    });
});

import { initialCheckpointCandidate } from '../../src/checkpoint/planner.mjs';
describe('first-open checkpoint placement', () => {
    it('starts after the real preamble rather than at end of the document', () => {
        const source = '\\documentclass{article}\n\\begin{document}\nFirst paragraph.\n\nLater paragraph.\n\\end{document}\n';
        const point = initialCheckpointCandidate('main.tex', source);
        expect(point.path).toBe('main.tex');
        expect(point.line).toBe(3);
        expect(point.editLine).toBeGreaterThan(point.line);
    });
    it('ignores document delimiters hidden in comments and verbatim', () => {
        const source = '% \\begin{document}\n\\begin{verbatim}\n\\begin{document}\n\\end{verbatim}\n';
        expect(initialCheckpointCandidate('main.tex', source)).toBeNull();
    });
});
