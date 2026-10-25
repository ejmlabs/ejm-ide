# Tasks

Root reviewed these artifacts and released implementation and native gates. Emit the required brief backticked Insight before and after code edits.

## 1. Profile publication and recovery

- [x] 1.1 Move only the locked tempfile requirement into production dependencies, extract the private path writer and add explicit publication outcomes with real file sync, replacement and final directory sync. Verify the scoped source diff, preserved private-file permissions, unchanged Cargo lock and unchanged harness pin; native execution waits for task 2.2.
- [x] 1.2 Apply outcome handling to save, clear and remove so staged rollback occurs only before publication and prior-key retirement follows successful directory sync. Preserve existing keyring service IDs and cleanup-error behavior. Verify through the four regression cases in task 1.3 and source review of every retirement path.
- [x] 1.3 Upgrade overlapping tests into at most four distinct regression cases: successful real publication and ordered retirement, real replacement failure and staged rollback, injected final directory-sync failure preserving both keys, and one parameterized clear/remove uncertainty case. Use only existing synthetic credential callbacks, real temporary files and the final directory-sync filesystem test port. Verify with a concrete pre-fix failure comparison and the released focused native gate.
- [x] 1.4 Update docs/harness.md and CHANGELOG.md with changed-state recovery, retained-key limits, unsupported directory synchronization and unverified power-loss/Keychain/AppHandle scope. Review the static public overview and record why no site source changes are needed. Verify affected Markdown links, wording and correspondence with tested behavior.

## 2. Integration and resource gates

- [x] 2.1 Record integrity for any reused dependency tree: resolved paths, source commit/tree, matching product and harness locks, installed-tree provenance and symlink destinations. Verify the harness remains clean at 09b779ee0452dda07b7f52503be22e65fe238373, establish the target-size baseline after root release, and record the 2 GiB growth cap, two-job limit, incremental-off setting, shared fcntl lock and 10 GiB disk floor.
- [x] 2.2 After root releases the native gate, run locked offline focused profile tests and cargo check --tests using the recorded inputs. Verify all four distinct regressions, existing affected contracts, bounded resources and exact source hashes; report any restriction or unrun acceptance honestly.
- [x] 2.3 After root releases the broader gate, run literal npm run verify with the same locked source and resource controls. Record command results, resource use, platform, fixture limits, ignored tests and any known warning. Do not install packages or make provider, UI or paid calls.
- [x] 2.4 Finish strict OpenSpec, scoped docs and whitespace checks; confirm all protected inputs and unrelated tracked blobs remain unchanged; capture the final patch, source hashes and check evidence. Verify the complete candidate is ready for root review and report all remaining limits before any workflow completion.

## Workflow follow-up

- Root reviews the candidate and verification limits before any publication decision.
- Sync the provider-profile-publication spec and archive the change only after required checks and root review accept completion. Verify the archived result.
- No commit, push, PR creation, merge, installer, site publication or deployment is part of this authorization.
