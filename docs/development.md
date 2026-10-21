# Development checks

Use Node.js 24 LTS and stable Rust with the `clippy` and `rustfmt` components.
The native host needs the [Tauri development prerequisites](https://v2.tauri.app/start/prerequisites/)
for your operating system. CI runs on macOS, the current desktop target.
Keep `ejm-harness` and `ejm-ui` beside the `ejm-ide` checkout, at the revisions
selected by `.github/harness-revision` and `.github/ui-source.json`. Run
`npm --prefix ../ejm-ui ci --ignore-scripts` first. The native host uses
`../../ejm-harness/crates/ejm-harness` as its shared library dependency.

```sh
npm ci --ignore-scripts
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

The PR workflow calls an immutable shared governance workflow. Opening or
updating a PR starts no checks or AI review. A human maintainer first posts
`/ready FULL_HEAD_SHA` for the current commit. Comment edits and deletions also
recheck that admission. See [Contributing](../CONTRIBUTING.md) for approval,
revocation, and retry rules.

Both normal callers and the release `standards-ref` use the same immutable
shared revision, `6717b433c462e01abaed86e2118e4843827598cb`. The release
validator preserves committed license and document bytes, including their line
endings. The
[source manifest](../.github/review-context/manifest.json) identifies both exact
implementations for static review. These copies must never be executed or
imported. Biome excludes `.github/review-context` to preserve canonical bytes;
check their Git identities, hashes, modes, and total size separately.

Each AI pass must return boolean `complete: true`. Missing, false, or nonboolean
completion fails even with no findings. Human readiness, maintainer approval,
both complete medium Codex passes, and every required check remain required.
A submitted caller does not replace the trusted workflow used to check its own
PR. A caller update therefore needs fresh admission and normal hosted checks
before merge; local standards checks do not establish hosted acceptance.

Trusted preparation reads `.github/harness-revision` from the base branch. It
must contain a full commit SHA for a compatible `ejmlabs/ejm-harness` revision.
Changing that pin in a PR does not change the harness used to check that PR.
The Quality job places the admitted IDE sources at `product` and the pinned
harness at sibling `ejm-harness` under the runner workspace. npm commands run
from `product`.

The unchanged harness pin is
`09b779ee0452dda07b7f52503be22e65fe238373`. Prepare the sibling checkout
at that exact revision with Rust 1.99.1 or newer. The harness is public, so this
update needs no private cross-repository token. Cargo Dependabot cannot resolve
the sibling harness path; review its immutable pin and compatible source
separately. Keep the documented unsupported Linux GLib advisory and native
platform limits in [the dependency audit](package-audit.md#public-readiness-dependency-check).

The installed shared revision keeps this IDE protected-base selection and the
macOS Quality commands. Trusted preparation also reads `.github/ui-source.json`
from protected base `main`, validates the official public UI repository and full
commit identity, then installs its locked dependencies. A PR-selected UI pin is
validated but is not used to check that PR. Accept a pin change in its own PR
first, then admit a fresh site PR against that accepted revision.

[PR #3](https://github.com/ejmlabs/ejm-ide/pull/3) proved the installed harness
pin and previous `c4f2873ef0eef5bc3c7d75cf71fa3489a911d134` caller in
[run 39302791631](https://github.com/ejmlabs/ejm-ide/actions/runs/39302791631).
[PR #8](https://github.com/ejmlabs/ejm-ide/pull/8) then passed under that caller
in [run 39344302241](https://github.com/ejmlabs/ejm-ide/actions/runs/39344302241)
and installed `6717b433…` on main. Both runs passed all five gates and two
complete actual `gpt-6.1-sol` medium reviews without an exception. The
installed `6717b433…` caller then passed
[PR #9](https://github.com/ejmlabs/ejm-ide/pull/9) in
[run 39347126851](https://github.com/ejmlabs/ejm-ide/actions/runs/39347126851),
attempt 1, with macOS Quality, all five statuses, native approval and two
complete actual medium reviews with no findings. Its exact reviewed tree
merged normally as `1c92944ee6c5c463472a730890d15eff7bdd3940`, with
protections unchanged. The genuine outside-account fork test remains open
by owner choice. See the
[change tasks](../openspec/changes/public-repository-standards/tasks.md).

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

## Public docs maintenance

The IDE owns `website/content/*.md`, product pages, routes and release state.
Canonical subsystem references remain in `docs/`. Update affected guides,
examples, configuration, limits and recovery steps in the same change. Public
source availability does not establish platform support or installer readiness.

Use Node.js 24 and the pinned public UI checkout. The site consumes public
`@ejm/*` exports; shared components, themes, docs rendering, build rules, capture
and demo machinery belong in ejm-ui. Do not copy design files or add local
visual CSS.

```sh
npm run site:build
npm run site:check
npm run site:docs:check
npm run site:test
```

The build prerenders every route and checks the unchanged gzip limits: 110 KiB
JavaScript, 15.5 KiB CSS, 70 KiB fonts and 30 KiB HTML. The built checks cover
navigation, headings, asset and source links, release states, public tool names
and the passive recorded example. They complement the required `npm run verify`
source gate. Browser examples run locally without a worker or model connection;
they do not prove native saves, credentials or process cleanup.

Review changed routes in light and dark at measured narrow and desktop
viewports. Check keyboard navigation, copy controls, local fragments, playback
controls and release loading, error, empty and available states. Record the
actual client width and check page overflow.

A UI source pin needs acceptance on protected `main` before a site PR can test
that revision. Keep human admission, approval and both AI reviews. Site source,
local output, protected-main checks and live publication are separate states.
Follow [distribution](distribution.md) for scoped Worker deployment and live
verification; do not publish native installers as part of a site-only change.
