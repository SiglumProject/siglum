import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../src/worker.js'), 'utf8');
const canonical = '/texlive/texmf-dist/tex/latex/beamer/beamerbasemisc.sty';
const sha256 = '55c5ed95880e452caf786ad4882fb0b839ef902395dcc1b613bc2caa332cf838';
const encoder = new TextEncoder();
const originalText = 'prefix\n    \\renewcommand<>\\includegraphics{%\nplaceholder\n  \\fi\nsuffix\n';
const originalBytes = encoder.encode(originalText);
const log = [
    'Document Class: beamer 2026/01/22 v3.77 A class for typesetting presentations',
    `(${canonical})`,
    './input.tex:46: LaTeX Error: Fil',
    "e `*' not found.",
].join('\n');
const child = '/input.tex';
const starred = encoder.encode(String.raw`\includegraphics<2>*[width=3cm]{exact.png}`);

type Recovery = (
    fs: { readFile: (path: string) => Uint8Array }, source: string, project: Map<string, Uint8Array>, log: string,
) => Promise<{ original: Uint8Array; patched: Uint8Array } | null>;
type ApplyRecovery = (fs: { readFile: (path: string) => Uint8Array; writeFile: (path: string, data: Uint8Array) => void },
    recovery: { original: Uint8Array; patched: Uint8Array }, changedOwner: boolean) => void;

function makeRecovery(hash = sha256) {
    const digest = vi.fn(async () => Uint8Array.from(Buffer.from(hash, 'hex')).buffer);
    const context = createContext({ self: {}, Uint8Array, TextDecoder, TextEncoder,
        crypto: { subtle: { digest } } });
    runInContext(source, context);
    const recover = runInContext('beamerStarRecoveryFiles', context) as Recovery;
    const mount = runInContext('mountVerifiedBeamerRecovery', context) as ApplyRecovery;
    return { recover, mount, digest };
}

it('builds only a separate overlay after the pinned wrapped diagnostic and a child starred call', async () => {
    const { recover, digest } = makeRecovery();
    const readFile = vi.fn(() => originalBytes);
    const project = new Map([[child, starred]]);
    const overlay = await recover({ readFile }, 'main without the starred call', project, log);
    expect(readFile.mock.calls).toEqual([[canonical]]);
    expect(digest.mock.calls).toEqual([['SHA-256', originalBytes]]);
    expect(overlay!.original).toEqual(originalBytes);
    expect(overlay!.original.buffer).not.toBe(originalBytes.buffer);
    expect(new TextDecoder().decode(overlay!.patched)).toMatch(/^prefix\n {4}\\renewcommand[\s\S]+\\beamer@readgraphics[\s\S]+\nsuffix\n$/);
    expect(new TextDecoder().decode(originalBytes)).toBe(originalText);
    expect(Array.from(project.entries())).toEqual([[child, starred]]);
});

it('declines unpinned bytes, local Beamer ownership and unrelated failures', async () => {
    const fs = { readFile: vi.fn(() => originalBytes) };
    const project = new Map([[child, starred]]);
    const different = makeRecovery('00'.repeat(32));
    expect(await different.recover(fs, '', project, log)).toBeNull();
    expect(different.digest).toHaveBeenCalledTimes(1);
    fs.readFile.mockClear();
    const { recover, digest } = makeRecovery();
    for (const name of ['/local/beamer.cls', '/local/beamerbasemisc.sty', '/local/beamerbaseoverlay.sty', canonical]) {
        expect(await recover(fs, '', new Map([...project, [name, originalBytes]]), log)).toBeNull();
    }
    expect(await recover(fs, '', project, log.replace('v3.77', 'v3.78'))).toBeNull();
    expect(await recover(fs, '', project, log.replace('`*\'', '`absent.png\''))).toBeNull();
    expect(await recover(fs, '', project, log.replace(canonical, '/local/beamerbasemisc.sty'))).toBeNull();
    expect(await recover(fs, '', new Map([[child, encoder.encode(String.raw`% \includegraphics*{example.png}`)]]), log)).toBeNull();
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(digest).not.toHaveBeenCalled();
});

it('rechecks every mounted preimage and declines an older Beamer owner before writing', async () => {
    const { recover, mount } = makeRecovery();
    const original = originalBytes.slice();
    const plan = await recover({ readFile: () => original }, '', new Map([[child, starred]]), log);
    const readFile = vi.fn(() => original);
    const writeFile = vi.fn();
    const fs = { readFile, writeFile };

    mount(fs, plan!, false);
    expect(readFile.mock.calls).toEqual([[canonical]]);
    expect(writeFile.mock.calls).toEqual([[canonical, plan!.patched]]);
    writeFile.mockClear();

    // A later VFS rebuild can mount a different archive under the same name
    // and length. The verified copy stays independent of the original mount.
    original[original.length - 1] ^= 1;
    expect(() => mount(fs, plan!, false)).toThrow('Pinned Beamer runfile changed');
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(writeFile).not.toHaveBeenCalled();
    expect(plan!.original).toEqual(originalBytes);

    readFile.mockReturnValue(originalBytes);
    expect(() => mount(fs, plan!, true)).toThrow('Beamer package version changed');
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(writeFile).not.toHaveBeenCalled();
});
