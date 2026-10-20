# Verification

Date: October 20, 2026. Base:
`0309cb7aceae91034d710ee3dbe992edd9a9df31`.

## Historical generation regression

At commit `c46e25d48205db39e8dd47c42ed62b83e8413c21`, static comparison
confirmed that the scratch runner's `LanguageState`, cancellation definitions,
request limit, and pending-start test matched that commit. Empty `Language` and
`Session` marker types replaced runtime types. The native test below has since
replaced the guard-only regression in product source.

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
behavior, recovery, and verification limits. The exact-pin site checks and build
below passed on the unchanged site inputs. No deployment, live publication, or
installer update is claimed.

## Exact-pin verification layout

Verification used separate product and harness clones under
`/private/tmp/ejm-audit-verification-20261020/ide13/`. Product base:
`c46e25d48205db39e8dd47c42ed62b83e8413c21`, tree
`3406f236767cabda55bd71e0f75c3315e57fcb65`. The harness remained clean at the
protected pin `09b779ee0452dda07b7f52503be22e65fe238373`, tree
`c98793042e99e9a7c716aee39e69b05428edfaa8`.

`logs/ide13/source-provenance.json` and `post-base-provenance.json` under that
audit root record clean base source, lock hashes, and toolchain. Node was
`v24.19.0`; Rust was `1.99.1` on `aarch64-apple-darwin`. The product manifest,
package lock, Cargo lock, and harness pin remained unchanged.

Every Cargo command, including nested npm gates, held the exclusive
`/tmp/ejm-capacity-cargo.lock`. The wrapper used two build jobs, disabled
incremental compilation, retained normal debug profiles, and stopped commands
if free disk fell below 10 GiB. Credential environment variables were excluded
through a non-secret allowlist. Cargo was offline. Provider tests used fixtures;
there were no paid calls or real login flows.

## Native production-path regression

The private `session_with_start` helper contains the same cache lookup, client
construction, and publication body that production `session` uses. Its start
closure preserves the production command and initialization options. Its
`on_created` callback starts the existing event pump only after publication;
cached, losing, and rejected clients do not invoke it.

The replacement test starts a real `LspClient` against
`tests/fixtures/initializing-language-server.cjs`. That fixture uses the existing
direct development dependency's public `vscode-languageserver-protocol/node`
transport and protocol types. It pauses its initialize handler on a loopback
socket. The parent waits for the ready byte, clears native language state twice,
then releases initialization. The test confirms initialization succeeded, the
production publication path rejected the client, the session map stayed empty,
and the child-held control socket closed after the worker returned. The fixture
keeps that socket open after shutdown and exit, so production `LspClient::drop`
performs the child cleanup. Bounded Tokio IO replaces timing sleeps; closing the
parent socket exits the fixture on a failing test.

The candidate was the clean product base plus the retained patch
`logs/ide13/native-cleanup-candidate.patch`, SHA-256
`07d83bce83264e9f90b33d8c9b5784ea9086c866012dbccc83e6f061aeb96d61`.
`native-cleanup-candidate.json` records all candidate file hashes. Tested runtime
hashes:

- `src-tauri/src/language.rs`:
  `ba921266cd409b9db48ffd43faee733bc64c130819be6d59427c23ddd31aa5a7`.
- `src-tauri/tests/fixtures/initializing-language-server.cjs`:
  `e4d20393cebc01c2c91de5110382b23765073474319369ecd1e17a23ea86f024`.

Task and documentation evidence updates followed these gates without changing
runtime, dependency, or gate inputs. The earlier scratch result is historical,
not the evidence for native cleanup.

## Executed gates and raw output

All paths below are relative to
`/private/tmp/ejm-audit-verification-20261020/logs/ide13/`. Each command has a raw
`.log` and a matching `.json` with arguments, environment policy, elapsed time,
exit code, resource settings, and free disk. Elapsed times include lock waits
where present and are not runtime performance measurements.

| Log stem | Command | Result |
| --- | --- | --- |
| `08-native-check` | `cargo check --manifest-path src-tauri/Cargo.toml --tests --locked --offline` on clean base | Passed, 82.135 s |
| `09-npm-verify` | `npm run verify` inside the sandbox on clean base | Four loopback fixture binds blocked; 202 native tests passed |
| `09b-npm-verify-loopback` | Same clean-base `npm run verify`, scoped loopback permission | Passed, 133.403 s |
| `10-site-check` | `npm run site:check` on unchanged site inputs | Passed, 3.055 s |
| `11-site-build` | `npm run site:build` on unchanged site inputs | Passed, 2.970 s |
| `13-native-cleanup-regression` | `cargo test --manifest-path src-tauri/Cargo.toml --locked --offline --lib language::tests::pending_language_start_cannot_publish_after_workspace_clear -- --exact --nocapture` | Passed, 1 test, 206 filtered, 0.15 s test time |
| `14-fixture-style` | Biome check of the new fixture with warnings denied | Passed, no edits |
| `15-candidate-native-check` | `cargo check --manifest-path src-tauri/Cargo.toml --tests --locked --offline` on final runtime bytes | Passed, 4.453 s |
| `16-candidate-npm-verify` | `npm run verify` once on final runtime bytes | Passed, 37.634 s |

The final gate passed formatting, Biome lint, strict TypeScript, all 611 web
tests, strict Clippy, 206 native unit tests, 8 workspace integration tests, and
the frontend production build. One native unit test and six installed-server
integration tests remain ignored by the normal command. The frontend still
reports its existing main-chunk warning, about 5.53 MB minified. No bundle-size
or speed improvement is claimed. Final free disk was over 30 GiB.

The first full gate failed only because sandbox policy blocked
`TcpListener::bind("127.0.0.1:0")` in four existing provider fixtures. The same
unmodified gate passed with scoped permission for those local fixtures. The
new native fixture and final gate used that same local permission. These are
environment failures followed by successful exact-source verification, not a
provider-source repair.

## Remaining acceptance

The native test covers two clears across pending initialization, matching the
language-state boundary used when leaving and returning to a folder. It does not
drive the app's folder picker, workspace IPC, or GUI. Task 2.4 remains open.
No hosted admission, merge, release, installer, deployment, or website
publication occurred. Keep the change open; sync and archive only after all
required acceptance and review gates pass.
