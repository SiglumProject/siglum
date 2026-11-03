# Releasing npm packages and runtime assets

The 0.2.0 web/engine release uses:

| Package | Version | Publish order |
| --- | --- | --- |
| `@siglum/filesystem` | 0.3.0 | First |
| `@siglum/git` | 0.1.0 | After filesystem |
| `@siglum/engine` | 0.2.0 | After filesystem |
| Web app and Cloudflare worker | 0.2.0 | Private workspace packages; do not publish to npm |

The engine and Git package require `@siglum/filesystem@^0.3.0`. Keep one
filesystem instance in browser bundles. Versions are immutable once published;
never reuse a version for changed package content.

## Validate and pack

Build the filesystem first (`bun run prepublishOnly`), then Git
(`bun run prepublishOnly`), then engine declarations (`bun run test:types`).
Run the engine unit/browser/proxy checks and the web production-preview tests.

The engine and Git manifests have sibling-directory overrides for local Bun
development. npm rejects those overrides when packing directly from the
checkout. Prepare a clean staging directory for each package containing its
`package.json`, README, LICENSE, and every directory listed in `files`. Remove
only `overrides` from the staged manifest, retaining the semver dependencies.
Build before copying: staging must contain generated `dist/` or `types/`.

```sh
npm pack /path/to/staged-package --pack-destination /path/to/release-tarballs
```

Inspect each tarball's file list and install all three tarballs into an isolated
consumer project. Check TypeScript imports, production bundling, and browser
loading with no sibling links or local overrides. Follow the README's Vite
configuration for the optional hashing dependency.

## Publish

Log in with an npm account that can publish under `@siglum`:

```sh
npm whoami
npm publish /path/to/siglum-filesystem-0.3.0.tgz --access public
npm publish /path/to/siglum-git-0.1.0.tgz --access public
npm publish /path/to/siglum-engine-0.2.0.tgz --access public
```

Publishing a tarball does not run the source checkout's build/test hooks; those
checks must already have passed. Complete npm's browser/2FA prompt if requested.
Verify registry versions and tarball integrity against the reviewed artifacts.
Never commit npm credentials. The optional engine tag workflow requires an
`NPM_TOKEN` secret when publishing an unpublished version; a version already
published by the maintainer is skipped.

## Runtime and application deployment

The npm tarball excludes TeX binaries and bundles. Run `stage:runtime` and
`verify:runtime`, then distribute that complete immutable directory. The release
script uploads assets to R2, archives the runtime, and creates a GitHub release:

```sh
DRY_RUN=1 scripts/release.sh v0.2.0
# After reviewing the staged manifest and upload destination:
scripts/release.sh v0.2.0
```

If the exact runtime is already uploaded and verified, `SKIP_R2=1` avoids
uploading it again. Do not skip verification or mix files from different runtime
IDs. The archive is `siglum-runtime-v0.2.0.tar.gz`.

The production adapter and web UI live in `siglum-web`. Its `prepare:release`
command builds `.local-release/site` against the staged runtime ID and deployed
package service. Use `preview:release` and `test:release` before deploying that
artifact to Cloudflare Pages. Do not deploy a local-preview build.

A GitHub merge, npm publication, and runtime archive creation do not deploy
Pages or the Worker. Those remain explicit, separate release operations.
