# Verification

Date: October 20, 2026. Base:
`0309cb7aceae91034d710ee3dbe992edd9a9df31`.

## Executed generation regression

The scratch runner contains the exact production `LanguageState` definition and
implementation, cancellation definitions and implementation, request limit, and
new `pending_language_start_cannot_publish_after_workspace_clear` test. Static
comparison confirmed that all four fragments in this branch match the executed
runner. Empty `Language` and `Session` marker types replace runtime types.

This is a guard-only result. It exercises generation invalidation and current
generation access, without constructing an LSP client or exercising startup,
IPC, or child-process cleanup. No Cargo build or new dependency was used.

Runner and retained evidence:
`/private/tmp/ejm-handoff-fixes-20261020/ide-generation-regression/`.
Its `metadata.json`, `build.json`, `test.json`, and `test.stdout` record source
hashes, exact commands, result, and resource use. Runner SHA-256:
`7d764fc707e4177a983e0c42b526fc6615ed1c1ddbd5717099b57da09ee8f3a6`.

Executed compile command with Rust 1.99.1:

```sh
rustc --test --edition 2024 -C debuginfo=0 \
  -L dependency=/Users/everettmorgan/Desktop/ejm-ide/src-tauri/target/debug/deps \
  --extern uuid=/Users/everettmorgan/Desktop/ejm-ide/src-tauri/target/debug/deps/libuuid-90eed1269713b8e3.rlib \
  /private/tmp/ejm-handoff-fixes-20261020/ide-generation-regression/generation_regression.rs \
  -o /private/tmp/ejm-handoff-fixes-20261020/ide-generation-regression/generation_regression
```

Executed test command:

```sh
/private/tmp/ejm-handoff-fixes-20261020/ide-generation-regression/generation_regression \
  --exact tests::pending_language_start_cannot_publish_after_workspace_clear --nocapture
```

Both commands exited 0. Exact test result:

```text
running 1 test
test tests::pending_language_start_cannot_publish_after_workspace_clear ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

Compile process wall time was 0.5093 seconds with peak RSS 148,652,032 bytes.
Test process wall time was 0.2121 seconds with peak RSS 2,179,072 bytes. The
binary was 1,204,760 bytes. Measurements use `os.wait4` resource usage on macOS;
`time -l` could not report RSS because the sandbox blocked `kern.clockrate`.
These figures describe the scratch processes, not IDE runtime performance.

## Primary draft native check

The following command passed with exit 0 in the primary dirty checkout at
`/Users/everettmorgan/Desktop/ejm-ide`:

```sh
CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0 cargo check --manifest-path src-tauri/Cargo.toml --tests --locked --offline
```

Final output:

```text
Finished `dev` profile [unoptimized + debuginfo] target(s) in 35.34s
```

It checked the IDE and active sibling `ejm-harness`, `ejm-harness-auth`, and
`ejm-harness-exec` source. The retained summary and final
output excerpt are in
`/private/tmp/ejm-handoff-fixes-20261020/ide-lifecycle-check-evidence.md`.
That file is not a complete raw build log.

This result proves primary draft type checking, including tests. It does not
prove clean immutable-pin compatibility or execution of the native test binary.
Primary draft site checks used newer site sources and do not apply here.

## Focused branch checks

The following focused branch checks passed with exit 0:

```sh
rustfmt --edition 2024 --check src-tauri/src/language.rs
git diff --check
openspec validate invalidate-pending-language-starts --strict
```

OpenSpec reported `Change 'invalidate-pending-language-starts' is valid`.
These checks do not compile native code or establish the full repository gates.

## Public docs review

This source pin has `docs/languages.md` and a static website language overview,
but no `website/content/` user or developer guides and no docs routes. The
overview makes no claim about pending startup lifetime, so its content needs no
change for this fix. The canonical guide and unreleased changelog carry the new
behavior, recovery, and verification limits. No site build, deployment, live
publication, or installer update is claimed.

## Required checks still unrun

- Clean-pin `cargo check --tests --locked` against the immutable harness revision
  `09b779ee0452dda07b7f52503be22e65fe238373`.
- Clean-pin `npm run verify`, including native tests, Clippy, and the app build.
- Native language-server acceptance for switching away and returning during
  startup, including rejected child-client cleanup.

No full build or test ran in this isolated branch. Keep tracked verification
tasks open. Sync and archive only after all required checks and review gates
pass.
