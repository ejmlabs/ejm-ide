---
name: ejm-ide-verify
description: Check that a change works before saying it is done. Use for running checks, driving the browser preview, capturing screenshots in both themes, and handling slow or full-disk builds.
---

# Verify

Say what you ran and what you saw. If you did not run something, say so.

## Commands

Run from the project root. `npm run verify` runs all of these in order.

| Command | What it checks |
| --- | --- |
| `npm run format` / `npm run format:check` | Biome for web files and rustfmt for the `ejm-ide` package |
| `npm run lint` / `npm run lint:fix` | Biome rules, import order, accessibility; warnings fail |
| `npm run check` | Strict TypeScript |
| `npm test` | Vitest |
| `npm run lint:rust` | Clippy with warnings denied |
| `npm run test:rust` | Native tests |
| `npm run build` | Production frontend build |
| `npm run site:check` | Website types, build, `_headers` check and tests, and the Worker's types (needs `../ejm-ui`) |

Details and the ignored integration tests are in
[docs/development.md](../../../docs/development.md). Do not weaken a lint rule
to pass. Fix the code or document a narrow exception.

## See it work

1. `npm run dev` serves the frontend on port 1420 in browser preview. Native
   features (saving, Git writes, sign-in, terminals) are unavailable there and say so.
   Run `npm run dev:desktop` for the Tauri app.
2. Drive the page with the built-in browser, or with `playwright-core` and the
   installed Chrome (`chromium.launch({ channel: 'chrome' })`) when you need an
   exact viewport. Keep scripts and screenshots in the scratchpad, not the repo.
3. Check light and dark by setting `localStorage` key `workbench.theme` before load.
4. Check at the widths that matter: 1280 wide for the app, 320, 375, and 1440 for the site.
5. For site changes, confirm `document.documentElement.scrollWidth` equals
   `clientWidth` at 320 and 375.
6. Read console errors. A 404 for one resource is a real finding.

## Tests

- Use local fixtures and replay responses. Never make paid model calls.
- Never put credentials in fixtures, logs, or docs.
- When you rename a user-visible string, update the tests that assert it.
- Tests that stub `document` need the fields the code touches (`dataset`, `style`).
- A Rust change needs `cargo check --tests` and the Rust tests, not only the web checks.

## Machine limits

- `src-tauri/target` grows past 19 GB. If a build fails with "No space left on
  device", free the incremental cache (`src-tauri/target/debug/incremental`) or
  run `cargo clean`. It rebuilds. Never delete source, `node_modules` you still
  need, or the user's other projects.
- The shell is zsh. Variables holding several words do not split; pipe file lists
  through `xargs`. macOS `sed` has no `\b`.
- Dev servers outlive their shell only when started detached (`nohup ... &`).
  The user's own dev server on 1420 breaks if the project folder moves; say so.
