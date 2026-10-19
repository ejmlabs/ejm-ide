# Agent tools and chat displays

The agent works in the same workspace as the editor. ejm-ide registers these
native tools with the shared ejm-harness.

| Tool | Purpose |
| --- | --- |
| `workbench_search_code` | Search the shared local code index. |
| `workbench_code_neighbors` | Traverse all indexed caller or callee branches through continuation pages. |
| `workbench_read_file` | Read a saved UTF-8 file and its source version. |
| `workbench_write_file` | Propose an exact file create or update for automatic review. |
| `workbench_show_ui` | Show Markdown, callouts, tables, charts, or diagrams in chat. |
| `workbench_open_file` | Open a workspace file and reveal a line and column. |
| `workbench_highlight_code` | Reveal and highlight a source range without editing it. |
| `workbench_show_hint` | Place a temporary hint over Project, Editor, Chat, Search, or Tools. |
| `workbench_clear_presentation` | Clear selected displays, highlights, and hints, or clear all of them. |

The `workbench_` API names remain stable across the product rename. Tools use
closed schemas. They are bound to the workspace, chat, and active turn, with
argument, concurrency, timeout, and output limits.

## File access and review

File tools accept regular UTF-8 files up to 128 KiB. Paths stay within the
captured workspace. Git metadata, symbolic links, special files, parent
traversal, and paths outside the workspace are rejected.

Updates require the exact `expectedVersion` returned by `workbench_read_file`.
Creates require explicit `expectedVersion: null` and an existing parent folder.
Every proposal receives automatic review through a separate model request with
no tools. Only a valid approval can proceed to application. The host then checks
the workspace, turn, and saved version again. A stale update or existing create
destination is preserved. Writes are not retried automatically.

Successful writes return the new version and a before/after record for the
inline chat diff. Source content and comments remain untrusted data.

## Navigation and graph tools

Navigation uses one-based lines and UTF-16 columns. Ranges end immediately after
the last character to include. The host reads the saved file and checks its hash;
the editor rejects an action if its buffer differs from that version. Tool
success requires an acknowledgement from the current IDE window. A closed
workspace, expired turn, or changed source causes a rejected action.

Code graph requests use a symbol ID from `workbench_search_code` and an optional
`incoming`, `outgoing`, or `both` direction. Each page contains at most 29 edges.
Repeat the same symbol and direction with `cursor: nextCursor` until the cursor
is null. Traversal handles cycles, shared descendants, and arbitrary depth.
`both` follows ancestors and descendants separately.

The result reports `generation`, `traversalComplete`, `indexLimited`, `stale`,
and `skippedStale`. Inferred and ambiguous relationships retain their evidence
labels. A finished traversal covers available indexed links, with external
dependencies and dynamic calls still possible boundaries. A changed workspace,
index generation, or verified evidence invalidates the continuation. Start
again without a cursor after such a change.

## Chat block kit

A display has an ID, a title, and up to 12 blocks. Reusing an ID replaces its
display. The full payload is limited to 128 KiB.

- **Markdown** supports GFM text. Raw HTML is skipped, and images are inert.
- **Callouts** use an information, success, or warning tone.
- **Tables** have up to 8 columns and 100 rows of scalar values.
- **Charts** use bars or lines, with up to 4 series and 100 data points. Missing
  values are gaps. A data table keeps the values accessible.
- **Diagrams** have up to 40 labelled nodes and 80 directed edges, arranged from
  left to right or top to bottom. Text relationships remain available.

Each display has Add to chat and Dismiss controls. Add to chat captures its block
data through the same reference system used by source selections and search
results. Hints can be closed with Escape or their close button, and expire after
30 seconds. Source highlights do not modify or save code.

## Tool activity

Tool calls appear as compact rows in the conversation. Expand a row to inspect
its arguments and result. The row shows running, completed, failed, or stopped.
File writes include their captured diff and actual result inside that row.
Output is bounded to keep a large result from overwhelming the chat.

Automatic review and workspace checks govern file writes. Display tools provide
declarative content and navigation. They cannot run scripts or click arbitrary
controls. Inline Tab predictions have no tools and do not add activity rows to
the conversation.
