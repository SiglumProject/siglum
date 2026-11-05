import { readFile, writeFile } from 'node:fs/promises';

const packageUrl = new URL('../package.json', import.meta.url);
const outputUrl = new URL('../src/package-metadata.js', import.meta.url);
const { version } = JSON.parse(await readFile(packageUrl, 'utf8'));
if (typeof version !== 'string' || !version) throw new Error('Missing engine package version');
const output = '// Generated from package.json by scripts/generate-package-metadata.mjs.\n'
    + `export const ENGINE_VERSION = ${JSON.stringify(version)};\n`;
let previous;
try { previous = await readFile(outputUrl, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
}
if (previous !== output) await writeFile(outputUrl, output);
