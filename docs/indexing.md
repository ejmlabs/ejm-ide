# Index and shared context

ejm-ide keeps a local SQLite index for each canonical workspace. It stores
source chunks, Tree-sitter symbols, and call links. The database lives in the
app cache outside the project.

Markdown files also contribute parsed heading symbols and document sections.
Fenced code and frontmatter do not become headings.

## Find code

Search combines SQLite FTS5 BM25 text ranking with symbol and path matches using
reciprocal rank fusion. A graph anchor can boost nearby results. This supports
code identifiers and descriptive text without a remote embedding service.

Tree-sitter parses Rust, Python, TypeScript, TSX, JavaScript, Ruby, and Go. It
extracts structural names even before a file opens. Calls found by syntax are
**inferred**. A name with several possible targets stays **ambiguous**. The IDE
can record language-server call results as **verified** only when their source
versions still match the saved files.

Inferred call candidates stay within their language family. JavaScript and
TypeScript share a family. Markdown headings have no inferred call edges.

Open a result to jump to source. Use its graph action to explore callers and
callees. The visible graph starts two levels deep, with at most 40 new symbols.
**More callers** and **More callees** reveal up to 20 more symbols per click.
Unexplored branches keep their controls until their frontier is exhausted.
Ancestors and descendants are traversed separately,
so another branch from an ancestor does not become a descendant of the selected
function. Cycles and shared descendants retain their links without repeating
nodes. Dashed edges show inferred links; ambiguous edges also carry a label.
Use Add to chat or drag the result into chat to share its captured snippet.

The host exposes `index_traverse` with a symbol ID, direction, and optional
continuation cursor. It returns up to 250 edges per page, source versions,
`generation`, `nextCursor`, `traversalComplete`, `indexLimited`, `stale`, and
`skippedStale`. Follow each cursor with the same symbol and direction until it
is null. A continuation is bound to its workspace, root symbol, direction,
index generation, reachable source hashes, and recorded evidence revision. A
refresh or new verified evidence requires a fresh traversal. Changed source files are pruned before
reachability is computed, so fresh descendants cannot appear through a stale
middle function. `index_neighbors` remains available for single-step navigation.

The IDE uses `direct: true` to page through a node's immediate relationships
before it follows the next level. This mode is bound into the continuation
cursor. The agent's graph tool keeps the full transitive traversal contract.

`index_symbol_at` resolves an absolute workspace path and a zero-based UTF-16
position to the smallest enclosing saved function or method. It returns no
symbol when the indexed version differs from the file. Unsaved editor buffers
use the language server instead.

Semantic crawls can share verified internal links with the index through
`index_record_graph` relation batches. Each batch accepts up to 128 links and
256 saved source versions, and 4,096 source ranges. A single dense link can use
that range budget. Every endpoint and caller range must still match
the saved index. A root in an external dependency does not prevent its verified
internal relationships from being recorded. Legacy incoming and outgoing
batches retain their root-adjacency checks.
`index_source_versions` supplies the saved indexed URI-to-hash map for this
validation, including files that have not been opened in an editor tab.

## Freshness and limits

Refresh checks file hashes and reparses changed files. Saves and completed
agent turns refresh the index. The Search header also has a refresh action for
changes made by other applications. Indexing follows ignore rules and omits
dependencies, build output, hidden files, and local ejm-ide state.

The index bounds individual files at 2 MiB, total source at 64 MiB, and traversal
at 10,000 files. Parsing, records, and refresh time also have limits. Search
reports a limited index rather than claiming complete coverage.

Each hit includes the captured file hash, URI, range, and source text. Opening a
stale chat reference shows its snapshot. Graph navigation checks saved versions
before using old positions. Unsaved editor content is attached directly from
the buffer; the persistent index describes saved files.

On Unix, traversal pages reuse a checked hash only while the file's canonical
workspace path, device, inode, size, modification time, and change time match.
Changed metadata triggers a new hash through the workspace capability reader.
The memo is separate for each workspace and holds at most 10,000 files.
Other platforms rehash reachable source files on each page.

`traversalComplete` means the available indexed relationships were exhausted
without stale links. It does not override `indexLimited` or prove whole-program
coverage. Stale links are counted and omitted. Ignored files, external package
sources, unresolved calls, and unsupported language-server actions can leave
boundaries in the graph.

## Agent tools

The agent uses the same index through read-only tools registered with ejm-harness
by the IDE. Search results and graph links retain their versions and
evidence labels. Tool requests are bound to the active chat and workspace, with
argument, concurrency, time, and output limits. The private Tab-completion
runtime has no index tools.

`workbench_code_neighbors` follows transitive branches through the same
traversal. Its pages contain at most 29 edges. The agent follows `nextCursor` to
continue, and receives the same coverage and freshness fields as the IDE.

Indexing runs locally. A tool result shares its source text with the configured
model provider. Indexed comments and documentation remain source data, not
instructions to the agent.

The graph records observed call links. It is not a whole-program proof. Dynamic
dispatch, generated code, macros, imports, and same-name methods can leave
inferred links incomplete or ambiguous. Language-server navigation remains
available for semantic answers.
