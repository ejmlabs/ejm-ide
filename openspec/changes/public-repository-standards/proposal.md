# Proposal

## Why

The IDE has unprotected main, failed remote CI, mutable workflow dependencies, and no shared release process. Native provider auth commands are absent from its ACL, and automatic project tooling can execute untrusted workspace code.

## What Changes

- Adopt the shared workflows and standards in `ejmlabs/.github`, pinned to immutable commits.
- Require a human maintainer to admit each exact PR commit before quality checks or AI review can run, with bounded work and no automatic reruns.
- Require a PR, current maintainer approval, resolved conversations, and passing quality, standards, and two Codex review passes before merging.
- Allow a maintainer to approve their own current commit explicitly, without bypassing checks.
- Standardize contributor, security, support, license, documentation, and dependency maintenance guidance.
- Add independent semantic versions, release notes, version consistency checks, immutable tags, checksums, and a manual draft release pipeline.
- Preserve existing work and keep publication, package uploads, deployment, and paid security enrollment separate from setup.
- Add the four registered provider auth commands to the host ACL and check command parity.
- Require explicit trust before automatic language servers or project quality tools execute code from a workspace.
- Correct source setup docs, dependency metadata, credential ignore rules, and release claims.
- Resolve the reported npm DOMPurify and esbuild advisories with narrow compatible dependency updates; document the unsupported Linux GTK dependency limit.

## Capabilities

### New Capabilities

- `repository-governance`: Consistent contribution, maintainer review, security checks, and repository policy.
- `semantic-releases`: Independent SemVer releases with checked metadata and reproducible source artifacts.
- `workspace-trust`: Untrusted workspaces remain editable while project code execution waits for explicit trust.
- `host-auth-commands`: Registered provider sign-in commands are available only through the intended host ACL.

### Modified Capabilities

None. OpenSpec was initialized for this work and has no existing capability specs.

## Impact

Host ACL, workspace trust state and UX, language and quality launch boundaries, frontend/native tests, docs, workflow callers, and GitHub settings.
