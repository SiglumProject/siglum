// Assemble an immutable local experiment from verified inputs. No network or publishing.
import { readFile, writeFile, mkdir, copyFile, rename, rm, mkdtemp } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const digest = data => createHash('sha256').update(data).digest('hex');
const validName = name => typeof name === 'string' && !!name && !isAbsolute(name)
    && !/[\\\0:#?]/.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..')
    && !['manifest.json', 'server-config.json', 'runtime.json'].includes(name);
const sorted = value => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));

export async function stageExperimentalRuntime({ configPath, output, replacements = {}, engineVersion }) {
    const configDirectory = dirname(resolve(configPath));
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const source = JSON.parse(await readFile(resolve(configDirectory, config.manifest), 'utf8'));
    if (!source.files || !Object.keys(source.files).length) throw new Error('Missing source artifact manifest');
    const sourceRoot = resolve(configDirectory, config.runtimeRoot);
    const entries = new Map();
    for (const [name, expected] of Object.entries(source.files)) {
        if (!validName(name) || !Number.isSafeInteger(expected.size) || expected.size < 0
            || !/^[a-f0-9]{64}$/.test(expected.sha256)) throw new Error('Invalid artifact descriptor: ' + name);
        const path = Object.hasOwn(config.files || {}, name)
            ? resolve(configDirectory, config.files[name]) : resolve(sourceRoot, name);
        const bytes = await readFile(path);
        if (bytes.length !== expected.size || digest(bytes) !== expected.sha256) throw new Error('Source artifact mismatch: ' + name);
        entries.set(name, { path, expected });
    }
    for (const [name, path] of Object.entries(replacements)) {
        if (!validName(name)) throw new Error('Invalid replacement path: ' + name);
        const bytes = await readFile(path);
        entries.set(name, { path: resolve(path), expected: { size: bytes.length, sha256: digest(bytes) } });
    }
    for (const name of ['wasm/busytex.wasm', 'wasm/busytex.js', 'bundles.json', 'file-manifest.json', 'xzwasm.js']) {
        if (!entries.has(name)) throw new Error('Runtime is incomplete: missing ' + name);
    }
    const files = sorted(Object.fromEntries([...entries].map(([name, entry]) => [name, entry.expected])));
    const identity = { texLiveYear: source.texLiveYear, engineVersion: engineVersion || source.engineVersion, files };
    const releaseId = 'tl' + source.texLiveYear + '-' + digest(JSON.stringify(identity)).slice(0, 16);
    if (!/^tl\d{4}-[a-f0-9]{16}$/.test(releaseId)) throw new Error('Invalid source TeX Live year');
    const destination = resolve(output, releaseId);
    const manifest = { releaseId, ...identity, experimental: true };
    try {
        const existing = JSON.parse(await readFile(resolve(destination, 'manifest.json'), 'utf8'));
        if (JSON.stringify(existing) !== JSON.stringify(manifest)) throw new Error('Immutable manifest mismatch');
        for (const [name, expected] of Object.entries(files)) {
            const bytes = await readFile(resolve(destination, name));
            if (bytes.length !== expected.size || digest(bytes) !== expected.sha256) throw new Error('Immutable artifact mismatch: ' + name);
        }
        return { releaseId, directory: destination, reused: true };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(resolve(output), { recursive: true });
    const temporary = await mkdtemp(resolve(output, '.staging-'));
    try {
        for (const [name, { path, expected }] of entries) {
            const target = resolve(temporary, name);
            await mkdir(dirname(target), { recursive: true });
            // APFS/reflink where supported; Node falls back to a copy. Never hardlink.
            await copyFile(path, target, constants.COPYFILE_FICLONE);
            const bytes = await readFile(target);
            if (bytes.length !== expected.size || digest(bytes) !== expected.sha256) throw new Error('Artifact changed during staging: ' + name);
        }
        await Promise.all([
            writeFile(resolve(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n'),
            writeFile(resolve(temporary, 'server-config.json'), JSON.stringify({ runtimeRoot: '.', manifest: 'manifest.json', files: {} }, null, 2) + '\n'),
        ]);
        await rename(temporary, destination);
        return { releaseId, directory: destination, reused: false };
    } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [configPath, output, replacementsPath] = process.argv.slice(2);
    if (!configPath || !output) throw new Error('Usage: node scripts/stage-experimental-runtime.mjs CONFIG OUTPUT [REPLACEMENTS_JSON]');
    const replacements = replacementsPath ? JSON.parse(await readFile(replacementsPath, 'utf8')) : {};
    const packageInfo = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(JSON.stringify(await stageExperimentalRuntime({ configPath, output, replacements, engineVersion: packageInfo.version }), null, 2));
}
