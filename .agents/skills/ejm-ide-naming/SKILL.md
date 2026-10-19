---
name: ejm-ide-naming
description: Use the right names for the program, its agent, the public page, and the shared repos. Use whenever you write UI text, prompts, docs, commit messages, release notes, or code identifiers that name the product.
---

# Names

| Thing | Name | Notes |
| --- | --- | --- |
| The desktop program | **ejm-ide** | Binary, bundle name, window title, installers, Cargo package `ejm-ide`, library `ejm_ide_lib`. |
| The agent in chat | **Edi** | IDE in reverse. Chat header, message labels, prompts, "Build with Edi", "Message Edi". |
| The public page | **ide** by ejmlabs | Lockup is the ejmlabs logo plus an "ide" tag. URL is `ide.ejmlabs.com`. |
| The studio | **ejmlabs** | Never type the wordmark in a font. Use the kit's logo SVG. |
| The shared engine | **ejm-harness** | Sibling repo. Crates are `ejm-harness`, `ejm-harness-auth`, and so on. |
| The sibling terminal agent | **ejm-cli** | Page name is "cli" by ejmlabs. |

Use Edi when the agent speaks, acts, or is addressed. Use ejm-ide when the
program does something (saves, indexes, fails to start, reports usage).
Write "ejm-ide" in lower case, even at the start of a sentence, or reword.

## Keep these identifiers

Renaming them would orphan existing local data or break contracts. Change them
only as a deliberate migration with the user's approval.

- Tauri bundle identifier `dev.workbench.ide`.
- Local storage keys that start with `workbench.` and the `workbench_*` agent tool names.
- The `.workbench/extensions/` project folder and the `window.workbench` SDK.
- The `workbench` CSS layers and the Monaco theme names `workbench` and `workbench-light`.
- Harness-owned names and the `gerry.package.json` manifest, which the harness repo owns.

## Writing rules

Never use em dashes. Use familiar words, active verbs, and only the words the
reader needs. Describe what exists. Do not claim a release, platform, speed, or
capability that has not shipped. Keep the product copy honest about unavailable
states.

## When the name changes again

Search for the old name in `app/`, `src-tauri/`, `docs/`, `website/`,
`distribution/`, `.agents/`, `.github/`, `extension-template/`, and the root
Markdown files. Update tests that assert the strings. Redeploy the site if its
copy changed, and recapture the site's screenshot if the app's labels changed.
