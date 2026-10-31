# Website and desktop downloads

The IDE's public website, "ide" by ejmlabs, lives at `ide.ejmlabs.com`. Cloudflare Workers
Static Assets hosts the website. The same Worker serves release metadata and
streams installers from a private R2 bucket. This design needs no database,
server VM, or GCP service. Native installers must be built on native runners.

The website and native IDE are separate builds. Hosting the website does not
run the Tauri IDE in a browser or make an unreleased platform downloadable.

## Current release state

No verified production installers are published by this change. The first
website deployment returns an empty release manifest and shows each platform
as unavailable. A missing manifest is an expected state, not a fabricated
version. A listed installer whose R2 object is missing or has the wrong size
returns `503` with a retry hint. Unknown platforms return `404`.

Before publishing desktop builds, resolve these source-level blockers:

- `src-tauri/tauri.conf.json` targets `app` and `dmg`, and bundles native
  macOS ARM packages. Add tested resources, icons, and bundle targets for
  macOS Intel, Windows x64, and Linux x64.
- Linux remains unsupported while its GTK stack requires glib 0.18.5 with
  RUSTSEC-2024-0429. Upgrade the upstream stack compatibly and pass native
  verification before advertising Linux support. See the
  [dependency check](package-audit.md#public-readiness-dependency-check).
- Cargo depends on sibling `ejm-harness` and `ejm-harness-auth` path crates. CI must
  check out the matching harness revision beside `ejm-ide`. The shared package
  owner must approve its release contract.
- Run the packaged IDE without the development server and verify editing,
  terminal cleanup, local language tooling, extensions, provider login, and a
  model request on each advertised platform. Frontend tests do not establish
  native platform support.
- Produce release builds. Sign and notarize macOS distribution; configure
  Windows signing. Verify Linux installer dependencies and launch behavior.
  Keep signing credentials in the native CI secret store.

The [source repository](https://github.com/ejmlabs/ejm-ide) is public.
Source availability does not establish native installer readiness.

Do not substitute a debug app bundle, a browser demo, or another platform's
installer for a missing release. Platform readiness is reflected by artifacts
in the manifest, not by a marketing promise.

## Source release drafts

The manual GitHub source workflow follows [Releases](../RELEASING.md) and the
[development guide](development.md#draft-source-releases). It validates the
selected checked main commit, SemVer metadata, dated notes, and original
license/document bytes. It reserves a new version tag and creates an
unpublished draft containing source archives, checksums, and provenance.
Existing tags or releases are refused. Its source archives need the separately
pinned harness checkout to build the IDE.

Adopting the repaired shared caller creates no IDE tag or release. A source
draft does not update the R2 manifest, build or sign desktop installers, deploy
the website, or establish any platform's support. Review those artifacts and
their native evidence under the installer gates below before publication.

## Files and official platform tools

| Responsibility | Owner |
| --- | --- |
| Website UI and build | `website/` |
| Shared private/public release contracts | `distribution/manifest.ts` |
| HTTP and R2 adapter | `distribution/worker.ts` |
| Worker, custom domain, and binding configuration | `distribution/wrangler.jsonc` |
| Verified installer publication | `distribution/publish.ts` |
| Generated Workers runtime declarations | `distribution/worker-configuration.d.ts` |

The Worker uses Cloudflare's native `Request`, `Response`, R2 conditional/range
API, readable streams, and static asset binding. Wrangler generates official
runtime types. The publisher uses Node's streaming SHA-256 implementation and
Wrangler's official R2 commands. It does not implement an upload protocol,
router framework, range parser, installer builder, or signing flow.

References:

- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Wrangler types](https://developers.cloudflare.com/workers/languages/typescript/#generate-types)
- [Tauri distribution](https://v2.tauri.app/distribute/)
- [Official Tauri GitHub Action](https://github.com/tauri-apps/tauri-action)

## Cloudflare setup

Create the bucket once, from the project root with the Wrangler that
`package.json` pins and the account that `distribution/wrangler.jsonc` names,
which owns the `ejmlabs.com` Cloudflare zone:

```sh
npx wrangler login
npx wrangler r2 bucket create ejmlabs-ide-releases
```

Keep R2 public access disabled. The Worker accesses it through `RELEASES`;
browsers use the controlled download routes. The custom domain route in the
config handles `ide.ejmlabs.com`. Review any existing DNS record or Worker route
before changing that hostname. [Website deploys](#website-deploys) publish the
Worker.

`workers.dev` and preview URLs are disabled. Worker request logging is disabled;
this public distribution service does not collect IDE sessions or request
content. It has no application credentials or client login endpoint.

For local review:

```sh
npm run site:build
npx wrangler dev --local --config distribution/wrangler.jsonc
```

The local R2 store is separate from remote releases. Use only disposable
fixtures there. Never upload fixtures to the remote release bucket.

## Website deploys

A merge to main deploys the website. `.github/workflows/deploy.yml` is the
canonical caller of the shared `ejmlabs/.github` workflow `deploy-site.yml`, pinned
to the same revision as `pr.yml` and `release.yml`. Each push to main runs three
jobs in order:

1. A build job, with `contents: read` and no secrets, builds the website from
   that main commit with `npm ci --ignore-scripts` and `npm run site:build`.
2. A staging job runs `wrangler deploy --env staging`. It publishes the Worker
   `ejmlabs-ide-staging` at `ide-staging.ejmlabs.com`, which binds the same
   R2 bucket `ejmlabs-ide-releases`. The Worker only reads that bucket.
3. A production job deploys the same built files to the Worker `ejmlabs-ide` at
   `ide.ejmlabs.com` with the top-level config, once staging succeeds. It needs
   no approval. The human decision is the merge: `gate:approve` and the required
   checks.

The deploy jobs trust nothing in the build artifact. They take the whole
`distribution` directory, which holds the Worker and its config, from the
reviewed commit and stop if the build's copy differs. The account must match,
the assets must come from `website/dist`, and staging needs its own Worker name
and routes. Wrangler runs from the lockfile in the shared repository's `deploy`
directory at the revision `deploy.yml` pins (4.153.0 at the current pin), not from
this repository's `wrangler` dependency. It receives the `CLOUDFLARE_API_TOKEN`
environment secret and no GitHub token.

### Before the first deploy

The owner sets these up. The shared deploy fails closed without them, before it
reaches Cloudflare:

- The `staging` and `production` GitHub environments exist, and each has a custom
  deployment branch policy with exactly one branch, `main`. Run
  `python3 scripts/set_deploy_token.py` in `ejmlabs/.github` to create them and
  store the token below, for every site repository at once.
- Each environment holds the `CLOUDFLARE_API_TOKEN` secret. The token needs
  Worker and custom-domain rights on the account that owns `ejmlabs.com`. No
  agent creates, reads or stores it.
- No DNS record for `ide-staging.ejmlabs.com` exists outside Wrangler. If one
  does, Wrangler prompts in CI and nobody can answer, so remove the record first.

Keep `secrets: inherit` in `deploy.yml`; without it the token is empty. Change
`distribution/wrangler.jsonc` in source, never in a build step.

### Checks, manual deploys and rollback

Local dry runs are fine:

```sh
npm run site:build
npx wrangler deploy --dry-run --config distribution/wrangler.jsonc
npx wrangler deploy --dry-run --config distribution/wrangler.jsonc --env staging
```

A manual `wrangler deploy` is not the procedure. `npm run site:deploy` remains
only as a fallback when CI cannot deploy and the owner asks for it. Installer and
manifest publishing with `distribution/publish.ts` is separate from website
deploys. See [Publish verified installers](#publish-verified-installers).

Each merge replaces both sites, so run the live checks in the
[website skill](../.agents/skills/ejm-ide-website/SKILL.md) on staging and then on
production, and keep the commit SHA and the Worker version ID from the job log.
To roll back the website, redeploy an earlier Worker version in Cloudflare, or
revert the change on main so the next run deploys the reverted site. A rollback
never restores R2 data; for the release manifest see [Rollback](#rollback).

## Release manifest

The private object is `releases/latest.json`. The canonical unreleased value is:

```json
{
  "schemaVersion": 1,
  "version": null,
  "publishedAt": null,
  "artifacts": []
}
```

For a release, `version` is a safe numeric three-part version with an optional
prerelease suffix. `publishedAt` is an ISO UTC timestamp. Include only verified
installers. Each artifact has these fields:

| Field | Meaning |
| --- | --- |
| `target` | `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64`, or `linux-x86_64` |
| `filename` | Safe installer basename, without directory separators or debug markers |
| `bytes` | Positive byte count of the actual installer |
| `sha256` | Lowercase 64-character SHA-256 digest of those bytes |
| `key` | `releases/{version}/{sha256}/{filename}` |

The parser accepts macOS `.dmg`, Windows `.exe` or `.msi`, and Linux `.AppImage`,
`.deb`, or `.rpm` installers. There is one preferred installer per target.
Targets can be added to this shared contract when their native builds are ready.
The optional `sourceUrl` must be a real HTTPS source location without credentials.

`GET /api/releases` returns the same release metadata, replacing each private
`key` with `url: "/downloads/{target}?sha256={sha256}"`. Both parsers validate canonical state,
platforms, filenames, sizes, hashes, duplicates, and safe paths. Public URLs can
only name their known same-origin download route with the exact artifact digest.

`GET /downloads/{target}?sha256={sha256}` reads the current manifest, requires
the exact artifact digest in the URL, and verifies the real object's byte size
before streaming it. A missing, stale, or mismatched digest returns a
non-cacheable `409` and asks the person to refresh the page. An unreleased
platform still returns `404`. Cached metadata can therefore never select bytes
from a different release; the query is part of the CDN cache key. R2 parses range and conditional headers.
`HEAD` returns metadata and cancels the unopened stream. The Worker returns
`206` for native partial ranges, `304` for matching read validators, and `412`
for failed preconditions. Native invalid-range errors return `416`; ranges that
R2 ignores return the full object with `200`. `If-Range` safely falls back to
full `200` because it is not an R2 condition. No binary body is buffered by the
Worker.

Metadata is cached for 30 seconds and digest-bound download URLs for 60
seconds. Error responses are never cached. These short lifetimes allow a new
release or rollback to become visible without cache purges.

## Publish verified installers

Build and verify installers first. Put their files and a complete manifest in a
release staging directory outside the source tree. Use the hashes and sizes of
the signed final installers, after signing or notarization changes their bytes.

Validate locally with Node 24 or newer:

```sh
node distribution/publish.ts /absolute/path/release.json /absolute/path/installers
```

The default is a dry run. It validates the manifest and streams every local
file into a private temporary snapshot, then hashes those snapshot bytes
before any cloud request. Uploads only read the validated snapshots, so a
concurrent native rebuild cannot replace bytes under a live digest key. It rejects files outside the
staging directory, missing installers, byte count or digest mismatches, empty
releases, and unsafe metadata.

Then publish the validated release:

```sh
node distribution/publish.ts /absolute/path/release.json /absolute/path/installers --publish
```

The publisher performs these steps in order:

1. Copy all local installers to private temporary snapshots, then validate all
   snapshot byte counts and digests before any upload.
2. Upload each validated snapshot with official Wrangler commands under its content
   digest, so another binary cannot replace it at the same key.
3. Download each uploaded object to a temporary file and verify its digest and
   byte count. Remove that temporary copy after verification.
4. Upload the manifest archive at
   `releases/{version}/manifest-{manifest-sha256}.json`.
5. Upload `releases/latest.json` last, after every installer passes verification.

Private snapshots and readback files are removed in `finally`, including dry
runs and failures. A failure before step 5 leaves the previous public release
pointer intact.
Unreferenced objects may remain in R2 and can be reviewed later. Never overwrite
a content-addressed object with different bytes. Wrangler's single-object CLI
upload limit applies; use an official S3 multipart client if installers exceed
that limit. Do not split an installer into browser-assembled parts.

## Rollback

Retrieve a previously verified archived manifest, validate it with
`parseReleaseManifest`, and check its referenced installers still exist. Upload
that exact archived JSON as `releases/latest.json` with the official Wrangler
CLI. Keep previous content-addressed installers and manifest archives until the
retention policy allows removal. The site picks up the rollback within the metadata cache lifetime. Old
digest-bound links may return `409` after the change; refreshing the page
provides the current verified links.

## Native release CI

Use the official `tauri-apps/tauri-action` on native macOS ARM, macOS Intel,
Windows x64, and Linux x64 runners. Pin the action and dependency revisions
through the project's normal dependency review. Build the matching sibling
harness checkout beside the IDE. Apply Tauri's documented platform prerequisites
and signing configuration. Run platform smoke checks on the packaged app before
its artifact enters the release manifest.

Cloudflare hosts the web assets and downloads; it does not replace macOS or
Windows signing/build runners. GitHub's native runners can build release
artifacts. If release builds later need GCP, add that as a separate CI decision.
No GCP service is required for the current hosting plan.

## Verification for this change

Focused tests cover manifest safety, public URL validation, private-key omission,
missing objects, reserved-route isolation, HEAD, native range/condition mapping,
and local artifact hash/path checks. Wrangler's local runtime also verified the
unreleased state, real streaming against a disposable local R2 fixture,
conditional `304`/`412`, byte ranges, and HEAD. These checks used no remote
artifact uploads. Worker dry run compiles the site assets and R2 binding.

Native installer builds, signatures, platform smoke tests, and public binary
downloads remain release gates. An empty production manifest is intentional
until those gates pass.
