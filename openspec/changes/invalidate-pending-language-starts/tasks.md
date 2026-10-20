# Tasks

## 1. Workspace language lifecycle

- [x] 1.1 Add shared generation checks to language-session lookup and publication, and verify source ordering against the reviewed language-only patch.
- [x] 1.2 Add the deterministic pending-start regression and confirm its production state code and test match the already executed scratch regression; record the guard-only limit.
- [x] 1.3 Update `docs/languages.md` and the unreleased changelog, and review the public site's language overview for affected claims at this source pin.
- [x] 1.4 Record the exact scratch regression and primary draft native-check evidence in `verification.md`, including the scope of each result and the clean-pin gates still unrun.

## 2. Integration checks

- [x] 2.1 After the shared measurement window ends, pass focused `rustfmt --edition 2024 --check`, `git diff --check`, and strict OpenSpec validation for this change.
- [ ] 2.2 With the immutable harness pin, pass clean-pin `cargo check --tests --locked` and `npm run verify`; retain native test, Clippy, and build output for review.
- [ ] 2.3 Confirm native language-server behavior while switching folders and reopening the same folder during startup, including release of the rejected child client.

## Workflow follow-up

- Keep the change and specs open while any required check is unrun.
- Sync specs and archive only after all tracked tasks and review gates pass.
- Review documentation through the normal release process. Local checks do not
  establish website publication or installer availability.
