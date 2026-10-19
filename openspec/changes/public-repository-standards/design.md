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

## Shared workflow refresh

Generate both normal product callers from the reviewed shared revision
`965cd684713ae91a7804745eddd452cc392af11d`, retained under its protected
`workflow-pins/965cd684713ae91a7804745eddd452cc392af11d` reference. This adopts
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
