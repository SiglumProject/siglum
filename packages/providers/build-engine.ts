// TeX build engine — the swappable backend that runs a TeX build step for the
// docstrip/dtx providers. Providers depend only on the TexBuildEngine interface
// (./types.ts), so this file is the one place that knows *how* TeX is invoked.
//
// The intent is to reuse the busytex WASM the engine already ships so
// build env == compile env. That
// headless-busytex wiring is an open question; until it lands, this provides a
// system-binary engine when a `tex` is on PATH (or $SIGLUM_TEX points at one),
// and otherwise reports "no engine" so build-requiring providers fail cleanly
// rather than crash.

import { promisify } from 'util';
import { exec } from 'child_process';
import { writeFile, readFile, rm, mkdir, readdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import type { RawFiles, TexBuildEngine } from './types.ts';

const execAsync = promisify(exec);

// Cache the resolved tex binary path across calls. `undefined` = not yet
// probed; `null` = probed, none found.
let cachedTexBin: string | null | undefined;

async function resolveTexBinary(): Promise<string | null> {
  if (cachedTexBin !== undefined) return cachedTexBin;

  const candidates = [process.env.SIGLUM_TEX, 'tex', 'pdftex'].filter(
    (c): c is string => !!c,
  );
  for (const bin of candidates) {
    try {
      // `tex --version` exits 0 and prints a banner when present.
      await execAsync(`${bin} --version`, { timeout: 10_000 });
      cachedTexBin = bin;
      return bin;
    } catch {
      // try next
    }
  }
  cachedTexBin = null;
  return null;
}

// Build steps must never hang on a license/`\Msg` prompt; batchmode + a hard
// timeout + EOF on stdin guarantee termination (plan §8).
const BUILD_TIMEOUT_MS = 30_000;

function flattenName(path: string): string {
  return path.split('/').pop() || path;
}

function makeSystemEngine(bin: string): TexBuildEngine {
  return {
    name: `system:${bin}`,
    async run({ entry, inputs, command }) {
      const tool = command || 'tex';
      const cmdBin = tool === 'tex' ? bin : tool;
      const dir = join(
        tmpdir(),
        `siglum-build-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      await mkdir(dir, { recursive: true });
      try {
        // Stage inputs by basename — .ins/.dtx reference siblings by name.
        const before = new Set<string>();
        for (const [path, data] of Object.entries(inputs)) {
          const name = flattenName(path);
          await writeFile(join(dir, name), data);
          before.add(name);
        }

        let log = '';
        try {
          const { stdout, stderr } = await execAsync(
            `${cmdBin} -interaction=batchmode ${JSON.stringify(entry)} < /dev/null`,
            { cwd: dir, timeout: BUILD_TIMEOUT_MS },
          );
          log = stdout + stderr;
        } catch (e: any) {
          // docstrip's `tex` often exits non-zero even on success; capture the
          // output and let the caller decide based on harvested files.
          log = `${e.stdout || ''}${e.stderr || ''}\n[exit] ${e.message || e}`;
        }

        // Harvest every file now in the dir (the caller diffs against inputs).
        const files: RawFiles = {};
        for (const name of await readdir(dir)) {
          files[name] = new Uint8Array(await readFile(join(dir, name)));
        }
        return { files, log };
      } finally {
        try {
          await rm(dir, { recursive: true });
        } catch {
          /* best effort */
        }
      }
    },
  };
}

// Returns an engine if one can be created in this environment, else undefined.
// Preference order:
//   1. headless busytex WASM (build env == compile env, plan §4.3) — used when
//      its assets (a large-stack busytex binary + texmf.cnf + docstrip.tex) are
//      present;
//   2. a system `tex`/`$SIGLUM_TEX` binary, if one is on PATH;
//   3. none — build-requiring providers then return a structured unbuildable.
export async function createBuildEngine(): Promise<TexBuildEngine | undefined> {
  const { createBusytexEngine } = await import('./busytex-engine.ts');
  const busytex = createBusytexEngine();
  if (busytex) return busytex;

  const bin = await resolveTexBinary();
  return bin ? makeSystemEngine(bin) : undefined;
}

// Test seam: reset the probe cache (used by unit tests).
export function _resetEngineCache(): void {
  cachedTexBin = undefined;
}
