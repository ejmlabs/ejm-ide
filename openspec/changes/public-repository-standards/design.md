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
- CLI and IDE consume pinned sibling harness revisions. The 2026-10-18 plan recorded the owner's decision to wait for a public harness and use no private cross-repository token. IDE hosted checks remain blocked under that policy. CLI's current dependency access belongs to its separate credential task. This refresh changes no consumer harness pin or credential and grants no dependency access. Later pin updates need review and hosted acceptance through the owning task.
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
Keep `.github/harness-revision` at
`4a751c6a3f24d7d143140f79ff53517fb93e3531`; change no credentials or dependency
access. Task 3.2 remains open for separate hosted acceptance.

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
