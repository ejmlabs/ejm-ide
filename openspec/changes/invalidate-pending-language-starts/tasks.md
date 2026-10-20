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

## Workflow follow-up

- Keep the change and specs open while any required check is unrun.
- Sync specs and archive only after all tracked tasks and review gates pass.
- Review documentation through the normal release process. Local checks do not
  establish website publication or installer availability.
