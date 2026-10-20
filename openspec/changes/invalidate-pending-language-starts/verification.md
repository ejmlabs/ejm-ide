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

## Frontend startup presentation follow-up

This later, uncommitted candidate starts from published IDE commit
`06260fd07ba82cc0981ec1e13c0a1d36441ab2f7`. It changes frontend startup result
publication and adds one language synchronization test. The native source,
native fixture, dependency locks, harness pin, and gate definitions are unchanged.
The earlier full native gate is evidence for those unchanged native bytes, not
a claim that `npm run verify` ran again for the frontend candidate.

### Reproduction and correction

The existing Vite browser facility ran the real React App effects, folder
commands, `language-sync`, and Monaco in a separate source export. A local Vite
plugin replaced only backend calls and event subscription. The controlled
workspace responses followed A to B to A while the first `language_open`
response stayed pending.

Before the fix, reopening the file without trust showed `untrusted`; releasing
the old unavailable result replaced it with `Syntax only`. In a second case,
trusting returned A requested a fresh startup and showed `starting`; rejecting
the old request replaced that status with `error`. Completing the current
request then showed `LSP`.

After the fix, both sequences ran through the same real App paths. DOM
assertions confirmed that the first case stayed `untrusted`, the second stayed
`starting`, and the current request still reached `LSP`.

Same-path requests are serialized by `language-sync`. The old request cannot
overtake a newer ready startup. The confirmed defect is an earlier workspace's
result replacing the current untrusted or starting state. The added Vitest
regression holds initialization, allows another folder's path to finish first,
rejects the old initialization, and verifies that reopening the same path waits
for its close before starting and can then become ready.

The correction captures the existing workspace object and checks its identity
before publishing a returned status or error. Every successful folder open
replaces that object. The only other replacements are initial workspace load
and trust. Initial load runs only with no workspace; trust installs its new
object before restarting each open file. Ordinary renders and Git, file,
document, index, and language refreshes preserve the object. An independent
source review found no unrelated refresh that discards a valid current start.
No new state, allocation, timer, worker, dependency, or shared API is added.

### Retained evidence

Evidence is under
`/private/tmp/ejm-audit-verification-20261020/ide13-frontend-race/`:

- `before-source.json`, `after-app-source.json`, and `tested-source.json` record
  the base commit and source hashes. The tested export matches the repair
  checkout for the app, language synchronization code and test, Monaco, real
  backend, dependency locks, native source, and native fixture.
- `before-browser-events.jsonl` and `after-browser-events.jsonl` retain backend
  command order and observed workspace/status transitions. `browser-result.json`
  records the before/after DOM assertions and their scope.
- `browser-fixture.mjs` retains the local test boundary. No browser test adapter
  is included in the production build.
- The original browser run used a fallback font because the reused
  `node_modules` symlink fell outside Vite's asset allowlist. The scratch fixture
  now allows that exact dependency directory; `08-fixture-font.json` records a
  200 response with 21,168 bytes for the font. Two Monaco tokenization time-limit
  warnings appeared. No unhandled frontend exception was observed. These runs
  establish controller state, not a layout or performance result.

App SHA-256 before the correction:
`1d5e0bf144def5398e9126092b51dedfc8a93ab56366613195b2aff9e20c2aba`.
Tested App SHA-256 after the correction:
`77e96879deebde68771897ec930c996b3aeb94beabccadd2d2dcd3f0edca77e9`.
Test SHA-256:
`e45132fd17165b3ac9ca4ef9a6bbd9d7be661909fa3aff370d325878dab77587`.
The native source and fixture still have the exact hashes recorded above:
`ba921266cd409b9db48ffd43faee733bc64c130819be6d59427c23ddd31aa5a7`
and `e4d20393cebc01c2c91de5110382b23765073474319369ecd1e17a23ea86f024`.

### Non-native checks

Each log has a matching JSON record with arguments, exit code, elapsed time, and
the non-secret environment allowlist. The source export reused already
installed dependencies. No dependency installation or native build ran.

| Log stem | Command | Result |
| --- | --- | --- |
| `02-language-sync-regression` | `npm test -- app/lib/language-sync.test.ts` | Passed, 5 tests |
| `03-web-format` | `biome format .` | Passed, no edits |
| `04-web-lint` | `npm run lint` | Passed |
| `05-web-check` | `npm run check` | Passed |
| `06-web-tests` | `npm test -- --maxWorkers=2` | Passed, all 612 tests in 40 files |
| `07-web-build` | `npm run build` | Passed; existing 5.53 MB main-chunk warning |
| `09-openspec-validation` | `openspec validate invalidate-pending-language-starts --strict` | Passed |
| `10-diff-whitespace` | `git diff --check` | Passed |

The public site's language overview at `website/index.html` describes startup
and advertised server capabilities. It has no status recovery or workspace
session claims to change. This source pin has no public docs routes or copied
language guide. The canonical `docs/languages.md` and unreleased changelog now
cover the frontend guard and distinguish the new web evidence from the earlier
native gate. Site runtime and build inputs are unchanged, so the earlier site
checks were not repeated. No website or installer publication is claimed.

Task 2.4 remains open. Browser backend fixtures do not establish native folder
picking, workspace IPC, language process startup, or child cleanup. No native
gate was repeated, and this candidate has not been committed, pushed, merged,
released, or deployed.
