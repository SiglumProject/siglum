const key = value => value.path + ':' + value.editLine;

// A native safe point can be later than a lexical boundary because TeX reads
// ahead. Try a measured earlier boundary before falling back to the file start.
export function placementCandidates(plan, hints) {
    const result = [], seen = new Set();
    const add = value => {
        const id = value.path + ':' + value.line + ':' + value.editLine;
        if (!seen.has(id)) { seen.add(id); result.push(value); }
    };
    for (const candidate of plan.candidates) {
        const earlier = hints.get(key(candidate));
        if (Number.isSafeInteger(earlier) && earlier > 0 && earlier < candidate.line) {
            add({ ...candidate, line: earlier, reason: 'Earlier boundary after observed native read-ahead' });
        }
        add(candidate);
    }
    return result;
}

export function recordOvershoot(hints, candidate, actualLine) {
    if (!Number.isSafeInteger(actualLine) || actualLine <= candidate.editLine || candidate.line <= 1) return false;
    const earlier = Math.max(1, candidate.line - Math.max(2, actualLine - candidate.editLine + 2));
    hints.delete(key(candidate));
    hints.set(key(candidate), earlier);
    while (hints.size > 16) hints.delete(hints.keys().next().value);
    return true;
}
