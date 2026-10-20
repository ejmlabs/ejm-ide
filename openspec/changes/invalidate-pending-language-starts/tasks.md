# Tasks

## 1. Workspace language lifecycle

- [x] 1.1 Add shared generation checks to language-session lookup and publication, and verify source ordering against the reviewed language-only patch.
- [x] 1.2 Replace the guard-only regression with a real native client regression through a private production cache/start/publication helper; preserve the production event pump and record the older scratch evidence separately.
- [x] 1.3 Update `docs/languages.md` and the unreleased changelog, and review the public site's language overview for affected claims at this source pin.
- [x] 1.4 Record historical scratch and primary draft evidence separately from exact-pin native checks, the final candidate regression and full gates in `verification.md`; retain raw logs, source and patch hashes, and remaining GUI limits.

## 2. Integration checks

- [x] 2.1 After the shared measurement window ends, pass focused `rustfmt --edition 2024 --check`, `git diff --check`, and strict OpenSpec validation for this change.
- [x] 2.2 With the immutable harness pin, pass clean-pin `cargo check --tests --locked` and `npm run verify`; retain native test, Clippy, and build output for review.
- [x] 2.3 Exercise the production native publication error path across two workspace clears with a real initializing LSP client, bounded loopback barriers, and child-owned socket EOF after rejection. Confirm successful initialization, an empty session map, and normal child cleanup.
- [ ] 2.4 Confirm the native app's folder-picker behavior while switching away and reopening the same folder during startup. The controlled native fixture does not establish this GUI acceptance check.

## 3. Frontend startup presentation

- [x] 3.1 Reproduce stale returned and rejected startup results through the real App controller across A to B to A; bind result publication to the requesting workspace object while preserving open-file checks and same-path serialization.
- [x] 3.2 Verify current untrusted and starting states survive old success and error completions, confirm the current startup can become ready, and add focused coverage for the existing serialized close/reopen contract.
- [x] 3.3 Run focused web regressions and the existing non-native gates, update the language guide and changelog, and retain before/after source hashes and browser evidence without claiming native GUI acceptance or a repeated full native gate.

## Workflow follow-up

- Keep the change and specs open while any required check is unrun.
- Sync specs and archive only after all tracked tasks and review gates pass.
- Review documentation through the normal release process. Local checks do not
  establish website publication or installer availability.
