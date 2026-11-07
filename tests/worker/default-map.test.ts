import { describe, expect, it, vi } from 'vitest';
import { compactDefaultMap, prepareDefaultMap } from '../../src/checkpoint/default-map.mjs';

const source = '/texlive/texmf-dist/texmf-var/fonts/map/pdftex/updmap/pdftex.map';
const target = '/tmp/siglum-default-font-map.map';
function moduleFor(text = 'cmr10 CMR10 <cmr10.pfb\ncmr10 CMR10 <cmr10.pfb\n', status = 0) {
    const files = new Map<string, string | Uint8Array>([[source, text]]);
    return { files, module: {
        FS: { analyzePath: (path: string) => ({ exists: files.has(path) }),
            readFile: (path: string) => { if (!files.has(path)) throw Error('missing'); const value = files.get(path); return typeof value === 'string' ? new TextEncoder().encode(value) : value; },
            writeFile: (path: string, value: string) => files.set(path, value),
            unlink: (path: string) => files.delete(path) },
        _malloc: vi.fn(() => 12), _free: vi.fn(), stringToUTF8: vi.fn(),
        _siglum_configure_default_map: vi.fn(() => status),
    } };
}
describe('private initial font map', () => {
    it('removes only exact duplicate rows and preserves alternatives, order and comments', () => {
        const map = '% header\na Font <a.pfb\na Font <a.pfb\na Other <b.pfb\n a Font <a.pfb\n% header\n';
        expect(compactDefaultMap(map)).toEqual({ text: '% header\na Font <a.pfb\na Other <b.pfb\n a Font <a.pfb\n% header\n', removed: 1 });
    });
    it('selects a private map while preserving the original for explicit TeX commands', () => {
        const { module, files } = moduleFor(); const original = files.get(source);
        expect(prepareDefaultMap(module)).toBe(1);
        expect(files.get(source)).toBe(original);
        expect(files.get(target)).toBe('cmr10 CMR10 <cmr10.pfb\n');
        expect(module._free).toHaveBeenCalledWith(12);
    });
    it('keeps an authored temporary-name collision intact', () => {
        const { module, files } = moduleFor(); files.set(target, 'authored');
        expect(prepareDefaultMap(module)).toBe(0);
        expect(files.get(target)).toBe('authored');
        expect(module._siglum_configure_default_map).not.toHaveBeenCalled();
    });
    it('leaves invalid UTF-8 map bytes to the normal engine', () => {
        const { module, files } = moduleFor(); const bytes = Uint8Array.of(255, 10, 255, 10);
        files.set(source, bytes);
        expect(prepareDefaultMap(module)).toBe(0);
        expect(files.get(source)).toBe(bytes);
        expect(module._siglum_configure_default_map).not.toHaveBeenCalled();
    });
    it('preserves normal behavior when the runtime rejects late configuration', () => {
        const { module, files } = moduleFor(undefined, -1); const original = files.get(source);
        expect(prepareDefaultMap(module)).toBe(0);
        expect(files.has(target)).toBe(false);
        expect(files.get(source)).toBe(original);
    });
});
