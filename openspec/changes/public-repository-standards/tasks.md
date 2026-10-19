# Tasks

## 1. IDE readiness fixes

- [x] 1.1 Gate automatic language servers and native quality tools behind explicit trust of the current canonical workspace; verify untrusted, trusted, stale-root, and workspace-switch cases with focused tests.
- [x] 1.2 Add a compact trust confirmation while retaining untrusted editing; verify the UI in both themes and its accessible interaction.
- [x] 1.3 Add the four provider auth commands to command declarations and the host ACL; verify permission parity and isolated panel denial.
- [x] 1.4 Correct README setup, credential ignore rules, and package metadata; verify linked docs and metadata consistency.
- [x] 1.5 Resolve the DOMPurify and esbuild npm alerts with narrow compatible dependency updates; audit the lock, inspect source compatibility, and document the unsupported Linux glib advisory.

## 2. Shared pipeline adoption

- [x] 2.1 Add uniform community docs, version/changelog, and immutable shared workflow callers with a pinned harness revision; verify standards/version/workflow checks.
- [x] 2.2 Apply available GitHub branch, approval, Actions, and dependency protections; verify API readback.
- [x] 2.3 Refresh the normal product workflow callers to retained shared revision `965cd684713ae91a7804745eddd452cc392af11d`; verify pinned standards and templates, rejection of the shared-only missing-key caller, actionlint, strict OpenSpec, whitespace, and the unchanged harness pin without claiming product gates or live acceptance.

## 3. Verification

- [x] 3.1 Run npm run verify, relevant native regressions, site checks/build, and strict OpenSpec validation with coordinated Cargo jobs; record missing platform evidence.

- [ ] 3.2 Verify human admission, self approval, stale commits, revocation, failed checks, missing secrets, and release tag refusal in GitHub; record live evidence before declaring public readiness.

## Workflow follow-up

- Sync completed specs and archive after all tracked work and required verification succeed.

## Local verification evidence

- From baseline `ad97a401ac956ab7dac167e08d9459b9317309c6`, both callers match the normal consumer generator at `965cd684713ae91a7804745eddd452cc392af11d`. Standards with that revision's community templates, rejection of its shared-only missing-key caller, actionlint, strict OpenSpec validation, and whitespace checks passed. The harness pin remains `4a751c6a3f24d7d143140f79ff53517fb93e3531`. Only the two callers and this change's design and task records changed. No product gate or live admission ran for this metadata refresh, and no public site content changed. Hosted dependency access was neither changed nor tested.
- At `267ad8aa2e42debf5d97ff7ce5ad8dd1c48eb0d8`, the browser preview showed the initial untrusted state and canonical `/sample/harbor` root. The trust dialog was readable in light and dark themes. Tab and Shift+Tab kept focus inside the dialog. Escape and **Keep tools off** retained the untrusted state and returned focus to the trigger. Enter on **Trust workspace** removed the untrusted badge and trigger, then focused the `orders.rs` editor.
- The browser uses fixed fixture responses. These checks verify the interface, not native process execution or the desktop host's trust boundary.
- At the same IDE commit on macOS arm64, `npm run verify`, `npm run site:check`, `npm run site:build`, and `openspec validate public-repository-standards --strict --no-interactive` passed with Node 24.19.0 and rustc 1.99.1. The gate used two Vitest workers, two Cargo jobs, disabled incremental compilation, a 2 GiB Node heap limit, and an isolated copy of the Cargo cache.
- The assembled gate passed 611 frontend tests, 205 native library tests, and eight workspace integration tests, including canonical-root trust and trust expiry on workspace open. Seven optional tests remained ignored: the disposable Harbor index acceptance test and six installed-language-server tests. Strict Clippy, formatting, lint, TypeScript, and both production builds passed. Vite still warned about the 5.53 MB app chunk; no size improvement is claimed.
- The local native gate used sibling harness commit `35205aa49b9261d133395c4d6116c37c456ecb95`. GitHub CI still pins `4a751c6a3f24d7d143140f79ff53517fb93e3531` and remains blocked while the harness is private. That pin and the live pipeline require separate acceptance. Linux remains unsupported with the documented GTK/glib advisory; Windows, installer signing, and distribution were not verified by this gate.
