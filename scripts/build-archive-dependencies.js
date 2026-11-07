// Refresh small-archive dependency hints from the same pinned TLPDB used for
// the release. The ordinary missing-file resolver remains authoritative.
// bun scripts/build-archive-dependencies.js [package-deps.json]
// TLPDB_PATH accepts a plain or .xz-compressed TeX Live package database.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const input = process.env.TLPDB_PATH || path.join(import.meta.dir, '../busytex/source/texmfrepo/tlpkg/texlive.tlpdb');
const output = process.argv[2] || path.join(import.meta.dir, '../packages/bundles/package-deps.json');
const data = input.endsWith('.xz') ? execFileSync('xz', ['-dc', input], { maxBuffer: 64 * 1024 * 1024 }) : fs.readFileSync(input);
const records = {};
for (const block of data.toString('utf8').split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const name = lines.find(line => line.startsWith('name '))?.slice(5);
    const size = Number(lines.find(line => line.startsWith('containersize '))?.slice(14));
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name) || !lines.includes('category Package')
        || !Number.isSafeInteger(size) || size <= 0) continue;
    let runfiles = false, portable = false;
    for (const line of lines) {
        if (line.startsWith('runfiles ')) runfiles = true;
        else if (!line.startsWith(' ')) runfiles = false;
        if (runfiles && /^ (?:RELOC|texmf-dist)\/(?:tex|fonts|bibtex)\//.test(line)) portable = true;
    }
    if (!portable) continue;
    records[name] = { bytes: size, requires: [...new Set(lines.filter(line => /^depend [a-zA-Z0-9_-]+$/.test(line)).map(line => line.slice(7)))].sort() };
}
const meta = JSON.parse(fs.readFileSync(output, 'utf8'));
meta.archiveDependencySource = { format: 1, tlpdbSha256: createHash('sha256').update(data).digest('hex') };
meta.archiveDependencies = Object.fromEntries(Object.keys(records).sort().map(name => [name, records[name]]));
fs.writeFileSync(output, JSON.stringify(meta, null, 2) + '\n');
console.log(`Indexed ${Object.keys(records).length} runtime archives from ${meta.archiveDependencySource.tlpdbSha256}`);
