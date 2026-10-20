# Design

## Context

At the start of this audit, the projects were private and main had no branch protection. Product workflows ran on every PR with failing remote runs, and the two hosts required a sibling harness checkout. All products currently use version 0.1.0. See proposal.md for motivation.

## Goals / Non-Goals

**Goals:** Share maintenance policy and trusted automation, keep each product independently versioned, and require a human to admit and approve the exact PR head.

**Non-Goals:** Publishing product releases, package uploads, installer signing, deployment, history rewrites, and buying private-repository security products during setup.

## Decisions

1. Use the user-selected ejmlabs/.github repository for reusable workflows, executable standards, templates, and runbooks. Consumers pin a reviewed full SHA. Product checks keep their established gate commands.
2. Use trusted default-branch issue-comment or manual dispatch entry points. A human maintainer issues `/ready <full-head-sha>` before quality or AI runs. New commits have no inherited readiness. Outsider and bot events do not launch jobs. Restrict GitHub fork workflows to approval by all external contributors and keep untrusted jobs read-only.
3. Keep readiness separate from `/approve <full-head-sha>`. The latter requires a current human maintainer and records native bot approval for self review where GitHub forbids native author approval. Main requires at least one native approval and the maintainer gate, plus required checks, resolved discussions, linear history, and no force pushes or deletion. Administrators do not bypass the merge requirements.
4. Run exactly two independent Codex passes using `gpt-6.1-sol` with medium reasoning, trusted prompts and configuration, read-only permissions, no PR build or test execution, and isolated model credentials. Post results in a separate job. Missing credentials or invalid output fail closed. Bound the diff, output, time, and concurrent runs. Check replayed admission identifiers before spending budget.
5. Keep a root VERSION and CHANGELOG.md in each product. Validate all releasable package versions. A common manual pipeline accepts an exact checked main commit and matching version, refuses existing tags, and creates only a draft release with source archives, checksums, and provenance. Document native binary and registry publication gates explicitly.
6. Keep licenses and brand notices distinct. Preserve each product's MIT license and bundled font licenses; include license text in SDK packages. The studio's design assets retain their existing ownership terms.
7. Enable available free repository protections and dependency alerts now. Do not enroll private repos into billed secret protection. Record the required public-only activation checks before any visibility change.

## Risks / Trade-offs

- Shared workflow changes affect several products. Immutable caller pins and reviewed update PRs bound rollout.
- Human readiness costs a small metadata action and can delay outside contributions. The expensive checks remain unavailable until deliberate admission.
- CLI and IDE consume pinned sibling harness revisions. The 2026-10-18 plan recorded the owner's decision to wait for a public harness and use no private cross-repository token. IDE hosted checks remain blocked under that policy. CLI's current dependency access belongs to its separate task. Earlier workflow refreshes changed no consumer harness pin or credential and granted no dependency access. The reviewed IDE pin refresh below needs separate hosted acceptance and grants no access.
- API review needs a scoped OPENAI_API_KEY and provider budget settings. Setup does not prove a successful paid review.
- Local disk space is constrained. Coordinate Cargo checks, use focused existing caches, and report missing full platform evidence honestly.
- Source and history scans reduce known risk; partial scan coverage and platform-specific tests remain explicit.

## Migration Plan

Create and test the shared repository first. Add pinned consumers and version metadata, then apply and read back repository settings. Run the project gates and first admitted PR through the new pipeline when the required credentials are present. Keep repositories private until blockers are resolved. Roll back a bad workflow update by restoring the previous immutable caller pin.

## IDE adapter

Trust is scoped to the selected canonical root and the current open session. The native host owns the decision and checks it at language-server and quality process boundaries. A compact confirmation explains that tooling may run project code. Untrusted editing stays available, and explicit terminal actions remain deliberate user actions. Add auth commands to both native declarations and the host ACL with a parity regression. Keep the harness checkout pinned to a compatible immutable commit.

## Dependency advisory resolution

Keep Monaco at 0.57.0 and override only its exact DOMPurify dependency to patched 3.4.16. Raise the direct esbuild dependency to the patched 0.28 line without upgrading Vite or other tools. Verify the complete npm lock with an audit and inspect dependency changes. The supported native target remains macOS on Apple Silicon. Linux GTK still requires glib 0.18.5, which has RUSTSEC-2024-0429; do not claim Linux support or force an incompatible GTK dependency override. Record the advisory and the upstream upgrade needed before Linux acceptance.

## Earlier shared workflow refresh

The earlier local refresh generated both normal product callers from the
reviewed shared revision
`965cd684713ae91a7804745eddd452cc392af11d`, retained under its protected
`workflow-pins/965cd684713ae91a7804745eddd452cc392af11d` reference. This adopted
the shared SemVer prerelease validation and explicit removal of `GITHUB_TOKEN`
from the Codex reviewer environment. Preserve human admission, maintainer
approval, all required checks, and two medium Codex passes. The missing-model-key
test caller remains exclusive to the shared standards repository.

Keep `.github/harness-revision` unchanged and provision no cross-repository
token in this refresh. Dependency access and pin changes need coordinated review
and separate hosted acceptance. This change updates workflow metadata and its verification record. It
changes no IDE product behavior or public site content. Check the exact pinned
standards and community templates, caller syntax, strict OpenSpec validation, and
whitespace. Product gates and live acceptance are separate evidence; this local
refresh does not repeat or claim them.

## Review completion and source context

Refresh both normal product callers and the release `standards-ref` to retained
shared revision `c4f2873ef0eef5bc3c7d75cf71fa3489a911d134`. The shared
repository owns the workflow, prompt, schema, and validator. The IDE consumes
that immutable public interface. Each AI pass must return boolean
`complete: true`; missing, false, or nonboolean completion fails even when the
findings list is empty. Preserve all human admission and approval gates, the
two medium Codex passes, and the normal product caller. The shared-only
missing-model-key route remains forbidden here.

Export the old default-branch implementation
`af4ee77e9ee8da606c4ae3a0838bc3b46fd9d7f3` and the new implementation from
canonical shared Git objects into `.github/review-context/`. Use the trusted
shared exporter and its fixed 16-file scope per revision. Keep the manifest
and both source sets below 750,000 bytes in total, with regular nonexecutable
committed files. These copies are static review data, never executable or
imported workflow helpers. Verify their bytes, blob IDs, modes, tree IDs, and
manifest hashes against the exact shared revisions.

The default branch still uses the old caller. Updating a submitted caller does
not replace the trusted base workflow used to check that PR. This preparation
does not admit an IDE head or authorize a recovery exception. Hosted IDE CI
remains blocked until the harness is public under the owner's no-token policy.
Task 2.4 kept `.github/harness-revision` at
`4a751c6a3f24d7d143140f79ff53517fb93e3531` and changed no credentials or
dependency access. Preserve that historical evidence. Task 3.2 remains open
for separate hosted acceptance; the pin refresh below adds no admission or
recovery decision.

Check exact caller templates, community and version standards, source identity,
safe file modes, actionlint, contributor links, strict OpenSpec validation, and
whitespace. Product, native, and site sources stay unchanged, so their earlier
source-covered evidence is retained without repeating those suites. Contributor
operating guidance must explain the completion guard and current access limit.
No public site behavior or release availability changes in this preparation.

The initial combined draft, including its earlier product fixes, exceeded the
shared 1,000,000-byte review diff limit against current main. Split only the
seven new generated OpenSpec skill files into [tooling PR #3](https://github.com/ejmlabs/ejm-ide/pull/3) on
`standards/openspec-skills`, based on captured main
`2395ddfbe7d4d252e3985267bf5924317c821cce`. Their exact bytes and modes from
`0b221630db35100b6a0ced1f877b2617cfa9b880` are preserved separately before
removal here. Merge this product PR first, then refresh the tooling draft's
base and obtain fresh human decisions on that head. Keep
`openspec/config.yaml`, this entire change, the product and
dependency fixes, generated ACL manifest, both review source sets, and shared
limits intact. Project-local generated skill installation remains pending
until its separate draft lands. Task 2.4 completes only after the assembled
product PR diff passes the review bound; task 2.5 tracks the pending tooling
installation. Neither local result admits this draft or establishes hosted
acceptance.

## Portable contributor brand guidance

Task 2.5 also repairs the contributor instructions that require a private brand
directory. The IDE owns its guidance, current site composition, and committed
asset references. `ejm-ui` owns active shared tokens, generated themes, reusable
visual primitives, and site infrastructure through public `@ejm/*` exports.
Retained `design-kit/` files support brand assets and earlier source references;
they are not a second authority for active shared UI. This documentation change
does not add a dependency or claim that a shared-package migration is installed.

Use `DESIGN.md`, the committed `website/index.html` and
`website/public/design-kit/` files, local font licenses, and
`website/public/notices.txt` for this source snapshot. Historical local paths in
the asset provenance record describe earlier inputs; they are not contributor
prerequisites. Keep an upstream brand-asset refresh an optional maintainer action
through the existing script and a reviewed source supplied by `DESIGN_KIT`.
Ordinary source and site work must not require a private marketing checkout.

Keep the seven generated OpenSpec additions byte-for-byte unchanged. Align only
the affected root, UI, theme, website, and shared-owner guidance. Check its local
links, source and license paths, whitespace, strict OpenSpec validation, unchanged
runtime, workflow, pins, configuration, and generated skills, and the full PR diff
bound. Site source, assets, build inputs, appearance, downloads, and release
availability do not change, so no live publication or new site acceptance is
claimed. Keep task 2.5 and all hosted acceptance open until the refreshed PR runs
both complete actual Codex passes, passes every required gate, and merges.

## Reviewed harness pin refresh

For task 2.6, refresh the proposed `.github/harness-revision` to reviewed
protected harness main `09b779ee0452dda07b7f52503be22e65fe238373`. The
harness owns its public core, auth, and execution contracts; the IDE consumes
them through sibling path crates. The IDE's resolved local dependency graph
contains `ejm-harness`, `ejm-harness-auth`, and `ejm-harness-exec`, not the
coding or package crates. Their production sources and the harness lock are
identical between the old pin and the reviewed main tree. The workspace Rust
floor rises to 1.99.1, which the recorded IDE gate already used. This aligns
the proposed checkout with the reviewed public candidate; it is not a claimed
runtime or performance fix. Do not adopt the separate host-auth feature.

Preparation reads the harness pin from trusted base source. Until this product
PR lands, its hosted Quality job still uses
`4a751c6a3f24d7d143140f79ff53517fb93e3531`, even when the submitted file names
the new pin. After landing, refresh tooling PR #3 onto that base and obtain
fresh human decisions. That PR must prove the installed new harness pin and
shared caller `c4f2873ef0eef5bc3c7d75cf71fa3489a911d134`, including both
complete actual Codex passes and every required gate. A successful old-pin
Quality run does not establish the new checkout. The old default AI caller
still needs its own explicitly authorized recovery; task 2.6 grants none.

Limit this preparation to the pin, contributor operating guidance, and this
change's design/tasks. Preserve the historical pin and gate evidence, both
canonical workflow source sets, and the seven-file tooling split. Check the
resolved consumed source and lock identity, exact pin bytes, pinned repository
standards, strict OpenSpec, local documentation links, whitespace, and the
assembled diff bound. Product sources and locks stay unchanged, so their
recorded tests remain source-covered. Run no native/site suite, model call,
hosted job, credential change, release, or publication for this preparation.
The public documentation impact is source setup and contributor CI guidance;
no public site behavior or download availability changes.

## Canonical review-source formatting

Admitted run `39294657006` fetched the trusted base harness pin successfully,
then stopped at `npm run format:check`: Biome wanted to reformat both canonical
review schemas. Keep those shared Git bytes exact. Use the installed Biome
`files.includes` force-ignore rule `!!.github/review-context` for this static
source directory only. Keep application rules unchanged and verify the exports
against the canonical shared objects, including their manifest and safe modes.

Task 2.7 covers local repair and focused format, lint, standards, documentation,
OpenSpec, and diff checks. Record the failed hosted run and unrun gates plainly.
Changing the head requires fresh human decisions and a new exact-head recovery
decision if needed. Do not reuse the old admission, run CI, or claim hosted
acceptance from local checks. This contributor-tooling repair changes no runtime
contract, public site content, or download availability.

## Byte-preserving release validation

The IDE owns its workflow callers and contributor guidance. Shared repository
`ejmlabs/.github` owns the reusable governance and draft-release workflows and
their embedded validators. Consume that public contract at retained reviewed
revision `6717b433c462e01abaed86e2118e4843827598cb`, replacing installed
revision `c4f2873ef0eef5bc3c7d75cf71fa3489a911d134` in both callers and
the release `standards-ref`. The new release validator preserves original
license and document line endings when comparing committed source with archive
entries. Do not edit the uniform community templates.

Generate a replacement old/new static source pair with the shared exporter.
The old revision must match installed main and the new revision must match all
three proposed pins. Verify the complete fixed scope, canonical Git bytes,
tree/blob identities, original modes, manifest hashes, and nonexecutable
committed copies. Keep the pair below 750,000 bytes and the whole proposed
diff below the normal review bounds.

The target also adds shared UI and harness preparation support. The IDE keeps
its existing protected-base harness selection and exact harness pin. No
`.github/ui-source.json` is introduced, so the optional UI checkout and install
are absent. IDE Quality still runs `npm ci --ignore-scripts`, `npm run verify`,
`npm run site:check`, and `npm run site:build` on macOS. No product, dependency,
secret, provider, or installer contract changes. Shared policy has no new
dependency on the IDE.

Update the development and distribution guides and unreleased changelog.
The current website has no release-operation guide, so its runtime, assets,
build inputs, and output are outside this metadata-only change. Check affected
Markdown links and preserve every runtime and dependency blob. The existing
native/platform checks are not repeated locally. Fresh exact-head human
admission, all five statuses, native approval, and both complete actual medium
Codex passes remain required before normal merge. This preparation creates no
tag, release, package, deployment, or new hosted verification. Tasks 2.5 and 3.2
stay open until their own evidence is reconciled.
