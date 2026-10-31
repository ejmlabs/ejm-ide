# Development checks

Use Node.js 24 LTS and stable Rust with the `clippy` and `rustfmt` components.
The native host needs the [Tauri development prerequisites](https://v2.tauri.app/start/prerequisites/)
for your operating system. CI runs on macOS, the current desktop target.
Keep `ejm-harness` beside the `ejm-ide` checkout. The native host uses
`../../ejm-harness/crates/ejm-harness` as its shared library dependency.

```sh
npm ci
rustup component add clippy rustfmt
CARGO_BUILD_JOBS=4 npm run verify
```

## Package choices

Use trusted, maintained packages for standard problems. Check platform APIs,
the standard library, and installed dependencies before adding a package.
Check maintenance, license, security, platform support, resource cost, and behavior.
Keep custom code for ejm-ide's distinct behavior and necessary thin adapters.
Document a custom infrastructure exception with the capability gap and alternatives.

The root [AGENTS.md](../AGENTS.md) enforces this rule. Project skills provide
[engineering guidance](../.agents/skills/ejm-ide-engineering/SKILL.md) and
[interface guidance](../.agents/skills/ejm-ide-ui/SKILL.md). The
[codebase audit](package-audit.md) tracks existing package use, exceptions, and
replacement candidates. Review it before extending a listed custom subsystem.

The shared harness and auth packages own provider transport and login machinery.
Coordinate shared changes with the "ejmlabs cli" session. Retain an IDE adapter
only for behavior the shared API cannot yet preserve, and record that gap.

## CI checkout layout

`.github/workflows/pr.yml` calls an immutable shared governance workflow, and
`release.yml` and its `standards-ref` use the same pinned revision. A pull request
run takes its workflow from the PR merge ref, so a PR that moves the pin is checked
by the new pin. Review the pin line by hand. A local standards check does not
establish hosted acceptance.

Admission is bound to the PR head commit and never reads comment text, so `/ready`
and `/approve` comments do nothing. A draft PR is never admitted. A maintainer's own
same-repository PR admits itself on open, reopen, push and Ready for review. Any
other PR is admitted when a current human maintainer marks it Ready for review or
adds `gate:approve`. Fork PRs are never admitted. A new commit needs a new
admission. Re-running failed jobs keeps the admission; fix code in a new commit.
See [Contributing](../CONTRIBUTING.md) for approval and revocation rules.

Trusted preparation exports the admitted head as committed bytes into `product` and
checks out two pinned sources beside it:

- `.github/harness-revision` is read from the admitted head. It must hold one full
  lowercase commit SHA that is the head of protected `ejmlabs/ejm-harness` main or
  an ancestor of it. The harness is placed at sibling `ejm-harness`. A pin change
  and its lockfile travel in one PR, and that PR is checked against the harness it
  pins.
- `.github/ui-source.json` is read from trusted base, never from the PR head. The
  owner source is placed at sibling `ejm-ui` and installed with
  `npm ci --ignore-scripts`. Changing this pin in a PR does not change that PR's
  checkout.

The Quality job is credential-free, has no token permissions, and runs on macOS
with Node 24 and Rust 1.99.1 with Clippy and rustfmt. The repository has no
`.github/quality` script, so the built-in commands run from `product`:
`npm ci --ignore-scripts`, `npm run verify`, `npm run site:check` and
`npm run site:build`. Prepare a local sibling harness checkout at the exact
revision in `.github/harness-revision`. The harness is public, so preparation needs
no private cross-repository token. Cargo Dependabot cannot resolve the sibling
harness path; review its immutable pin and compatible source separately. Keep the
documented unsupported Linux GLib advisory and native platform limits in
[the dependency audit](package-audit.md#public-readiness-dependency-check).

## Draft source releases

Follow [Releases](../RELEASING.md) for independent SemVer, matching package
versions, dated changelog notes, checked main commits, and explicit draft
review. The manual workflow creates source archives, `SHA256SUMS`, and
`provenance.json`; it does not build or sign an installer. Committed notices
retain their original bytes. Fetch the exact harness pin separately when
building from a source archive.

The dated `0.1.0` [source notes](../CHANGELOG.md) are prepared for review.
No IDE draft is announced. After their normal protected merge, freeze the
resulting main commit before requesting a source-only draft. Check both source
archives, original notice bytes, checksums and provenance before publication.

An existing `vVERSION` tag or release blocks another request. Do not use a rerun
or move a tag after a failure. Inspect the retained run, tag, draft, and assets
before choosing the next version. Installing the workflow and testing its PR
caller create no IDE tag or release. Native signing, platform checks, installer
publication, and site deployment keep their separate gates in
[distribution](distribution.md).

## Commands

| Command | Check |
| --- | --- |
| `npm run format` | Format TypeScript, TSX, CSS, JSON, and Rust |
| `npm run format:check` | Check formatting without changing files |
| `npm run lint` | Check Biome rules and import order without changing files |
| `npm run lint:fix` | Apply safe Biome fixes and organize imports |
| `npm run lint:rust` | Run Clippy on every native host target; warnings fail |
| `npm run check` | Check TypeScript with strict mode |
| `npm test` | Run frontend tests |
| `npm run test:rust` | Run native host tests |
| `npm run verify` | Run all checks, tests, and the production frontend build |

Run `npm run format` and `npm run lint:fix` before `npm run verify`.
Biome uses its recommended rules, including correctness, security, accessibility,
and suspicious code checks. Warnings fail the lint command. Its parser supports
the Tailwind CSS 4 directives used by the application. Build output, dependencies,
generated Tauri files, and local workspace state are excluded from Biome checks.

Rust denies unsafe code and operations in unsafe functions. The few native calls
that need unsafe code must have a local exception with a reason and a `SAFETY`
comment. Clippy also rejects undocumented unsafe blocks, debug macros, and
unfinished `todo!()` calls. Do not weaken these rules to pass a check. Fix the
code, or document a narrow exception when a rule does not apply.

The language server integration test is ignored by default because it needs
external language servers. Run it when changing that integration:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --test language_servers -- --ignored
```

The ignored index acceptance test needs a disposable copy of Harbor outside the
repository. It checks real SQLite search, call evidence, and stale file hashes,
then writes a JSON report with observed timings. Set these variables before
running it:

`WORKBENCH_INDEX_ACCEPTANCE_ROOT` is the copied workspace directory.
`WORKBENCH_INDEX_ACCEPTANCE_REPORT` is the destination JSON path.

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib index_sample_workspace_acceptance -- --ignored --nocapture
```

Editor settings come from `.editorconfig`, `biome.json`, and `rustfmt.toml`.
Use the Biome editor extension for TypeScript, TSX, CSS, and JSON, and rust-analyzer
with rustfmt for Rust. CI uses the same `npm run verify` command as local checks.

## Shared harness changes

Keep the agent loop, canonical messages/events, resource governor, and execution
policies in ejm-harness. IDE tools, provider profiles, review, and rich chat
records belong in the IDE adapters. A change to the shared crate also needs its
own workspace formatting, strict Clippy, and focused tests from the
`ejm-harness` checkout. Native dependency compilation does not run those tests.
Use replay responses or local HTTP fixtures. Hosted model calls are separate
from automated verification.

## Shared UI source

The exact UI revision is recorded in `.github/ui-source.json`. Shared CI reads
this pin from trusted base and installs the owner workspace with lifecycle
scripts disabled. Site migration is a separate change after the pin is accepted.
