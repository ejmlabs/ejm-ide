# Design

## Context

See `proposal.md` for the startup race. The IDE owns the language-session map.
It starts language clients outside that map's lock and clears the map after a
new workspace opens. Root checks already protect a changed folder path but do
not distinguish two open sessions for the same folder.

## Goals / Non-Goals

**Goals:**

- Give workspace clear and session publication one shared ordering point.
- Preserve startup outside the session-map lock and existing client cleanup.
- Keep the fix within the IDE's workspace adapter and existing standard APIs.

**Non-Goals:**

- Interrupt server initialization, replace process ownership, or change IPC.
- Change providers, credentials, shared harness contracts, or site structure.
- Claim that a guard-only regression proves native process cleanup.

## Decisions

1. Add a shared generation counter to `LanguageState` and clone the state for
   pending startup. Advance the counter while holding the session-map mutex in
   `clear`. Check it under that same mutex before cached session use and before
   inserting a newly started client. The lock makes invalidation and publication
   ordered. A root-only check cannot detect leaving and reopening one folder.
2. Capture the generation before document and root validation. Retain the
   existing root check inside asynchronous startup. This makes a request that
   overlaps a workspace switch fail conservatively, rather than binding an old
   request to the new generation.
3. Keep client startup outside the map lock. Holding the lock through startup
   would block workspace changes. Rejecting the completed client releases its
   owned value through the existing cleanup path. A separate cancellation or
   process engine is unnecessary for this publication contract.
4. Use `AtomicU64`, `Arc`, and `Mutex` from the standard library. This is a small
   host-specific ordering guard, with no dependency or new worker. Budget one
   shared counter allocation per state and two checked map acquisitions per
   startup. Do not infer app memory, process cleanup, or latency from scratch
   test measurements.
5. Add one deterministic test that pauses a pending generation check, clears the
   workspace twice, resumes it, and confirms rejection plus access by the current
   generation. Synchronous channels avoid timing sleeps. Record the executed
   production-fragment regression separately from full native checks.

## Risks / Trade-offs

- Initialization still runs to completion. The guard releases a rejected client
  when startup returns; native child-process acceptance remains a separate check.
- A request during a workspace switch can be rejected. Reopen a file after
  trusting the current workspace to request its language service again.
- Primary draft checks used active sibling source. Preserve their exact scope
  and keep clean-pin native and repository gates open until they run.

## Migration Plan

Apply the language-only patch on the protected main source pin, update the
canonical language guide and changelog, then run focused format, diff, and
OpenSpec checks after the shared measurement window ends. Commit locally for
review. Full checks must use the immutable harness pin before landing. No data
migration is needed. Sync specs and archive only after all required verification
is complete. Publication and deployment follow the existing release gates.
