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

The Quality workflow checks out the IDE at `ejm-ide` and its shared harness at
`ejm-harness` under the runner workspace. npm commands run from `ejm-ide`.
The npm cache uses `ejm-ide/package-lock.json`, and the Rust cache uses
`ejm-ide/src-tauri/target`. Cargo uses at most four build jobs.

By default, the harness repository is `ejmlabs-harness` under the same GitHub owner
as the IDE. Checkout uses that repository's default branch. Repository variables
can select a different source or pin a revision:

| Repository variable | Value |
| --- | --- |
| `EJM_HARNESS_REPOSITORY` | `owner/repository`; defaults to the IDE owner's `ejmlabs-harness` repository |
| `EJM_HARNESS_REF` | Optional branch, tag, or commit; unset uses the harness repository's default branch |

The harness repository must be accessible to the workflow's checkout action.
A private harness repository needs a repository secret named `EJM_HARNESS_TOKEN`,
a fine-grained token with read-only Contents access to that repository. Without
the secret, checkout uses the workflow token, which can read only this repository.
Pin a compatible revision when releasing the IDE.

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
