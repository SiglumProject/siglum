# Releasing npm packages and runtime assets

The June 2026 release adds a compatible engine patch. The filesystem and Git
dependencies keep their existing versions.

| Package | Version | Publish order |
| --- | --- | --- |
| `@siglum/filesystem` | 0.3.0 | First |
| `@siglum/git` | 0.1.0 | After filesystem |
| `@siglum/engine` | 0.2.1 | After filesystem |
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

Publish npm packages when the library code changes. For the June update, follow
the [release order below](#june-2026-release). For a new npm version, log in with
an account that can publish under `@siglum` and publish each changed package
in dependency order.

```sh
npm whoami
npm publish /path/to/reviewed-package.tgz --access public
```

Publishing a tarball does not run the source checkout's build/test hooks; those
checks must already have passed. Complete npm's browser/2FA prompt if requested.
Verify registry versions and tarball integrity against the reviewed artifacts.
Never commit npm credentials. The optional engine tag workflow requires an
`NPM_TOKEN` secret when publishing an unpublished version; a version already
published by the maintainer is skipped.

## Runtime and application deployment

The npm tarball excludes TeX binaries, format files, and bundles. A LaTeX
format update reaches the browser through a new immutable runtime and an app
build that references its ID. Generate and package the formats with the same
WASM that will load them using the [build steps](building.md). Run
`stage:runtime` and `verify:runtime`, then distribute that complete directory.

The release script uploads assets to R2, archives the runtime, and creates
a GitHub release. Use an unused tag that matches the engine package version.

```sh
version=$(node -p "require('./package.json').version")
DRY_RUN=1 bash scripts/release.sh "$version"
# After reviewing the staged manifest and upload destination:
bash scripts/release.sh "$version"
```

If the exact runtime is already uploaded and verified, `SKIP_R2=1` avoids
uploading it again. Do not skip verification or mix files from different runtime
IDs. The archive is `siglum-runtime-v<version>.tar.gz`.

### Runtime-only updates

Use `--runtime-only` to upload an immutable runtime as a separate operation.
This also supports a format-only refresh using an existing npm engine version.
The combined BusyTeX WASM, glue, and three bundled formats must match the hashes in
`busytex/build/texlive-basic-formats.sha256`. For downloaded CI artifacts, keep
`SIGLUM_RUNTIME_INPUTS` set to the prepared artifact directory as shown in
[Building Siglum Engine](building.md#restore-ci-build-outputs).

```sh
DRY_RUN=1 bash scripts/release.sh --runtime-only
# After reviewing the staged manifest and upload destination:
bash scripts/release.sh --runtime-only
```

This path verifies and uploads the combined runtime under a fresh R2 release
prefix and leaves the npm package and release tag untouched.

### June 2026 release

1. Prepare the June build from the reviewed `0.2.1` engine commit and its pinned
   BusyTeX fork. Stage it and run the local browser release checks.
2. Upload with `bash scripts/release.sh --runtime-only`. Verify the uploaded
   runtime against its immutable ID.

   ```sh
   release_id=$(node -p "require('./.local-release/current.json').releaseId")
   node scripts/verify-runtime.mjs "https://packages.siglum.org/releases/$release_id"
   ```

3. Publish the reviewed `@siglum/engine@0.2.1` tarball or let the tag workflow
   publish it. Create the GitHub tag and attach the exact verified runtime with
   the commands below. Keep `.local-release/current.json` pointing to the runtime
   verified in step 2.

   ```sh
   # Optional when publishing manually in place of npm CI:
   npm publish /path/to/siglum-engine-0.2.1.tgz --access public

   SKIP_R2=1 DRY_RUN=1 bash scripts/release.sh 0.2.1
   SKIP_R2=1 bash scripts/release.sh 0.2.1
   ```

4. Build Pages from the reviewed engine source using the verified release ID.
   Follow the [web application checks](#web-application) before deployment.

### Web application

The production adapter and web UI live in `siglum-web`. Its `prepare:release`
command builds `.local-release/site` against the staged runtime ID and deployed
package service. Verify the runtime at
`https://packages.siglum.org/releases/<releaseId>` before building the app with
that value as `VITE_ENGINE_RELEASE`. Use `preview:release` and `test:release`
before deploying the production artifact to Cloudflare Pages. The existing
Worker routes cover the new `tl2026-…` prefix.

A GitHub merge, npm publication, and runtime archive creation do not deploy
Pages or the Worker. Those remain explicit, separate release operations.
