# Changelog

Changes follow [Semantic Versioning](https://semver.org/). Each repository is versioned independently.

## [Unreleased]

- Keep retained dependency source outside Vitest discovery while preserving
  default exclusions and all IDE application, website and distribution tests.

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
