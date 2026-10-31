# Changelog

Changes follow [Semantic Versioning](https://semver.org/). Each repository is versioned independently.

## [Unreleased]

- Adopt the shared ejmlabs/.github revision with the Ready-for-review gate, resync the shared agent
  skills and house rules, and read the harness pin from the admitted PR head.

- Propose the accepted shared UI source pin after complete retained-source review; site migration follows protected pin acceptance.

- Remove the retained review inputs under `review/dependency-sources/` and
  `.github/review-context/` and their Biome and Vitest exclusions. The AI review
  they fed is gone. Rewrite the CI checkout notes for the current gate.

### Fixed

- Reject language-server starts from an earlier workspace session, including
  leaving and reopening the same folder. Pending initialization still runs
  until it returns, then releases the rejected client.
- Keep the current file's language status and capabilities when an earlier
  workspace's startup returns or fails after the same folder reopens.
- Sync provider profile replacement before retiring its prior Keychain key.
  Preserve both credentials when the config changed but folder sync failed,
  and direct users to reopen Model connections before retrying. Clear and
  remove retain the prior key under the same uncertain outcome.
- Use the already locked tempfile package for private config staging and
  failed-write cleanup. Credential formats, Keychain services and the pinned
  shared harness stay unchanged.

### Security

- Update the editor's dompurify override to 3.4.17 for GHSA-cg2g-xh64-v4q7,
  GHSA-mrv2-3pqr-j5jr and GHSA-c6gr-qvv4-5v3f. Monaco loads it in the app.
- Override the site tooling's transitive undici to 7.30.1 (wrangler stays at
  4.151.3, as in ejm-harness/registry) for GHSA-4qv8-2p9j-2685,
  GHSA-f72v-6w45-q472, GHSA-xjj6-f33q-929c, GHSA-4w7w-5xrc-9h26,
  GHSA-2m5v-pch6-74hx, GHSA-qrxm-fqhp-jwvm, GHSA-9fm3-97px-rjf6 and
  GHSA-55wc-3pg8-jfw6. Drop the override once the wrangler pin ships
  undici 7.30.1 or later (wrangler 4.153.0 and up).
- Update the native lock to rustls-webpki 0.103.16 and webpki-root-certs 1.0.10
  for RUSTSEC-2026-0382 and RUSTSEC-2026-0383, pulldown-cmark 0.13.5 for
  RUSTSEC-2026-0414, and ctutils 0.4.4 for RUSTSEC-2026-0385.
- No release, installer or site deploy is part of this change.

### Verification and limits

- The native pending-start and child-cleanup regression, exact-pin native checks,
  and full repository checks passed for the native guard. The later frontend
  guard passed real App controller checks with controlled local backend
  responses and separate web checks; native gates were not repeated for it.
  Manual app folder-switch acceptance remains unrun. See the
  [language guide](docs/languages.md#workspace-changes-during-server-startup).
- No release, installer, or live website update is claimed.


### Provider profile verification and limits

- On October 20, 2026, macOS on Apple Silicon passed 16 focused profile tests,
  the locked offline native check and `npm run verify` with local fixture
  loopback access. The full gate passed 611 web tests, 207 native unit tests
  and eight workspace integrity tests. One index acceptance test and six
  language-server fixtures remained ignored. Vite reported a large-chunk
  warning in the successful production build.
- Regression fixtures use real file publication and synthetic credentials.
  A controlled mutant that skipped folder sync failed the retirement check;
  it was not an exact protected-base test. Real Keychain access, AppHandle
  paths, forced power loss and new platform support remain unverified. See
  [Provider profile writes](docs/harness.md#provider-profile-writes) for
  recovery steps and retained-key limits. No release or live docs publication
  is announced.

## [0.1.0] - 2026-10-19

Prepared development source for the first `0.1.0` release. These notes do not
announce a GitHub draft, signed installer, package or website deployment.
Follow [Releases](RELEASING.md) before creating or publishing artifacts.

### Added

- Desktop editor source built with React, Monaco, Tauri and Rust, with Edi's
  agent interface and the shared `ejm-harness` engine.
- Explicit trust for each canonical workspace before automatic language servers
  and native format or lint tools run. Browsing and editing remain available
  without trust; trust does not sandbox project code.
- Provider authentication commands with matching native declarations and host
  permissions, while sandboxed panels remain unable to invoke them.
- Uniform repository guidance, explicit human admission, protected merge gates,
  two complete Codex reviews, and independent SemVer source-draft preparation.

### Fixed

- Patch DOMPurify and esbuild dependencies with compatible updates, and correct
  setup, package metadata and credential ignore guidance.
- Preserve original document and license bytes, including line endings, when
  validating source archives.
- Replace obsolete internal briefs and development diaries with current public
  guidance and portable contributor instructions.

### Verification and limits

- [PR #9](https://github.com/ejmlabs/ejm-ide/pull/9) verified the installed shared
  caller, macOS Quality, all five merge gates and two complete Codex Sol 6.1
  medium reviews. It used the separately pinned harness revision
  `09b779ee0452dda07b7f52503be22e65fe238373`; fetch that checkout beside the IDE
  when building the source archives.
- The current target is macOS on Apple Silicon. Native installer, signing and
  packaged-app acceptance remain open in the [distribution guide](docs/distribution.md).
- Linux remains unsupported while its GTK stack requires `glib 0.18.5` with
  [GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g)
  (RUSTSEC-2024-0429). Cargo Dependabot cannot resolve the sibling harness path;
  its immutable pin needs separate review. See the [dependency audit](docs/package-audit.md#public-readiness-dependency-check).
- Source availability and frontend or CI checks do not establish Windows or
  Linux support, verified installers, download availability or live deployment.
