# ejm-harness in ejm-ide

The IDE uses the shared `ejm-harness` Rust crate for agent execution. The
source dependency lives in the sibling `ejm-harness` checkout, at
`../../ejm-harness/crates/ejm-harness` relative to `src-tauri`.

## Ownership

| Layer | Owns |
| --- | --- |
| ejm-harness | Agent loop, shared resource governor, tool schemas, canonical messages and events, context/repeat/step limits, and cancellation |
| Shared Responses/auth | Native OpenAI transport, stateless reasoning continuation, ChatGPT login and renewal |
| IDE provider adapter | Profile/account selection, per-send model and effort, diagnostic projection, detailed usage, and temporary compatibility transports |
| IDE tool host | Workspace access, reviewed file proposals, navigation, source highlights, chat displays, and interface acknowledgements |
| IDE chat store | Workspace chat titles, archive state, rich tool records, file diffs, and context references |
| IDE diagnostics | Causal traces, span waterfalls, bounded local payload capture, active work, measured timing, transfers, limits, and failures |

The IDE supplies a `Provider` implementation and registers its tools through the
shared harness contract. Model and effort may change for a new send while the
same harness session retains its canonical history. The IDE publishes chat and presentation events from its provider and tool
adapters while the shared engine journals canonical execution events.

Provider credentials stay in native code. macOS Keychain stores saved keys; a
profile may instead name an environment variable. Frontend state and diagnostic
exports do not receive those secrets. Native OpenAI profiles can instead bind
to a ChatGPT registration. The shared `ejm-harness-auth::AuthEngine` and supplied
`FileStore` own token exchange, renewal, rotation, and logout. The IDE supplies
an axum loopback callback listener, browser launch, account controls, cancellation,
and a ten-minute flow deadline. Authorization URLs, callbacks, codes, and tokens
never enter frontend state or Debug.

Native OpenAI uses shared `ResponsesProvider` at the validated canonical public
`https://api.openai.com/v1` base. API keys and subscription credentials take the
same route with `store: false`; custom compatible endpoints retain Chat
Completions. Each call preserves the selected model and effort. Opaque encrypted
reasoning is replayed only in the same provider/account/model binding. Optional
usage detail remains unknown when absent and is included in the token totals.
Anthropic API keys remain supported. The shared auth contract does not provide
a native Anthropic subscription credential source.

Responses HTTP observations enter a bounded 16-record nonblocking queue before
local storage/UI work. Request bodies, allowlisted response headers, decoded SSE
payloads, error bodies, and finish markers remain inspectable. A full queue
reports dropped records. Stopping or timing out a call drains queued records
and marks its remaining capture incomplete. Its byte counts cover decoded payloads, exclude SSE
framing and transfer overhead, and become partial if records are dropped.
Catalog diagnostics label their validated projection because the shared catalog
API does not currently expose raw HTTP observation.

The current shared Responses bounds are 64 KiB text, 64 KiB continuation,
16 tool calls, 64 output items, 512 KiB per buffered SSE field, 32 MiB of
aggregate SSE body input, and 100,000 decoded events. Body limits include
ignored progress, comments, and framing. Reported cached and reasoning tokens
cannot exceed their input and output totals. Limits and provider errors are surfaced; the IDE does not silently lower effort or switch
models. See [the package audit](package-audit.md) for compatibility gaps that
prevent replacing every local protocol adapter yet.

## Runtime boundaries

A run belongs to a canonical workspace and chat. Every IDE tool checks its
captured workspace and turn identity. Cancellation and workspace changes make
late tool results invalid. Inline predictions expose no tools and use their
own cancellation scope.

ejm-harness owns resource admission, bounded context preparation, tool schema
validation, repeat detection, step limits, and durable execution events. The
IDE's HTTP adapter bounds streaming frames, input, output, and event counts.
Requests have deadlines. Uncertain writes are not retried automatically.

The tool catalog derives from registered definitions. Adding an IDE tool needs
a declared schema and a native implementation. Model responses cannot register
new capabilities. The same catalog supplies the model and Debug.

## Automatic review

A file write first becomes an exact proposal containing the path, prior
content, replacement content, and saved source version. A separate model request
with no tools must return a valid approval decision. Rejection, timeout, or an
invalid decision leaves the file unchanged.

Approval alone cannot publish a write. The host rechecks the selected workspace,
turn, path, and source version. Creates cannot overwrite an existing file.
Updates preserve concurrent edits by rejecting a stale version. These are
application save checks, not an operating-system sandbox or a cross-process
filesystem transaction.

UI extensions retain their own host capabilities. See
[Local extensions](extensions.md) and [Agent tools](agent-tools.md).

## Persistence and diagnostics

The shared harness persists canonical messages and execution events. The IDE
also stores the rich chat records needed for source references, tool results,
and inline diffs. These local history records contain conversation content.
They are separate from the Debug report.

Debug opens with **Traces**, a waterfall of nested spans on a shared time axis.
A chat turn links its model calls, the tools each call produced, and automatic
review. Inline completion and model discovery have their own traces. Saves,
formatting, linting, language requests, index operations, and Git commands also
record traces. These independent IDE commands are root spans; their timing does
not imply a parent relationship.

Rust span ancestry uses `tracing` with a private `tracing-subscriber` Registry
and a small local layer. The layer projects registered spans into the bounded
Debug store. Persistent Debug IDs are separate from reusable Registry IDs.
Completion is explicit because causal contexts can outlive the operation that
created them. The collector installs no global subscriber and puts no payloads
or credentials in trace fields. Full content remains in the local capture store.

Select a trace, search its spans, filter errors, and expand or collapse branches.
Zoom or fit the waterfall, use the arrow keys to navigate, and press Enter to
inspect a span. The inspector shows the trace ID, parent, start offset, duration,
and self time. Self time subtracts the union of retained descendant intervals
within the selected span, so overlapping work is counted once. Missing parents
and dropped spans are marked. Timings use a monotonic clock.

The Activity view retains the event timeline. Select an activity or span to
inspect its request body, response or SSE stream, tool arguments and result, or
raw error. Records also show operation names, connection IDs where applicable,
lifecycle states, timestamps, measured durations, byte counts, registered tools,
and configured runtime limits. Running local operations appear as IDE work even
when they have no provider connection.

Credential values are replaced with explicit redaction markers before captured
content is shown or exported. Each content block reports its redaction count,
original byte count, and bytes omitted by the capture limit. Evicted or
unavailable content has a reason; any retained parts remain available to
inspect.

Native capture has these bounds:

| Bound | Limit |
| --- | --- |
| Total captured content | 128 MiB |
| Individual content item | 32 MiB |
| Activities with captured content | 400 |
| Completed spans | 400 |
| Running spans | 96 |
| Timeline events | 400 |

Content that exceeds an item limit is truncated with an omitted-byte count.
Older content is evicted when the total storage or activity limit is reached.
These limits apply to Debug capture, separately from agent execution limits.

Debug polls only while visible and live, with one snapshot request in flight.
Snapshot polls return metadata and the capture summary. Selected activity
content loads lazily. Each content block has a Copy action. Copy diagnostics
and Download fetch retained activity details on demand and export their full
captured content with the redaction, truncation, and availability markers.
Exports preserve every supplied snapshot and content field, including future
metadata.

No diagnostic telemetry or captured content is uploaded. Copy and Download are
local user actions. Debug records are lost when the app exits; shared harness
and chat persistence remain separate.

Pause freezes the view. Clear removes the timeline, completed spans, and all
retained content while totals and running work continue. Retention counts show
dropped spans, dropped events, and evicted content. Exports include the retained
span graph and payloads. Browser preview uses labelled sample records; native
errors remain errors.

## Troubleshooting

1. Open Debug and reproduce the issue.
2. Select the trace and inspect its failed or long-running span.
3. Check the provider profile, connection state, and applicable runtime limit.
4. Inspect the captured content and its redaction or retention markers, then
   copy or download the diagnostics needed to investigate.

Debug inspects the IDE and agent runtime. Source breakpoints and program stepping
need a language debugger.

## Design sources

DeepSeek's harness provides useful examples of an agent contract, driver,
session events, tool registry, and scoped registration lifetimes. Its tool
pipeline separates validation, policy, execution, and observation.

Sources inspected October 18, 2026:

- [Core package map](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/README.md)
- [Tool registry and execution](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md)
- [Scoped registrations](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/scope/README.md)

Performance claims need measurements on representative projects. Tests use
local fixtures and replay responses; hosted model calls need separate evidence.
