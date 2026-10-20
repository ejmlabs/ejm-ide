# Proposal

## Why

A language-server start can finish after its workspace closes and put the old
client back in the active session map. Checking the root path alone also misses
leaving a folder and reopening it while that start is pending.

## What Changes

- Bind language-server lookup and publication to the workspace generation that
  requested startup.
- Advance that generation when workspace language services are cleared. Reject
  older starts and release their owned clients through normal cleanup.
- Add one deterministic regression for a start paused across workspace clears.
- Update the canonical language guide and changelog with the lifecycle and
  verification limits.

## Capabilities

### New Capabilities

- `language-session-lifetime`: Keep language services within the workspace
  session that requested them, including pending starts.

### Modified Capabilities

None. This checkout has no main specs.

## Impact

`ejm-ide` owns the workspace service adapter in `src-tauri/src/language.rs`.
No public harness API, IPC shape, dependency, or sibling source changes. The
dependency direction remains from IDE to public harness packages. Existing
client ownership supplies cleanup when a rejected startup returns.

The public documentation at this source pin is `docs/languages.md`. The site
has a language overview but no authored user or developer guides and no docs
routes. Review that overview for affected claims without importing another
checkout's site structure. Local edits do not establish live publication.

Use the standard synchronization APIs already in the crate. The resource
budget is one shared generation value per language state, two generation
checks per startup, and no added worker, timer, or package. No speed improvement
is claimed. Focused checks supplement, but do not replace, clean-pin native and
full repository gates. Keep the change open until those required gates pass.
