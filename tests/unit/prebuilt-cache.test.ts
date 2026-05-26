/**
 * Tests for the normalized-artifact cache loader/serializer.
 *
 * These are the locally-verifiable half of the cache layer: that a committed
 * prebuilt artifact loads in the shape both proxies serve, and that the
 * serializer is deterministic (re-running the prebuild → byte-identical files).
 */

import { describe, it, expect } from 'vitest';

import {
  loadPrebuilt,
  clearPrebuiltCache,
  stablePrebuiltJson,
  isSafePrebuiltName,
  isValidArtifact,
  PREBUILT_SCHEMA,
  type PrebuiltArtifact,
} from '../../packages/prebuilt-cache.ts';

describe('prebuilt-cache loader', () => {
  it('returns null for a package with no committed artifact', async () => {
    clearPrebuiltCache();
    expect(await loadPrebuilt('definitely-not-a-real-package-xyz')).toBeNull();
  });

  it('loads the committed acrotex artifact in ProcessedPackage shape', async () => {
    clearPrebuiltCache();
    const a = await loadPrebuilt('acrotex');
    // This fixture is produced by `bun scripts/prebuild-packages.js acrotex`.
    expect(a).not.toBeNull();
    expect(a!.name).toBe('acrotex');
    expect(a!.provider).toBe('ins');
    expect(a!.schema).toBe(PREBUILT_SCHEMA);
    expect(a!.totalFiles).toBe(Object.keys(a!.files).length);
    // The whole point: docstrip output insdljs.sty is present, routed to TDS.
    expect(
      Object.keys(a!.files).some((p) => p.endsWith('/acrotex/insdljs.sty')),
    ).toBe(true);
  });

  it('memoizes: a second load returns the identical object', async () => {
    clearPrebuiltCache();
    const first = await loadPrebuilt('acrotex');
    const second = await loadPrebuilt('acrotex');
    expect(second).toBe(first);
  });

  it('rejects path-traversal / unsafe names without touching disk', async () => {
    clearPrebuiltCache();
    for (const bad of [
      '../acrotex',
      '../../etc/passwd',
      'acrotex/../soul',
      'a/b',
      'foo.bar',
      '',
      '.',
      'a'.repeat(65),
    ]) {
      expect(await loadPrebuilt(bad)).toBeNull();
    }
  });
});

describe('isSafePrebuiltName', () => {
  it('accepts real package names', () => {
    for (const ok of ['acrotex', 'insdljs', 'latex-lab', 'pgf', 'a4wide', 'l3kernel']) {
      expect(isSafePrebuiltName(ok)).toBe(true);
    }
  });
  it('rejects separators, traversal, dots, over-long, and non-strings', () => {
    for (const bad of ['../x', 'a/b', 'a\\b', '..', 'a.b', '-lead', '', 'a'.repeat(65)]) {
      expect(isSafePrebuiltName(bad)).toBe(false);
    }
    // @ts-expect-error — runtime guard must tolerate non-string input
    expect(isSafePrebuiltName(null)).toBe(false);
  });
});

describe('isValidArtifact', () => {
  const good: PrebuiltArtifact = {
    name: 'x',
    files: { '/a.sty': { path: '/', content: '1' } },
    totalFiles: 1,
    dependencies: [],
  };
  it('accepts a well-formed artifact', () => {
    expect(isValidArtifact(good)).toBe(true);
  });
  it('rejects malformed/truncated artifacts (→ degrade to live fetch)', () => {
    expect(isValidArtifact(null)).toBe(false);
    expect(isValidArtifact({})).toBe(false);
    expect(isValidArtifact({ ...good, files: undefined })).toBe(false);
    expect(isValidArtifact({ ...good, totalFiles: 0 })).toBe(false);
    // totalFiles must agree with the actual file count (truncation guard)
    expect(isValidArtifact({ ...good, totalFiles: 5 })).toBe(false);
  });
});

describe('stablePrebuiltJson', () => {
  const artifact = (): PrebuiltArtifact => ({
    name: 'x',
    files: {
      '/b/two.sty': { path: '/b', content: '2' },
      '/a/one.sty': { path: '/a', content: '1' },
    },
    totalFiles: 2,
    dependencies: ['zed', 'alpha'],
    provider: 'ins',
    schema: PREBUILT_SCHEMA,
  });

  it('sorts object keys at every level (deterministic file ordering)', () => {
    const out = stablePrebuiltJson(artifact());
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed.files)).toEqual(['/a/one.sty', '/b/two.sty']);
  });

  it('is insertion-order independent (byte-identical for equal content)', () => {
    const a = stablePrebuiltJson(artifact());
    const reordered: PrebuiltArtifact = {
      schema: PREBUILT_SCHEMA,
      provider: 'ins',
      dependencies: ['zed', 'alpha'],
      totalFiles: 2,
      files: {
        '/a/one.sty': { content: '1', path: '/a' },
        '/b/two.sty': { content: '2', path: '/b' },
      },
      name: 'x',
    };
    expect(stablePrebuiltJson(reordered)).toBe(a);
  });

  it('does not reorder dependency arrays (arrays are order-significant)', () => {
    const parsed = JSON.parse(stablePrebuiltJson(artifact()));
    expect(parsed.dependencies).toEqual(['zed', 'alpha']);
  });

  it('ends with a trailing newline', () => {
    expect(stablePrebuiltJson(artifact()).endsWith('\n')).toBe(true);
  });
});
