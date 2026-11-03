/** Normalize a path inside the compiler's virtual project root. */
export function normalizeProjectPath(path) {
    if (typeof path !== 'string' || !path || /[\0\r\n\\]/.test(path)) {
        throw new Error('Invalid project file path');
    }
    const parts = [];
    for (const part of path.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') {
            if (!parts.length) throw new Error(`Project path escapes its root: ${path}`);
            parts.pop();
        } else parts.push(part);
    }
    if (!parts.length) throw new Error('Project file path must name a file');
    return parts.join('/');
}
