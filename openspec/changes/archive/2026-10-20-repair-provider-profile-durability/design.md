# Design

## Context

See [proposal.md](proposal.md) for the motivation and the provider-profile-publication spec for behavior. At protected base `0309cb7aceae91034d710ee3dbe992edd9a9df31`, one private profile writer syncs file contents and renames the file. Save and remove helpers accept credential and commit callbacks; a commit error currently means the staged new key is safe to remove.

The source uses macOS Keychain through keyring, with stable service IDs and native-only credential references. The verified harness pin is `09b779ee0452dda07b7f52503be22e65fe238373`. The pinned Cargo lock already contains tempfile 3.27.0, also used by the shared auth package. The primary IDE draft's vault migration is a separate source and is not a dependency of this design.

## Goals / Non-Goals

**Goals:**

- Make credential retirement follow the supported host's completed file and directory synchronization sequence.
- Distinguish failure before replacement from visible replacement whose durability remains uncertain.
- Exercise real staging, file sync and replacement through the production path helper without using actual credentials.
- Preserve clear, remove and post-commit cleanup behavior under the existing test ports.

**Non-Goals:**

- Change provider authentication, Keychain service IDs, credential serialization, IPC or harness public interfaces.
- Import vault migration, language work or Agent Scale work.
- Add orphan-key cleanup, cross-process coordination, recovery replay or a new platform support claim.
- Promise that file-system synchronization guarantees power-loss recovery on every device.

## Decisions

### Keep profile publication policy in the IDE

The IDE owns the association between its profile file and saved Keychain references. Its existing put, remove and commit callbacks are sufficient. Keep public harness consumption and the immutable pin unchanged. Moving this policy into the harness or adopting the draft vault would widen the owner, dependency and verification scope.

### Use the already locked staging package

Move the current tempfile requirement from dev to regular dependencies and use NamedTempFile in the profile directory. Write and sync that file, then persist it over the destination. Preserve private-file permissions. This replaces the current manual temporary-name lifecycle with maintained staging and cleanup.

Do not change the dependency version or Cargo lock. No new package resolution is needed, and tempfile already occurs in the pinned production dependency graph. Retaining a second hand-written temporary-file lifecycle would duplicate available package behavior.

### Represent the publication boundary explicitly

Keep a thin AppHandle wrapper and one private path helper. A normal error means publication failed before replacement; an internal successful result distinguishes a completed directory sync from a visible but unsynced replacement. The latter carries the recovery error returned to the caller.

Only the final directory-sync operation is an injected filesystem callback. Directory creation, serialization, staging, writes, file sync and replacement use the real production operations. Credential callbacks remain the existing Keychain boundary.

Save behavior:

1. Stage a new credential under its own reference when requested.
2. Publish the changed profile through the path helper.
3. On pre-publication failure, remove only the staged key and preserve existing cleanup-error reporting.
4. On visible but unsynced replacement, return the changed-state error without deleting either credential.
5. After successful directory sync, retire the prior key if its reference changed. Preserve the existing error if that cleanup fails after publication.

Clear and remove use the same publication outcome before retiring the prior key. No automatic rollback or replay runs after uncertain publication.

A single undifferentiated error would delete a key already referenced by the visible file. Ignoring sync failure would permit old-key retirement without the intended durability evidence.

### Report unsupported targets conservatively

Use standard directory open and sync on Unix, with native acceptance limited to the existing macOS host. On a target without that operation, return an unsupported error from the final sync step and classify the already replaced file as unsynced. Preserve both possible credentials. Never treat a skipped or unsupported directory sync as durable.

This conservative path can report that a profile changed even though the command failed. Documentation must explain that result and direct the user to close and reopen Model connections before retrying. Linux and Windows support remain unverified or unsupported under the existing product contract.

### Upgrade four regression cases

Use the existing synthetic credential map and real temporary config files. Upgrade overlapping replacement-success and publication-failure tests instead of retaining duplicates.

1. Successful replacement: decode the published config at the final sync boundary and permit old-key retirement only after that boundary succeeds. Restrict this real-success fixture to Unix, where the production helper attempts directory sync; keep the platform-independent callback policy tests.
2. Real replacement failure: use a blocking destination to fail the actual replacement, retain the prior synthetic key, remove the staged key and clean staging files. State that a destination directory fixture does not establish preservation of a previous JSON file.
3. Final sync failure: after real replacement, verify the complete new config, inject only the final directory-sync failure and preserve both keys.
4. Clear/remove uncertainty: one parameterized case executes real publication for both operations and retains the old key after the same final sync failure.

Existing endpoint, subscription, incoming-reference, key-write and post-commit cleanup cases remain. The fixtures exercise product ordering, not the keyring implementation. A pre-fix comparison must expose the concrete ordering failure; source-shape assertions do not count.

### Bound resources and retain provenance

The sole isolated product checkout is `/private/tmp/ejm-handoff-fixes-20261020/ide-profile-durability/product`. Its baseline capture covers every tracked blob. Product code stays untouched until root reviews these artifacts and releases implementation. Native work also requires a later root gate release.

Before using an existing dependency tree, record its real paths, source commit/tree, lock hashes, installed-tree provenance and symlink destinations. The clean cached harness is at the unchanged pin. Do not modify linked dependencies or install packages.

Native commands run serially through the shared fcntl lock `/tmp/ejm-capacity-cargo.lock`, with at most two Cargo jobs, incremental compilation disabled, normal debug profiles and the shared target cache. Record target size immediately before the released gate. Stop if attributable target growth exceeds 2 GiB or free disk falls below 10 GiB. The planning stage creates no target output.

The runtime cost is one additional directory open and sync for a profile mutation. No background task, polling or frontend bundle change is added. No speed, binary-size or power-loss improvement is claimed without applicable evidence.

## Risks / Trade-offs

- A directory sync can fail after the visible file changed. Preserve both keys, report the changed state, and require inspection before retrying.
- Repeated uncertain writes can retain unused keys. Keep automatic garbage collection out of this repair because a crash can restore the prior profile.
- File and directory sync do not prove device-level power-loss behavior. Retain that limit in docs and verification.
- Fixtures do not exercise AppHandle paths or native Keychain. Those adapters remain unchanged, and no new acceptance claim is made for them.
- A dependency link can hide drift. Check source and link integrity before gates and capture exact tested bytes afterward.
- Cached native work can exceed disk budgets. Wait for root release, use the existing lock and stop at the agreed limits rather than starting a fresh dependency build.

## Migration Plan

There is no credential-format or Keychain migration. The change follows normal source review and publication gates after verification. Rolling code back restores the earlier write policy; no repair step deletes retained keys or replays an uncertain save.

Update `docs/harness.md` and `CHANGELOG.md` with behavior, recovery and verification scope. Review the static site overview; it has no affected durability claim or authored docs route at this source pin. No live documentation publication is implied.

Run focused profile tests, locked offline native checking, literal `npm run verify`, strict OpenSpec, scoped docs and provenance checks only after the respective root release. Sync and archive only after required checks pass and root review accepts their limits. No provider call, native GUI, installer or publication action is part of this work.
