use aho_corasick::{AhoCorasick, BuildError, MatchKind};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::{Arc, Mutex},
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{State, WebviewWindow};

mod trace;

const EVENT_CAPACITY: usize = 400;
const ACTIVITY_CAPACITY: usize = 96;
const COMPLETED_SPAN_CAPACITY: usize = 400;
const CONNECTION_CAPACITY: usize = 16;
const CAPTURE_MAX_BYTES: usize = 128 * 1024 * 1024;
const CAPTURE_MAX_CONTENT_BYTES: usize = 32 * 1024 * 1024;
const CREDENTIAL_MARKER: &str = "[REDACTED credential]";

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ToolKind {
    Index,
    Presentation,
    File,
}

#[derive(Serialize)]
pub(crate) struct ToolDescription {
    pub(crate) name: &'static str,
    pub(crate) kind: ToolKind,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ConnectionKind {
    Control,
    Chat,
    Completion,
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ActivityKind {
    Request,
    Turn,
    Tool,
    Operation,
}

#[derive(Clone, Copy)]
pub(crate) enum Outcome {
    Completed,
    Failed(&'static str),
    Cancelled,
}

impl Outcome {
    pub(crate) fn error(error: &str) -> Self {
        let error = error.to_ascii_lowercase();
        if error.contains("cancel") || error.contains("turn ended") || error.contains("changed") {
            Self::Cancelled
        } else if error.contains("timed out")
            || error.contains("timeout")
            || error.contains("time limit")
        {
            Self::Failed("timeout")
        } else if error.contains("limit") || error.contains("too many") {
            Self::Failed("limit")
        } else if error.contains("disconnected") || error.contains("exited") {
            Self::Failed("disconnected")
        } else if error.contains("could not start") || error.contains("not found") {
            Self::Failed("unavailable")
        } else if error.contains("frame") || error.contains("invalid") || error.contains("json") {
            Self::Failed("protocol_error")
        } else {
            Self::Failed("rejected")
        }
    }

    fn phase(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed(_) => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    fn code(self) -> Option<&'static str> {
        match self {
            Self::Completed => None,
            Self::Failed(code) => Some(code),
            Self::Cancelled => Some("cancelled"),
        }
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Counters {
    connections_opened: u64,
    connections_closed: u64,
    requests_started: u64,
    requests_completed: u64,
    requests_failed: u64,
    requests_cancelled: u64,
    turns_started: u64,
    turns_completed: u64,
    turns_failed: u64,
    turns_cancelled: u64,
    tools_started: u64,
    tools_completed: u64,
    tools_failed: u64,
    tools_cancelled: u64,
    bytes_sent: u64,
    bytes_received: u64,
    notifications_received: u64,
}

impl Counters {
    fn start(&mut self, kind: ActivityKind) {
        *match kind {
            ActivityKind::Request => &mut self.requests_started,
            ActivityKind::Turn => &mut self.turns_started,
            ActivityKind::Tool => &mut self.tools_started,
            ActivityKind::Operation => return,
        } += 1;
    }

    fn finish(&mut self, kind: ActivityKind, outcome: Outcome) {
        *match (kind, outcome) {
            (ActivityKind::Request, Outcome::Completed) => &mut self.requests_completed,
            (ActivityKind::Request, Outcome::Failed(_)) => &mut self.requests_failed,
            (ActivityKind::Request, Outcome::Cancelled) => &mut self.requests_cancelled,
            (ActivityKind::Turn, Outcome::Completed) => &mut self.turns_completed,
            (ActivityKind::Turn, Outcome::Failed(_)) => &mut self.turns_failed,
            (ActivityKind::Turn, Outcome::Cancelled) => &mut self.turns_cancelled,
            (ActivityKind::Tool, Outcome::Completed) => &mut self.tools_completed,
            (ActivityKind::Tool, Outcome::Failed(_)) => &mut self.tools_failed,
            (ActivityKind::Tool, Outcome::Cancelled) => &mut self.tools_cancelled,
            (ActivityKind::Operation, _) => return,
        } += 1;
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DebugEvent {
    id: u64,
    at: u64,
    connection_id: Option<u64>,
    kind: &'static str,
    name: String,
    phase: &'static str,
    duration_ms: Option<u64>,
    bytes: Option<u64>,
    code: Option<&'static str>,
    activity_id: Option<u64>,
    detail_version: u64,
    has_content: bool,
    #[serde(skip)]
    revision: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessContent {
    text: String,
    format: &'static str,
    original_bytes: u64,
    redactions: u64,
    truncated_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessEventDetail {
    activity_id: u64,
    name: String,
    available: bool,
    reason: Option<String>,
    request: Option<HarnessContent>,
    response: Option<HarnessContent>,
    error: Option<HarnessContent>,
}

struct Credential {
    value: String,
    prefix: Vec<usize>,
}

impl Credential {
    fn new(value: &str) -> Self {
        let bytes = value.as_bytes();
        let mut prefix = vec![0; bytes.len()];
        for index in 1..bytes.len() {
            let mut matched = prefix[index - 1];
            while matched > 0 && bytes[index] != bytes[matched] {
                matched = prefix[matched - 1];
            }
            if bytes[index] == bytes[matched] {
                matched += 1;
            }
            prefix[index] = matched;
        }
        Self {
            value: value.to_owned(),
            prefix,
        }
    }

    // Aho-Corasick's stream API lacks leftmost-longest matching and unfinished-prefix snapshots.
    // This linear adapter withholds only a suffix that can complete a credential in the next chunk.
    fn pending_prefix(&self, text: &str) -> usize {
        let bytes = self.value.as_bytes();
        let start = text.len().saturating_sub(bytes.len().saturating_sub(1));
        let mut matched = 0;
        for byte in &text.as_bytes()[start..] {
            while matched > 0 && *byte != bytes[matched] {
                matched = self.prefix[matched - 1];
            }
            if *byte == bytes[matched] {
                matched += 1;
            }
            if matched == bytes.len() {
                matched = self.prefix[matched - 1];
            }
        }
        matched
    }

    fn stored_bytes(&self) -> usize {
        self.value.len() + self.prefix.len() * std::mem::size_of::<usize>()
    }
}

fn utf8_prefix(text: &str, max_bytes: usize) -> &str {
    let mut end = text.len().min(max_bytes);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn content_format(format: &str) -> &'static str {
    match format {
        "json" => "json",
        "sse" => "sse",
        _ => "text",
    }
}

fn credential_matcher(credentials: &[Credential]) -> Result<AhoCorasick, BuildError> {
    AhoCorasick::builder()
        .match_kind(MatchKind::LeftmostLongest)
        .build(credentials.iter().map(|credential| &credential.value))
}

// Returns the count of complete redactions and source bytes omitted by the bound.
fn append_redacted(
    text: &str,
    output: &mut String,
    matcher: Option<&AhoCorasick>,
    max_bytes: usize,
) -> (u64, usize) {
    let mut position = 0;
    let mut redactions = 0;
    let mut matches = matcher
        .into_iter()
        .flat_map(|matcher| matcher.find_iter(text));
    while position < text.len() {
        let next = matches.next();
        let plain_end = next.map_or(text.len(), |matched| matched.start());
        let plain = &text[position..plain_end];
        let retained = utf8_prefix(plain, max_bytes.saturating_sub(output.len()));
        output.push_str(retained);
        position += retained.len();
        if retained.len() < plain.len() {
            return (redactions, text.len() - position);
        }
        let Some(matched) = next else {
            break;
        };
        if CREDENTIAL_MARKER.len() > max_bytes.saturating_sub(output.len()) {
            return (redactions, text.len() - position);
        }
        output.push_str(CREDENTIAL_MARKER);
        redactions += 1;
        position = matched.end();
    }
    (redactions, 0)
}

struct CapturedContent {
    value: HarnessContent,
    // A stream chunk can end inside a known credential. Never expose that prefix.
    pending: String,
    stopped: bool,
}

impl CapturedContent {
    fn new(format: &str) -> Self {
        Self {
            value: HarnessContent {
                text: String::new(),
                format: content_format(format),
                original_bytes: 0,
                redactions: 0,
                truncated_bytes: 0,
            },
            pending: String::new(),
            stopped: false,
        }
    }

    fn append(
        &mut self,
        text: &str,
        format: &str,
        credentials: &[Credential],
        matcher: Option<&AhoCorasick>,
        limit: usize,
    ) {
        let retained_source = self
            .value
            .original_bytes
            .saturating_sub(self.value.truncated_bytes);
        self.value.original_bytes = self.value.original_bytes.saturating_add(text.len() as u64);
        self.value.format = content_format(format);
        if self.stopped {
            self.value.truncated_bytes =
                self.value.truncated_bytes.saturating_add(text.len() as u64);
            return;
        }
        let remaining =
            limit.saturating_sub(usize::try_from(retained_source).unwrap_or(usize::MAX));
        let retained = utf8_prefix(text, remaining);
        self.value.truncated_bytes += (text.len() - retained.len()) as u64;
        let mut input = std::mem::take(&mut self.pending);
        input.push_str(retained);
        let pending_bytes = credentials
            .iter()
            .map(|credential| credential.pending_prefix(&input))
            .max()
            .unwrap_or(0);
        let mut split = input.len() - pending_bytes;
        // Keep an overlapping complete match with the suffix until its longest match is known.
        if pending_bytes > 0
            && let Some(matched) = matcher.and_then(|matcher| {
                matcher
                    .find_iter(&input)
                    .find(|matched| matched.start() < split && matched.end() > split)
            })
        {
            split = matched.start();
        }
        let pending_bytes = input.len() - split;
        let (redactions, omitted) =
            append_redacted(&input[..split], &mut self.value.text, matcher, limit);
        self.value.redactions += redactions;
        self.value.truncated_bytes += omitted as u64;
        if omitted > 0 {
            self.value.truncated_bytes += pending_bytes as u64;
        } else if pending_bytes > 0 {
            let reserved = pending_bytes.max(CREDENTIAL_MARKER.len());
            if reserved <= limit.saturating_sub(self.value.text.len()) {
                self.pending.push_str(&input[split..]);
            } else {
                self.value.truncated_bytes += pending_bytes as u64;
            }
        }
        self.stopped = self.value.truncated_bytes > 0;
    }

    fn finalize(&mut self, matcher: Option<&AhoCorasick>, limit: usize) -> bool {
        if self.pending.is_empty() {
            return false;
        }
        let pending = std::mem::take(&mut self.pending);
        if self.stopped {
            // A truncated stream cannot prove that its withheld prefix is ordinary text.
            self.value.text.push_str(CREDENTIAL_MARKER);
            self.value.redactions += 1;
            return true;
        }
        let (redactions, omitted) = append_redacted(&pending, &mut self.value.text, matcher, limit);
        self.value.redactions += redactions;
        self.value.truncated_bytes += omitted as u64;
        self.stopped |= omitted > 0;
        true
    }

    fn stored_bytes(&self, matcher: Option<&AhoCorasick>) -> usize {
        if self.pending.is_empty() {
            return self.value.text.len();
        }
        // A withheld suffix can finalize into several complete redaction markers.
        let finalized_bytes = matcher.map_or(self.pending.len(), |matcher| {
            matcher
                .find_iter(&self.pending)
                .fold(self.pending.len(), |bytes, matched| {
                    bytes
                        .saturating_sub(matched.len())
                        .saturating_add(CREDENTIAL_MARKER.len())
                })
        });
        self.value.text.len()
            + self
                .pending
                .len()
                .max(CREDENTIAL_MARKER.len())
                .max(finalized_bytes)
    }

    fn snapshot(&self) -> HarnessContent {
        let mut value = self.value.clone();
        if !self.pending.is_empty() {
            value.text.push_str(CREDENTIAL_MARKER);
            value.redactions += 1;
        }
        value
    }
}

#[derive(Clone, Copy)]
enum ContentField {
    Request,
    Response,
    Error,
}

struct CapturedActivity {
    name: String,
    reason: Option<String>,
    credentials: Vec<Credential>,
    matcher: Option<AhoCorasick>,
    request: Option<CapturedContent>,
    response: Option<CapturedContent>,
    error: Option<CapturedContent>,
}

impl CapturedActivity {
    fn new(name: &str, reason: Option<String>) -> Self {
        Self {
            name: name.to_owned(),
            reason,
            credentials: Vec::new(),
            matcher: None,
            request: None,
            response: None,
            error: None,
        }
    }

    fn has_content(&self) -> bool {
        self.request.is_some() || self.response.is_some() || self.error.is_some()
    }

    fn stored_bytes(&self) -> usize {
        [&self.request, &self.response, &self.error]
            .into_iter()
            .flatten()
            .map(|content| content.stored_bytes(self.matcher.as_ref()))
            .sum::<usize>()
            + self
                .credentials
                .iter()
                .map(Credential::stored_bytes)
                .sum::<usize>()
            + self.matcher.as_ref().map_or(0, AhoCorasick::memory_usage)
    }

    fn detail(&self, activity_id: u64) -> HarnessEventDetail {
        HarnessEventDetail {
            activity_id,
            name: self.name.clone(),
            available: true,
            reason: self.reason.clone(),
            request: self.request.as_ref().map(CapturedContent::snapshot),
            response: self.response.as_ref().map(CapturedContent::snapshot),
            error: self.error.as_ref().map(CapturedContent::snapshot),
        }
    }
}

struct ContentCapture<'a> {
    field: ContentField,
    text: &'a str,
    format: &'a str,
    secrets: &'a [&'a str],
    append: bool,
}

struct CaptureStore {
    activities: BTreeMap<u64, CapturedActivity>,
    order: VecDeque<u64>,
    stored_bytes: usize,
    evicted_activities: u64,
    cleared_through: u64,
    latest_activity: u64,
    max_bytes: usize,
    max_content_bytes: usize,
    max_activities: usize,
}

impl Default for CaptureStore {
    fn default() -> Self {
        Self {
            activities: BTreeMap::new(),
            order: VecDeque::new(),
            stored_bytes: 0,
            evicted_activities: 0,
            cleared_through: 0,
            latest_activity: 0,
            max_bytes: CAPTURE_MAX_BYTES,
            max_content_bytes: CAPTURE_MAX_CONTENT_BYTES,
            max_activities: EVENT_CAPACITY,
        }
    }
}

impl CaptureStore {
    fn begin(&mut self, activity_id: u64, name: &str) -> Vec<u64> {
        self.latest_activity = self.latest_activity.max(activity_id);
        self.activities
            .insert(activity_id, CapturedActivity::new(name, None));
        self.order.push_back(activity_id);
        self.enforce_bounds()
    }

    fn resumed_reason(&self, activity_id: u64) -> String {
        if activity_id <= self.cleared_through {
            "Earlier content was cleared. Content recorded since clearing is shown.".to_owned()
        } else {
            "Earlier content was evicted at the local retention limit. New content is shown."
                .to_owned()
        }
    }

    fn record(&mut self, activity_id: u64, name: &str, capture: ContentCapture<'_>) -> Vec<u64> {
        let ContentCapture {
            field,
            text,
            format,
            secrets,
            append,
        } = capture;
        let mut activity = if let Some(activity) = self.activities.remove(&activity_id) {
            self.stored_bytes = self.stored_bytes.saturating_sub(activity.stored_bytes());
            activity
        } else {
            self.order.push_back(activity_id);
            CapturedActivity::new(name, Some(self.resumed_reason(activity_id)))
        };
        let mut credentials_changed = false;
        for secret in secrets.iter().filter(|secret| !secret.is_empty()) {
            let encoded = serde_json::to_string(secret).unwrap_or_default();
            let escaped = encoded
                .get(1..encoded.len().saturating_sub(1))
                .unwrap_or_default();
            for pattern in [*secret, escaped] {
                if !pattern.is_empty()
                    && !activity
                        .credentials
                        .iter()
                        .any(|credential| credential.value == pattern)
                {
                    activity.credentials.push(Credential::new(pattern));
                    credentials_changed = true;
                }
            }
        }
        if credentials_changed {
            match credential_matcher(&activity.credentials) {
                Ok(matcher) => activity.matcher = Some(matcher),
                Err(error) => {
                    activity.matcher = None;
                    activity.reason = Some(format!(
                        "Content could not be captured because credential redaction is unavailable: {error}"
                    ));
                }
            }
        }
        if !activity.credentials.is_empty() && activity.matcher.is_none() {
            // A matcher build failure must never fall back to storing known credentials in plain text.
            activity.request = None;
            activity.response = None;
            activity.error = None;
            self.stored_bytes += activity.stored_bytes();
            self.activities.insert(activity_id, activity);
            return self.enforce_bounds();
        }
        let content = match field {
            ContentField::Request => &mut activity.request,
            ContentField::Response => &mut activity.response,
            ContentField::Error => &mut activity.error,
        };
        if !append {
            *content = None;
        }
        let content = content.get_or_insert_with(|| CapturedContent::new(format));
        if matches!(field, ContentField::Error) && content.value.original_bytes > 0 {
            content.append(
                "
",
                format,
                &activity.credentials,
                activity.matcher.as_ref(),
                self.max_content_bytes,
            );
        }
        content.append(
            text,
            format,
            &activity.credentials,
            activity.matcher.as_ref(),
            self.max_content_bytes,
        );
        self.stored_bytes += activity.stored_bytes();
        self.activities.insert(activity_id, activity);
        self.enforce_bounds()
    }

    fn finalize(&mut self, activity_id: u64) -> bool {
        let Some(activity) = self.activities.get_mut(&activity_id) else {
            return false;
        };
        self.stored_bytes = self.stored_bytes.saturating_sub(activity.stored_bytes());
        let mut changed = false;
        for content in [
            &mut activity.request,
            &mut activity.response,
            &mut activity.error,
        ]
        .into_iter()
        .flatten()
        {
            changed |= content.finalize(activity.matcher.as_ref(), self.max_content_bytes);
        }
        self.stored_bytes += activity.stored_bytes();
        changed
    }

    fn enforce_bounds(&mut self) -> Vec<u64> {
        let mut evicted = Vec::new();
        while self.activities.len() > self.max_activities || self.stored_bytes > self.max_bytes {
            let Some(id) = self.order.pop_front() else {
                break;
            };
            if let Some(activity) = self.activities.remove(&id) {
                self.stored_bytes = self.stored_bytes.saturating_sub(activity.stored_bytes());
                self.evicted_activities += 1;
                evicted.push(id);
            }
        }
        evicted
    }

    fn clear(&mut self, through: u64) {
        self.activities.clear();
        self.order.clear();
        self.stored_bytes = 0;
        self.evicted_activities = 0;
        self.cleared_through = through;
    }

    fn detail(&self, activity_id: u64, name: String) -> HarnessEventDetail {
        if let Some(activity) = self.activities.get(&activity_id) {
            return activity.detail(activity_id);
        }
        let reason = if activity_id == 0 || activity_id > self.latest_activity {
            "This activity does not exist."
        } else if activity_id <= self.cleared_through {
            "Content was cleared from Debug."
        } else {
            "Content was evicted after local capture reached its retention limit."
        };
        HarnessEventDetail {
            activity_id,
            name,
            available: false,
            reason: Some(reason.to_owned()),
            request: None,
            response: None,
            error: None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DebugConnection {
    id: u64,
    kind: ConnectionKind,
    state: &'static str,
    opened_at: u64,
    closed_at: Option<u64>,
    requests: u64,
    bytes_sent: u64,
    bytes_received: u64,
    #[serde(skip)]
    started: Instant,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HarnessSpan {
    id: u64,
    trace_id: String,
    parent_id: Option<u64>,
    connection_id: Option<u64>,
    kind: ActivityKind,
    name: String,
    started_at: u64,
    ended_at: Option<u64>,
    duration_ms: u64,
    status: &'static str,
    code: Option<&'static str>,
    detail_version: u64,
    has_content: bool,
    #[serde(skip)]
    started: Instant,
}

impl HarnessSpan {
    fn snapshot(&self) -> Self {
        let mut span = self.clone();
        if span.status == "running" {
            span.duration_ms = milliseconds(span.started.elapsed());
        }
        span
    }
}

struct SpanClock {
    instant: Instant,
    timestamp: u64,
}

impl Default for SpanClock {
    fn default() -> Self {
        Self {
            instant: Instant::now(),
            timestamp: now(),
        }
    }
}

impl SpanClock {
    fn at(&self, instant: Instant) -> u64 {
        self.timestamp.saturating_add(milliseconds(
            instant.saturating_duration_since(self.instant),
        ))
    }
}

struct Active {
    connection_id: Option<u64>,
    kind: ActivityKind,
    name: String,
    started_at: u64,
    started: Instant,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveSnapshot {
    id: u64,
    connection_id: Option<u64>,
    kind: ActivityKind,
    name: String,
    started_at: u64,
    elapsed_ms: u64,
}

#[derive(Default)]
struct Runtime {
    cursor: u64,
    next_activity: u64,
    dropped_events: u64,
    active_omitted: u64,
    cleared_at: Option<u64>,
    counters: Counters,
    connections: BTreeMap<u64, DebugConnection>,
    active: BTreeMap<u64, Active>,
    events: VecDeque<DebugEvent>,
    capture: CaptureStore,
    detail_version: u64,
    spans: BTreeMap<u64, HarnessSpan>,
    completed_spans: VecDeque<u64>,
    dropped_spans: u64,
    clock: SpanClock,
}

impl Runtime {
    fn event(&mut self, mut event: DebugEvent) {
        self.cursor += 1;
        event.id = self.cursor;
        event.revision = self.cursor;
        if self.events.len() == EVENT_CAPACITY {
            self.events.pop_front();
            self.dropped_events += 1;
        }
        self.events.push_back(event);
    }
}

#[derive(Clone)]
pub(crate) struct HarnessState(Arc<Mutex<Runtime>>, trace::Collector);

impl Default for HarnessState {
    fn default() -> Self {
        let runtime = Arc::new(Mutex::new(Runtime::default()));
        let collector = trace::Collector::new(Arc::downgrade(&runtime));
        Self(runtime, collector)
    }
}

#[derive(Clone)]
pub(crate) struct ActivityContext {
    state: HarnessState,
    id: u64,
    trace_id: String,
    span: tracing::Span,
}

pub(crate) struct Activity {
    state: HarnessState,
    id: u64,
    context: ActivityContext,
    connection_id: Option<u64>,
    kind: ActivityKind,
    name: String,
    started: Instant,
    tracked: bool,
    finished: bool,
    // Clearing Debug erases captured content, but live errors still need redaction.
    credentials: Mutex<Vec<String>>,
}

fn milliseconds(duration: std::time::Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn now() -> u64 {
    milliseconds(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default(),
    )
}

fn kind_name(kind: ActivityKind) -> &'static str {
    match kind {
        ActivityKind::Request => "request",
        ActivityKind::Turn => "turn",
        ActivityKind::Tool => "tool",
        ActivityKind::Operation => "operation",
    }
}

impl HarnessState {
    pub(crate) fn open(&self, id: u64, kind: ConnectionKind) {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if state.connections.len() == CONNECTION_CAPACITY {
            let oldest_closed = state
                .connections
                .values()
                .filter(|connection| connection.closed_at.is_some())
                .min_by_key(|connection| connection.closed_at)
                .map(|connection| connection.id);
            if let Some(oldest) = oldest_closed {
                state.connections.remove(&oldest);
            }
        }
        if state.connections.len() < CONNECTION_CAPACITY {
            state.connections.insert(
                id,
                DebugConnection {
                    id,
                    kind,
                    state: "connected",
                    opened_at: now(),
                    closed_at: None,
                    requests: 0,
                    bytes_sent: 0,
                    bytes_received: 0,
                    started: Instant::now(),
                },
            );
        }
        state.counters.connections_opened += 1;
        state.event(DebugEvent {
            id: 0,
            at: now(),
            connection_id: Some(id),
            kind: "connection",
            name: "http-sse".to_owned(),
            phase: "started",
            duration_ms: None,
            bytes: None,
            code: None,
            activity_id: None,
            detail_version: 0,
            has_content: false,
            revision: 0,
        });
    }

    pub(crate) fn close(&self, id: u64, outcome: Outcome) {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let duration = state.connections.get_mut(&id).map(|connection| {
            let at = now();
            connection.state = "closed";
            connection.closed_at = Some(at);
            milliseconds(connection.started.elapsed())
        });
        state.counters.connections_closed += 1;
        state.event(DebugEvent {
            id: 0,
            at: now(),
            connection_id: Some(id),
            kind: "connection",
            name: "http-sse".to_owned(),
            phase: "closed",
            duration_ms: duration,
            bytes: None,
            code: outcome.code(),
            activity_id: None,
            detail_version: 0,
            has_content: false,
            revision: 0,
        });
    }

    pub(crate) fn begin(&self, connection_id: u64, kind: ActivityKind, name: &str) -> Activity {
        self.begin_inner(Some(connection_id), kind, name, None)
    }

    pub(crate) fn begin_with_parent(
        &self,
        connection_id: u64,
        kind: ActivityKind,
        name: &str,
        parent: &ActivityContext,
    ) -> Activity {
        self.begin_inner(Some(connection_id), kind, name, Some(parent))
    }

    pub(crate) fn begin_operation(&self, name: &str) -> Activity {
        self.begin_inner(None, ActivityKind::Operation, name, None)
    }

    fn begin_inner(
        &self,
        connection_id: Option<u64>,
        kind: ActivityKind,
        name: &str,
        parent: Option<&ActivityContext>,
    ) -> Activity {
        let name = name.to_owned();
        // A context from a different runtime cannot name a causal parent here.
        let parent = parent.filter(|parent| Arc::ptr_eq(&self.0, &parent.state.0));
        let trace_id = parent.map_or_else(
            || uuid::Uuid::new_v4().simple().to_string(),
            |parent| parent.trace_id.clone(),
        );
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        state.next_activity += 1;
        let id = state.next_activity;
        let started = Instant::now();
        let started_at = state.clock.at(started);
        let tracked = state.active.len() < ACTIVITY_CAPACITY;
        if tracked {
            state.active.insert(
                id,
                Active {
                    connection_id,
                    kind,
                    name: name.clone(),
                    started_at,
                    started,
                },
            );
        } else {
            state.active_omitted += 1;
            state.dropped_spans += 1;
        }
        let evicted = state.capture.begin(id, &name);
        for evicted_id in evicted {
            state.refresh_detail_version(evicted_id);
        }
        state.counters.start(kind);
        if kind == ActivityKind::Request
            && let Some(connection) = connection_id.and_then(|id| state.connections.get_mut(&id))
        {
            connection.requests += 1;
        }
        state.event(DebugEvent {
            id: 0,
            at: started_at,
            connection_id,
            kind: kind_name(kind),
            name: name.clone(),
            phase: "started",
            duration_ms: None,
            bytes: None,
            code: (!tracked).then_some("activity_capacity"),
            activity_id: Some(id),
            detail_version: 0,
            has_content: false,
            revision: 0,
        });
        // Subscriber callbacks acquire the runtime lock to create the retained
        // projection. Never call into tracing while holding that lock.
        drop(state);
        let span = if tracked {
            self.1.begin(id, &trace_id, &name, parent)
        } else {
            tracing::Span::none()
        };
        Activity {
            state: self.clone(),
            id,
            context: ActivityContext {
                state: self.clone(),
                id,
                trace_id,
                span,
            },
            connection_id,
            kind,
            name,
            started,
            tracked,
            finished: false,
            credentials: Mutex::new(Vec::new()),
        }
    }

    pub(crate) fn traffic(&self, id: u64, bytes: usize, incoming: bool, notification: bool) {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let bytes = bytes as u64;
        if incoming {
            state.counters.bytes_received += bytes;
            state.counters.notifications_received += u64::from(notification);
        } else {
            state.counters.bytes_sent += bytes;
        }
        if let Some(connection) = state.connections.get_mut(&id) {
            if incoming {
                connection.bytes_received += bytes;
            } else {
                connection.bytes_sent += bytes;
            }
        }
    }

    fn snapshot(&self, after: Option<u64>) -> serde_json::Value {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .snapshot(after)
    }

    pub(crate) fn event_detail(&self, activity_id: u64) -> HarnessEventDetail {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .detail(activity_id)
    }

    fn diagnostics(&self) -> serde_json::Value {
        let state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let ids: BTreeSet<_> = state
            .capture
            .activities
            .keys()
            .copied()
            .chain(state.events.iter().filter_map(|event| event.activity_id))
            .chain(state.active.keys().copied())
            .chain(state.spans.keys().copied())
            .collect();
        serde_json::json!({
            "snapshot": state.snapshot(None),
            "details": ids.into_iter().map(|id| state.detail(id)).collect::<Vec<_>>(),
        })
    }

    fn clear(&self) {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        state.events.clear();
        state.dropped_events = 0;
        state.cleared_at = Some(now());
        let through = state.next_activity;
        state.capture.clear(through);
        state.spans.retain(|_, span| span.status == "running");
        state.completed_spans.clear();
        state.dropped_spans = 0;
        state.detail_version += 1;
        state.cursor += 1;
        let version = state.detail_version;
        for span in state.spans.values_mut() {
            span.has_content = false;
            span.detail_version = version;
        }
    }
}

impl Runtime {
    fn refresh_detail_version(&mut self, activity_id: u64) {
        self.detail_version += 1;
        self.cursor += 1;
        let has_content = self
            .capture
            .activities
            .get(&activity_id)
            .is_some_and(CapturedActivity::has_content);
        if let Some(span) = self.spans.get_mut(&activity_id) {
            span.detail_version = self.detail_version;
            span.has_content |= has_content;
        }
        for event in self
            .events
            .iter_mut()
            .filter(|event| event.activity_id == Some(activity_id))
        {
            event.detail_version = self.detail_version;
            event.revision = self.cursor;
            // Keep evicted rows inspectable so the reason is visible.
            event.has_content |= has_content;
        }
    }

    fn complete_span(&mut self, activity_id: u64, outcome: Outcome) {
        let Some(span) = self.spans.get_mut(&activity_id) else {
            return;
        };
        span.duration_ms = milliseconds(span.started.elapsed());
        span.ended_at = Some(span.started_at.saturating_add(span.duration_ms));
        span.status = outcome.phase();
        span.code = outcome.code();
        self.completed_spans.push_back(activity_id);
        while self.completed_spans.len() > COMPLETED_SPAN_CAPACITY {
            if let Some(oldest) = self.completed_spans.pop_front() {
                self.spans.remove(&oldest);
                self.dropped_spans += 1;
            }
        }
    }

    fn detail(&self, activity_id: u64) -> HarnessEventDetail {
        let name = self
            .active
            .get(&activity_id)
            .map(|active| active.name.clone())
            .or_else(|| self.spans.get(&activity_id).map(|span| span.name.clone()))
            .or_else(|| {
                self.events
                    .iter()
                    .rev()
                    .find(|event| event.activity_id == Some(activity_id))
                    .map(|event| event.name.clone())
            })
            .unwrap_or_else(|| format!("activity {activity_id}"));
        self.capture.detail(activity_id, name)
    }

    fn snapshot(&self, after: Option<u64>) -> serde_json::Value {
        let state = self;
        let active: Vec<_> = state
            .active
            .iter()
            .map(|(id, active)| ActiveSnapshot {
                id: *id,
                connection_id: active.connection_id,
                kind: active.kind,
                name: active.name.clone(),
                started_at: active.started_at,
                elapsed_ms: milliseconds(active.started.elapsed()),
            })
            .collect();
        let events: Vec<_> = state
            .events
            .iter()
            .filter(|event| after.is_none_or(|after| event.id > after || event.revision > after))
            .collect();
        serde_json::json!({
            "schemaVersion": 1,
            "capturedAt": now(),
            "cursor": state.cursor,
            "droppedEvents": state.dropped_events,
            "activeOmitted": state.active_omitted,
            "spans": state.spans.values().map(HarnessSpan::snapshot).collect::<Vec<_>>(),
            "droppedSpans": state.dropped_spans,
            "clearedAt": state.cleared_at,
            "transport": "workbench/http-sse",
            "approvalPolicy": "auto-review",
            "limits": {
                "eventCapacity":EVENT_CAPACITY,"activityCapacity":ACTIVITY_CAPACITY,"connectionCapacity":CONNECTION_CAPACITY,
                "completedSpanCapacity":COMPLETED_SPAN_CAPACITY,"runningSpanCapacity":ACTIVITY_CAPACITY,
                "rpcTimeoutMs":120000,"writeTimeoutMs":0,"approvalTimeoutMs":120000,
                "maxFrameBytes":crate::providers::driver::MAX_FRAME_BYTES,"maxInputBytes":crate::agent::MAX_INPUT,
                "maxTurnOutputBytes":crate::agent::MAX_TURN_OUTPUT,"maxTurnEvents":crate::providers::driver::MAX_EVENTS,
                "maxPendingRequests":4,"maxModelRounds":24,"maxToolCalls":64,
            },
            "counters": state.counters,
            "connections": state.connections.values().collect::<Vec<_>>(),
            "active": active,
            "events": events,
            "tools": crate::agent_tools::tool_catalog(),
            "privacy": {"localOnly":true,"contentLogged":true,"credentialsRedacted":true},
            "capture": {
                "storedBytes": state.capture.stored_bytes,
                "maxBytes": state.capture.max_bytes,
                "retainedActivities": state.capture.activities.len(),
                "evictedActivities": state.capture.evicted_activities,
                "maxContentBytes": state.capture.max_content_bytes,
            },
        })
    }
}

impl Activity {
    pub(crate) fn context(&self) -> ActivityContext {
        self.context.clone()
    }

    pub(crate) fn record_result<T: Serialize>(&mut self, result: &Result<T, String>) {
        match result {
            Ok(value) => {
                match serde_json::to_value(value) {
                    Ok(value) => self.record_response(&value),
                    Err(error) => {
                        self.record_error(&format!("Debug response serialization failed: {error}"))
                    }
                }
                self.finish(Outcome::Completed);
            }
            Err(error) => {
                self.record_error(error);
                self.finish(Outcome::error(error));
            }
        }
    }

    fn record(
        &self,
        field: ContentField,
        text: &str,
        format: &str,
        secrets: &[&str],
        append: bool,
    ) {
        let mut credentials = self
            .credentials
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for secret in secrets.iter().filter(|secret| !secret.is_empty()) {
            if !credentials.iter().any(|known| known.as_str() == *secret) {
                credentials.push((*secret).to_owned());
            }
        }
        let secrets: Vec<_> = credentials.iter().map(String::as_str).collect();
        let mut state = self
            .state
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let evicted = state.capture.record(
            self.id,
            &self.name,
            ContentCapture {
                field,
                text,
                format,
                secrets: &secrets,
                append,
            },
        );
        state.refresh_detail_version(self.id);
        for id in evicted {
            if id != self.id {
                state.refresh_detail_version(id);
            }
        }
    }

    pub(crate) fn record_request(&self, value: &serde_json::Value) {
        let text = serde_json::to_string_pretty(value).unwrap_or_else(|error| error.to_string());
        self.record(ContentField::Request, &text, "json", &[], false);
    }

    pub(crate) fn record_response(&self, value: &serde_json::Value) {
        let text = serde_json::to_string_pretty(value).unwrap_or_else(|error| error.to_string());
        self.record_response_text(&text, "json", &[]);
    }

    pub(crate) fn record_error(&self, error: &str) {
        self.record(ContentField::Error, error, "text", &[], true);
    }

    pub(crate) fn record_request_text(&self, text: &str, format: &str, secrets: &[&str]) {
        self.record(ContentField::Request, text, format, secrets, false);
    }

    pub(crate) fn record_response_text(&self, text: &str, format: &str, secrets: &[&str]) {
        self.record(ContentField::Response, text, format, secrets, false);
    }

    pub(crate) fn append_response_text(&self, text: &str, format: &str, secrets: &[&str]) {
        self.record(ContentField::Response, text, format, secrets, true);
    }
    pub(crate) fn finish(&mut self, outcome: Outcome) {
        self.finish_with_bytes(outcome, None);
    }

    pub(crate) fn finish_with_bytes(&mut self, outcome: Outcome, bytes: Option<usize>) {
        if self.finished {
            return;
        }
        self.finished = true;
        // Causal contexts can outlive this operation. Record completion now;
        // Registry::on_close runs only after every retained context is dropped.
        self.context.span.record("status", outcome.phase());
        if let Some(code) = outcome.code() {
            self.context.span.record("code", code);
        }
        let mut state = self
            .state
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.tracked {
            state.active.remove(&self.id);
        } else {
            state.active_omitted = state.active_omitted.saturating_sub(1);
        }
        state.counters.finish(self.kind, outcome);
        if state.capture.finalize(self.id) {
            state.refresh_detail_version(self.id);
        }
        state.complete_span(self.id, outcome);
        let detail_version = state
            .events
            .iter()
            .rev()
            .find(|event| event.activity_id == Some(self.id))
            .map_or(state.detail_version, |event| event.detail_version);
        let has_content = state
            .capture
            .activities
            .get(&self.id)
            .is_some_and(CapturedActivity::has_content)
            || state
                .events
                .iter()
                .any(|event| event.activity_id == Some(self.id) && event.has_content);
        state.event(DebugEvent {
            id: 0,
            at: now(),
            connection_id: self.connection_id,
            kind: kind_name(self.kind),
            name: self.name.clone(),
            phase: outcome.phase(),
            duration_ms: Some(milliseconds(self.started.elapsed())),
            bytes: bytes.map(|bytes| bytes as u64),
            code: outcome.code(),
            activity_id: Some(self.id),
            detail_version,
            has_content,
            revision: 0,
        });
    }
}

impl Drop for Activity {
    fn drop(&mut self) {
        self.finish(Outcome::Cancelled);
    }
}

#[tauri::command]
pub(crate) async fn harness_snapshot(
    window: WebviewWindow,
    host: State<'_, crate::HostAccessState>,
    state: State<'_, HarnessState>,
    agent: State<'_, crate::agent::AgentState>,
    auth: String,
    after: Option<u64>,
) -> Result<serde_json::Value, String> {
    host.check(&window, &auth)?;
    let mut snapshot = state.snapshot(after);
    snapshot["engine"] = agent.engine_snapshot().await;
    Ok(snapshot)
}

#[tauri::command]
pub(crate) fn harness_event_detail(
    window: WebviewWindow,
    host: State<'_, crate::HostAccessState>,
    state: State<'_, HarnessState>,
    auth: String,
    activity_id: u64,
) -> Result<HarnessEventDetail, String> {
    host.check(&window, &auth)?;
    Ok(state.event_detail(activity_id))
}

#[tauri::command]
pub(crate) async fn harness_diagnostics(
    window: WebviewWindow,
    host: State<'_, crate::HostAccessState>,
    state: State<'_, HarnessState>,
    agent: State<'_, crate::agent::AgentState>,
    auth: String,
) -> Result<serde_json::Value, String> {
    host.check(&window, &auth)?;
    let mut report = state.diagnostics();
    report["snapshot"]["engine"] = agent.engine_snapshot().await;
    Ok(report)
}

#[tauri::command]
pub(crate) fn harness_clear(
    window: WebviewWindow,
    host: State<'_, crate::HostAccessState>,
    state: State<'_, HarnessState>,
    auth: String,
) -> Result<(), String> {
    host.check(&window, &auth)?;
    state.clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn span(snapshot: &serde_json::Value, id: u64) -> &serde_json::Value {
        snapshot["spans"]
            .as_array()
            .unwrap()
            .iter()
            .find(|span| span["id"] == id)
            .unwrap()
    }

    #[test]
    fn explicit_context_links_turn_model_tool_and_review_without_timestamp_inference() {
        let state = HarnessState::default();
        let turn = state.begin(1, ActivityKind::Turn, "chat");
        let model =
            state.begin_with_parent(1, ActivityKind::Request, "model/complete", &turn.context());
        let tool = state.begin_with_parent(
            1,
            ActivityKind::Tool,
            "workbench_write_file",
            &model.context(),
        );
        let review =
            state.begin_with_parent(1, ActivityKind::Request, "model/review", &tool.context());
        let independent = state.begin_operation("workspace/open");
        let snapshot = state.snapshot(None);
        let trace = span(&snapshot, turn.id)["traceId"].as_str().unwrap();
        assert_eq!(trace.len(), 32);
        assert!(trace.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(span(&snapshot, turn.id)["parentId"].is_null());
        for (child, parent) in [(&model, &turn), (&tool, &model), (&review, &tool)] {
            assert_eq!(span(&snapshot, child.id)["parentId"], parent.id);
            assert_eq!(span(&snapshot, child.id)["traceId"], trace);
            assert_eq!(span(&snapshot, child.id)["connectionId"], 1);
        }
        let independent = span(&snapshot, independent.id);
        assert!(independent["parentId"].is_null());
        assert!(independent["connectionId"].is_null());
        assert_eq!(independent["kind"], "operation");
        assert_ne!(independent["traceId"], trace);
        assert_eq!(snapshot["active"].as_array().unwrap().len(), 5);
    }

    #[test]
    fn active_snapshot_includes_native_operations_without_transport_connections() {
        let state = HarnessState::default();
        let mut operation = state.begin_operation("workspace/open");
        let request = state.begin(7, ActivityKind::Request, "model/complete");
        let snapshot = state.snapshot(None);
        let active = snapshot["active"].as_array().unwrap();
        assert_eq!(active.len(), 2);
        let native = active.iter().find(|row| row["id"] == operation.id).unwrap();
        assert_eq!(native["name"], "workspace/open");
        assert_eq!(native["kind"], "operation");
        assert!(native["connectionId"].is_null());
        let model = active.iter().find(|row| row["id"] == request.id).unwrap();
        assert_eq!(model["connectionId"], 7);
        assert_eq!(snapshot["activeOmitted"], 0);
        operation.finish(Outcome::Completed);
        let finished = state.snapshot(None);
        assert_eq!(finished["active"].as_array().unwrap().len(), 1);
        assert_eq!(span(&finished, operation.id)["status"], "completed");
    }

    #[test]
    fn foreign_runtime_context_does_not_fabricate_a_parent() {
        let first = HarnessState::default();
        let second = HarnessState::default();
        let parent = first.begin_operation("first runtime");
        let child = second.begin_with_parent(
            1,
            ActivityKind::Request,
            "second runtime",
            &parent.context(),
        );
        let snapshot = second.snapshot(None);
        assert!(span(&snapshot, child.id)["parentId"].is_null());
        assert_ne!(
            span(&snapshot, child.id)["traceId"],
            parent.context.trace_id
        );
    }

    #[test]
    fn span_timings_use_monotonic_elapsed_time_and_keep_payloads_lazy() {
        let state = HarnessState::default();
        let mut activity = state.begin_operation("workspace/save");
        activity.record_request(&serde_json::json!({"private source": "fn source() {}"}));
        activity.started = Instant::now() - std::time::Duration::from_millis(25);
        {
            let mut runtime = state.0.lock().unwrap();
            let span = runtime.spans.get_mut(&activity.id).unwrap();
            span.started = activity.started;
            span.started_at = 50_000;
        }
        let running = state.snapshot(None);
        let running_span = span(&running, activity.id);
        assert_eq!(running_span["status"], "running");
        assert!(running_span["endedAt"].is_null());
        assert!(running_span["durationMs"].as_u64().unwrap() >= 25);
        assert_eq!(running_span["hasContent"], true);
        assert!(!running.to_string().contains("fn source() {}"));
        activity.finish(Outcome::Completed);
        let completed = state.snapshot(None);
        let completed_span = span(&completed, activity.id);
        let duration = completed_span["durationMs"].as_u64().unwrap();
        assert!(duration >= running_span["durationMs"].as_u64().unwrap());
        assert_eq!(completed_span["endedAt"], 50_000 + duration);
        assert_eq!(completed_span["status"], "completed");
        assert!(completed_span["code"].is_null());
        assert!(
            state
                .event_detail(activity.id)
                .request
                .unwrap()
                .text
                .contains("fn source() {}")
        );
    }

    #[test]
    fn span_failure_and_guard_cancellation_preserve_final_outcomes_once() {
        let state = HarnessState::default();
        let mut failed = state.begin_operation("quality/format");
        failed.record_error("formatter exited with raw error");
        failed.finish(Outcome::Failed("formatter_error"));
        failed.finish(Outcome::Completed);
        let cancelled = state.begin_operation("index/search");
        let cancelled_id = cancelled.id;
        drop(cancelled);
        let snapshot = state.snapshot(None);
        assert_eq!(span(&snapshot, failed.id)["status"], "failed");
        assert_eq!(span(&snapshot, failed.id)["code"], "formatter_error");
        assert_eq!(span(&snapshot, cancelled_id)["status"], "cancelled");
        assert_eq!(span(&snapshot, cancelled_id)["code"], "cancelled");
        assert!(span(&snapshot, failed.id)["endedAt"].is_u64());
        assert!(
            state
                .event_detail(failed.id)
                .error
                .unwrap()
                .text
                .contains("raw error")
        );
        assert_eq!(snapshot["spans"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn span_retention_bounds_completed_and_running_records_independently() {
        let state = HarnessState::default();
        for _ in 0..=COMPLETED_SPAN_CAPACITY {
            let mut activity = state.begin_operation("completed operation");
            activity.finish(Outcome::Completed);
        }
        let running: Vec<_> = (0..ACTIVITY_CAPACITY)
            .map(|_| state.begin_operation("running operation"))
            .collect();
        let overflow = state.begin_operation("overflow operation");
        let snapshot = state.snapshot(None);
        let spans = snapshot["spans"].as_array().unwrap();
        assert_eq!(spans.len(), COMPLETED_SPAN_CAPACITY + ACTIVITY_CAPACITY);
        assert_eq!(
            spans
                .iter()
                .filter(|span| span["status"] == "running")
                .count(),
            ACTIVITY_CAPACITY
        );
        assert!(!spans.iter().any(|span| span["id"] == 1));
        assert!(!spans.iter().any(|span| span["id"] == overflow.id));
        assert_eq!(snapshot["droppedSpans"], 2);
        assert_eq!(snapshot["activeOmitted"], 1);
        drop(overflow);
        drop(running);
        assert_eq!(
            state.snapshot(None)["spans"].as_array().unwrap().len(),
            COMPLETED_SPAN_CAPACITY
        );
    }

    #[test]
    fn clear_keeps_live_context_but_removes_completed_spans_and_content() {
        let state = HarnessState::default();
        let mut completed = state.begin_operation("finished operation");
        completed.finish(Outcome::Completed);
        let mut running = state.begin(1, ActivityKind::Turn, "chat");
        running.record_request(&serde_json::json!({"source":"before clear"}));
        let context = running.context();
        state.clear();
        let cleared = state.snapshot(None);
        assert_eq!(cleared["spans"].as_array().unwrap().len(), 1);
        assert_eq!(span(&cleared, running.id)["status"], "running");
        assert_eq!(span(&cleared, running.id)["hasContent"], false);
        assert_eq!(cleared["droppedSpans"], 0);
        assert!(!state.event_detail(running.id).available);
        let mut child =
            state.begin_with_parent(1, ActivityKind::Request, "model/complete", &context);
        child.record_response(&serde_json::json!({"after":"clear"}));
        child.finish(Outcome::Completed);
        running.finish(Outcome::Completed);
        let finished = state.snapshot(None);
        assert_eq!(span(&finished, child.id)["parentId"], running.id);
        assert_eq!(span(&finished, child.id)["traceId"], context.trace_id);
        assert_eq!(span(&finished, running.id)["status"], "completed");
        assert_eq!(finished["counters"]["turnsCompleted"], 1);
        assert!(!state.diagnostics().to_string().contains("before clear"));
    }

    #[test]
    fn operation_result_helper_records_success_and_errors_without_model_counters() {
        let state = HarnessState::default();
        let mut success = state.begin_operation("workspace/read");
        success.record_result(&Ok::<_, String>(
            serde_json::json!({"content":"actual source"}),
        ));
        let mut failure = state.begin_operation("workspace/write");
        failure.record_result(&Err::<serde_json::Value, _>(
            "operation timed out".to_owned(),
        ));
        let snapshot = state.snapshot(None);
        assert_eq!(span(&snapshot, success.id)["status"], "completed");
        assert!(
            state
                .event_detail(success.id)
                .response
                .unwrap()
                .text
                .contains("actual source")
        );
        assert_eq!(span(&snapshot, failure.id)["status"], "failed");
        assert_eq!(span(&snapshot, failure.id)["code"], "timeout");
        assert_eq!(snapshot["counters"]["requestsStarted"], 0);
        assert_eq!(snapshot["counters"]["turnsStarted"], 0);
    }

    #[test]
    fn lifecycle_counters_distinguish_success_failure_and_dropped_futures() {
        let state = HarnessState::default();
        state.open(1, ConnectionKind::Chat);
        let mut first = state.begin(1, ActivityKind::Request, "turn/start");
        let mut second = state.begin(1, ActivityKind::Tool, "workbench_search_code");
        let dropped = state.begin(1, ActivityKind::Turn, "chat");
        first.finish(Outcome::Completed);
        first.finish(Outcome::Failed("should_not_count"));
        second.finish(Outcome::Failed("timeout"));
        drop(dropped);
        state.close(1, Outcome::Cancelled);
        let snapshot = state.snapshot(None);
        assert_eq!(snapshot["active"], serde_json::json!([]));
        assert_eq!(snapshot["counters"]["requestsCompleted"], 1);
        assert_eq!(snapshot["counters"]["requestsFailed"], 0);
        assert_eq!(snapshot["counters"]["toolsFailed"], 1);
        assert_eq!(snapshot["counters"]["turnsCancelled"], 1);
        assert_eq!(snapshot["connections"][0]["state"], "closed");
        assert!(snapshot["events"][2]["durationMs"].is_null());
        assert!(snapshot["events"][4]["durationMs"].is_u64());
    }

    #[test]
    fn events_activities_and_connections_have_strict_bounds_and_monotonic_cursors() {
        let state = HarnessState::default();
        let activities: Vec<_> = (0..ACTIVITY_CAPACITY + 4)
            .map(|_| state.begin(1, ActivityKind::Request, "account/read"))
            .collect();
        let snapshot = state.snapshot(None);
        assert_eq!(
            snapshot["active"].as_array().unwrap().len(),
            ACTIVITY_CAPACITY
        );
        assert_eq!(snapshot["activeOmitted"], 4);
        drop(activities);
        for id in 1..=(EVENT_CAPACITY as u64) {
            state.open(id, ConnectionKind::Control);
            state.close(id, Outcome::Completed);
        }
        let snapshot = state.snapshot(None);
        assert_eq!(snapshot["events"].as_array().unwrap().len(), EVENT_CAPACITY);
        assert_eq!(snapshot["activeOmitted"], 0);
        assert!(snapshot["connections"].as_array().unwrap().len() <= CONNECTION_CAPACITY);
        assert!(snapshot["droppedEvents"].as_u64().unwrap() > 0);
        let cursor = snapshot["cursor"].as_u64().unwrap();
        assert_eq!(
            state.snapshot(Some(cursor))["events"],
            serde_json::json!([])
        );
        state.clear();
        state.open(999, ConnectionKind::Completion);
        assert!(state.snapshot(None)["cursor"].as_u64().unwrap() > cursor);
    }

    #[test]
    fn clear_retains_live_work_and_counters_without_interrupting_it() {
        let state = HarnessState::default();
        state.open(1, ConnectionKind::Chat);
        let mut activity = state.begin(1, ActivityKind::Turn, "chat");
        state.traffic(1, 123, false, false);
        state.traffic(1, 456, true, true);
        state.clear();
        let snapshot = state.snapshot(None);
        assert_eq!(snapshot["events"], serde_json::json!([]));
        assert_eq!(snapshot["active"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["counters"]["bytesSent"], 123);
        assert_eq!(snapshot["counters"]["bytesReceived"], 456);
        assert_eq!(snapshot["counters"]["notificationsReceived"], 1);
        activity.finish(Outcome::Completed);
        assert_eq!(state.snapshot(None)["counters"]["turnsCompleted"], 1);
    }

    #[test]
    fn full_details_preserve_names_arguments_results_and_raw_errors() {
        let state = HarnessState::default();
        let mut activity = state.begin(1, ActivityKind::Tool, "custom/read_source");
        activity.record_request(
            &serde_json::json!({"file":"/private/source.rs", "token": "ordinary data"}),
        );
        activity.record_response(
            &serde_json::json!({"value":"source", "changes":[{"diff":"+ exact diff"}]}),
        );
        activity.record_error("raw source error: /private/source.rs");
        activity.record_error("final error");
        activity.finish(Outcome::Failed("rejected"));
        let detail = state.event_detail(activity.id);
        assert_eq!(detail.name, "custom/read_source");
        assert!(detail.available);
        assert!(detail.request.unwrap().text.contains("ordinary data"));
        assert!(detail.response.unwrap().text.contains("+ exact diff"));
        assert_eq!(
            detail.error.unwrap().text,
            "raw source error: /private/source.rs\nfinal error"
        );
        let snapshot = state.snapshot(None);
        assert!(snapshot["events"][0]["hasContent"].as_bool().unwrap());
        assert!(snapshot["events"][0]["detailVersion"].as_u64().unwrap() > 0);
        assert_eq!(snapshot["events"][0]["name"], "custom/read_source");
        assert_eq!(snapshot["events"][0]["activityId"], activity.id);
        assert!(!snapshot.to_string().contains("ordinary data"));
        assert!(!snapshot.to_string().contains("exact diff"));
        assert!(state.diagnostics().to_string().contains("ordinary data"));
        assert_eq!(snapshot["privacy"]["contentLogged"], true);
        assert_eq!(snapshot["privacy"]["credentialsRedacted"], true);
    }

    #[test]
    fn exact_credentials_are_redacted_across_stream_chunks_and_errors() {
        let state = HarnessState::default();
        let activity = state.begin(1, ActivityKind::Request, "model/complete");
        let credential = "secret-key-123";
        activity.record_request_text(
            "token: ordinary data; auth: secret-key-123",
            "text",
            &[credential],
        );
        activity.append_response_text("data: secret-", "sse", &[credential]);
        let partial = state.event_detail(activity.id).response.unwrap();
        assert_eq!(partial.text, format!("data: {CREDENTIAL_MARKER}"));
        activity.append_response_text("key-123 then secret-key-123 done", "sse", &[credential]);
        activity.record_error("request failed for secret-key-123");
        let detail = state.event_detail(activity.id);
        let request = detail.request.unwrap();
        assert!(request.text.contains("token: ordinary data"));
        assert!(!request.text.contains(credential));
        assert_eq!(request.redactions, 1);
        let response = detail.response.unwrap();
        assert_eq!(
            response.text,
            format!("data: {CREDENTIAL_MARKER} then {CREDENTIAL_MARKER} done")
        );
        assert_eq!(response.redactions, 2);
        assert_eq!(response.truncated_bytes, 0);
        assert_eq!(response.original_bytes, 45);
        assert!(!detail.error.unwrap().text.contains(credential));
    }

    #[test]
    fn terminal_matches_with_repeating_prefixes_remain_redacted_in_one_byte_chunks() {
        for credential in ["abcab", "test-api-secret"] {
            let state = HarnessState::default();
            let activity = state.begin(1, ActivityKind::Request, "model/complete");
            for byte in credential.as_bytes() {
                let chunk = char::from(*byte).to_string();
                activity.append_response_text(&chunk, "sse", &[credential]);
                let partial = state.event_detail(activity.id).response.unwrap();
                assert!(!partial.text.contains(credential));
            }
            let response = state.event_detail(activity.id).response.unwrap();
            assert_eq!(response.text, CREDENTIAL_MARKER);
            assert_eq!(response.redactions, 1);
        }
    }

    #[test]
    fn finish_preserves_ordinary_text_that_ends_in_a_credential_prefix() {
        let state = HarnessState::default();
        let mut activity = state.begin(1, ActivityKind::Request, "model/complete");
        activity.record_response_text("cat", "text", &["test-api-secret"]);
        activity.finish(Outcome::Completed);
        let response = state.event_detail(activity.id).response.unwrap();
        assert_eq!(response.text, "cat");
        assert_eq!(response.redactions, 0);
        assert_eq!(response.original_bytes, 3);
        assert_eq!(response.truncated_bytes, 0);
    }

    #[test]
    fn canonical_json_escaped_credentials_are_redacted_across_chunks() {
        let state = HarnessState::default();
        let activity = state.begin(1, ActivityKind::Request, "model/complete");
        let credential = r#"key-"quote\slash"#;
        let encoded = serde_json::to_string(credential).unwrap();
        let escaped = &encoded[1..encoded.len() - 1];
        activity.record_request_text(
            &format!(r#"{{"auth":{encoded},"token":"plain data"}}"#),
            "json",
            &[credential],
        );
        let split = escaped.len() / 2;
        activity.append_response_text(&escaped[..split], "sse", &[credential]);
        activity.append_response_text(&escaped[split..], "sse", &[credential]);
        let detail = state.event_detail(activity.id);
        let request = detail.request.unwrap();
        assert!(request.text.contains("plain data"));
        assert!(request.text.contains(CREDENTIAL_MARKER));
        assert!(!request.text.contains(escaped));
        assert_eq!(request.redactions, 1);
        assert_eq!(detail.response.unwrap().text, CREDENTIAL_MARKER);
    }

    #[test]
    fn incremental_snapshots_return_changed_detail_metadata_without_copying_bodies() {
        let state = HarnessState::default();
        let activity = state.begin(1, ActivityKind::Request, "model/complete");
        let cursor = state.snapshot(None)["cursor"].as_u64().unwrap();
        activity.append_response_text("private payload", "sse", &[]);
        let delta = state.snapshot(Some(cursor));
        assert!(delta["cursor"].as_u64().unwrap() > cursor);
        assert_eq!(delta["events"].as_array().unwrap().len(), 1);
        assert_eq!(delta["events"][0]["hasContent"], true);
        assert!(!delta.to_string().contains("private payload"));
    }

    #[test]
    fn overlapping_credentials_use_the_longest_match_without_redacting_markers() {
        let credentials = [Credential::new("secret"), Credential::new("secret-key")];
        let matcher = credential_matcher(&credentials).unwrap();
        let mut output = String::new();
        let (count, omitted) =
            append_redacted("secret-key secret", &mut output, Some(&matcher), 1024);
        assert_eq!(count, 2);
        assert_eq!(omitted, 0);
        assert_eq!(output, format!("{CREDENTIAL_MARKER} {CREDENTIAL_MARKER}"));
    }

    #[test]
    fn streaming_credentials_keep_longest_matches_across_every_chunk_boundary() {
        for (patterns, input, expected) in [
            (
                &["secret", "secret-key"][..],
                "before secret-key then secret end",
                format!("before {CREDENTIAL_MARKER} then {CREDENTIAL_MARKER} end"),
            ),
            (
                &["abcab"][..],
                "abcab plus abcab suffix",
                format!("{CREDENTIAL_MARKER} plus {CREDENTIAL_MARKER} suffix"),
            ),
            (
                &["é🙂", "é🙂token"][..],
                "pré é🙂token fin",
                format!("pré {CREDENTIAL_MARKER} fin"),
            ),
        ] {
            let credentials: Vec<_> = patterns
                .iter()
                .map(|pattern| Credential::new(pattern))
                .collect();
            let matcher = credential_matcher(&credentials).unwrap();
            for split in (0..=input.len()).filter(|split| input.is_char_boundary(*split)) {
                let mut content = CapturedContent::new("sse");
                for chunk in [&input[..split], &input[split..]] {
                    content.append(chunk, "sse", &credentials, Some(&matcher), 4096);
                    let snapshot = content.snapshot();
                    assert!(
                        patterns
                            .iter()
                            .all(|pattern| !snapshot.text.contains(pattern))
                    );
                }
                content.finalize(Some(&matcher), 4096);
                let captured = content.snapshot();
                assert_eq!(captured.text, expected, "split at byte {split}");
                assert_eq!(captured.original_bytes, input.len() as u64);
                assert_eq!(captured.truncated_bytes, 0);
            }
        }
    }

    #[test]
    fn mismatching_credential_extensions_preserve_ordinary_text() {
        let credentials = [Credential::new("secret"), Credential::new("secret-key")];
        let matcher = credential_matcher(&credentials).unwrap();
        let mut content = CapturedContent::new("sse");
        content.append("prefix secret-", "sse", &credentials, Some(&matcher), 4096);
        content.append("x and secrez", "sse", &credentials, Some(&matcher), 4096);
        content.finalize(Some(&matcher), 4096);
        let captured = content.snapshot();
        assert_eq!(
            captured.text,
            format!("prefix {CREDENTIAL_MARKER}-x and secrez")
        );
        assert_eq!(captured.redactions, 1);
        assert_eq!(captured.truncated_bytes, 0);
    }

    #[test]
    fn complete_matching_prefers_earliest_start_then_longest_credential() {
        let credentials = [
            Credential::new("b"),
            Credential::new("ab"),
            Credential::new("abcd"),
        ];
        let matcher = credential_matcher(&credentials).unwrap();
        let mut output = String::new();
        let (redactions, omitted) = append_redacted("zabcdab b", &mut output, Some(&matcher), 4096);
        assert_eq!(
            output,
            format!("z{CREDENTIAL_MARKER}{CREDENTIAL_MARKER} {CREDENTIAL_MARKER}")
        );
        assert_eq!(redactions, 3);
        assert_eq!(omitted, 0);
    }

    #[test]
    fn redaction_output_bound_reports_source_bytes_without_partial_markers() {
        let credentials = [Credential::new("secret-key")];
        let matcher = credential_matcher(&credentials).unwrap();
        let input = "é secret-key tail";
        for (limit, expected, count, omitted) in [
            (
                3 + CREDENTIAL_MARKER.len(),
                format!("é {CREDENTIAL_MARKER}"),
                1,
                5,
            ),
            (2 + CREDENTIAL_MARKER.len(), "é ".to_owned(), 0, 15),
        ] {
            let mut output = String::new();
            assert_eq!(
                append_redacted(input, &mut output, Some(&matcher), limit),
                (count, omitted)
            );
            assert_eq!(output, expected);
            assert!(output.len() <= limit);
        }
    }

    #[test]
    fn truncated_streams_never_release_a_withheld_credential_prefix() {
        let credential = format!("{}b", "a".repeat(48));
        let credentials = [Credential::new(&credential)];
        let matcher = credential_matcher(&credentials).unwrap();
        let mut content = CapturedContent::new("sse");
        content.append(&credential, "sse", &credentials, Some(&matcher), 32);
        assert_eq!(content.snapshot().text, CREDENTIAL_MARKER);
        content.finalize(Some(&matcher), 32);
        let captured = content.snapshot();
        assert_eq!(captured.text, CREDENTIAL_MARKER);
        assert_eq!(captured.redactions, 1);
        assert_eq!(captured.original_bytes, 49);
        assert_eq!(captured.truncated_bytes, 17);
        assert!(content.stored_bytes(Some(&matcher)) <= 32);
    }

    #[test]
    fn pending_capture_reserves_all_markers_that_finalization_can_emit() {
        let credentials = [
            Credential::new("x"),
            Credential::new("xyyyyyz"),
            Credential::new("y"),
        ];
        let matcher = credential_matcher(&credentials).unwrap();
        let mut content = CapturedContent::new("sse");
        content.append("xy", "sse", &credentials, Some(&matcher), 4096);
        let reserved = content.stored_bytes(Some(&matcher));
        assert_eq!(content.snapshot().text, CREDENTIAL_MARKER);
        content.finalize(Some(&matcher), 4096);
        let captured = content.snapshot();
        assert_eq!(captured.text, CREDENTIAL_MARKER.repeat(2));
        assert_eq!(captured.redactions, 2);
        assert!(content.stored_bytes(Some(&matcher)) <= reserved);
    }

    #[test]
    fn compiled_credential_matchers_count_toward_capture_retention() {
        let credential = "secret-key";
        let matcher_bytes = credential_matcher(&[Credential::new(credential)])
            .unwrap()
            .memory_usage();
        let mut store = CaptureStore {
            max_bytes: matcher_bytes - 1,
            ..CaptureStore::default()
        };
        store.begin(1, "model/complete");
        store.record(
            1,
            "model/complete",
            ContentCapture {
                field: ContentField::Request,
                text: "auth: secret-key",
                format: "text",
                secrets: &[credential],
                append: false,
            },
        );
        assert_eq!(store.stored_bytes, 0);
        assert_eq!(store.evicted_activities, 1);
        let detail = store.detail(1, "model/complete".to_owned());
        assert!(!detail.available);
        assert!(detail.reason.unwrap().contains("retention limit"));
    }

    #[test]
    fn repeated_credentials_preserve_a_large_tail_when_other_credentials_are_absent() {
        let repetitions = 32_768;
        let tail = "x".repeat(1024 * 1024);
        let text = format!("{}{tail}", "credential-a ".repeat(repetitions));
        let expected = format!(
            "{}{tail}",
            format!("{CREDENTIAL_MARKER} ").repeat(repetitions)
        );
        let credentials = [
            Credential::new("credential-a"),
            Credential::new("absent-credential-b"),
        ];
        let matcher = credential_matcher(&credentials).unwrap();
        let mut output = String::new();
        let (redactions, omitted) =
            append_redacted(&text, &mut output, Some(&matcher), expected.len());
        assert_eq!(redactions, repetitions as u64);
        assert_eq!(omitted, 0);
        assert_eq!(output, expected);
    }

    #[test]
    fn content_limits_are_utf8_safe_and_truncation_remains_explicit() {
        let mut content = CapturedContent::new("text");
        content.append("aé🙂z", "text", &[], None, 6);
        let first = content.snapshot();
        assert_eq!(first.text, "aé");
        assert_eq!(first.original_bytes, 8);
        assert_eq!(first.truncated_bytes, 5);
        content.append("more", "text", &[], None, 6);
        let final_content = content.snapshot();
        assert_eq!(final_content.text, "aé");
        assert_eq!(final_content.original_bytes, 12);
        assert_eq!(final_content.truncated_bytes, 9);
        assert!(content.stored_bytes(None) <= 6);
    }

    #[test]
    fn stored_bytes_and_activity_count_evict_oldest_content_with_reasons() {
        let mut store = CaptureStore {
            max_bytes: 12,
            max_content_bytes: 10,
            max_activities: 2,
            ..CaptureStore::default()
        };
        store.begin(1, "first");
        store.record(
            1,
            "first",
            ContentCapture {
                field: ContentField::Request,
                text: "abcdefghij",
                format: "text",
                secrets: &[],
                append: false,
            },
        );
        store.begin(2, "second");
        store.record(
            2,
            "second",
            ContentCapture {
                field: ContentField::Request,
                text: "klmnop",
                format: "text",
                secrets: &[],
                append: false,
            },
        );
        assert!(store.stored_bytes <= 12);
        assert_eq!(store.evicted_activities, 1);
        let evicted = store.detail(1, "first".to_owned());
        assert!(!evicted.available);
        assert!(evicted.reason.unwrap().contains("evicted"));
        store.begin(3, "third");
        store.begin(4, "fourth");
        assert_eq!(store.activities.len(), 2);
        assert_eq!(store.evicted_activities, 2);
    }

    #[test]
    fn clear_erases_payloads_and_live_capture_restarts_with_a_visible_reason() {
        let state = HarnessState::default();
        let mut activity = state.begin(1, ActivityKind::Request, "live request");
        activity.record_request(&serde_json::json!({"before":"clear"}));
        activity.append_response_text("partial", "sse", &[]);
        state.clear();
        let cleared = state.event_detail(activity.id);
        assert!(!cleared.available);
        assert!(cleared.reason.unwrap().contains("cleared"));
        assert_eq!(state.snapshot(None)["capture"]["storedBytes"], 0);
        assert!(!state.diagnostics().to_string().contains("partial"));
        activity.append_response_text("after clear", "sse", &[]);
        activity.finish(Outcome::Completed);
        let resumed = state.event_detail(activity.id);
        assert!(resumed.available);
        assert!(resumed.reason.unwrap().contains("cleared"));
        assert!(resumed.request.is_none());
        assert_eq!(resumed.response.unwrap().text, "after clear");
        assert_eq!(state.snapshot(None)["counters"]["requestsCompleted"], 1);
    }

    #[test]
    fn clearing_payloads_keeps_live_error_credentials_redacted() {
        let state = HarnessState::default();
        let mut activity = state.begin(1, ActivityKind::Request, "model/complete");
        activity.record_request_text("auth: secret-key", "text", &["secret-key"]);
        state.clear();
        activity.record_error("server echoed secret-key in the failure");
        activity.finish(Outcome::Failed("rejected"));
        let detail = state.event_detail(activity.id);
        assert!(detail.request.is_none());
        let error = detail.error.unwrap();
        assert!(!error.text.contains("secret-key"));
        assert!(error.text.contains(CREDENTIAL_MARKER));
    }

    #[test]
    fn connection_events_do_not_claim_activity_content() {
        let state = HarnessState::default();
        state.open(1, ConnectionKind::Chat);
        let snapshot = state.snapshot(None);
        let event = &snapshot["events"][0];
        assert!(event["activityId"].is_null());
        assert_eq!(event["detailVersion"], 0);
        assert_eq!(event["hasContent"], false);
    }
}
