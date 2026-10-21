---
title: Documentation
description: Learn to use ejm-ide and Edi, set up a source build, or contribute to the desktop editor.
lead: Use the editor, work with Edi, or help build ejm-ide. Start with the guide for the work you want to do.
group: Start
---

## Start here {#start}

ejm-ide is an MIT-licensed open-source desktop editor with Edi beside your source. Start with the [example session](/#try) or [build from source](/docs/user-guide/#setup). The setup guide covers pinned shared dependencies and the current Apple Silicon macOS target.

> **Note:** The [example session](/#try) runs locally in your browser without a model connection. The app's browser preview uses read-only sample data for native services. Neither provides native saving, Git writes, provider sign-in, or terminal execution.

Check the [download page](/download/) for verified installers. A platform marked **In development** has no published installer. A source archive is not a signed desktop release.

Read [website privacy](https://ejmlabs.com/privacy/) for this site's visit counts and theme choice. Native provider credentials and model traffic are covered separately in the [model connection guide](/docs/user-guide/#models) and your provider's terms.

## Use the IDE {#user}

The [user guide](/docs/user-guide/) walks through a source build and your first project, then covers the tasks you use each day:

- [Open a project and decide whether to trust it.](/docs/user-guide/#workspace)
- [Connect a model with a subscription, API key, or local endpoint.](/docs/user-guide/#models)
- [Navigate source, split editors, and add context to chat.](/docs/user-guide/#editor)
- [Work with Edi and inspect automatic review.](/docs/user-guide/#edi)
- [Review changes and commit staged files.](/docs/user-guide/#git)
- [Diagnose connection, language, save, and release problems.](/docs/user-guide/#troubleshooting)

## Build the IDE {#developer}

The [developer guide](/docs/developer-guide/) explains the React interface, native Rust host, and shared ejm-harness engine. It covers local setup, code layout, checks, agent tools, extensions, the website and releases.

If you are building an agent client rather than an editor, start with [ejm-harness documentation](https://harness.ejmlabs.com/docs/). For a terminal workflow, read the [ejm-cli documentation](https://cli.ejmlabs.com/docs/).

## Find a reference {#reference}

Detailed guides live in the [open-source repository](https://github.com/ejmlabs/ejm-ide). Read the [contribution guide](https://github.com/ejmlabs/ejm-ide/blob/main/CONTRIBUTING.md) before opening a pull request, or [report an issue](https://github.com/ejmlabs/ejm-ide/issues) with the platform and steps to reproduce it.

Table: Source guides

| Guide | What it covers |
| --- | --- |
| Languages | Server setup, executable overrides, formatting, and capability limits. Read [docs/languages.md](https://github.com/ejmlabs/ejm-ide/blob/main/docs/languages.md). |
| Index and context | Local search, evidence labels, freshness, and attached source. Read [docs/indexing.md](https://github.com/ejmlabs/ejm-ide/blob/main/docs/indexing.md). |
| Agent tools | File access, automatic review, and chat displays. Read [docs/agent-tools.md](https://github.com/ejmlabs/ejm-ide/blob/main/docs/agent-tools.md). |
| Harness and Debug | Execution, saved chats, traces, capture, and retention. Read [docs/harness.md](https://github.com/ejmlabs/ejm-ide/blob/main/docs/harness.md). |
| Extensions | Panel capabilities, versions, builds, and isolation. Read [docs/extensions.md](https://github.com/ejmlabs/ejm-ide/blob/main/docs/extensions.md). |
| Distribution | Website hosting, release manifests, and native release gates. Read [docs/distribution.md](https://github.com/ejmlabs/ejm-ide/blob/main/docs/distribution.md). |

For help, use [Support](https://github.com/ejmlabs/ejm-ide/blob/main/SUPPORT.md). Report vulnerabilities through [Security](https://github.com/ejmlabs/ejm-ide/blob/main/SECURITY.md); keep keys and private workspace content out of public reports.
