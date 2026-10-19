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

The PR workflow calls an immutable shared governance workflow. Opening or
updating a PR starts no checks or AI review. A human maintainer first posts
`/ready FULL_HEAD_SHA` for the current commit. Comment edits and deletions also
recheck that admission. See [Contributing](../CONTRIBUTING.md) for approval,
revocation, and retry rules.

Trusted preparation reads `.github/harness-revision` from the base branch. It
must contain a full commit SHA for a compatible `ejmlabs/ejm-harness` revision.
Changing that pin in a PR does not change the harness used to check that PR.
The workflow checks out the IDE at `ejm-ide` and the pinned harness at
`ejm-harness` under the runner workspace. npm commands run from `ejm-ide`.

If the harness is private, a fine-grained token with read-only Contents access
may be stored as `EJM_HARNESS_TOKEN`. Only trusted preparation receives this
token. Build jobs run the prepared source without that credential. Keep the
harness pin current when updating the shared API or preparing a release.

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
