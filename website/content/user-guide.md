---
title: User guide
description: Set up ejm-ide, open a project, connect a model, and use the editor, Edi, Git, and language tools.
lead: Build the development app, open a project, follow the code and work with Edi. Check the platform limits before using it on important files.
group: Guides
---

## Run from source {#setup}

The current development target is Apple Silicon macOS. Install Git, Node.js 24 LTS, stable Rust, Xcode Command Line Tools and the [Tauri development prerequisites](https://v2.tauri.app/start/prerequisites/). Keep the IDE, harness and shared UI repositories in the same parent directory. Their source is public. Check out the compatible shared revisions before installing dependencies.

```sh title="Clone and start the native IDE"
git clone https://github.com/ejmlabs/ejm-harness.git
git clone https://github.com/ejmlabs/ejm-ui.git
git clone https://github.com/ejmlabs/ejm-ide.git
cd ejm-ide
git -C ../ejm-harness checkout --detach "$(cat .github/harness-revision)"
git -C ../ejm-ui checkout --detach "$(node -p "require('./.github/ui-source.json').revision")"
npm --prefix ../ejm-ui ci --ignore-scripts
npm ci --ignore-scripts
rustup component add rust-analyzer rustfmt clippy
npm run dev:desktop
```

The native host loads the sibling harness; the site uses the sibling UI packages. The two metadata files select compatible immutable revisions. Follow the [developer setup](/docs/developer-guide/#setup) before updating either pin.

`dev:desktop` keeps frontend hot reload on and native watching off. Restart it after changing Rust code. For a frontend-only preview, run `npm run dev` and open the local address it prints.

> **Note:** The browser preview uses labelled read-only samples for native services. Saving files, Git writes, sign-in, and terminal execution need the desktop app. The site's example session plays a local, scripted workflow without a model connection.

Check the [download page](/download/) for a verified installer. Source and browser checks do not establish installer availability or support for other platforms. Read the [platform requirements and limits](/docs/developer-guide/#platforms).

## Open a project {#workspace}

1. Choose **Open folder** and select the project root, where build files such as `Cargo.toml`, `tsconfig.json`, or `go.mod` live.
2. Open a file from the project tree.
3. Choose **Trust workspace** when you know the source and want language servers and native format or lint tools to run.

New folders start with automatic project tools off. You can browse, edit, and save without trust. Built-in JSON, HTML, CSS, and Markdown tools remain available. Trust applies to the current open session, so opening the folder again asks for a new decision.

Language servers and project tools run with your permissions. Rust build scripts or Ruby configuration can execute code. Trust does not sandbox a project or a terminal command you choose to run.

## Connect a model {#models}

1. Open **Model providers**, or use **Manage model connections** in the command palette.
2. Add a provider profile, choose its endpoint and authentication method, and set the model IDs, output limit, and supported reasoning choices.
3. Save the profile, then choose its model and effort in chat. Discovery offers model choices when the provider supports it; configured model IDs remain usable.

Table: Model connection choices

| Connection | Setup |
| --- | --- |
| OpenAI-compatible API | Use an API key, a named environment variable, or a key-free local endpoint. Remote endpoints require HTTPS; HTTP is allowed only on loopback addresses. |
| OpenAI Responses | The native OpenAI endpoint uses the shared Responses transport. API keys use native credential storage. |
| ChatGPT subscription | For the native OpenAI endpoint, choose ChatGPT subscription, finish browser sign-in, and select the account before saving the profile. |
| Anthropic | Use an Anthropic profile with an API key and explicit model. Native Claude subscription login is not available through this auth flow. |

Saved API keys use the macOS Keychain; a profile can instead name an environment variable supplied to the app process. Local endpoints can run without a key. ChatGPT credentials stay in the shared auth engine's private native store. The interface receives key availability and public account status, never stored secrets. The auth engine owns subscription sign-in, renewal and sign-out. Other OpenAI-compatible endpoints use Chat Completions. Exact plan limits and charges stay with the provider.

Send a small request when you are ready to use your provider. A request can incur usage under that provider's terms. Stop an active response before changing connections or chats.

If a saved key is unavailable, check the selected profile and unlock macOS Keychain before retrying. For an environment-backed key, confirm the variable reaches the desktop process. For a subscription failure, inspect the account's displayed state and sign in again when required. Preserve original credential files and key records while diagnosing a failure; deleting them can prevent recovery. See [provider storage and authentication](https://github.com/ejmlabs/ejm-ide/blob/main/docs/harness.md) for the current contract.

## Work in the editor {#editor}

Source views, read-only diffs, and Markdown previews share the main editor. Split the editor right from its toolbar or choose **Split down** from a group menu. Drag a tab between groups or move it from its tab menu. Source views share a buffer while each group keeps its active tab and cursor.

Table: Useful keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| ⌘ K / Ctrl K | Search files and commands. |
| ⌘ P / Ctrl P | Go to a file. |
| F12 / ⇧ F12 | Go to a definition / find references, when the server supports them. |
| ⌘ ⌥ H / Ctrl Alt H | Open call hierarchy for the selected function. |
| ⌘ L / Ctrl L | Add the selected code to chat. |
| ⌘ S / Ctrl S | Save the current buffer. |
| Tab / Escape | Accept / dismiss an inline prediction. |

Double click an empty tab strip for an untitled buffer. Save it to a new path inside the workspace; its parent folder must exist. A failed save keeps the draft open and never overwrites an existing destination. Format and lint on save have separate controls in Preferences and start enabled. Native project tools also need trust.

Use hover for signatures and documentation. The call hierarchy follows the cursor and unsaved buffer. It starts two levels deep with at most 40 new symbols; **More callers** or **More callees** reveals up to 20 more. Dashed or inferred links come from the local index and can be incomplete. Use **All links** to inspect the same revealed relationships as a list.

Open Markdown preview from the editor tab bar. It renders the live buffer, supports GFM tables and task lists, and links headings back to source. Raw HTML is skipped; images stay labelled placeholders without fetching their URLs.

Preferences offers System, Light, and Dark. The editor follows the selected theme.

These shortcuts describe the current macOS target. Windows and Linux support has not been established by the native release checks.

The desktop **Terminal** is a command runner: enter a command for the current workspace and read its output and exit code when it finishes. Use **Add terminal output to chat** for selected output or retained history. Commands run with your permissions, so inspect them before running them. Commands time out after 30 seconds and capture at most 512 KiB per stream. Interactive prompts and PTY sessions are not supported. This is not a filesystem or network sandbox.

To try a local panel, open **Extensions**, create **Sample notebook**, then choose **Build and preview** and **Enable**. Reload activates a later checked build; Disable unloads it and Revert restores the prior enabled version. See [Local extensions](https://github.com/ejmlabs/ejm-ide/blob/main/docs/extensions.md) for capabilities and limits.

## Work with Edi {#edi}

1. Open chat and describe the result you want. Select code and press **⌘ L**, drag a search result, or choose **Add to chat** from a pane when specific source matters.
2. Inspect each attachment's preview. It captures a source version, including unsaved editor text. If the source changes, update the attachment or keep the earlier snapshot deliberately.
3. Send the request. Expand tool rows to see arguments, results, progress, and failures. File-write rows retain their captured before-and-after diffs.
4. Inspect the changed source and run the project's checks before committing.

**Automatic review is the fixed policy.** Each proposed file write receives a separate model review with no tools. A valid approval still has to pass workspace, active-turn, path, and saved-version checks. A rejection, timeout, invalid decision, or stale version leaves the file unchanged. Edi has no shell or external-action tool.

The local index stays on your machine until source is attached or returned by a tool to the model. Inline predictions send nearby code to the selected provider while enabled; they have no tools. Press **⌘ ⌥ Space** to request one, or disable predictions in Preferences.

Chat history is local to the current workspace. Search, resume, rename, archive, or restore chats from history. Stop a running response before switching. Reported context and token use appear in the composer; missing values stay unknown and exact dollar charges are unavailable.

For a failure, open **Debug > Traces**. Follow the turn through model calls, tools, and review; select a span for retained requests, responses, and errors. Debug capture stays in local memory and is lost when the app exits. Saved chat content has separate persistence. Copy and Download are local actions; inspect exports for private source before sharing them. See [Harness and Debug](https://github.com/ejmlabs/ejm-ide/blob/main/docs/harness.md) for capture and retention details.

## Review Git changes {#git}

1. Open **Source control** and inspect staged and unstaged groups. A partially staged file can appear in both.
2. Select a file for a read-only Monaco diff. Switch inline or side-by-side, then stage or unstage the changes you intend to include.
3. Choose **Commit staged**. Git hooks and signing still run. If HEAD or the staged snapshot changed, refresh and review it before committing.

**History** offers a paginated commit graph, author and message search, branch and tag labels, and changed-file statistics. File history and Blame follow the active editor; blame includes unsaved text. **Compare** accepts branches, tags, or commit IDs and shows the merge base, ahead/behind counts, and changed files.

Use **Add to chat** on a commit, diff, comparison, or blame view to preserve that Git context for Edi. Git uses your installed Git CLI and stays inside the opened workspace. Remote operations, branch checkout, rebase, stash, and hosted pull-request integration are not included.

## Set up languages {#languages}

Open the project root, install its normal dependencies, then trust the workspace. A server starts when you open the first file for its language. Features follow the server's advertised capabilities.

Table: Language tools

| Language | Tools |
| --- | --- |
| Rust | **Insight:** Install rust-analyzer. **Format and lint:** rustfmt and Cargo Clippy; set up project dependencies first. |
| Python | **Insight:** Bundled Pyright needs Node.js. **Format and lint:** Install Ruff for format and lint. |
| TypeScript / JavaScript | **Insight:** Bundled TypeScript Language Server needs Node.js. **Format and lint:** Bundled Biome. |
| Ruby | **Insight:** Install Ruby LSP and a current Ruby. **Format and lint:** Project formatter bundle plus a RuboCop executable for saved-file lint. |
| Go | **Insight:** Install gopls and Go. **Format and lint:** gofmt and gopls diagnostics. |
| Markdown | **Insight:** Bundled outline and source index. **Format and lint:** Bundled remark and remark-lint. |

JSON, JSONC, HTML, CSS, SCSS, and Less have bundled services. Other common text and config files have syntax highlighting; that alone does not provide semantic navigation or validation. Ruby LSP does not advertise call hierarchy, so Ruby graph links use the local index and say they are inferred.

Installed Node.js 24 is required for bundled Python/TypeScript servers and extension builds. The [language reference](https://github.com/ejmlabs/ejm-ide/blob/main/docs/languages.md) contains installation commands, Ruby bundle setup, executable search paths and absolute-path overrides such as `EJM_IDE_RUST_LSP`.

## Know the limits {#limits}

Table: Current limits and boundaries

| Area | Limit or boundary |
| --- | --- |
| Platform | Apple Silicon macOS is the current target. Other platforms need native implementation and acceptance work. See [platform requirements](/docs/developer-guide/#platforms) and [installer status](/download/). |
| Editor files | Regular UTF-8 files up to 2 MiB, within the workspace path rules. Binary files and unsafe paths are rejected. |
| Edi file tools | Regular UTF-8 files up to 128 KiB. Creates need an existing parent; updates need the exact saved version. |
| Call graphs | Static relationships can be partial, inferred, ambiguous, or stale. A completed crawl does not prove every runtime call. |
| Git history | Older commits load in pages, up to 600 per view. Large and binary diff previews state their limits. |
| Debug capture | 128 MiB total, 32 MiB per content item; redaction, truncation, and eviction are marked. |
| Program debugging | Debug inspects the IDE and agent runtime. Source breakpoints and stepping need a language debugger. |

## Troubleshoot a problem {#troubleshooting}

- **A clone fails or the native app cannot build.** Check the repository URL and network connection. Check Node 24, Rust, Tauri prerequisites, and compatible sibling `ejm-harness` and `ejm-ui` revisions. Read the first failing command, then follow the [verification guide](/docs/developer-guide/#verification).
- **A language feature or formatter is missing.** Confirm the project root is open and trusted, its dependencies are ready, and the required executable is installed. Inspect Problems and Debug. A server may not support the requested feature; use the language reference for overrides.
- **Edi cannot connect or a model fails.** Check the selected connection, endpoint, account or key availability, model ID, and provider access. Inspect the failed span in Debug. Reconnect after a transport failure; retry a model request deliberately after addressing authentication or provider limits.
- **A save or Edi write is rejected.** Keep the open draft. Check the path, file size, existing destination, and source version. A stale write preserves newer source; reread it before proposing another update. If a file is locked or read-only, release the other app's lock or restore the intended write permission, then retry.
- **A download is unavailable.** Check the [download status](/download/). **In development** means the validated release list has no installer for that platform. **Not checked**, **Checking**, or **Status unavailable** means availability is still unknown; enable JavaScript or choose **Try again** after a failed check. On Mac, choose Apple Silicon or Intel to match your computer; the site does not detect its CPU. Refresh if a previously selected digest has become stale; do not replace a missing release with a debug bundle.

For a reproducible defect, use [Support](https://github.com/ejmlabs/ejm-ide/blob/main/SUPPORT.md) and include the app/source revision, platform, steps, and a small safe example. Use [the private security route](https://github.com/ejmlabs/ejm-ide/blob/main/SECURITY.md) for vulnerabilities. Remove credentials and private content before sharing diagnostic exports.
