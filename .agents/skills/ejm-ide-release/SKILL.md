---
name: ejm-ide-release
description: Build, sign, verify, and publish ejm-ide installers, or change release metadata and the download Worker. Use for anything that makes a download appear on the site.
---

# Releases and downloads

Read [docs/distribution.md](../../../docs/distribution.md) first. It is the
source of truth for the Worker, the R2 bucket, the manifest, and the blockers.

## Facts

- Worker `ejmlabs-ide` serves the site and the download routes at `ide.ejmlabs.com`.
  Config is `distribution/wrangler.jsonc`. Private R2 bucket: `ejmlabs-ide-releases`.
- The public manifest is `releases/latest.json`. The empty value means no release.
  `GET /api/releases` returns it, and `GET /downloads/{target}?sha256=...` streams a
  verified installer. An unreleased platform returns 404.
- Targets: `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64`, `linux-x86_64`.
- `distribution/publish.ts` validates, snapshots, hashes, uploads, reads back, and
  only then updates `latest.json`. It dry-runs by default; `--publish` uploads.

## Rules

1. Publish only verified, signed, release-mode installers built on native
   runners. Never publish a debug bundle, a browser demo, or another platform's
   installer.
2. Hash the final signed files. Notarization or signing changes the bytes.
3. Do not edit `latest.json` by hand. Use the publisher, and for rollback use the
   documented archived-manifest procedure.
4. Never overwrite a content-addressed object with different bytes.
5. Publishing is outward-facing. Get the user's explicit approval for the exact
   version and files first.
6. Do not widen provider login or harness ownership to ship a release.
7. Keep signing credentials in the CI secret store. Never in the repo, logs, or docs.

## Before the first release

The blockers in `docs/distribution.md` still apply: bundle targets (today
`app` and `dmg`) for every platform, tested icons, packaged-app checks for
editing, terminal cleanup, language tools, extensions, provider login and a
model request, signing and notarization, a pinned harness revision, and a real
source URL before any source link appears. Until each is done, the site keeps
showing "In development".

## Verify

Run `npm test` (Worker, manifest, and publisher tests), `npm run site:check`,
and a dry run of the publisher with a disposable manifest. Use local R2
(`wrangler dev --local`) for fixtures. Never upload fixtures to the remote bucket.
