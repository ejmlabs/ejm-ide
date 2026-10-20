# Language support

ejm-ide uses language servers for code insight and a configured model provider
for chat and inline predictions. Open the project root so the language server can read its build and
dependency files. After you grant **Trust workspace**, a server starts when you
open the first file for its language. Trust lasts for the current open session.

Language servers, native formatters, and linters run with your permissions and
can execute project code. Rust tools may run build scripts and procedural macros;
Ruby tools may load code from project configuration. Offline or locked dependency
flags do not prevent this execution. Newly opened folders keep these tools off
until you trust the selected canonical root. Browsing, editing, saving, syntax
highlighting, and bundled JSON, HTML, CSS, and Markdown tools remain available.
Workspace trust does not sandbox explicit terminal commands or other execution
actions you request.

## Workspace changes during server startup

Language services belong to one open workspace session. Opening another folder
clears that session. Returning to the same folder starts a new session, so an
earlier pending server cannot become its active language service.

Server initialization may continue until it returns. The IDE then rejects and
releases the earlier client; this guard does not interrupt startup immediately.
If a file reports that the workspace changed before its language service
started, trust the current workspace and reopen the file to request its server.

This is unreleased source behavior. A native regression passed with a real LSP
client paused during initialization, two workspace clears, rejection through
the production publication path, and cleanup of the rejected child. Native
checks and the full repository checks passed against the exact harness pin.
The app's folder picker and manual folder-switch behavior remain unverified.
These checks do not establish a published website or installer update.

## Languages and tools

| Language | Files | Code insight | Format on save | Lint on save |
| --- | --- | --- | --- | --- |
| Rust | `.rs` | rust-analyzer | rustfmt through rust-analyzer | Cargo Clippy |
| Python | `.py`, `.pyi` | Pyright | Ruff | Ruff |
| TypeScript and JavaScript | `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` | TypeScript Language Server | Bundled Biome | Bundled Biome |
| Ruby | `.rb`, `.rake`, `.gemspec`, `.ru`, `Gemfile`, `Rakefile`, `Guardfile`, `Brewfile` | Ruby LSP | Ruby LSP with a formatter in the project bundle | RuboCop |
| Go | `.go` | gopls | gofmt | gopls diagnostics and analyzers |
| Markdown | `.md`, `.markdown` | Heading outline and local source index | remark with GFM support | remark-lint recommended rules |
| JSON and JSONC | `.json`, `.jsonc`, VS Code workspace and snippet files | Monaco JSON service | Monaco JSON formatter | Live syntax and local schema validation |
| HTML | `.html`, `.htm` | Monaco HTML completion, hover, and symbols | Monaco HTML formatter | No bundled linter |
| CSS, SCSS, and Less | `.css`, `.scss`, `.less` | Monaco CSS services | Monaco CSS formatters | Live syntax and CSS rule checks |
| Other text and config | See below | Syntax highlighting | No bundled formatter | No bundled linter |

Hover, completion, signature help, definition, references, symbols, and formatting
follow the server's advertised capabilities. The call graph uses semantic
callers and callees when the server supports them. With the hierarchy pane open,
it follows the active file and function as you move through source. Unsaved
buffers are sent to the language server before inspection. A short debounce
keeps rapid cursor movement from starting a crawl for every position.

The graph starts two levels deep, with at most 40 new symbols in its first
batch. Nodes with unexplored branches show **More callers** or **More callees**.
Click one to reveal up to 20 more symbols in that direction. The crawl retains
its frontier so wide branches can be revealed over several clicks. Shared
callees and recursive calls retain their links without repeating nodes. The
graph and its **All links** list show the same revealed relationships. Pan and
zoom controls let you inspect them without resetting the view for each batch.

Links labelled **inferred** come from the local source index and can be incomplete
or ambiguous. Indexed exploration uses the same depth and batch limits. Branch
controls stay visible while more relationships remain. Completion refers to
available static relationships, not proof of every runtime call.
The graph reports source boundaries, unsupported requests, changed files, and
index size or time limits as partial results instead of silently hiding them.

Ruby LSP 0.26.11 provides hover, completion, signature help, definition, and
references. It does not advertise call hierarchy or go to implementation. Its
formatting support depends on the project's formatter. Dynamic Ruby calls can
remain unresolved. Go's gopls provides semantic callers, callees, and
implementation lookup.

ejm-ide sends precise UTF16 edit ranges to incremental language servers. For
Ruby LSP, it refreshes document symbols once per edited revision before code
insight requests, so an unsaved method rename can update its signature and
definition without saving the file. This refresh runs when insight is requested
and does not block typing.
Ruby edits that span multiple lines reopen the server's document with the current
unsaved text. This avoids Ruby LSP's declaration-index heuristic missing a bulk
replacement that starts in a comment. The file is not written to disk.

Markdown has a live rendered preview beside the source, with heading navigation
and section attachments for chat. The preview supports tables, task lists,
and fenced code. Heading links navigate to the source; file links go through the
workspace's normal navigation. Raw HTML is skipped, and images appear as labelled
placeholders without fetching their URLs. Formatting preserves YAML frontmatter
and code block contents. Markdown tools are bundled and need no language server.

## Syntax colors

Shiki's bundled TextMate grammars provide syntax colors, including function and
type roles absent from some Monaco defaults. Where a language server advertises
semantic tokens, those tokens refine the colors. The grammar fallback does not
resolve symbols or calls.

## Common text and config files

Monaco's bundled services handle JSON, HTML, CSS, SCSS, and Less in the app.
These services need no separate runtime. JSON and CSS problems appear while you
edit. JSON schema requests over the network are disabled; schema checks use
schemas already supplied to the service.

Ordinary `.json` files use strict JSON rules. `.jsonc`, `.code-workspace`, and
`.code-snippets` files allow comments and trailing commas. The same rules apply
to `tsconfig.json`, `jsconfig.json`, their named variants, and `settings.json`,
`launch.json`, `tasks.json`, and `extensions.json` inside `.vscode`. JSON
formatting keeps comments in these files.

The following files have bundled syntax highlighting:

- YAML: `.yaml`, `.yml`.
- TOML: `.toml`, `Cargo.lock`, `Pipfile`, `poetry.lock`, `uv.lock`, and `pdm.lock`.
- Key-value config: `.ini`, `.cfg`, `.conf`, `.properties`, `.editorconfig`,
  `.gitconfig`, `.npmrc`, `.env`, and `.env.*`. Config files use the bundled INI
  grammar as an approximation.
- SQL: `.sql`.
- Shell: `.sh`, `.bash`, `.zsh`, `.ksh`, and common Bash, Zsh, and profile dotfiles.
- XML: `.xml`, `.svg`, `.xsd`, `.xsl`, `.xslt`, `.plist`.
- Docker: `Dockerfile`, `Containerfile`, their named variants, and `.dockerfile`.
- GraphQL: `.graphql`, `.gql`.

These syntax modes do not provide a semantic language server or validation.
Unknown extensions, ignore files, and other plain text still open and save.
Formatting leaves them unchanged. Opening and saving accepts UTF-8 text up to
2 MiB; binary files, unsafe paths, and links are rejected.

## Install the runtimes

Rust needs a Rust toolchain. Python needs Python for the project, plus Node.js for
Pyright. TypeScript and JavaScript also need Node.js. ejm-ide bundles the
Pyright and TypeScript Language Server packages, together with TypeScript.

Install the native tools you need:

```sh
rustup component add rust-analyzer rustfmt clippy
pipx install ruff
gem install ruby-lsp rubocop
go install golang.org/x/tools/gopls@latest
```

Use a current Ruby runtime for Ruby LSP. Install Go to provide both `go` and
`gofmt`. Install `pipx` first if you use the Python command above. ejm-ide uses
your project's existing `Cargo.toml`, `pyproject.toml`, `tsconfig.json`, `Gemfile`,
and `go.mod` settings.

For Ruby formatting, add RuboCop or Syntax Tree to the project's `Gemfile` and
run `bundle install` to update its lockfile. Ruby LSP detects the formatter from
that bundle. For example:

```ruby
group :development do
  gem "rubocop", require: false
end
```

Install a `rubocop` executable on the app's PATH as well for ejm-ide's saved-file
lint command. Ruby LSP can create a `.ruby-lsp` bundle in the workspace on first
use. A project with an unlocked `Gemfile` must run `bundle install` before the
server can start.

## Executable discovery

ejm-ide searches PATH, common Homebrew locations, `~/.local/bin`, `~/.cargo/bin`, `~/go/bin`,
`GOBIN`, `GOPATH`, `GEM_HOME`, `GEM_PATH`, and common versioned Ruby gem bins. This
also covers apps opened from Finder with a minimal PATH. Node.js discovery also
checks common fnm and nvm installations.

Use an absolute executable path to override a server. Set these variables in the
environment that launches ejm-ide:

| Variable | Executable |
| --- | --- |
| `EJM_IDE_RUST_LSP` | `rust-analyzer` |
| `EJM_IDE_PYTHON_LSP` | `pyright-langserver` or `basedpyright-langserver` |
| `EJM_IDE_TYPESCRIPT_LSP` | `typescript-language-server` |
| `EJM_IDE_RUBY_LSP` | `ruby-lsp` |
| `EJM_IDE_GO_LSP` | `gopls` |
| `WORKBENCH_NODE` | `node` for the bundled Python and TypeScript servers |

`WORKBENCH_NODE` remains a compatibility name for the bundled server runtime.

Overrides take an executable path, without command arguments. ejm-ide adds
`--stdio` for Pyright and TypeScript Language Server. Ruby LSP and gopls use their
normal stdio startup.

## Saving and diagnostics

Settings has separate **Format on save** and **Lint on save** controls. Both start
enabled. Formatting uses the current buffer. A newer edit cancels applying stale
formatter output. Lint results are attached to the saved file version and appear
in Problems. A missing tool is reported, and the file can still be saved.

Clippy runs for the nearest Cargo project with `--offline --locked --no-deps`.
The IDE owns this check; rust-analyzer's separate check on save is disabled.
Run the project's normal dependency setup first. Go uses gopls diagnostics after
save. ejm-ide sends `didSave` only when the server requests it and the saved
buffer still matches the open document version. Language-server diagnostics can
also arrive while you edit.

## Sample workspace

Open `examples/harbor` to try the five language integrations. It has small Rust,
Python, TypeScript, Ruby, and Go examples with a helper and its caller. The Go
example includes a minimal `go.mod`. Ruby code insight works without a Gemfile;
add a project formatter bundle to try Ruby formatting.

Native language-server tests need the corresponding tools installed:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --test language_servers -- --ignored --nocapture
```
