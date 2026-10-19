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
- [x] 2.4 Adopt retained shared revision `c4f2873ef0eef5bc3c7d75cf71fa3489a911d134` in both normal callers and release standards-ref; export the exact old default caller revision and new revision as bounded static review context; separate only the seven preserved generated OpenSpec skill additions from this draft; verify canonical sources, safe committed modes, normal templates, community/version standards, shared-only missing-key rejection, actionlint, contributor links, strict OpenSpec, unchanged product sources and harness pin, whitespace, and the full PR diff bound. Record local preparation separately from blocked hosted acceptance; trigger no IDE readiness or recovery.
- [ ] 2.5 Land [tooling PR #3](https://github.com/ejmlabs/ejm-ide/pull/3) after this product PR, with a refreshed base and fresh human decisions; verify that all seven project-local skill files retain their exact `0b221630db35100b6a0ced1f877b2617cfa9b880` bytes and modes. Repair the private brand-directory prerequisite in contributor guidance with committed design, site asset, license and notice references; keep brand refresh optional and assign active shared tokens, themes, primitives and site infrastructure to `ejm-ui` public exports. Verify local links, unchanged runtime/workflows/pins/configuration, strict OpenSpec, whitespace and the full diff bound. Use that PR to prove the installed harness pin `09b779ee0452dda07b7f52503be22e65fe238373` and shared caller `c4f2873ef0eef5bc3c7d75cf71fa3489a911d134`, including both complete actual Codex passes and every required gate. Preserve configuration and this change here; do not claim the project-local skills or new hosted checkout are verified before that draft passes and merges.
- [x] 2.6 Refresh the proposed harness pin to reviewed protected main `09b779ee0452dda07b7f52503be22e65fe238373`; preserve historical `4a751c6a3f24d7d143140f79ff53517fb93e3531` evidence and document that this product PR still checks the trusted base's old pin. Verify actual resolved core/auth/exec production source and harness lock identity, exact one-line pin, pinned standards, strict OpenSpec, local docs links, whitespace, unchanged product sources and locks, and the assembled diff bound. Keep both drafts unadmitted; record no review or recovery decision and run no native/site suite, model call, or hosted job.
- [x] 2.7 Repair the formatter failure from admitted run `39294657006` with the narrow Biome force-ignore rule for immutable `.github/review-context` exports; preserve every canonical byte and mode, reproduce the failure, then verify literal format/lint commands, exact source exports, pinned standards, contributor links, strict OpenSpec, unchanged runtime sources and locks, whitespace, and the assembled diff bound. Record local evidence and unrun gates. Require fresh human decisions for the new head; do not trigger CI, reuse old recovery authorization, or claim hosted acceptance.

## 3. Verification

- [x] 3.1 Run npm run verify, relevant native regressions, site checks/build, and strict OpenSpec validation with coordinated Cargo jobs; record missing platform evidence.

- [ ] 3.2 Verify human admission, self approval, stale commits, revocation, failed checks, missing secrets, and release tag refusal in GitHub; record live evidence before declaring public readiness.

## Workflow follow-up

- Sync completed specs and archive after all tracked work and required verification succeed.

## Local verification evidence

- Task 2.5 has a local provisional preview on proposed product head
  `5c680dabc6aa0f387fed0a9839699449deb4d744`, without claiming actual-main
  ancestry. Its first commit preserves all seven generated additions from
  `703f4bce5b2f691cae7f9238d95c459eda1ad841` and original
  `0b221630db35100b6a0ced1f877b2617cfa9b880`: 96,361 source bytes, exact
  Git blobs and regular nonexecutable modes, with the same 99,291-byte text
  diff and no conflicts. The separate guidance repair removes the private
  brand-directory prerequisite, links committed design/site assets and notices,
  leaves historical provenance intact, and names the current shared owners.
  All 47 local Markdown link targets across the eight affected guidance and
  planning files exist within this checkout. Strict OpenSpec and whitespace
  checks pass. Runtime, site source/assets/build inputs, workflows, harness pin,
  configuration, and the seven generated files remain unchanged by the repair.
  No runtime/native/site suite, hosted job, model call, comment, remote ref,
  setting, release, or publication ran. This preview must be replayed on the
  actual product squash merge, reverified, and admitted under fresh human
  decisions. Tasks 2.5 and 3.2 remain open; no new hosted checkout, two-pass AI
  acceptance, shared-package migration, live site update, or merge is claimed.

- Task 2.7 starts from `c3e17d59e47683286675ef631bf9069883d4066a`.
  Admitted run [39294657006](https://github.com/ejmlabs/ejm-ide/actions/runs/39294657006)
  fetched trusted base harness pin `4a751c6a3f24d7d143140f79ff53517fb93e3531`,
  then Quality failed before runtime checks because Biome tried to reformat the
  two exact review schemas. The literal local format command reproduced both
  errors. With only `!!.github/review-context` added, `npm run format:check`
  and `npm run lint` passed on Node 24.19.0, Biome 2.5.15, and Rust 1.99.1.
  Discovery kept 150 formatter files and 155 lint files, excluding only the
  canonical review directory. All 33 exports, totaling 581,900 bytes, match a
  fresh trusted canonical export, with exact manifest, hashes, Git object
  identities, and regular nonexecutable modes. Pinned standards and normal
  callers, contributor links, strict OpenSpec, whitespace, and the full PR diff
  bound passed. Application rules, source, dependencies, locks, callers, and
  harness pin are unchanged by this repair.
- The full frontend/native gate and site checks were not repeated for task 2.7.
  Runtime and dependency inputs still match tested IDE head
  `267ad8aa2e42debf5d97ff7ce5ad8dd1c48eb0d8`. Consumed harness production
  sources, manifests, workspace settings, and lock match the tested
  `35205aa49b9261d133395c4d6116c37c456ecb95` at proposed pin
  `09b779ee0452dda07b7f52503be22e65fe238373`; the only difference in those
  crate directories is an integration test not compiled by the IDE. Reuse that
  recorded local source coverage without claiming a new full gate or hosted
  success. The committed public site has no contributor formatter guide;
  canonical development guidance changed, while site content and downloads did
  not. No live publication is claimed. Fresh human decisions and any needed
  recovery authorization must name the new head. No workflow, model call,
  approval comment, remote ref, setting, merge, or publication changed. Tasks
  2.5 and 3.2 remain open.

- From baseline `52290665507efd88c64621125a02cba6b99ac8a9`, task 2.6 proposes reviewed protected harness main `09b779ee0452dda07b7f52503be22e65fe238373` as an exact 41-byte pin file, including its single newline. The IDE lock resolves only core, auth, and exec from the sibling harness. All 24 production files in their three source trees match the old pin, locally tested `35205aa49b9261d133395c4d6116c37c456ecb95`, and reviewed head `8343142b01622d588d98dddbb3ef5f94c26f2785`. The reviewed and merged main trees both equal `c98793042e99e9a7c716aee39e69b05428edfaa8`. The harness lock SHA-256 is `ea0d974c629dce3deeb29d4bd1b3b274779d8466acf51b2c68bcf8f99c351178` at all three compared revisions. Effective consumed manifests and workspace dependency declarations match apart from inherited publication metadata; the workspace Rust floor is now 1.99.1, already used by the recorded IDE gate. Exact pinned `c4f2873ef0eef5bc3c7d75cf71fa3489a911d134` standards, normal callers, version 0.1.0, seven local contributor links, strict OpenSpec, whitespace, and the local assembled diff bound passed. The unchanged 33-file workflow context totals 581,900 bytes. Product source, locks, callers, config, and skill split remain unchanged. No native/site suite, model call, hosted job, credential change, remote mutation, or human decision ran. This PR still checks trusted base pin `4a751c6a3f24d7d143140f79ff53517fb93e3531`; refreshed tooling PR #3 must prove the installed new pin and `c4f2873...` caller with both complete actual reviews and all required gates. No IDE recovery exception is authorized. Tasks 2.5 and 3.2 remain open. The source setup and contributor CI notes changed; public site behavior and download availability did not.

- From baseline `0b221630db35100b6a0ced1f877b2617cfa9b880`, task 2.4 locally prepares normal callers and release `standards-ref` at `c4f2873ef0eef5bc3c7d75cf71fa3489a911d134`. The trusted shared exporter supplied exact old default `af4ee77e9ee8da606c4ae3a0838bc3b46fd9d7f3` and new source context: 32 source files plus manifest, 581,900 bytes in total, below the 750,000-byte source-context bound. Canonical Git bytes, blob IDs, tree IDs, original modes, sizes, hashes, and 33 regular nonexecutable index entries matched. Exact normal callers, community templates and version 0.1.0, product rejection of the shared-only missing-key route, named actionlint checks, seven contributor links, strict OpenSpec, and whitespace passed. The initial combined draft exceeded the separate 1,000,000-byte review limit at 1,031,246 default diff bytes across 98 files. Before removal, all seven generated skill additions were copied and hash-verified unchanged in tooling PR #3 at `703f4bce5b2f691cae7f9238d95c459eda1ad841`, based on captured main `2395ddfbe7d4d252e3985267bf5924317c821cce`. After the split, the assembled product PR has 934810 default text diff bytes and 940816 full-index diff bytes across 91 files, both below the limit. These are local comparisons; exact GitHub response formatting remains unverified. Source context and shared limits are intact. Configuration, this entire change, product and dependency fixes, generated ACL manifest, and harness pin `4a751c6a3f24d7d143140f79ff53517fb93e3531` remain unchanged from their prepared baseline. No product suite, model call, hosted job, credential change, or release ran. The default caller remains unchanged and broken, hosted IDE access stays blocked until the harness is public, and no readiness or recovery is authorized. Tasks 2.5 and 3.2 remain open. No public site content or release availability changed.
- From baseline `ad97a401ac956ab7dac167e08d9459b9317309c6`, both callers match the normal consumer generator at `965cd684713ae91a7804745eddd452cc392af11d`. Standards with that revision's community templates, rejection of its shared-only missing-key caller, actionlint, strict OpenSpec validation, and whitespace checks passed. The harness pin remains `4a751c6a3f24d7d143140f79ff53517fb93e3531`. Only the two callers and this change's design and task records changed. No product gate or live admission ran for this metadata refresh, and no public site content changed. Hosted dependency access was neither changed nor tested.
- At `267ad8aa2e42debf5d97ff7ce5ad8dd1c48eb0d8`, the browser preview showed the initial untrusted state and canonical `/sample/harbor` root. The trust dialog was readable in light and dark themes. Tab and Shift+Tab kept focus inside the dialog. Escape and **Keep tools off** retained the untrusted state and returned focus to the trigger. Enter on **Trust workspace** removed the untrusted badge and trigger, then focused the `orders.rs` editor.
- The browser uses fixed fixture responses. These checks verify the interface, not native process execution or the desktop host's trust boundary.
- At the same IDE commit on macOS arm64, `npm run verify`, `npm run site:check`, `npm run site:build`, and `openspec validate public-repository-standards --strict --no-interactive` passed with Node 24.19.0 and rustc 1.99.1. The gate used two Vitest workers, two Cargo jobs, disabled incremental compilation, a 2 GiB Node heap limit, and an isolated copy of the Cargo cache.
- The assembled gate passed 611 frontend tests, 205 native library tests, and eight workspace integration tests, including canonical-root trust and trust expiry on workspace open. Seven optional tests remained ignored: the disposable Harbor index acceptance test and six installed-language-server tests. Strict Clippy, formatting, lint, TypeScript, and both production builds passed. Vite still warned about the 5.53 MB app chunk; no size improvement is claimed.
- The local native gate used sibling harness commit `35205aa49b9261d133395c4d6116c37c456ecb95`. GitHub CI still pins `4a751c6a3f24d7d143140f79ff53517fb93e3531` and remains blocked while the harness is private. That pin and the live pipeline require separate acceptance. Linux remains unsupported with the documented GTK/glib advisory; Windows, installer signing, and distribution were not verified by this gate.
