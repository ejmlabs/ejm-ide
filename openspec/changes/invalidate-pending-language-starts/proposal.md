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
- Exercise the production cache, start, and publication path with a real native
  client paused during initialization across workspace clears. Confirm rejected
  child cleanup with the existing public LSP transport package.
- Bind frontend startup results to the workspace object that requested them.
  Ignore earlier status and capability updates after leaving and reopening the
  same root, including both returned statuses and rejected requests.
- Update the canonical language guide and changelog with the lifecycle and
  verification limits.

## Capabilities

### New Capabilities

- `language-session-lifetime`: Keep language services within the workspace
  session that requested them, including pending starts.

### Modified Capabilities

None. This checkout has no main specs.

## Impact

`ejm-ide` owns the workspace service adapter in `src-tauri/src/language.rs` and
the language startup presentation in `app/App.tsx`.
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
The test uses bounded loopback barriers and the existing Node transport package;
it does not establish GUI folder-picker acceptance.

The frontend reuses each folder open's existing workspace object as identity.
It captures one reference and checks it before applying a result. The real App
controller is exercised with controlled local backend responses in the existing
Vite browser facility. Same-path starts remain serialized by `language-sync`;
the confirmed frontend regression is an old result replacing the current
untrusted or starting status, not an old result overtaking a newer ready start.
