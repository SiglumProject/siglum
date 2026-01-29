// Build file→package index from TeX Live TLPDB
import fs from 'fs';

const data = fs.readFileSync('/tmp/tlpdb.txt', 'utf-8');
const lines = data.split('\n');

const fileToPackage = {};
let currentPkg = null;
let inRunfiles = false;

// Extensions to index: LaTeX packages, classes, defs, and TikZ/PGF library files
const indexedExtensions = /\.(sty|cls|def|fd|cfg|clo|ltx|code\.tex)$/;

for (const line of lines) {
    if (line.startsWith('name ')) {
        currentPkg = line.slice(5).trim();
        inRunfiles = false;
    } else if (line.startsWith('runfiles ')) {
        inRunfiles = true;
    } else if (line.startsWith('docfiles ') || line.startsWith('srcfiles ') || line === '') {
        inRunfiles = false;
    } else if (inRunfiles && line.startsWith(' ')) {
        const file = line.trim();
        if (file.match(indexedExtensions)) {
            const fileName = file.split('/').pop();
            if (fileName && currentPkg && !currentPkg.startsWith('00')) {
                if (!fileToPackage[fileName]) {
                    fileToPackage[fileName] = currentPkg;
                }
            }
        }
    }
}

console.log('Total entries:', Object.keys(fileToPackage).length);
console.log('lingmacros.sty ->', fileToPackage['lingmacros.sty']);
console.log('tree-dvips.sty ->', fileToPackage['tree-dvips.sty']);
console.log('amsmath.sty ->', fileToPackage['amsmath.sty']);
console.log('graphicx.sty ->', fileToPackage['graphicx.sty']);
console.log('tikzlibrarybayesnet.code.tex ->', fileToPackage['tikzlibrarybayesnet.code.tex']);

// Write index to file
const outputPath = process.argv[2] || '/tmp/file-to-package.json';
fs.writeFileSync(outputPath, JSON.stringify(fileToPackage));
console.log(`\nWritten to ${outputPath} (${(fs.statSync(outputPath).size / 1024).toFixed(1)} KB)`);
