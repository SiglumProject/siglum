import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { verifyRuntime } from './verify-runtime.mjs';

class PublicationPendingError extends Error {}

// This prepares verified objects. The serialized release workflow writes them.
export async function prepareRuntimePromotion({ manifestPath, outputDirectory,
  serviceBase = 'https://packages.siglum.org', packageVersion, fetchResource = globalThis.fetch }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(packageVersion)) throw new Error('Invalid SDK version');
  const service = new URL(serviceBase);
  if (service.protocol !== 'https:' || service.pathname !== '/' || service.search || service.hash || service.username || service.password) {
    throw new Error('Runtime service must be an HTTPS origin');
  }
  const expectedBytes = await readFile(manifestPath);
  const expected = JSON.parse(expectedBytes.toString());
  if (expected.engineVersion !== packageVersion) throw new Error('Runtime does not match the SDK version');
  if (!/^tl\d{4}-[a-f0-9]{16}$/.test(expected.releaseId)) throw new Error('Invalid runtime release ID');
  const baseUrl = `${service.origin}/releases/${expected.releaseId}`;
  const { manifest, manifestBytes } = await verifyRuntime(baseUrl, fetchResource);
  if (!manifestBytes.equals(expectedBytes)) throw new Error('Hosted manifest differs from the release artifact');
  for (const name of ['wasm/busytex.js', 'wasm/busytex.wasm', 'bundles.json', 'file-manifest.json', 'xzwasm.js']) {
    if (!manifest.files[name]) throw new Error(`Runtime is missing ${name}`);
  }

  const descriptor = {
    schemaVersion: 1,
    engineVersion: packageVersion,
    releaseId: manifest.releaseId,
    baseUrl,
    manifestUrl: `${baseUrl}/runtime.json`,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
  };
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(resolve(outputDirectory, 'runtime.json'), JSON.stringify(descriptor, null, 2) + '\n');
  return descriptor;
}

export async function verifyPublishedEngine(packageVersion, fetchResource = globalThis.fetch) {
  // One registry document keeps the version and dist-tag checks consistent.
  const registryUrl = 'https://registry.npmjs.org/@siglum%2fengine';
  const publishedResponse = await fetchResource(registryUrl, { cache: 'no-store' });
  if (publishedResponse.status === 404) throw new PublicationPendingError('SDK publication is not available yet');
  if (!publishedResponse.ok) throw new Error(`SDK publication is not available: HTTP ${publishedResponse.status}`);
  const metadata = await publishedResponse.json();
  if (metadata.name !== '@siglum/engine') throw new Error('Published SDK metadata is invalid');
  const published = metadata.versions?.[packageVersion];
  if (!published) throw new PublicationPendingError('SDK publication is not available yet');
  if (published.version !== packageVersion || !published.dist?.integrity || typeof metadata['dist-tags']?.latest !== 'string') throw new Error('Published SDK metadata is invalid');
  return metadata['dist-tags'].latest === packageVersion;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const packageInfo = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  if (process.argv[2] === '--published') {
    const outputDirectory = process.argv[3];
    if (!outputDirectory) throw new Error('Supply the prepared promotion directory');
    const descriptor = JSON.parse(await readFile(resolve(outputDirectory, 'runtime.json'), 'utf8'));
    if (descriptor.engineVersion !== packageInfo.version) throw new Error('Prepared runtime does not match this SDK');
    let promoteLatest;
    for (let attempt = 0; attempt < 24; attempt++) {
      try {
        promoteLatest = await verifyPublishedEngine(packageInfo.version);
        break;
      } catch (error) {
        if (!(error instanceof PublicationPendingError) || attempt === 23) throw error;
        await setTimeout(5000);
      }
    }
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `promote_latest=${promoteLatest}\n`);
    console.log(`SDK publication verified; promote global latest: ${promoteLatest}`);
  } else {
    const [manifestPath, outputDirectory] = process.argv.slice(2);
    if (!manifestPath || !outputDirectory) throw new Error('Usage: node scripts/prepare-runtime-promotion.mjs <runtime.json> <output directory>');
    const descriptor = await prepareRuntimePromotion({ manifestPath, outputDirectory, packageVersion: packageInfo.version });
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `engine_version=${descriptor.engineVersion}\n`);
    console.log(`Verified ${descriptor.releaseId} for SDK ${descriptor.engineVersion}`);
  }
}
