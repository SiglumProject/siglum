/**
 * Mock manifest and bundle data for testing.
 */

// Sample file manifest - maps paths to bundle info
export const SAMPLE_FILE_MANIFEST: Record<string, { bundle: string; start: number; end: number; size?: number }> = {
    '/texlive/texmf-dist/tex/latex/base/article.cls': { bundle: 'base', start: 0, end: 1000 },
    '/texlive/texmf-dist/tex/latex/base/size10.clo': { bundle: 'base', start: 1000, end: 2000 },
    '/texlive/texmf-dist/tex/latex/base/latex.ltx': { bundle: 'base', start: 2000, end: 3000 },
    '/texlive/texmf-dist/tex/latex/amsmath/amsmath.sty': { bundle: 'amsmath', start: 0, end: 5000 },
    '/texlive/texmf-dist/tex/latex/amsmath/amstext.sty': { bundle: 'amsmath', start: 5000, end: 6000 },
    '/texlive/texmf-dist/tex/latex/amsmath/amsgen.sty': { bundle: 'amsmath', start: 6000, end: 7000 },
    '/texlive/texmf-dist/tex/latex/graphics/graphicx.sty': { bundle: 'graphics', start: 0, end: 3000 },
    '/texlive/texmf-dist/tex/latex/graphics/graphics.sty': { bundle: 'graphics', start: 3000, end: 6000 },
    '/texlive/texmf-dist/tex/latex/graphics/keyval.sty': { bundle: 'graphics', start: 6000, end: 8000 },
    '/texlive/texmf-dist/tex/latex/hyperref/hyperref.sty': { bundle: 'hyperref', start: 0, end: 10000 },
    '/texlive/texmf-dist/tex/latex/hyperref/pd1enc.def': { bundle: 'hyperref', start: 10000, end: 12000 },
    '/texlive/texmf-dist/tex/latex/xcolor/xcolor.sty': { bundle: 'xcolor', start: 0, end: 4000 },
    '/texlive/texmf-dist/tex/latex/geometry/geometry.sty': { bundle: 'geometry', start: 0, end: 5000 },
    '/texlive/texmf-dist/tex/latex/fontspec/fontspec.sty': { bundle: 'fontspec', start: 0, end: 8000 },
    '/texlive/texmf-dist/tex/latex/beamer/beamer.cls': { bundle: 'beamer', start: 0, end: 15000 },
    '/texlive/texmf-dist/fonts/type1/public/cm-super/sfrm1000.pfb': { bundle: 'cm-super', start: 0, end: 50000 },
    '/texlive/texmf-dist/fonts/enc/dvips/cm-super/cm-super-ts1.enc': { bundle: 'cm-super', start: 50000, end: 55000 },
    '/texlive/texmf-dist/web2c/texmf.cnf': { bundle: 'base', start: 3000, end: 4000 },
};

// Sample bundles.json structure
export const SAMPLE_BUNDLES_JSON = {
    version: 5,
    bundles: {
        'base': {
            size: 4000,
            files: 4,
            requires: [],
        },
        'amsmath': {
            size: 7000,
            files: 3,
            requires: ['base'],
        },
        'graphics': {
            size: 8000,
            files: 3,
            requires: ['base'],
        },
        'hyperref': {
            size: 12000,
            files: 2,
            requires: ['base', 'graphics'],
        },
        'xcolor': {
            size: 4000,
            files: 1,
            requires: ['base'],
        },
        'geometry': {
            size: 5000,
            files: 1,
            requires: ['base'],
        },
        'fontspec': {
            size: 8000,
            files: 1,
            requires: ['base'],
        },
        'beamer': {
            size: 15000,
            files: 1,
            requires: ['base', 'graphics', 'hyperref'],
        },
        'cm-super': {
            size: 55000,
            files: 2,
            requires: [],
        },
    },
    packages: {
        'article': 'base',
        'amsmath': 'amsmath',
        'amstext': 'amsmath',
        'amssymb': 'amsmath',
        'amsthm': 'amsmath',
        'graphicx': 'graphics',
        'graphics': 'graphics',
        'hyperref': 'hyperref',
        'xcolor': 'xcolor',
        'geometry': 'geometry',
        'fontspec': 'fontspec',
        'beamer': 'beamer',
    },
    engines: {
        'pdflatex': {
            required: ['base'],
        },
        'xelatex': {
            required: ['base', 'fontspec'],
        },
        'lualatex': {
            required: ['base'],
        },
    },
    deferred: ['cm-super'],
};

// Sample package map
export const SAMPLE_PACKAGE_MAP: Record<string, string> = {
    'article': 'base',
    'report': 'base',
    'book': 'base',
    'amsmath': 'amsmath',
    'amssymb': 'amsmath',
    'amsthm': 'amsmath',
    'graphicx': 'graphics',
    'graphics': 'graphics',
    'color': 'graphics',
    'hyperref': 'hyperref',
    'url': 'hyperref',
    'xcolor': 'xcolor',
    'geometry': 'geometry',
    'fontspec': 'fontspec',
    'unicode-math': 'fontspec',
    'beamer': 'beamer',
};

// Sample package dependencies
export const SAMPLE_PACKAGE_DEPS: Record<string, string[]> = {
    'amsmath': ['amsgen', 'amstext'],
    'graphicx': ['graphics', 'keyval'],
    'hyperref': ['url', 'color'],
    'beamer': ['hyperref', 'xcolor'],
    'environ': ['utils'],
};

// Bundle dependencies
export const SAMPLE_BUNDLE_DEPS = {
    engines: {
        'pdflatex': { required: ['base'] },
        'xelatex': { required: ['base', 'fontspec'] },
    },
    bundles: {
        'amsmath': { requires: ['base'] },
        'graphics': { requires: ['base'] },
        'hyperref': { requires: ['base', 'graphics'] },
        'beamer': { requires: ['base', 'graphics', 'hyperref'] },
    },
    deferred: ['cm-super'],
};

// Mock bundle data (binary content)
export function createMockBundleData(bundleName: string): ArrayBuffer {
    // Create fake bundle data based on manifest entries
    const entries = Object.entries(SAMPLE_FILE_MANIFEST)
        .filter(([_, info]) => info.bundle === bundleName);

    if (entries.length === 0) {
        return new ArrayBuffer(1000); // Empty bundle
    }

    const maxEnd = Math.max(...entries.map(([_, info]) => info.end));
    const buffer = new ArrayBuffer(maxEnd);
    const view = new Uint8Array(buffer);

    // Fill with identifiable content
    for (const [path, info] of entries) {
        const content = `% ${path}\n% Mock content for testing\n`;
        const bytes = new TextEncoder().encode(content);
        view.set(bytes.slice(0, info.end - info.start), info.start);
    }

    return buffer;
}

// File-to-package index (maps filenames to package names)
export const SAMPLE_FILE_TO_PACKAGE: Record<string, string> = {
    'algorithm.sty': 'algorithms',
    'algorithmic.sty': 'algorithms',
    'bbm.sty': 'bbm-macros',
    'fancyhdr.sty': 'fancyhdr',
    'booktabs.sty': 'booktabs',
    'longtable.sty': 'tools',
    'array.sty': 'tools',
    'multirow.sty': 'multirow',
    'listings.sty': 'listings',
    'tikz.sty': 'pgf',
    'pgfplots.sty': 'pgfplots',
};

// CTAN package result mock
export interface MockPackageResult {
    files: Map<string, Uint8Array>;
    dependencies: string[];
    notFound?: boolean;
}

export function createMockCtanPackage(packageName: string, fileCount = 2): MockPackageResult {
    const files = new Map<string, Uint8Array>();

    // Create main .sty file
    const mainContent = `\\ProvidesPackage{${packageName}}[2024/01/01 Mock package]
\\newcommand{\\${packageName}cmd}{Mock command}
`;
    files.set(`/texlive/texmf-dist/tex/latex/${packageName}/${packageName}.sty`,
        new TextEncoder().encode(mainContent));

    // Create additional files if requested
    for (let i = 1; i < fileCount; i++) {
        const auxContent = `% Auxiliary file ${i} for ${packageName}\n`;
        files.set(`/texlive/texmf-dist/tex/latex/${packageName}/${packageName}-aux${i}.tex`,
            new TextEncoder().encode(auxContent));
    }

    return {
        files,
        dependencies: [],
    };
}

// TAR format helpers for CTAN fetcher tests
export function createMockTarData(files: Record<string, string | Uint8Array>): Uint8Array {
    // Simplified TAR creation for testing
    const chunks: Uint8Array[] = [];

    for (const [path, content] of Object.entries(files)) {
        const data = typeof content === 'string'
            ? new TextEncoder().encode(content)
            : content;

        // Create TAR header (512 bytes)
        const header = new Uint8Array(512);

        // Name (bytes 0-99)
        const nameBytes = new TextEncoder().encode(path.slice(0, 100));
        header.set(nameBytes, 0);

        // Mode (bytes 100-107) - octal 644
        header.set(new TextEncoder().encode('0000644'), 100);

        // UID (bytes 108-115)
        header.set(new TextEncoder().encode('0000000'), 108);

        // GID (bytes 116-123)
        header.set(new TextEncoder().encode('0000000'), 116);

        // Size (bytes 124-135) - octal
        const sizeStr = data.length.toString(8).padStart(11, '0');
        header.set(new TextEncoder().encode(sizeStr), 124);

        // Mtime (bytes 136-147)
        header.set(new TextEncoder().encode('00000000000'), 136);

        // Checksum (bytes 148-155) - placeholder
        header.set(new TextEncoder().encode('        '), 148);

        // Type flag (byte 156) - '0' for regular file
        header[156] = 48; // ASCII '0'

        // Calculate checksum
        let checksum = 0;
        for (let i = 0; i < 512; i++) {
            checksum += header[i];
        }
        const checksumStr = checksum.toString(8).padStart(6, '0') + '\0 ';
        header.set(new TextEncoder().encode(checksumStr), 148);

        chunks.push(header);

        // Add data (padded to 512 bytes)
        chunks.push(data);
        const padding = 512 - (data.length % 512);
        if (padding < 512) {
            chunks.push(new Uint8Array(padding));
        }
    }

    // End of archive (two zero blocks)
    chunks.push(new Uint8Array(1024));

    // Concatenate all chunks
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }

    return result;
}

// Sample aux files for caching tests
export const SAMPLE_AUX_FILES = {
    'document.aux': '\\relax\n\\@writefile{toc}{\\contentsline {section}{\\numberline {1}Introduction}{1}{}}\n',
    'document.toc': '\\contentsline {section}{\\numberline {1}Introduction}{1}{}\n',
    'document.log': '% Mock log file\nOutput written on document.pdf (1 page).\n',
};

// Sample PDF data
export const SAMPLE_PDF_DATA = new Uint8Array([
    0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, // %PDF-1.4
    0x0A, 0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A, // Binary marker
    0x31, 0x20, 0x30, 0x20, 0x6F, 0x62, 0x6A, 0x0A, // 1 0 obj
]);

// Sample format file data
export const SAMPLE_FORMAT_DATA = new Uint8Array([
    0x54, 0x45, 0x58, 0x00, // TEX\0
    0x00, 0x00, 0x00, 0x01, // Version
    // ... mock format content
    0x00, 0x00, 0x00, 0x00,
]);

// Compile stats mock
export const SAMPLE_COMPILE_STATS = {
    totalTime: 1500,
    wasmTime: 1200,
    vfsTime: 100,
    bundleLoadTime: 200,
    bundlesLoaded: ['base', 'amsmath'],
    retryCount: 0,
    wasmHeapBytes: 64 * 1024 * 1024,
};
