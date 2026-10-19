use crate::{
    HostAccessState, NativeEvents,
    harness::{HarnessState, Outcome},
    lsp::{Language, Position, path_to_uri, uri_to_path},
    workspace::{WorkspaceRoot, WorkspaceState},
};
use ignore::WalkBuilder;
use pulldown_cmark::{
    Event as MarkdownEvent, Options as MarkdownOptions, Parser as MarkdownParser, Tag, TagEnd,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    ops::ControlFlow,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tree_sitter::{Node, ParseOptions, Parser};

pub(crate) mod source_versions;
pub(crate) mod traversal;
pub(crate) use traversal::IndexTraverse;

const FILE_LIMIT: usize = 2 * 1024 * 1024;
const TOTAL_LIMIT: usize = 64 * 1024 * 1024;
const FILE_COUNT_LIMIT: usize = 10_000;
const RECORD_LIMIT: usize = 50_000;
const SYMBOL_LIMIT: usize = 30_000;
const CALL_LIMIT: usize = 100_000;
const REFRESH_LIMIT: Duration = Duration::from_secs(30);
const CHUNK_BYTES: usize = 4096;
const CHUNK_LINES: usize = 60;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SourceRange {
    pub start: Position,
    pub end: Position,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub root: String,
    pub state: String,
    pub files: usize,
    pub chunks: usize,
    pub symbols: usize,
    pub edges: usize,
    pub verified_edges: usize,
    pub indexed_bytes: usize,
    pub skipped: usize,
    pub limited: bool,
    pub stale: bool,
    pub updated_at: Option<u64>,
    pub generation: u64,
    pub last_error: Option<String>,
}

impl IndexStatus {
    fn empty(root: &Path) -> Self {
        Self {
            root: root.to_string_lossy().into_owned(),
            state: "idle".into(),
            files: 0,
            chunks: 0,
            symbols: 0,
            edges: 0,
            verified_edges: 0,
            indexed_bytes: 0,
            skipped: 0,
            limited: false,
            stale: false,
            updated_at: None,
            generation: 0,
            last_error: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexNode {
    pub id: String,
    pub name: String,
    pub qualified_name: String,
    pub kind: String,
    pub path: String,
    pub uri: String,
    pub range: SourceRange,
    pub selection_range: SourceRange,
    pub version: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEdge {
    pub id: String,
    pub from: String,
    pub to: String,
    pub kind: String,
    pub evidence: String,
    pub ranges: Vec<SourceRange>,
    pub source_version: String,
    pub target_version: String,
}

#[derive(Debug, Serialize)]
pub struct IndexGraph {
    pub nodes: Vec<IndexNode>,
    pub edges: Vec<IndexEdge>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexHit {
    pub id: String,
    pub kind: String,
    pub symbol_kind: Option<String>,
    pub path: String,
    pub uri: String,
    pub range: SourceRange,
    pub selection_range: Option<SourceRange>,
    pub name: Option<String>,
    pub qualified_name: Option<String>,
    pub content: String,
    pub version: String,
    pub score: f64,
    pub reasons: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IndexSearch {
    pub query: String,
    pub limit: Option<usize>,
    pub anchor_symbol_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IndexDirection {
    Incoming,
    Outgoing,
    #[default]
    Both,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IndexNeighbors {
    pub symbol_id: String,
    pub direction: Option<IndexDirection>,
    pub limit: Option<usize>,
}

#[derive(Clone)]
struct Handle {
    database: PathBuf,
    status: Arc<Mutex<IndexStatus>>,
    cursor_secret: Arc<String>,
    #[cfg(unix)]
    source_versions: Arc<Mutex<HashMap<String, traversal::VerifiedSource>>>,
}

#[derive(Clone, Default)]
pub struct IndexState {
    handles: Arc<Mutex<HashMap<PathBuf, Handle>>>,
    refreshing: Arc<AtomicBool>,
}

struct RefreshGuard<'a>(&'a AtomicBool);

impl Drop for RefreshGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn hash(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}
fn error(value: impl std::fmt::Display) -> String {
    format!("Code index: {value}")
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn connect(path: &Path, write: bool) -> Result<Connection, String> {
    let flags = if write {
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let connection = Connection::open_with_flags(path, flags).map_err(error)?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(error)?;
    connection
        .execute_batch("PRAGMA foreign_keys=ON; PRAGMA cache_size=-8192;")
        .map_err(error)?;
    Ok(connection)
}

fn initialize(path: &Path) -> Result<Connection, String> {
    let connection = connect(path, true)?;
    let version: u32 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(error)?;
    if version > 1 {
        return Err(error("this cache was created by a newer ejm-ide version"));
    }
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA max_page_count=131072;
      CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, version TEXT NOT NULL, bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS entries(
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
        name TEXT NOT NULL, qualified_name TEXT NOT NULL, symbol_kind TEXT NOT NULL,
        range_json TEXT NOT NULL, selection_json TEXT NOT NULL, snippet_range_json TEXT NOT NULL, content TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS entries_path ON entries(path);
      CREATE INDEX IF NOT EXISTS entries_name ON entries(name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS entries_name_binary ON entries(name);
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, caller TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE, name TEXT NOT NULL, range_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS edges(id TEXT PRIMARY KEY, from_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE, to_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE, evidence TEXT NOT NULL, ranges_json TEXT NOT NULL, source_version TEXT NOT NULL, target_version TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS edges_from ON edges(from_id);
      CREATE INDEX IF NOT EXISTS edges_to ON edges(to_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(id UNINDEXED, path, name, qualified_name, content, tokenize='unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version=1;").map_err(error)?;
    Ok(connection)
}

impl IndexState {
    fn handle(&self, root: &Path, cache_dir: &Path) -> Result<Handle, String> {
        let mut handles = self
            .handles
            .lock()
            .map_err(|_| error("state is unavailable"))?;
        if let Some(handle) = handles.get(root) {
            return Ok(handle.clone());
        }
        fs::create_dir_all(cache_dir).map_err(error)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(cache_dir, fs::Permissions::from_mode(0o700)).map_err(error)?;
        }
        let database = cache_dir.join(format!(
            "{}.sqlite",
            hash(root.as_os_str().as_encoded_bytes())
        ));
        let connection = initialize(&database)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&database, fs::Permissions::from_mode(0o600)).map_err(error)?;
        }
        let mut status = IndexStatus::empty(root);
        let previous: Option<String> = connection
            .query_row("SELECT value FROM metadata WHERE key='status'", [], |row| {
                row.get(0)
            })
            .optional()
            .map_err(error)?;
        if let Some(previous) =
            previous.and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        {
            status.updated_at = previous["updatedAt"].as_u64();
            status.generation = previous["generation"].as_u64().unwrap_or(0);
            status.skipped = previous["skipped"].as_u64().unwrap_or(0) as usize;
            status.limited = previous["limited"].as_bool().unwrap_or(false);
            status.state = "ready".into();
            status.stale = true;
            counts(&connection, &mut status)?;
        }
        let handle = Handle {
            database,
            status: Arc::new(Mutex::new(status)),
            cursor_secret: Arc::new(uuid::Uuid::new_v4().to_string()),
            #[cfg(unix)]
            source_versions: Arc::default(),
        };
        handles.insert(root.to_owned(), handle.clone());
        Ok(handle)
    }

    pub(crate) fn status(&self, root: &Path, cache_dir: &Path) -> Result<IndexStatus, String> {
        self.handle(root, cache_dir)?
            .status
            .lock()
            .map(|value| value.clone())
            .map_err(|_| error("status is unavailable"))
    }

    pub(crate) fn refresh(
        &self,
        snapshot: &WorkspaceRoot,
        cache_dir: &Path,
    ) -> Result<IndexStatus, String> {
        let handle = self.handle(&snapshot.path, cache_dir)?;
        if self.refreshing.swap(true, Ordering::AcqRel) {
            return Err(error(
                "a refresh is already running; try again when it finishes",
            ));
        }
        let _refresh = RefreshGuard(&self.refreshing);
        {
            let mut status = handle
                .status
                .lock()
                .map_err(|_| error("status is unavailable"))?;
            status.state = "indexing".into();
            status.last_error = None;
        }
        let result = refresh_database(&handle, snapshot);
        match result {
            Ok(status) => {
                *handle
                    .status
                    .lock()
                    .map_err(|_| error("status is unavailable"))? = status.clone();
                Ok(status)
            }
            Err(reason) => {
                let mut status = handle
                    .status
                    .lock()
                    .map_err(|_| error("status is unavailable"))?;
                status.state = "error".into();
                status.last_error = Some(reason);
                Ok(status.clone())
            }
        }
    }
}

fn counts(connection: &Connection, status: &mut IndexStatus) -> Result<(), String> {
    status.files = connection
        .query_row("SELECT count(*) FROM files", [], |row| {
            row.get::<_, u32>(0).map(|value| value as usize)
        })
        .map_err(error)?;
    status.indexed_bytes = connection
        .query_row("SELECT coalesce(sum(bytes),0) FROM files", [], |row| {
            row.get::<_, u32>(0).map(|value| value as usize)
        })
        .map_err(error)?;
    status.symbols = connection
        .query_row(
            "SELECT count(*) FROM entries WHERE kind='symbol'",
            [],
            |row| row.get::<_, u32>(0).map(|value| value as usize),
        )
        .map_err(error)?;
    status.chunks = connection
        .query_row(
            "SELECT count(*) FROM entries WHERE kind='chunk'",
            [],
            |row| row.get::<_, u32>(0).map(|value| value as usize),
        )
        .map_err(error)?;
    status.edges = connection
        .query_row("SELECT count(*) FROM edges", [], |row| {
            row.get::<_, u32>(0).map(|value| value as usize)
        })
        .map_err(error)?;
    status.verified_edges = connection
        .query_row(
            "SELECT count(*) FROM edges WHERE evidence='verified'",
            [],
            |row| row.get::<_, u32>(0).map(|value| value as usize),
        )
        .map_err(error)?;
    Ok(())
}

fn source_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|value| value.to_str()),
        Some(
            "rs" | "py"
                | "pyi"
                | "ts"
                | "tsx"
                | "mts"
                | "cts"
                | "js"
                | "jsx"
                | "mjs"
                | "cjs"
                | "rb"
                | "rake"
                | "gemspec"
                | "ru"
                | "go"
                | "md"
                | "markdown"
                | "txt"
                | "json"
                | "jsonc"
                | "toml"
                | "yaml"
                | "yml"
                | "css"
                | "scss"
                | "html"
                | "sql"
                | "sh"
                | "xml"
                | "graphql"
                | "proto"
        )
    ) || matches!(
        path.file_name().and_then(|value| value.to_str()),
        Some(
            "Gemfile"
                | "Rakefile"
                | "Guardfile"
                | "Brewfile"
                | "Dockerfile"
                | "Makefile"
                | "README"
                | "LICENSE"
        )
    )
}

fn refresh_database(handle: &Handle, snapshot: &WorkspaceRoot) -> Result<IndexStatus, String> {
    let mut connection = connect(&handle.database, true)?;
    let transaction = connection.transaction().map_err(error)?;
    let mut status = IndexStatus::empty(&snapshot.path);
    let mut seen = HashSet::new();
    let mut records = 0;
    let mut symbols = 0;
    let mut calls = 0;
    let started = Instant::now();
    let walker = WalkBuilder::new(&snapshot.path)
        .hidden(true)
        .require_git(false)
        .follow_links(false)
        .max_depth(Some(64))
        .filter_entry(|entry| {
            entry.depth() == 0
                || !matches!(
                    entry.file_name().to_str(),
                    Some(
                        ".git"
                            | ".workbench"
                            | "node_modules"
                            | "target"
                            | "dist"
                            | "build"
                            | ".next"
                            | ".venv"
                            | "venv"
                            | "__pycache__"
                            | ".bundle"
                            | "vendor"
                            | "coverage"
                    )
                )
        })
        .build();
    for entry in walker {
        if started.elapsed() > REFRESH_LIMIT
            || seen.len() >= FILE_COUNT_LIMIT
            || records >= RECORD_LIMIT
            || symbols >= SYMBOL_LIMIT
            || calls >= CALL_LIMIT
        {
            status.limited = true;
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                status.skipped += 1;
                continue;
            }
        };
        if !entry.file_type().is_some_and(|kind| kind.is_file()) || !source_file(entry.path()) {
            continue;
        }
        if matches!(
            entry.file_name().to_str(),
            Some("package-lock.json" | "Cargo.lock")
        ) {
            continue;
        }
        let document = match snapshot.read_document(entry.path()) {
            Ok(document) => document,
            Err(_) => {
                status.skipped += 1;
                continue;
            }
        };
        if document.content.len() > FILE_LIMIT {
            status.skipped += 1;
            continue;
        }
        if status.indexed_bytes + document.content.len() > TOTAL_LIMIT {
            status.limited = true;
            break;
        }
        let relative = entry
            .path()
            .strip_prefix(&snapshot.path)
            .map_err(error)?
            .to_string_lossy()
            .replace('\\', "/");
        seen.insert(relative.clone());
        status.indexed_bytes += document.content.len();
        let previous: Option<String> = transaction
            .query_row(
                "SELECT version FROM files WHERE path=?1",
                [&relative],
                |row| row.get(0),
            )
            .optional()
            .map_err(error)?;
        if previous.as_deref() == Some(document.version.as_str()) {
            let (entry_count, symbol_count): (usize, usize) = transaction
                .query_row(
                    "SELECT count(*), coalesce(sum(kind='symbol'),0) FROM entries WHERE path=?1",
                    [&relative],
                    |row| {
                        Ok((
                            row.get::<_, u32>(0)? as usize,
                            row.get::<_, u32>(1)? as usize,
                        ))
                    },
                )
                .map_err(error)?;
            records += entry_count;
            symbols += symbol_count;
            calls += transaction.query_row("SELECT count(*) FROM calls JOIN entries ON entries.id=calls.caller WHERE entries.path=?1", [&relative], |row| row.get::<_, u32>(0)).map_err(error)? as usize;
            continue;
        }
        remove_file(&transaction, &relative)?;
        transaction
            .execute(
                "INSERT INTO files(path,version,bytes) VALUES(?1,?2,?3)",
                params![relative, document.version, document.content.len() as u32],
            )
            .map_err(error)?;
        let map = TextMap::new(&document.content);
        let mut offset = 0;
        loop {
            let end = snippet_end(&document.content, offset, CHUNK_BYTES, CHUNK_LINES);
            let range = map.range(&document.content, offset, end);
            let id = hash(format!("chunk\0{relative}\0{offset}"));
            insert_entry(
                &transaction,
                &EntryData {
                    id,
                    kind: "chunk".into(),
                    path: relative.clone(),
                    name: String::new(),
                    qualified_name: String::new(),
                    symbol_kind: String::new(),
                    range: range.clone(),
                    selection: range.clone(),
                    snippet_range: range,
                    content: document.content[offset..end].into(),
                },
            )?;
            offset = end;
            records += 1;
            if offset >= document.content.len() || records >= RECORD_LIMIT {
                status.limited |= offset < document.content.len();
                break;
            }
        }
        let analysis = analyze(entry.path(), &relative, &document.content, &map)?;
        status.limited |= analysis.limited;
        status.limited |= analysis.symbols.len()
            > (SYMBOL_LIMIT - symbols).min(RECORD_LIMIT - records)
            || analysis.calls.len() > CALL_LIMIT - calls;
        for symbol in analysis
            .symbols
            .into_iter()
            .take((SYMBOL_LIMIT - symbols).min(RECORD_LIMIT - records))
        {
            insert_entry(&transaction, &symbol)?;
            records += 1;
            symbols += 1;
        }
        for call in analysis.calls.into_iter().take(CALL_LIMIT - calls) {
            transaction.execute("INSERT INTO calls(id,caller,name,range_json) SELECT ?1,?2,?3,?4 WHERE EXISTS(SELECT 1 FROM entries WHERE id=?2)", params![call.id, call.caller, call.name, serde_json::to_string(&call.range).map_err(error)?]).map_err(error)?;
            calls += 1;
        }
    }
    let paths: Vec<String> = transaction
        .prepare("SELECT path FROM files")
        .map_err(error)?
        .query_map([], |row| row.get(0))
        .map_err(error)?
        .collect::<rusqlite::Result<_>>()
        .map_err(error)?;
    for path in paths {
        if !seen.contains(&path) {
            remove_file(&transaction, &path)?;
        }
    }
    status.limited |= infer_edges(&transaction)?;
    counts(&transaction, &mut status)?;
    status.state = "ready".into();
    status.updated_at = Some(now());
    status.generation = handle
        .status
        .lock()
        .map_err(|_| error("status is unavailable"))?
        .generation
        + 1;
    traversal::advance_graph_revision(&transaction)?;
    transaction
        .execute(
            "INSERT OR REPLACE INTO metadata(key,value) VALUES('status',?1)",
            [serde_json::to_string(&status).map_err(error)?],
        )
        .map_err(error)?;
    transaction.commit().map_err(error)?;
    Ok(status)
}

fn remove_file(connection: &Connection, path: &str) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM search_fts WHERE id IN (SELECT id FROM entries WHERE path=?1)",
            [path],
        )
        .map_err(error)?;
    connection
        .execute("DELETE FROM files WHERE path=?1", [path])
        .map_err(error)?;
    Ok(())
}

struct EntryData {
    id: String,
    kind: String,
    path: String,
    name: String,
    qualified_name: String,
    symbol_kind: String,
    range: SourceRange,
    selection: SourceRange,
    snippet_range: SourceRange,
    content: String,
}

fn insert_entry(connection: &Connection, value: &EntryData) -> Result<(), String> {
    connection.execute("INSERT INTO entries(id,kind,path,name,qualified_name,symbol_kind,range_json,selection_json,snippet_range_json,content) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)", params![value.id,value.kind,value.path,value.name,value.qualified_name,value.symbol_kind,serde_json::to_string(&value.range).map_err(error)?,serde_json::to_string(&value.selection).map_err(error)?,serde_json::to_string(&value.snippet_range).map_err(error)?,value.content]).map_err(error)?;
    connection
        .execute(
            "INSERT INTO search_fts(id,path,name,qualified_name,content) VALUES(?1,?2,?3,?4,?5)",
            params![
                value.id,
                value.path,
                value.name,
                value.qualified_name,
                value.content
            ],
        )
        .map_err(error)?;
    Ok(())
}

struct TextMap {
    lines: Vec<usize>,
}
impl TextMap {
    fn new(text: &str) -> Self {
        let mut lines = vec![0];
        let bytes = text.as_bytes();
        let mut offset = 0;
        while offset < bytes.len() {
            match bytes[offset] {
                b'\r' => {
                    offset += 1;
                    if bytes.get(offset) == Some(&b'\n') {
                        offset += 1;
                    }
                    lines.push(offset);
                }
                b'\n' => {
                    offset += 1;
                    lines.push(offset);
                }
                _ => offset += 1,
            }
        }
        Self { lines }
    }
    fn position(&self, text: &str, offset: usize) -> Position {
        let line = self
            .lines
            .partition_point(|start| *start <= offset)
            .saturating_sub(1);
        Position {
            line: line as u32,
            character: text[self.lines[line]..offset.min(self.line_end(text, line))]
                .encode_utf16()
                .count() as u32,
        }
    }
    fn line_end(&self, text: &str, line: usize) -> usize {
        let mut end = self.lines.get(line + 1).copied().unwrap_or(text.len());
        while end > self.lines[line] && matches!(text.as_bytes()[end - 1], b'\r' | b'\n') {
            end -= 1;
        }
        end
    }
    fn offset(&self, text: &str, position: Position) -> Option<usize> {
        let line = position.line as usize;
        let start = *self.lines.get(line)?;
        let mut units = 0;
        for (offset, character) in text[start..self.line_end(text, line)].char_indices() {
            if units == position.character {
                return Some(start + offset);
            }
            units += character.len_utf16() as u32;
        }
        (units == position.character).then(|| self.line_end(text, line))
    }
    fn range(&self, text: &str, start: usize, end: usize) -> SourceRange {
        SourceRange {
            start: self.position(text, start),
            end: self.position(text, end),
        }
    }
}

fn snippet_end(text: &str, start: usize, bytes: usize, lines: usize) -> usize {
    let mut end = (start + bytes).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    if end > start && text.as_bytes()[end - 1] == b'\r' && text.as_bytes().get(end) == Some(&b'\n')
    {
        end -= 1;
    }
    let mut count = 0;
    let mut offset = start;
    while offset < end {
        if matches!(text.as_bytes()[offset], b'\r' | b'\n') {
            if text.as_bytes()[offset] == b'\r' && text.as_bytes().get(offset + 1) == Some(&b'\n') {
                offset += 1;
            }
            count += 1;
            if count >= lines {
                return offset + 1;
            }
        }
        offset += 1;
    }
    end
}

struct Call {
    id: String,
    caller: String,
    name: String,
    range: SourceRange,
}
struct Analysis {
    symbols: Vec<EntryData>,
    calls: Vec<Call>,
    limited: bool,
}

fn analyze_markdown(relative: &str, text: &str, map: &TextMap) -> Analysis {
    struct Heading {
        level: u8,
        start: usize,
        end: usize,
        selection_start: usize,
        selection_end: usize,
        name: String,
    }
    let mut headings = Vec::new();
    let mut pending: Option<Heading> = None;
    let mut limited = false;
    let started = Instant::now();
    let options = MarkdownOptions::ENABLE_YAML_STYLE_METADATA_BLOCKS;
    for (count, (event, range)) in MarkdownParser::new_ext(text, options)
        .into_offset_iter()
        .enumerate()
    {
        if count >= 200_000
            || headings.len() >= 5000
            || started.elapsed() > Duration::from_millis(500)
        {
            limited = true;
            break;
        }
        match event {
            MarkdownEvent::Start(Tag::Heading { level, .. }) => {
                pending = Some(Heading {
                    level: level as u8,
                    start: range.start,
                    end: range.end,
                    selection_start: range.end,
                    selection_end: range.end,
                    name: String::new(),
                });
            }
            MarkdownEvent::Text(value) | MarkdownEvent::Code(value) => {
                if let Some(heading) = pending.as_mut() {
                    heading.selection_start = heading.selection_start.min(range.start);
                    heading.selection_end = range.end;
                    heading.name.push_str(&value);
                }
            }
            MarkdownEvent::SoftBreak | MarkdownEvent::HardBreak => {
                if let Some(heading) = pending.as_mut() {
                    heading.name.push(' ');
                }
            }
            MarkdownEvent::End(TagEnd::Heading(_)) => {
                if let Some(mut heading) = pending.take() {
                    heading.name = heading.name.trim().into();
                    if !heading.name.is_empty() && heading.name.len() <= 256 {
                        headings.push(heading);
                    } else if heading.name.len() > 256 {
                        limited = true;
                    }
                }
            }
            _ => {}
        }
    }
    let mut symbols = Vec::new();
    let mut scopes: Vec<(u8, &str)> = Vec::new();
    for (index, heading) in headings.iter().enumerate() {
        while scopes.last().is_some_and(|scope| scope.0 >= heading.level) {
            scopes.pop();
        }
        let qualified_name = scopes
            .iter()
            .map(|scope| scope.1)
            .chain([heading.name.as_str()])
            .collect::<Vec<_>>()
            .join("::");
        let section_end = headings[index + 1..]
            .iter()
            .find(|next| next.level <= heading.level)
            .map(|next| next.start)
            .unwrap_or(text.len());
        let snippet_end = snippet_end(text, heading.start, 2048, 30).min(section_end);
        symbols.push(EntryData {
            id: hash(format!("heading\0{relative}\0{}", heading.start)),
            kind: "symbol".into(),
            path: relative.into(),
            name: heading.name.clone(),
            qualified_name,
            symbol_kind: "heading".into(),
            range: map.range(text, heading.start, section_end.max(heading.end)),
            selection: map.range(text, heading.selection_start, heading.selection_end),
            snippet_range: map.range(text, heading.start, snippet_end),
            content: text[heading.start..snippet_end].into(),
        });
        scopes.push((heading.level, &heading.name));
    }
    Analysis {
        symbols,
        calls: Vec::new(),
        limited,
    }
}

fn grammar(path: &Path) -> Option<tree_sitter::Language> {
    Some(match path.extension().and_then(|value| value.to_str()) {
        Some("rs") => tree_sitter_rust::LANGUAGE.into(),
        Some("py" | "pyi") => tree_sitter_python::LANGUAGE.into(),
        Some("ts" | "mts" | "cts") => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        Some("tsx") => tree_sitter_typescript::LANGUAGE_TSX.into(),
        Some("js" | "jsx" | "mjs" | "cjs") => tree_sitter_javascript::LANGUAGE.into(),
        Some("rb" | "rake" | "gemspec" | "ru") => tree_sitter_ruby::LANGUAGE.into(),
        Some("go") => tree_sitter_go::LANGUAGE.into(),
        _ if matches!(
            path.file_name().and_then(|value| value.to_str()),
            Some("Gemfile" | "Rakefile" | "Guardfile" | "Brewfile")
        ) =>
        {
            tree_sitter_ruby::LANGUAGE.into()
        }
        _ => return None,
    })
}

fn definition(node: Node<'_>) -> Option<(&'static str, Node<'_>)> {
    let kind = match node.kind() {
        "function_item"
        | "function_definition"
        | "function_declaration"
        | "generator_function_declaration"
        | "function_signature" => "function",
        "method" | "singleton_method" | "method_definition" | "method_declaration"
        | "method_signature" => "method",
        "class_definition" | "class_declaration" | "class" => "class",
        "struct_item" => "struct",
        "enum_item" | "enum_declaration" => "enum",
        "trait_item" | "interface_declaration" => "interface",
        "mod_item" | "module" => "module",
        "type_item" | "type_alias_declaration" | "type_spec" => "type",
        "impl_item" => return node.child_by_field_name("type").map(|name| ("impl", name)),
        "variable_declarator"
            if node.child_by_field_name("value").is_some_and(|value| {
                matches!(
                    value.kind(),
                    "arrow_function" | "function_expression" | "generator_function"
                )
            }) =>
        {
            "function"
        }
        _ => return None,
    };
    node.child_by_field_name("name").map(|name| (kind, name))
}

fn call_name(mut node: Node<'_>) -> Option<Node<'_>> {
    for _ in 0..8 {
        if matches!(
            node.kind(),
            "identifier" | "field_identifier" | "property_identifier" | "constant"
        ) {
            return Some(node);
        }
        node = node
            .child_by_field_name("field")
            .or_else(|| node.child_by_field_name("property"))
            .or_else(|| node.child_by_field_name("attribute"))
            .or_else(|| node.child_by_field_name("name"))
            .or_else(|| node.child_by_field_name("function"))?;
    }
    None
}

fn analyze(path: &Path, relative: &str, text: &str, map: &TextMap) -> Result<Analysis, String> {
    if matches!(
        path.extension().and_then(|value| value.to_str()),
        Some("md" | "markdown")
    ) {
        return Ok(analyze_markdown(relative, text, map));
    }
    let mut analysis = Analysis {
        symbols: Vec::new(),
        calls: Vec::new(),
        limited: false,
    };
    let Some(language) = grammar(path) else {
        return Ok(analysis);
    };
    let mut parser = Parser::new();
    parser.set_language(&language).map_err(error)?;
    let started = Instant::now();
    let mut progress = |_: &tree_sitter::ParseState| {
        if started.elapsed() > Duration::from_millis(500) {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    };
    let Some(tree) = parser.parse_with_options(
        &mut |offset, _| &text.as_bytes()[offset.min(text.len())..],
        None,
        Some(ParseOptions::new().progress_callback(&mut progress)),
    ) else {
        analysis.limited = true;
        return Ok(analysis);
    };
    let mut cursor = tree.walk();
    let mut scopes: Vec<(usize, String, String, bool)> = Vec::new();
    let mut visited = 0;
    loop {
        let node = cursor.node();
        visited += 1;
        if visited > 200_000 || analysis.symbols.len() >= 5000 || analysis.calls.len() >= 20_000 {
            analysis.limited = true;
            break;
        }
        while scopes
            .last()
            .is_some_and(|scope| scope.0 <= node.start_byte())
        {
            scopes.pop();
        }
        if let Some((kind, name_node)) = definition(node) {
            let name = name_node
                .utf8_text(text.as_bytes())
                .unwrap_or_default()
                .trim();
            if !name.is_empty() && name.len() <= 256 {
                let qualified_name = scopes
                    .iter()
                    .map(|scope| scope.1.as_str())
                    .chain([name])
                    .collect::<Vec<_>>()
                    .join("::");
                let id = hash(format!(
                    "symbol\0{relative}\0{kind}\0{qualified_name}\0{}",
                    node.start_byte()
                ));
                let end = snippet_end(text, node.start_byte(), 2048, 30).min(node.end_byte());
                analysis.symbols.push(EntryData {
                    id: id.clone(),
                    kind: "symbol".into(),
                    path: relative.into(),
                    name: name.into(),
                    qualified_name,
                    symbol_kind: kind.into(),
                    range: map.range(text, node.start_byte(), node.end_byte()),
                    selection: map.range(text, name_node.start_byte(), name_node.end_byte()),
                    snippet_range: map.range(text, node.start_byte(), end),
                    content: text[node.start_byte()..end].into(),
                });
                scopes.push((
                    node.end_byte(),
                    name.into(),
                    id,
                    matches!(kind, "function" | "method"),
                ));
            }
        }
        if matches!(node.kind(), "call_expression" | "call") {
            let function = node
                .child_by_field_name("function")
                .or_else(|| node.child_by_field_name("method"));
            if let Some((callee, caller)) = function
                .and_then(call_name)
                .zip(scopes.iter().rev().find(|scope| scope.3))
            {
                let name = callee.utf8_text(text.as_bytes()).unwrap_or_default();
                if !name.is_empty() && name.len() <= 256 {
                    analysis.calls.push(Call {
                        id: hash(format!("call\0{relative}\0{}", callee.start_byte())),
                        caller: caller.2.clone(),
                        name: name.into(),
                        range: map.range(text, callee.start_byte(), callee.end_byte()),
                    });
                }
            }
        }
        if cursor.goto_first_child() {
            continue;
        }
        while !cursor.goto_next_sibling() {
            if !cursor.goto_parent() {
                return Ok(analysis);
            }
        }
    }
    Ok(analysis)
}

fn infer_edges(connection: &Connection) -> Result<bool, String> {
    connection
        .execute("DELETE FROM edges WHERE evidence!='verified'", [])
        .map_err(error)?;
    let mut symbols = connection.prepare("SELECT entries.id,files.version,entries.path,entries.name FROM entries JOIN files ON files.path=entries.path WHERE entries.kind='symbol' ORDER BY entries.id").map_err(error)?;
    let rows = symbols
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(error)?;
    let mut candidates: HashMap<(String, Language), Vec<(String, String)>> = HashMap::new();
    for row in rows {
        let (id, version, path, name) = row.map_err(error)?;
        if let Some(language) = Language::for_path(Path::new(&path)) {
            let entries = candidates.entry((name, language)).or_default();
            if entries.len() < 9 {
                entries.push((id, version));
            }
        }
    }
    let mut calls = connection.prepare("SELECT calls.caller,calls.name,calls.range_json,files.version,entries.path FROM calls JOIN entries ON entries.id=calls.caller JOIN files ON files.path=entries.path ORDER BY calls.id").map_err(error)?;
    let calls = calls
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(error)?;
    let mut edges: BTreeMap<(String, String), IndexEdge> = BTreeMap::new();
    let mut contributions = 0;
    let started = Instant::now();
    let mut limited = false;
    for call in calls {
        if contributions >= CALL_LIMIT || started.elapsed() > Duration::from_secs(10) {
            limited = true;
            break;
        }
        let (from, name, range, source_version, path) = call.map_err(error)?;
        let Some(language) = Language::for_path(Path::new(&path)) else {
            continue;
        };
        let targets = candidates
            .get(&(name, language))
            .map(Vec::as_slice)
            .unwrap_or_default();
        let evidence = if targets.len() == 1 {
            "inferred"
        } else {
            "ambiguous"
        };
        let range: SourceRange = serde_json::from_str(&range).map_err(error)?;
        if targets.len() > 8 {
            limited = true;
        }
        for (to, target_version) in targets.iter().take(8) {
            if contributions >= CALL_LIMIT {
                limited = true;
                break;
            }
            contributions += 1;
            let edge = edges
                .entry((from.clone(), to.clone()))
                .or_insert_with(|| IndexEdge {
                    id: hash(format!("inferred\0{from}\0{to}")),
                    from: from.clone(),
                    to: to.clone(),
                    kind: "call".into(),
                    evidence: evidence.into(),
                    ranges: Vec::new(),
                    source_version: source_version.clone(),
                    target_version: target_version.clone(),
                });
            if edge.ranges.len() < 128 {
                edge.ranges.push(range.clone());
            } else {
                limited = true;
            }
        }
    }
    for edge in edges.values() {
        connection.execute("INSERT INTO edges(id,from_id,to_id,evidence,ranges_json,source_version,target_version) SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE NOT EXISTS(SELECT 1 FROM edges WHERE from_id=?2 AND to_id=?3 AND evidence='verified')", params![edge.id,edge.from,edge.to,edge.evidence,serde_json::to_string(&edge.ranges).map_err(error)?,edge.source_version,edge.target_version]).map_err(error)?;
    }
    Ok(limited)
}

struct Record {
    data: EntryData,
    version: String,
}
fn record(connection: &Connection, id: &str) -> Result<Option<Record>, String> {
    let raw = connection.query_row("SELECT entries.id,entries.kind,entries.path,entries.name,entries.qualified_name,entries.symbol_kind,entries.range_json,entries.selection_json,entries.snippet_range_json,entries.content,files.version FROM entries JOIN files ON files.path=entries.path WHERE entries.id=?1", [id], |row| {
        Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?,row.get::<_,String>(6)?,row.get::<_,String>(7)?,row.get::<_,String>(8)?,row.get::<_,String>(9)?,row.get::<_,String>(10)?))
    }).optional().map_err(error)?;
    raw.map(
        |(
            id,
            kind,
            path,
            name,
            qualified_name,
            symbol_kind,
            range,
            selection,
            snippet,
            content,
            version,
        )| {
            Ok(Record {
                data: EntryData {
                    id,
                    kind,
                    path,
                    name,
                    qualified_name,
                    symbol_kind,
                    range: serde_json::from_str(&range).map_err(error)?,
                    selection: serde_json::from_str(&selection).map_err(error)?,
                    snippet_range: serde_json::from_str(&snippet).map_err(error)?,
                    content,
                },
                version,
            })
        },
    )
    .transpose()
}

impl Record {
    fn node(&self, root: &Path) -> Result<IndexNode, String> {
        let path = root.join(&self.data.path);
        Ok(IndexNode {
            id: self.data.id.clone(),
            name: self.data.name.clone(),
            qualified_name: self.data.qualified_name.clone(),
            kind: self.data.symbol_kind.clone(),
            path: path.to_string_lossy().into_owned(),
            uri: path_to_uri(&path).map_err(error)?,
            range: self.data.range.clone(),
            selection_range: self.data.selection.clone(),
            version: self.version.clone(),
        })
    }
    fn fresh(
        &self,
        snapshot: &WorkspaceRoot,
        versions: &mut HashMap<String, Option<String>>,
    ) -> bool {
        versions
            .entry(self.data.path.clone())
            .or_insert_with(|| {
                snapshot
                    .read_document(&snapshot.path.join(&self.data.path))
                    .ok()
                    .map(|document| document.version)
            })
            .as_deref()
            == Some(self.version.as_str())
    }
}

fn query_ids(connection: &Connection, sql: &str, query: &str) -> Result<Vec<String>, String> {
    connection
        .prepare(sql)
        .map_err(error)?
        .query_map([query], |row| row.get(0))
        .map_err(error)?
        .collect::<rusqlite::Result<_>>()
        .map_err(error)
}

fn fts_query(query: &str) -> String {
    query
        .split(|character: char| !character.is_alphanumeric() && character != '_')
        .filter(|part| !part.is_empty())
        .take(12)
        .map(|part| format!("\"{}\"*", part.chars().take(64).collect::<String>()))
        .collect::<Vec<_>>()
        .join(" OR ")
}

fn add_ranks(
    scores: &mut BTreeMap<String, (f64, Vec<String>)>,
    ids: Vec<String>,
    weight: f64,
    reason: &str,
) {
    for (rank, id) in ids.into_iter().enumerate() {
        let entry = scores.entry(id).or_default();
        entry.0 += weight / (60.0 + rank as f64 + 1.0);
        entry.1.push(reason.into());
    }
}

impl IndexState {
    pub(crate) fn search(
        &self,
        snapshot: &WorkspaceRoot,
        cache_dir: &Path,
        request: &IndexSearch,
    ) -> Result<Vec<IndexHit>, String> {
        let query = request.query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        if query.len() > 512 {
            return Err(error("search queries are limited to 512 bytes"));
        }
        let handle = self.handle(&snapshot.path, cache_dir)?;
        let connection = connect(&handle.database, false)?;
        let mut scores = BTreeMap::new();
        add_ranks(
            &mut scores,
            query_ids(
                &connection,
                "SELECT id FROM entries WHERE kind='symbol' AND (name=?1 COLLATE NOCASE OR qualified_name=?1 COLLATE NOCASE) ORDER BY id LIMIT 200",
                query,
            )?,
            3.0,
            "Exact symbol",
        );
        let relative = query
            .strip_prefix(&format!("{}/", snapshot.path.display()))
            .unwrap_or(query);
        add_ranks(
            &mut scores,
            query_ids(
                &connection,
                "SELECT id FROM entries WHERE path=?1 ORDER BY kind DESC,id LIMIT 100",
                relative,
            )?,
            3.0,
            "Exact path",
        );
        let terms = fts_query(query);
        if !terms.is_empty() {
            add_ranks(
                &mut scores,
                query_ids(
                    &connection,
                    "SELECT id FROM search_fts WHERE search_fts MATCH ?1 ORDER BY bm25(search_fts,0,4,12,8,1) LIMIT 200",
                    &terms,
                )?,
                1.0,
                "Text match",
            );
        }
        let pattern = format!(
            "%{}%",
            query
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        add_ranks(
            &mut scores,
            query_ids(
                &connection,
                "SELECT id FROM entries WHERE name LIKE ?1 ESCAPE '\\' OR path LIKE ?1 ESCAPE '\\' ORDER BY kind DESC,id LIMIT 200",
                &pattern,
            )?,
            0.7,
            "Path or symbol match",
        );
        if let Some(anchor) = request.anchor_symbol_id.as_deref() {
            let graph = self.neighbors(
                snapshot,
                cache_dir,
                &IndexNeighbors {
                    symbol_id: anchor.into(),
                    direction: None,
                    limit: Some(100),
                },
            )?;
            for (rank, edge) in graph.edges.into_iter().enumerate() {
                let id = if edge.from == anchor {
                    edge.to
                } else {
                    edge.from
                };
                if let Some(entry) = scores.get_mut(&id) {
                    entry.0 += 0.5 / (61.0 + rank as f64);
                    entry.1.push("Nearby in call graph".into());
                }
            }
        }
        let mut ranked = scores.into_iter().collect::<Vec<_>>();
        ranked.sort_by(|(a, av), (b, bv)| bv.0.total_cmp(&av.0).then_with(|| a.cmp(b)));
        let mut versions = HashMap::new();
        let mut ranges = HashSet::new();
        let mut hits = Vec::new();
        let mut stale = false;
        for (id, (score, reasons)) in ranked {
            let Some(record) = record(&connection, &id)? else {
                continue;
            };
            if !record.fresh(snapshot, &mut versions) {
                stale = true;
                continue;
            }
            let range = &record.data.snippet_range;
            let identity = (
                record.data.path.clone(),
                range.start.line,
                range.start.character,
                range.end.line,
                range.end.character,
            );
            if !ranges.insert(identity) {
                continue;
            }
            let node = record.node(&snapshot.path)?;
            hits.push(IndexHit {
                id,
                kind: record.data.kind.clone(),
                symbol_kind: (!record.data.symbol_kind.is_empty())
                    .then_some(record.data.symbol_kind),
                path: node.path,
                uri: node.uri,
                range: record.data.snippet_range,
                selection_range: (record.data.kind == "symbol").then_some(record.data.selection),
                name: (!record.data.name.is_empty()).then_some(record.data.name),
                qualified_name: (!record.data.qualified_name.is_empty())
                    .then_some(record.data.qualified_name),
                content: record.data.content,
                version: record.version,
                score,
                reasons,
            });
            if hits.len() >= request.limit.unwrap_or(20).clamp(1, 50) {
                break;
            }
        }
        if stale && let Ok(mut status) = handle.status.lock() {
            status.stale = true;
        }
        Ok(hits)
    }

    pub(crate) fn neighbors(
        &self,
        snapshot: &WorkspaceRoot,
        cache_dir: &Path,
        request: &IndexNeighbors,
    ) -> Result<IndexGraph, String> {
        if request.symbol_id.len() > 128 {
            return Err(error("invalid symbol id"));
        }
        let handle = self.handle(&snapshot.path, cache_dir)?;
        let connection = connect(&handle.database, false)?;
        let mut versions = HashMap::new();
        let Some(anchor) =
            record(&connection, &request.symbol_id)?.filter(|record| record.data.kind == "symbol")
        else {
            return Ok(IndexGraph {
                nodes: Vec::new(),
                edges: Vec::new(),
            });
        };
        if !anchor.fresh(snapshot, &mut versions) {
            if let Ok(mut status) = handle.status.lock() {
                status.stale = true;
            }
            return Ok(IndexGraph {
                nodes: Vec::new(),
                edges: Vec::new(),
            });
        }
        let condition = match request.direction.unwrap_or_default() {
            IndexDirection::Incoming => "to_id=?1",
            IndexDirection::Outgoing => "from_id=?1",
            IndexDirection::Both => "from_id=?1 OR to_id=?1",
        };
        let sql = format!(
            "SELECT id,from_id,to_id,evidence,ranges_json,source_version,target_version FROM edges WHERE {condition} ORDER BY CASE evidence WHEN 'verified' THEN 0 WHEN 'inferred' THEN 1 ELSE 2 END,id LIMIT ?2"
        );
        let mut statement = connection.prepare(&sql).map_err(error)?;
        let rows = statement
            .query_map(
                params![
                    request.symbol_id,
                    request.limit.unwrap_or(40).clamp(1, 100) as u32
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )
            .map_err(error)?;
        let mut nodes = BTreeMap::new();
        nodes.insert(anchor.data.id.clone(), anchor.node(&snapshot.path)?);
        let mut edges = Vec::new();
        let mut stale = false;
        for row in rows {
            let (id, from, to, evidence, ranges, source_version, target_version) =
                row.map_err(error)?;
            let (Some(source), Some(target)) =
                (record(&connection, &from)?, record(&connection, &to)?)
            else {
                continue;
            };
            if source.version != source_version
                || target.version != target_version
                || !source.fresh(snapshot, &mut versions)
                || !target.fresh(snapshot, &mut versions)
            {
                stale = true;
                continue;
            }
            nodes.insert(from.clone(), source.node(&snapshot.path)?);
            nodes.insert(to.clone(), target.node(&snapshot.path)?);
            edges.push(IndexEdge {
                id,
                from,
                to,
                kind: "call".into(),
                evidence,
                ranges: serde_json::from_str(&ranges).map_err(error)?,
                source_version,
                target_version,
            });
        }
        if stale && let Ok(mut status) = handle.status.lock() {
            status.stale = true;
        }
        Ok(IndexGraph {
            nodes: nodes.into_values().collect(),
            edges,
        })
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSymbol {
    pub name: String,
    pub uri: String,
    pub range: SourceRange,
    pub selection_range: SourceRange,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRelation {
    pub from: GraphSymbol,
    pub to: GraphSymbol,
    pub from_ranges: Vec<SourceRange>,
}
#[derive(Debug, Deserialize)]
pub struct GraphEvidence {
    pub root: GraphSymbol,
    pub incoming: Vec<GraphRelation>,
    pub outgoing: Vec<GraphRelation>,
    #[serde(default)]
    pub relations: Vec<GraphRelation>,
}
#[derive(Debug, Serialize)]
pub struct GraphRecorded {
    pub recorded: usize,
    pub skipped: usize,
}

fn graph_symbol(
    connection: &Connection,
    snapshot: &WorkspaceRoot,
    symbol: &GraphSymbol,
    expected: &HashMap<String, String>,
    versions: &mut HashMap<String, Option<String>>,
) -> Result<Option<Record>, String> {
    if symbol.uri.len() > 8192 || symbol.name.len() > 256 {
        return Ok(None);
    }
    let Ok(path) = uri_to_path(&symbol.uri) else {
        return Ok(None);
    };
    let Ok(relative) = path.strip_prefix(&snapshot.path) else {
        return Ok(None);
    };
    let relative = relative.to_string_lossy().replace('\\', "/");
    let Some(version) = expected.get(&symbol.uri) else {
        return Ok(None);
    };
    let ids = connection
        .prepare("SELECT id FROM entries WHERE kind='symbol' AND path=?1 AND name=?2")
        .map_err(error)?
        .query_map(params![relative, symbol.name], |row| {
            row.get::<_, String>(0)
        })
        .map_err(error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(error)?;
    for id in ids {
        if let Some(record) = record(connection, &id)?
            && record.version == *version
            && record.data.selection == symbol.selection_range
            && record.fresh(snapshot, versions)
        {
            let Ok(document) = snapshot.read_document(&path) else {
                return Ok(None);
            };
            let map = TextMap::new(&document.content);
            if document.version == *version
                && valid_range(&map, &document.content, &symbol.range)
                && contains_range(&symbol.range, &symbol.selection_range)
            {
                return Ok(Some(record));
            }
        }
    }
    Ok(None)
}

fn position_key(position: Position) -> (u32, u32) {
    (position.line, position.character)
}

fn contains_range(outer: &SourceRange, inner: &SourceRange) -> bool {
    position_key(outer.start) <= position_key(inner.start)
        && position_key(inner.end) <= position_key(outer.end)
}

fn valid_range(map: &TextMap, text: &str, range: &SourceRange) -> bool {
    position_key(range.start) < position_key(range.end)
        && map.offset(text, range.start).is_some()
        && map.offset(text, range.end).is_some()
}

impl IndexState {
    fn record_graph(
        &self,
        snapshot: &WorkspaceRoot,
        cache_dir: &Path,
        graph: &GraphEvidence,
        versions: &HashMap<String, String>,
    ) -> Result<GraphRecorded, String> {
        if graph.incoming.len() + graph.outgoing.len() + graph.relations.len() > 128
            || versions.len() > 256
        {
            return Err(error("this graph exceeds the evidence limit"));
        }
        if graph
            .incoming
            .iter()
            .chain(&graph.outgoing)
            .chain(&graph.relations)
            .map(|relation| relation.from_ranges.len())
            .sum::<usize>()
            > 4096
        {
            return Err(error("this graph exceeds the source range limit"));
        }
        let handle = self.handle(&snapshot.path, cache_dir)?;
        let mut connection = connect(&handle.database, true)?;
        let transaction = connection.transaction().map_err(error)?;
        let mut current = HashMap::new();
        let mut reply = GraphRecorded {
            recorded: 0,
            skipped: 0,
        };
        let root = graph_symbol(&transaction, snapshot, &graph.root, versions, &mut current)?;
        for (relation, incoming) in graph
            .incoming
            .iter()
            .map(|relation| (relation, Some(true)))
            .chain(
                graph
                    .outgoing
                    .iter()
                    .map(|relation| (relation, Some(false))),
            )
            .chain(graph.relations.iter().map(|relation| (relation, None)))
        {
            if (incoming.is_some() && root.is_none()) || relation.from_ranges.is_empty() {
                reply.skipped += 1;
                continue;
            }
            let (Some(from), Some(to)) = (
                graph_symbol(
                    &transaction,
                    snapshot,
                    &relation.from,
                    versions,
                    &mut current,
                )?,
                graph_symbol(&transaction, snapshot, &relation.to, versions, &mut current)?,
            ) else {
                reply.skipped += 1;
                continue;
            };
            if let Some(incoming) = incoming
                && root.as_ref().is_none_or(|root| {
                    if incoming {
                        to.data.id != root.data.id
                    } else {
                        from.data.id != root.data.id
                    }
                })
            {
                reply.skipped += 1;
                continue;
            }
            let document = match snapshot.read_document(&snapshot.path.join(&from.data.path)) {
                Ok(document) if document.version == from.version => document,
                _ => {
                    reply.skipped += 1;
                    continue;
                }
            };
            let map = TextMap::new(&document.content);
            if !relation.from_ranges.iter().all(|range| {
                valid_range(&map, &document.content, range)
                    && contains_range(&from.data.range, range)
            }) {
                reply.skipped += 1;
                continue;
            }
            let id = hash(format!("verified\0{}\0{}", from.data.id, to.data.id));
            transaction
                .execute(
                    "DELETE FROM edges WHERE from_id=?1 AND to_id=?2",
                    params![from.data.id, to.data.id],
                )
                .map_err(error)?;
            transaction.execute("INSERT INTO edges(id,from_id,to_id,evidence,ranges_json,source_version,target_version) VALUES(?1,?2,?3,'verified',?4,?5,?6)", params![id,from.data.id,to.data.id,serde_json::to_string(&relation.from_ranges).map_err(error)?,from.version,to.version]).map_err(error)?;
            reply.recorded += 1;
        }
        if reply.recorded > 0 {
            traversal::advance_graph_revision(&transaction)?;
        }
        transaction.commit().map_err(error)?;
        if let Ok(mut status) = handle.status.lock() {
            counts(&connection, &mut status)?;
        }
        Ok(reply)
    }
}

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|path| path.join("code-index"))
        .map_err(error)
}

fn check_workspace(workspace: &WorkspaceState, root: &Path) -> Result<(), String> {
    if workspace.root_path()? != root {
        return Err(error("the selected workspace changed; discard this result"));
    }
    Ok(())
}

#[tauri::command]
pub async fn index_status(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    index: State<'_, IndexState>,
    auth: String,
) -> Result<IndexStatus, String> {
    host.check(&window, &auth)?;
    let root = workspace.root_path()?;
    let cache = cache_dir(&app)?;
    let index = index.inner().clone();
    let worker_root = root.clone();
    let result = tauri::async_runtime::spawn_blocking(move || index.status(&worker_root, &cache))
        .await
        .map_err(error)??;
    check_workspace(&workspace, &root)?;
    Ok(result)
}

#[tauri::command]
pub async fn index_refresh(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    index: State<'_, IndexState>,
    auth: String,
) -> Result<IndexStatus, String> {
    host.check(&window, &auth)?;
    let mut activity = window
        .app_handle()
        .state::<HarnessState>()
        .begin_operation("index.refresh");
    activity.record_request(&serde_json::json!({}));
    let result: Result<IndexStatus, String> = async {
        let snapshot = workspace.snapshot()?;
        let root = snapshot.path.clone();
        let cache = cache_dir(&app)?;
        let index = index.inner().clone();
        let result = tauri::async_runtime::spawn_blocking(move || index.refresh(&snapshot, &cache))
            .await
            .map_err(error)??;
        check_workspace(&workspace, &root)?;
        app.state::<NativeEvents>().publish(
            "index:changed",
            serde_json::to_value(&result).map_err(error)?,
        );
        Ok(result)
    }
    .await;
    match &result {
        Ok(value) if value.state == "error" => {
            activity.record_response(&serde_json::json!(value));
            if let Some(message) = &value.last_error {
                activity.record_error(message);
                activity.finish(Outcome::error(message));
            } else {
                activity.finish(Outcome::Failed("index_error"));
            }
        }
        _ => activity.record_result(&result),
    }
    result
}

#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "Tauri injects host state alongside named search arguments"
)]
pub async fn index_search(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    index: State<'_, IndexState>,
    auth: String,
    query: String,
    limit: Option<usize>,
    anchor_symbol_id: Option<String>,
) -> Result<Vec<IndexHit>, String> {
    host.check(&window, &auth)?;
    let mut activity = window
        .app_handle()
        .state::<HarnessState>()
        .begin_operation("index.search");
    activity.record_request(
        &serde_json::json!({"query": query, "limit": limit, "anchorSymbolId": anchor_symbol_id}),
    );
    let result: Result<Vec<IndexHit>, String> = async {
        let snapshot = workspace.snapshot()?;
        let root = snapshot.path.clone();
        let cache = cache_dir(&app)?;
        let index = index.inner().clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            index.search(
                &snapshot,
                &cache,
                &IndexSearch {
                    query,
                    limit,
                    anchor_symbol_id,
                },
            )
        })
        .await
        .map_err(error)??;
        check_workspace(&workspace, &root)?;
        Ok(result)
    }
    .await;
    activity.record_result(&result);
    result
}

#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "Tauri injects host state alongside named graph arguments"
)]
pub async fn index_neighbors(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    index: State<'_, IndexState>,
    auth: String,
    symbol_id: String,
    direction: Option<IndexDirection>,
    limit: Option<usize>,
) -> Result<IndexGraph, String> {
    host.check(&window, &auth)?;
    let mut activity = window
        .app_handle()
        .state::<HarnessState>()
        .begin_operation("index.neighbors");
    activity.record_request(
        &serde_json::json!({"symbolId": symbol_id, "direction": direction, "limit": limit}),
    );
    let result: Result<IndexGraph, String> = async {
        let snapshot = workspace.snapshot()?;
        let root = snapshot.path.clone();
        let cache = cache_dir(&app)?;
        let index = index.inner().clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            index.neighbors(
                &snapshot,
                &cache,
                &IndexNeighbors {
                    symbol_id,
                    direction,
                    limit,
                },
            )
        })
        .await
        .map_err(error)??;
        check_workspace(&workspace, &root)?;
        Ok(result)
    }
    .await;
    activity.record_result(&result);
    result
}

#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "Tauri injects host state alongside versioned graph evidence"
)]
pub async fn index_record_graph(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    index: State<'_, IndexState>,
    auth: String,
    graph: GraphEvidence,
    versions: HashMap<String, String>,
) -> Result<GraphRecorded, String> {
    host.check(&window, &auth)?;
    let snapshot = workspace.snapshot()?;
    let root = snapshot.path.clone();
    let cache = cache_dir(&app)?;
    let index = index.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        index.record_graph(&snapshot, &cache, &graph, &versions)
    })
    .await
    .map_err(error)??;
    check_workspace(&workspace, &root)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    struct Fixture {
        directory: TempDir,
        workspace: WorkspaceState,
        index: IndexState,
        cache: PathBuf,
    }

    impl Fixture {
        fn new(files: &[(&str, &str)]) -> Self {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().join("workspace");
            fs::create_dir(&root).unwrap();
            for (relative, text) in files {
                let path = root.join(relative);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, text).unwrap();
            }
            let workspace = WorkspaceState::default();
            workspace.open_folder(&root).unwrap();
            let cache = directory.path().join("cache");
            Self {
                directory,
                workspace,
                index: IndexState::default(),
                cache,
            }
        }
        fn snapshot(&self) -> WorkspaceRoot {
            self.workspace.snapshot().unwrap()
        }
        fn refresh(&self) -> IndexStatus {
            let status = self.index.refresh(&self.snapshot(), &self.cache).unwrap();
            assert_eq!(status.state, "ready", "{:?}", status.last_error);
            status
        }
        fn search(&self, query: &str) -> Vec<IndexHit> {
            self.index
                .search(
                    &self.snapshot(),
                    &self.cache,
                    &IndexSearch {
                        query: query.into(),
                        limit: Some(50),
                        anchor_symbol_id: None,
                    },
                )
                .unwrap()
        }
        fn graph(&self, id: &str) -> IndexGraph {
            self.index
                .neighbors(
                    &self.snapshot(),
                    &self.cache,
                    &IndexNeighbors {
                        symbol_id: id.into(),
                        direction: None,
                        limit: None,
                    },
                )
                .unwrap()
        }
        fn traversal(
            &self,
            id: &str,
            direction: IndexDirection,
            limit: usize,
        ) -> Vec<traversal::IndexTraversalPage> {
            let mut pages = Vec::new();
            let mut cursor = None;
            loop {
                let page = self
                    .index
                    .traverse(
                        &self.snapshot(),
                        &self.cache,
                        &IndexTraverse {
                            symbol_id: id.into(),
                            direction: Some(direction),
                            cursor,
                            limit: Some(limit),
                        },
                    )
                    .unwrap();
                cursor = page.next_cursor.clone();
                pages.push(page);
                if cursor.is_none() {
                    break;
                }
                assert!(pages.len() < 10_000, "traversal did not terminate");
            }
            pages
        }
    }

    fn graph_symbol_from(node: &IndexNode) -> GraphSymbol {
        GraphSymbol {
            name: node.name.clone(),
            uri: node.uri.clone(),
            range: node.range.clone(),
            selection_range: node.selection_range.clone(),
        }
    }

    #[test]
    fn direct_traversal_pages_only_adjacent_branches_and_binds_its_mode() {
        let fixture = Fixture::new(&[(
            "sample.rs",
            "fn parent() { root(); }\nfn root() { left(); right(); root(); }\nfn left() { deep(); }\nfn right() {}\nfn deep() {}\n",
        )]);
        fixture.refresh();
        let root = fixture
            .search("root")
            .into_iter()
            .find(|hit| hit.name.as_deref() == Some("root"))
            .unwrap();
        let request = |cursor| IndexTraverse {
            symbol_id: root.id.clone(),
            direction: Some(IndexDirection::Outgoing),
            cursor,
            limit: Some(1),
        };
        let mut next = None;
        let mut count = 0;
        loop {
            let page = fixture
                .index
                .traverse_mode(&fixture.snapshot(), &fixture.cache, &request(next), true)
                .unwrap();
            assert!(
                page.nodes
                    .iter()
                    .all(|node| node.name != "deep" && node.name != "parent")
            );
            count += page.edges.len();
            if let Some(cursor) = page.next_cursor.as_ref() {
                assert!(
                    fixture
                        .index
                        .traverse(
                            &fixture.snapshot(),
                            &fixture.cache,
                            &request(Some(cursor.clone()))
                        )
                        .is_err()
                );
            }
            next = page.next_cursor;
            if next.is_none() {
                assert!(page.traversal_complete);
                break;
            }
            assert!(count <= 3);
        }
        assert_eq!(count, 3);
    }

    #[test]
    fn direct_traversal_checks_only_the_revealed_adjacency_sources() {
        let fixture = Fixture::new(&[
            ("root.rs", "fn root() { middle(); }\n"),
            ("middle.rs", "fn middle() { leaf(); }\n"),
            ("leaf.rs", "fn leaf() {}\n"),
        ]);
        fixture.refresh();
        let root = fixture
            .search("root")
            .into_iter()
            .find(|hit| hit.name.as_deref() == Some("root"))
            .unwrap();
        fs::write(
            fixture.snapshot().path.join("leaf.rs"),
            "fn leaf() { changed(); }\n",
        )
        .unwrap();
        let request = IndexTraverse {
            symbol_id: root.id,
            direction: Some(IndexDirection::Outgoing),
            cursor: None,
            limit: Some(20),
        };
        let preview = fixture
            .index
            .traverse_mode(&fixture.snapshot(), &fixture.cache, &request, true)
            .unwrap();
        assert_eq!(preview.nodes.len(), 2);
        assert_eq!(preview.edges.len(), 1);
        assert!(!preview.stale);
        assert!(preview.traversal_complete);
        let full = fixture
            .index
            .traverse(&fixture.snapshot(), &fixture.cache, &request)
            .unwrap();
        assert!(full.stale);
        assert!(!full.traversal_complete);
    }

    #[test]
    fn traversal_covers_deep_chains_without_a_depth_cutoff() {
        let mut source = String::new();
        for index in 0..1200 {
            source.push_str(&format!("fn step_{index}() {{ step_{}(); }}\n", index + 1));
        }
        source.push_str("fn step_1200() {}\n");
        let fixture = Fixture::new(&[("deep.rs", &source)]);
        fixture.refresh();
        let root = fixture
            .search("step_0")
            .into_iter()
            .find(|hit| hit.name.as_deref() == Some("step_0"))
            .unwrap();
        let pages = fixture.traversal(&root.id, IndexDirection::Outgoing, 29);
        assert_eq!(
            pages.iter().map(|page| page.edges.len()).sum::<usize>(),
            1200
        );
        assert!(pages.len() > 1);
        assert!(pages.last().unwrap().traversal_complete);
        assert!(pages.iter().all(|page| !page.stale && !page.index_limited));
    }

    #[test]
    fn traversal_pages_preserve_wide_branches_diamonds_and_cycles() {
        let mut source = String::from("fn root() {\n");
        for index in 0..140 {
            source.push_str(&format!("branch_{index}();\n"));
        }
        source.push_str("}\n");
        for index in 0..140 {
            source.push_str(&format!("fn branch_{index}() {{ shared(); }}\n"));
        }
        source.push_str("fn shared() { root(); shared(); }\n");
        let fixture = Fixture::new(&[("wide.rs", &source)]);
        fixture.refresh();
        let root = fixture
            .search("root")
            .into_iter()
            .find(|hit| hit.name.as_deref() == Some("root"))
            .unwrap();
        let pages = fixture.traversal(&root.id, IndexDirection::Both, 29);
        let edges: Vec<_> = pages.iter().flat_map(|page| &page.edges).collect();
        assert_eq!(edges.len(), 282);
        assert_eq!(
            edges
                .iter()
                .map(|edge| &edge.id)
                .collect::<HashSet<_>>()
                .len(),
            edges.len()
        );
        let names: HashSet<_> = pages
            .iter()
            .flat_map(|page| &page.nodes)
            .map(|node| node.name.as_str())
            .collect();
        assert_eq!(names.len(), 142);
        assert!(pages.iter().all(|page| page.edges.len() <= 29));
        assert!(pages.last().unwrap().traversal_complete);
        assert!(
            pages[..pages.len() - 1]
                .iter()
                .all(|page| !page.traversal_complete)
        );
    }

    #[test]
    fn traversal_keeps_ancestor_and_descendant_paths_separate() {
        let fixture = Fixture::new(&[(
            "branches.rs",
            "fn upstream() { parent(); }\nfn parent() { root(); sibling(); }\nfn root() { left(); right(); }\nfn left() { joined(); }\nfn right() { joined(); }\nfn joined() {}\nfn sibling() {}\nfn stranger() { joined(); }\n",
        )]);
        fixture.refresh();
        let root = fixture
            .search("root")
            .into_iter()
            .find(|hit| hit.name.as_deref() == Some("root"))
            .unwrap();
        for (direction, expected) in [
            (IndexDirection::Incoming, vec!["root", "parent", "upstream"]),
            (
                IndexDirection::Outgoing,
                vec!["root", "left", "right", "joined"],
            ),
            (
                IndexDirection::Both,
                vec!["root", "left", "right", "joined", "parent", "upstream"],
            ),
        ] {
            let pages = fixture.traversal(&root.id, direction, 2);
            let names: HashSet<_> = pages
                .iter()
                .flat_map(|page| &page.nodes)
                .map(|node| node.name.as_str())
                .collect();
            assert_eq!(names, expected.into_iter().collect(), "{direction:?}");
        }
    }

    #[test]
    fn traversal_continuations_are_bound_to_workspace_query_and_graph_revision() {
        let fixture = Fixture::new(&[(
            "sample.rs",
            "fn root() { left(); right(); }\nfn left() {}\nfn right() {}\n",
        )]);
        fixture.refresh();
        let root = fixture
            .search("root")
            .into_iter()
            .find(|hit| hit.name.as_deref() == Some("root"))
            .unwrap();
        let request = |cursor| IndexTraverse {
            symbol_id: root.id.clone(),
            direction: Some(IndexDirection::Both),
            cursor,
            limit: Some(1),
        };
        let first = fixture
            .index
            .traverse(&fixture.snapshot(), &fixture.cache, &request(None))
            .unwrap();
        let cursor = first.next_cursor.unwrap();
        let mut changed = request(Some(cursor.clone()));
        changed.direction = Some(IndexDirection::Incoming);
        assert!(
            fixture
                .index
                .traverse(&fixture.snapshot(), &fixture.cache, &changed)
                .is_err()
        );
        changed = request(Some(cursor.clone()));
        changed.symbol_id = first.edges[0].to.clone();
        assert!(
            fixture
                .index
                .traverse(&fixture.snapshot(), &fixture.cache, &changed)
                .is_err()
        );
        let mut tampered: serde_json::Value = serde_json::from_str(&cursor).unwrap();
        tampered["after"] = serde_json::json!("z".repeat(64));
        assert!(
            fixture
                .index
                .traverse(
                    &fixture.snapshot(),
                    &fixture.cache,
                    &request(Some(tampered.to_string()))
                )
                .is_err()
        );
        let other = Fixture::new(&[(
            "sample.rs",
            "fn root() { left(); right(); }\nfn left() {}\nfn right() {}\n",
        )]);
        other.refresh();
        assert!(
            other
                .index
                .traverse(
                    &other.snapshot(),
                    &other.cache,
                    &request(Some(cursor.clone()))
                )
                .is_err()
        );
        let graph = fixture.graph(&root.id);
        let from = graph.nodes.iter().find(|node| node.id == root.id).unwrap();
        let target = graph
            .nodes
            .iter()
            .find(|node| node.id == graph.edges[0].to)
            .unwrap();
        let versions = graph
            .nodes
            .iter()
            .map(|node| (node.uri.clone(), node.version.clone()))
            .collect();
        let recorded = fixture
            .index
            .record_graph(
                &fixture.snapshot(),
                &fixture.cache,
                &GraphEvidence {
                    root: graph_symbol_from(from),
                    incoming: vec![],
                    relations: vec![],
                    outgoing: vec![GraphRelation {
                        from: graph_symbol_from(from),
                        to: graph_symbol_from(target),
                        from_ranges: graph.edges[0].ranges.clone(),
                    }],
                },
                &versions,
            )
            .unwrap();
        assert_eq!(recorded.recorded, 1);
        assert!(
            fixture
                .index
                .traverse(
                    &fixture.snapshot(),
                    &fixture.cache,
                    &request(Some(cursor.clone()))
                )
                .is_err()
        );
        let next = fixture
            .index
            .traverse(&fixture.snapshot(), &fixture.cache, &request(None))
            .unwrap()
            .next_cursor;
        fixture.refresh();
        assert!(
            fixture
                .index
                .traverse(&fixture.snapshot(), &fixture.cache, &request(next))
                .is_err()
        );
    }

    #[test]
    fn traversal_reports_stale_links_and_limited_index_coverage() {
        let fixture = Fixture::new(&[
            ("root.rs", "fn root() { child(); }\n"),
            ("child.rs", "fn child() {}\n"),
        ]);
        fixture.refresh();
        let root = fixture
            .search("root")
            .into_iter()
            .find(|hit| hit.name.as_deref() == Some("root"))
            .unwrap();
        fs::write(
            fixture.snapshot().path.join("child.rs"),
            "fn child() { /* changed */ }\n",
        )
        .unwrap();
        let pages = fixture.traversal(&root.id, IndexDirection::Outgoing, 29);
        assert_eq!(pages.len(), 1);
        assert!(pages[0].stale);
        assert_eq!(pages[0].skipped_stale, 1);
        assert!(!pages[0].traversal_complete);
        assert!(pages[0].edges.is_empty());
        fixture.refresh();
        let handle = fixture
            .index
            .handle(&fixture.snapshot().path, &fixture.cache)
            .unwrap();
        let connection = connect(&handle.database, true).unwrap();
        connection.execute("UPDATE metadata SET value=json_set(value,'$.limited',json('true')) WHERE key='status'", []).unwrap();
        let pages = fixture.traversal(&root.id, IndexDirection::Outgoing, 29);
        assert!(pages[0].index_limited);
        assert!(pages[0].traversal_complete);
        assert!(
            pages[0]
                .edges
                .iter()
                .all(|edge| edge.evidence == "inferred")
        );
    }

    #[test]
    fn traversal_prunes_descendants_behind_stale_files_and_rejects_source_changes_between_pages() {
        let fixture = Fixture::new(&[
            ("root.rs", "fn root() { middle(); }\n"),
            ("middle.rs", "fn middle() { next(); }\n"),
            ("next.rs", "fn next() { leaf(); }\n"),
            ("leaf.rs", "fn leaf() {}\n"),
        ]);
        fixture.refresh();
        let root = fixture
            .search("root")
            .into_iter()
            .find(|hit| hit.name.as_deref() == Some("root"))
            .unwrap();
        let first = fixture
            .index
            .traverse(
                &fixture.snapshot(),
                &fixture.cache,
                &IndexTraverse {
                    symbol_id: root.id.clone(),
                    direction: Some(IndexDirection::Outgoing),
                    cursor: None,
                    limit: Some(1),
                },
            )
            .unwrap();
        assert!(first.next_cursor.is_some());
        fs::write(
            fixture.snapshot().path.join("middle.rs"),
            "fn middle() { /* next removed */ }\n",
        )
        .unwrap();
        assert!(
            fixture
                .index
                .traverse(
                    &fixture.snapshot(),
                    &fixture.cache,
                    &IndexTraverse {
                        symbol_id: root.id.clone(),
                        direction: Some(IndexDirection::Outgoing),
                        cursor: first.next_cursor,
                        limit: Some(1),
                    }
                )
                .is_err()
        );
        let pages = fixture.traversal(&root.id, IndexDirection::Outgoing, 29);
        assert_eq!(pages.len(), 1);
        assert!(pages[0].stale);
        assert!(!pages[0].traversal_complete);
        assert_eq!(pages[0].skipped_stale, 3);
        assert!(pages[0].edges.is_empty());
        assert_eq!(pages[0].nodes.len(), 1);
        assert_eq!(pages[0].nodes[0].name, "root");
    }

    #[test]
    fn graph_evidence_batches_record_transitive_internal_links_with_an_external_root() {
        let fixture = Fixture::new(&[(
            "sample.rs",
            "fn root() { middle(); }\nfn middle() { leaf(); }\nfn leaf() {}\n",
        )]);
        fixture.refresh();
        let root = fixture
            .search("root")
            .into_iter()
            .find(|hit| hit.name.as_deref() == Some("root"))
            .unwrap();
        let pages = fixture.traversal(&root.id, IndexDirection::Outgoing, 29);
        let page = &pages[0];
        let nodes = page
            .nodes
            .iter()
            .map(|node| (node.id.as_str(), node))
            .collect::<HashMap<_, _>>();
        let relations = page
            .edges
            .iter()
            .map(|edge| GraphRelation {
                from: graph_symbol_from(nodes[edge.from.as_str()]),
                to: graph_symbol_from(nodes[edge.to.as_str()]),
                from_ranges: edge.ranges.clone(),
            })
            .collect::<Vec<_>>();
        let mut external = graph_symbol_from(nodes[root.id.as_str()]);
        external.uri = "file:///outside-workspace/dependency.rs".into();
        let mut graph = GraphEvidence {
            root: external,
            incoming: vec![],
            outgoing: vec![],
            relations,
        };
        let versions = page
            .nodes
            .iter()
            .map(|node| (node.uri.clone(), node.version.clone()))
            .collect();
        let result = fixture
            .index
            .record_graph(&fixture.snapshot(), &fixture.cache, &graph, &versions)
            .unwrap();
        assert_eq!(result.recorded, 2);
        assert_eq!(result.skipped, 0);
        let pages = fixture.traversal(&root.id, IndexDirection::Outgoing, 29);
        assert!(
            pages[0]
                .edges
                .iter()
                .all(|edge| edge.evidence == "verified")
        );
        graph.relations = vec![graph.relations[0].clone(); 129];
        assert!(
            fixture
                .index
                .record_graph(&fixture.snapshot(), &fixture.cache, &graph, &versions)
                .is_err()
        );
    }

    #[test]
    fn graph_evidence_batches_preserve_dense_call_ranges_within_the_total_budget() {
        let mut source = String::from("fn root() {\n");
        source.push_str(&"  helper();\n".repeat(150));
        source.push_str("}\nfn helper() {}\n");
        let fixture = Fixture::new(&[("dense.rs", &source)]);
        fixture.refresh();
        let root = fixture
            .search("root")
            .into_iter()
            .find(|hit| hit.name.as_deref() == Some("root"))
            .unwrap();
        let graph = fixture.graph(&root.id);
        let from = graph.nodes.iter().find(|node| node.id == root.id).unwrap();
        let to = graph
            .nodes
            .iter()
            .find(|node| node.name == "helper")
            .unwrap();
        let ranges = analyze(
            Path::new("dense.rs"),
            "dense.rs",
            &source,
            &TextMap::new(&source),
        )
        .unwrap()
        .calls
        .into_iter()
        .map(|call| call.range)
        .collect::<Vec<_>>();
        assert_eq!(ranges.len(), 150);
        let versions = graph
            .nodes
            .iter()
            .map(|node| (node.uri.clone(), node.version.clone()))
            .collect();
        let mut evidence = GraphEvidence {
            root: graph_symbol_from(from),
            incoming: vec![],
            outgoing: vec![],
            relations: vec![GraphRelation {
                from: graph_symbol_from(from),
                to: graph_symbol_from(to),
                from_ranges: ranges,
            }],
        };
        let result = fixture
            .index
            .record_graph(&fixture.snapshot(), &fixture.cache, &evidence, &versions)
            .unwrap();
        assert_eq!(result.recorded, 1);
        assert_eq!(fixture.graph(&root.id).edges[0].ranges.len(), 150);
        evidence.relations[0].from_ranges =
            vec![evidence.relations[0].from_ranges[0].clone(); 4097];
        assert!(
            fixture
                .index
                .record_graph(&fixture.snapshot(), &fixture.cache, &evidence, &versions)
                .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn traversal_hash_memo_detects_same_size_replacement_and_restored_mtime_edits() {
        let fixture = Fixture::new(&[
            ("root.rs", "fn root() { child(); }\n"),
            ("child.rs", "fn child() { /* a */ }\n"),
        ]);
        fixture.refresh();
        let root = fixture
            .search("root")
            .into_iter()
            .find(|hit| hit.name.as_deref() == Some("root"))
            .unwrap();
        assert!(!fixture.traversal(&root.id, IndexDirection::Outgoing, 29)[0].stale);
        let path = fixture.snapshot().path.join("child.rs");
        let original = fs::metadata(&path).unwrap();
        let replacement = path.with_extension("new");
        fs::write(&replacement, "fn child() { /* b */ }\n").unwrap();
        fs::File::open(&replacement)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(original.modified().unwrap()))
            .unwrap();
        fs::rename(replacement, &path).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(), original.len());
        assert_eq!(
            fs::metadata(&path).unwrap().modified().unwrap(),
            original.modified().unwrap()
        );
        assert!(fixture.traversal(&root.id, IndexDirection::Outgoing, 29)[0].stale);
        fixture.refresh();
        assert!(!fixture.traversal(&root.id, IndexDirection::Outgoing, 29)[0].stale);
        let saved_mtime = fs::metadata(&path).unwrap().modified().unwrap();
        fs::write(&path, "fn child() { /* c */ }\n").unwrap();
        fs::File::open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(saved_mtime))
            .unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().modified().unwrap(),
            saved_mtime
        );
        assert!(fixture.traversal(&root.id, IndexDirection::Outgoing, 29)[0].stale);
    }

    #[cfg(unix)]
    #[test]
    fn traversal_hash_memos_are_isolated_by_workspace_and_reject_outside_symlinks() {
        let first = Fixture::new(&[("sample.rs", "fn root() { child(); }\nfn child() {}\n")]);
        let second = Fixture::new(&[(
            "sample.rs",
            "fn root() { child(); }\nfn child() { /* second */ }\n",
        )]);
        first.refresh();
        first
            .index
            .refresh(&second.snapshot(), &first.cache)
            .unwrap();
        let first_root = first
            .search("root")
            .into_iter()
            .find(|hit| hit.name.as_deref() == Some("root"))
            .unwrap();
        let request = IndexTraverse {
            symbol_id: first_root.id.clone(),
            direction: Some(IndexDirection::Outgoing),
            cursor: None,
            limit: Some(29),
        };
        let one = first
            .index
            .traverse(&first.snapshot(), &first.cache, &request)
            .unwrap();
        let two = first
            .index
            .traverse(&second.snapshot(), &first.cache, &request)
            .unwrap();
        assert!(!one.stale && !two.stale);
        assert_ne!(one.nodes[0].version, two.nodes[0].version);
        let first_handle = first
            .index
            .handle(&first.snapshot().path, &first.cache)
            .unwrap();
        let second_handle = first
            .index
            .handle(&second.snapshot().path, &first.cache)
            .unwrap();
        assert!(!Arc::ptr_eq(
            &first_handle.source_versions,
            &second_handle.source_versions
        ));
        let outside = first.directory.path().join("outside.rs");
        fs::write(&outside, "fn root() { child(); }\nfn child() {}\n").unwrap();
        let path = first.snapshot().path.join("sample.rs");
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(outside, &path).unwrap();
        let page = first
            .index
            .traverse(&first.snapshot(), &first.cache, &request)
            .unwrap();
        assert!(page.stale);
        assert!(page.nodes.is_empty() && page.edges.is_empty());
    }

    #[test]
    fn symbol_at_selects_smallest_fresh_callable_with_utf16_positions() {
        let fixture = Fixture::new(&[(
            "nested.rs",
            "struct Outside;\nfn outer() {\n  fn inner() { let label = \"🦀\"; }\n}\n",
        )]);
        fixture.refresh();
        let snapshot = fixture.snapshot();
        let path = snapshot.path.join("nested.rs");
        let symbol = fixture
            .index
            .symbol_at(
                &snapshot,
                &fixture.cache,
                &path,
                Position {
                    line: 2,
                    character: 33,
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(symbol.name, "inner");
        assert!(
            fixture
                .index
                .symbol_at(
                    &snapshot,
                    &fixture.cache,
                    &path,
                    Position {
                        line: 0,
                        character: 8
                    }
                )
                .unwrap()
                .is_none()
        );
        assert!(
            fixture
                .index
                .symbol_at(
                    &snapshot,
                    &fixture.cache,
                    &path,
                    Position {
                        line: 99,
                        character: 0
                    }
                )
                .unwrap()
                .is_none()
        );
        fs::write(&path, "fn replacement() {}\n").unwrap();
        assert!(
            fixture
                .index
                .symbol_at(
                    &snapshot,
                    &fixture.cache,
                    &path,
                    Position {
                        line: 0,
                        character: 3
                    }
                )
                .unwrap()
                .is_none()
        );
        assert!(
            fixture
                .index
                .status(&snapshot.path, &fixture.cache)
                .unwrap()
                .stale
        );
    }

    #[test]
    fn sqlite_search_fuses_exact_symbols_paths_and_bm25_text() {
        let fixture = Fixture::new(&[
            (
                "src/main.rs",
                "fn resolve_invoice() { settle(); }\nfn settle() {}\n",
            ),
            ("notes.md", "The golden kestrel settles each invoice.\n"),
            ("empty.txt", ""),
        ]);
        let status = fixture.refresh();
        assert_eq!((status.files, status.symbols, status.chunks), (3, 2, 3));
        let symbols = fixture.search("resolve_invoice");
        assert_eq!(symbols[0].name.as_deref(), Some("resolve_invoice"));
        assert!(
            symbols[0]
                .reasons
                .iter()
                .any(|reason| reason == "Exact symbol")
        );
        assert_eq!(
            fixture.search("golden kestrel")[0].path,
            fixture.snapshot().path.join("notes.md").to_string_lossy()
        );
        for path in ["src/main.rs", "empty.txt"] {
            let hits = fixture.search(path);
            assert!(!hits.is_empty());
            assert!(hits[0].reasons.iter().any(|reason| reason == "Exact path"));
        }
        assert_eq!(fixture.search("empty.txt")[0].content, "");
        for query in [
            "\" OR *",
            "name:near(foo)",
            "'; DROP TABLE files; --",
            "🦀",
            "%_\\",
        ] {
            fixture.search(query);
        }
        assert_eq!(fixture.refresh().files, 3);
        assert!(
            fixture
                .index
                .search(
                    &fixture.snapshot(),
                    &fixture.cache,
                    &IndexSearch {
                        query: "x".repeat(513),
                        limit: None,
                        anchor_symbol_id: None,
                    }
                )
                .is_err()
        );
    }

    #[test]
    fn grammars_extract_real_definitions_and_calls_for_each_supported_language() {
        let examples = [
            ("sample.rs", "fn caller() { helper(); }\nfn helper() {}\n"),
            (
                "sample.py",
                "def caller():\n    helper()\ndef helper():\n    pass\n",
            ),
            (
                "sample.ts",
                "function caller(): void { helper(); }\nfunction helper() {}\n",
            ),
            (
                "sample.tsx",
                "const caller = () => <div>{helper()}</div>;\nfunction helper() {}\n",
            ),
            (
                "sample.js",
                "const caller = () => helper();\nfunction helper() {}\n",
            ),
            (
                "sample.jsx",
                "function caller() { return <div>{helper()}</div>; }\nfunction helper() {}\n",
            ),
            (
                "sample.rb",
                "def caller\n  helper()\nend\ndef helper\nend\n",
            ),
            (
                "sample.go",
                "package sample\nfunc caller() { helper() }\nfunc helper() {}\n",
            ),
        ];
        for (path, text) in examples {
            let analysis = analyze(Path::new(path), path, text, &TextMap::new(text)).unwrap();
            let names = analysis
                .symbols
                .iter()
                .map(|symbol| symbol.name.as_str())
                .collect::<Vec<_>>();
            assert!(names.contains(&"caller"), "{path}: {names:?}");
            assert!(names.contains(&"helper"), "{path}: {names:?}");
            assert_eq!(analysis.calls.len(), 1, "{path}");
            assert_eq!(analysis.calls[0].name, "helper", "{path}");
            assert!(!analysis.limited, "{path}");
        }
    }

    #[test]
    fn markdown_headings_index_sections_and_ignore_fenced_fake_symbols() {
        let text = "---\ntitle: Hidden metadata\n---\n\n# Harbor\n\nWelcome.\n\n## **Orders** and \x60receipts\x60\n\nReconcile daily payments.\n\n\x60\x60\x60rust\n# Not a heading\nfn fake_call() {}\n\x60\x60\x60\n\nNext section\n------------\n\nEnd.\n";
        let fixture = Fixture::new(&[("guide.markdown", text)]);
        let status = fixture.refresh();
        assert_eq!((status.symbols, status.edges), (3, 0));
        let headings = analyze_markdown("guide.markdown", text, &TextMap::new(text)).symbols;
        assert!(
            headings
                .iter()
                .all(|heading| heading.symbol_kind == "heading")
        );
        assert_eq!(
            headings
                .iter()
                .map(|heading| heading.name.as_str())
                .collect::<Vec<_>>(),
            ["Harbor", "Orders and receipts", "Next section"]
        );
        assert_eq!(headings[1].qualified_name, "Harbor::Orders and receipts");
        assert_eq!(headings[1].range.end, headings[2].range.start);
        assert_eq!(
            headings[0].range.end,
            crate::lsp::byte_offset_to_position(text, text.len())
        );
        let hits = fixture.search("Orders and receipts");
        assert_eq!(hits[0].name.as_deref(), Some("Orders and receipts"));
        assert_eq!(hits[0].symbol_kind.as_deref(), Some("heading"));
        assert!(hits[0].content.contains("Reconcile daily payments"));
        assert!(
            fixture
                .search("fake_call")
                .iter()
                .all(|hit| hit.name.as_deref() != Some("fake_call"))
        );
        assert!(fixture.graph(&hits[0].id).edges.is_empty());
    }

    #[test]
    #[ignore = "requires a disposable Harbor copy and report path"]
    fn index_sample_workspace_acceptance() {
        let root = PathBuf::from(
            std::env::var_os("WORKBENCH_INDEX_ACCEPTANCE_ROOT")
                .expect("set WORKBENCH_INDEX_ACCEPTANCE_ROOT to a disposable Harbor copy"),
        );
        let report_path = PathBuf::from(
            std::env::var_os("WORKBENCH_INDEX_ACCEPTANCE_REPORT")
                .expect("set WORKBENCH_INDEX_ACCEPTANCE_REPORT"),
        );
        assert!(!root.starts_with(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()));
        let workspace = WorkspaceState::default();
        workspace.open_folder(&root).unwrap();
        let snapshot = workspace.snapshot().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let index = IndexState::default();
        let started = Instant::now();
        let status = index.refresh(&snapshot, cache.path()).unwrap();
        let refresh_ms = started.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(status.state, "ready", "{:?}", status.last_error);
        assert!(!status.limited);
        let query = |value: &str| {
            index
                .search(
                    &snapshot,
                    cache.path(),
                    &IndexSearch {
                        query: value.into(),
                        limit: Some(5),
                        anchor_symbol_id: None,
                    },
                )
                .unwrap()
        };
        let started = Instant::now();
        let exact = query("calculate_total");
        let exact_ms = started.elapsed().as_secs_f64() * 1000.0;
        let rust = exact
            .iter()
            .find(|hit| hit.kind == "symbol" && hit.path.ends_with("src/money.rs"))
            .expect("Rust exact symbol in top five");
        let started = Instant::now();
        let prose = query("difference expected received funds");
        let prose_ms = started.elapsed().as_secs_f64() * 1000.0;
        assert!(
            prose
                .iter()
                .any(|hit| hit.path.ends_with("tools/reconcile.py"))
        );
        let graph = index
            .neighbors(
                &snapshot,
                cache.path(),
                &IndexNeighbors {
                    symbol_id: rust.id.clone(),
                    direction: None,
                    limit: Some(29),
                },
            )
            .unwrap();
        assert!(!graph.edges.is_empty());
        assert!(
            graph
                .edges
                .iter()
                .all(|edge| matches!(edge.evidence.as_str(), "inferred" | "ambiguous"))
        );
        for node in &graph.nodes {
            assert_eq!(
                node.version,
                snapshot
                    .read_document(Path::new(&node.path))
                    .unwrap()
                    .version
            );
        }
        let path = snapshot.path.join("src/money.rs");
        let original = fs::read_to_string(&path).unwrap();
        fs::write(
            &path,
            format!("{original}\n// acceptance freshness marker\n"),
        )
        .unwrap();
        let stale = query("calculate_total");
        assert!(stale.iter().all(|hit| !hit.path.ends_with("src/money.rs")));
        assert!(
            index
                .neighbors(
                    &snapshot,
                    cache.path(),
                    &IndexNeighbors {
                        symbol_id: rust.id.clone(),
                        direction: None,
                        limit: None,
                    }
                )
                .unwrap()
                .nodes
                .is_empty()
        );
        let refreshed = index.refresh(&snapshot, cache.path()).unwrap();
        assert_eq!(refreshed.state, "ready");
        let fresh = query("calculate_total");
        let changed = fresh
            .iter()
            .find(|hit| hit.path.ends_with("src/money.rs"))
            .unwrap();
        assert_ne!(changed.version, rust.version);
        fs::write(&path, original).unwrap();
        assert_eq!(
            index.refresh(&snapshot, cache.path()).unwrap().state,
            "ready"
        );
        fs::create_dir_all(report_path.parent().unwrap()).unwrap();
        fs::write(&report_path, serde_json::to_vec_pretty(&serde_json::json!({
            "root": snapshot.path,
            "status": status,
            "observedMilliseconds": { "coldRefresh": refresh_ms, "exactSearch": exact_ms, "proseSearch": prose_ms },
            "exactTopFive": exact,
            "proseTopFive": prose,
            "neighborhood": graph,
            "staleMoneyHitsRejected": true,
            "staleNeighborsRejected": true,
            "newHashVisibleAfterRefresh": true,
            "sourceRestored": true,
        })).unwrap()).unwrap();
        println!("Index acceptance report: {}", report_path.display());
    }

    #[test]
    fn same_names_and_overloads_remain_ambiguous_and_case_sensitive() {
        let fixture = Fixture::new(&[
            ("caller.rs", "fn caller() { helper(); }\n"),
            ("one.rs", "fn helper() {}\n"),
            ("two.rs", "fn helper() {}\nfn Helper() {}\n"),
        ]);
        let status = fixture.refresh();
        assert_eq!((status.edges, status.verified_edges), (2, 0));
        let caller = fixture
            .search("caller")
            .into_iter()
            .find(|hit| hit.name.as_deref() == Some("caller"))
            .unwrap();
        let graph = fixture.graph(&caller.id);
        assert_eq!(graph.edges.len(), 2);
        assert!(graph.edges.iter().all(|edge| edge.evidence == "ambiguous"));
        assert!(graph.nodes.iter().all(|node| node.name != "Helper"));

        let overloads = Fixture::new(&[(
            "sample.ts",
            "function choose(value: string): string;\nfunction choose(value: number): number;\nfunction choose(value: unknown) { return value; }\nfunction caller() { choose(1); }\n",
        )]);
        assert_eq!(overloads.refresh().edges, 3);
        let caller = overloads
            .search("caller")
            .into_iter()
            .find(|hit| hit.name.as_deref() == Some("caller"))
            .unwrap();
        assert!(
            overloads
                .graph(&caller.id)
                .edges
                .iter()
                .all(|edge| edge.evidence == "ambiguous")
        );
    }

    #[test]
    fn inferred_calls_stay_within_language_families() {
        let fixture = Fixture::new(&[
            ("caller.rs", "fn caller() { helper(); }\n"),
            ("helper.rs", "fn helper() {}\n"),
            ("other.rb", "def helper\nend\n"),
            ("web.js", "function render() { component(); }\n"),
            (
                "component.tsx",
                "function component() { return <div />; }\n",
            ),
            ("other.py", "def component():\n    pass\n"),
        ]);
        assert_eq!(fixture.refresh().edges, 2);
        for (name, target) in [("caller", "helper.rs"), ("render", "component.tsx")] {
            let caller = fixture
                .search(name)
                .into_iter()
                .find(|hit| hit.name.as_deref() == Some(name))
                .unwrap();
            let graph = fixture.graph(&caller.id);
            assert_eq!(graph.edges.len(), 1);
            assert_eq!(graph.edges[0].evidence, "inferred");
            assert!(graph.nodes.iter().any(|node| node.path.ends_with(target)));
            assert!(
                graph
                    .nodes
                    .iter()
                    .all(|node| !node.path.ends_with(".rb") && !node.path.ends_with(".py"))
            );
        }
    }

    #[test]
    fn incremental_refresh_replaces_hashes_removes_files_and_keeps_generations() {
        let fixture = Fixture::new(&[
            ("first.py", "def first():\n    return 'old_marker'\n"),
            ("second.py", "def second():\n    pass\n"),
        ]);
        let first = fixture.refresh();
        let old = fixture.search("first").remove(0);
        let unchanged = fixture.refresh();
        assert_eq!(unchanged.generation, first.generation + 1);
        assert_eq!(fixture.search("first")[0].version, old.version);
        fs::write(
            fixture.snapshot().path.join("first.py"),
            "def first():\n    return 'new_marker'\n",
        )
        .unwrap();
        fs::remove_file(fixture.snapshot().path.join("second.py")).unwrap();
        assert!(fixture.search("old_marker").is_empty());
        assert!(
            fixture
                .index
                .status(&fixture.snapshot().path, &fixture.cache)
                .unwrap()
                .stale
        );
        let updated = fixture.refresh();
        assert_eq!((updated.files, updated.symbols), (1, 1));
        assert!(!updated.stale);
        assert_eq!(updated.generation, unchanged.generation + 1);
        assert_ne!(fixture.search("first")[0].version, old.version);
        assert!(fixture.search("second").is_empty());
        assert!(!fixture.search("new_marker").is_empty());
        let restored = IndexState::default()
            .status(&fixture.snapshot().path, &fixture.cache)
            .unwrap();
        assert_eq!(restored.generation, updated.generation);
        assert_eq!(restored.symbols, 1);
        assert!(restored.stale);
    }

    #[test]
    fn stale_neighbors_and_anchors_trigger_refresh_without_exposing_old_edges() {
        let fixture = Fixture::new(&[
            ("caller.rs", "fn caller() { helper(); }\n"),
            ("helper.rs", "fn helper() {}\n"),
        ]);
        fixture.refresh();
        let caller = fixture
            .search("caller")
            .into_iter()
            .find(|hit| hit.name.as_deref() == Some("caller"))
            .unwrap();
        assert_eq!(fixture.graph(&caller.id).edges.len(), 1);
        fs::write(
            fixture.snapshot().path.join("helper.rs"),
            "fn helper() { /* updated */ }\n",
        )
        .unwrap();
        assert!(fixture.graph(&caller.id).edges.is_empty());
        assert!(
            fixture
                .index
                .status(&fixture.snapshot().path, &fixture.cache)
                .unwrap()
                .stale
        );
        fixture.refresh();
        fs::write(
            fixture.snapshot().path.join("caller.rs"),
            "fn caller() {}\n",
        )
        .unwrap();
        assert!(fixture.graph(&caller.id).nodes.is_empty());
        assert!(
            fixture
                .index
                .status(&fixture.snapshot().path, &fixture.cache)
                .unwrap()
                .stale
        );
    }

    #[test]
    fn graph_boost_requires_fresh_links() {
        let fixture = Fixture::new(&[("sample.rs", "fn caller() { helper(); }\nfn helper() {}\n")]);
        fixture.refresh();
        let caller = fixture
            .search("caller")
            .into_iter()
            .find(|hit| hit.name.as_deref() == Some("caller"))
            .unwrap();
        let request = IndexSearch {
            query: "helper".into(),
            limit: None,
            anchor_symbol_id: Some(caller.id),
        };
        let hits = fixture
            .index
            .search(&fixture.snapshot(), &fixture.cache, &request)
            .unwrap();
        assert!(hits.iter().any(|hit| {
            hit.reasons
                .iter()
                .any(|reason| reason == "Nearby in call graph")
        }));
        fs::write(
            fixture.snapshot().path.join("sample.rs"),
            "fn caller() {}\nfn helper() {}\n",
        )
        .unwrap();
        assert!(
            fixture
                .index
                .search(&fixture.snapshot(), &fixture.cache, &request)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn verified_links_require_current_hashes_matching_root_and_valid_caller_ranges() {
        let fixture = Fixture::new(&[("sample.rs", "fn caller() { helper(); }\nfn helper() {}\n")]);
        fixture.refresh();
        let caller = fixture
            .search("caller")
            .into_iter()
            .find(|hit| hit.name.as_deref() == Some("caller"))
            .unwrap();
        let graph = fixture.graph(&caller.id);
        let source = graph
            .nodes
            .iter()
            .find(|node| node.name == "caller")
            .unwrap();
        let target = graph
            .nodes
            .iter()
            .find(|node| node.name == "helper")
            .unwrap();
        let relation = GraphRelation {
            from: graph_symbol_from(source),
            to: graph_symbol_from(target),
            from_ranges: graph.edges[0].ranges.clone(),
        };
        let versions = graph
            .nodes
            .iter()
            .map(|node| (node.uri.clone(), node.version.clone()))
            .collect::<HashMap<_, _>>();
        let record =
            |root: GraphSymbol, relation: GraphRelation, versions: &HashMap<String, String>| {
                fixture
                    .index
                    .record_graph(
                        &fixture.snapshot(),
                        &fixture.cache,
                        &GraphEvidence {
                            root,
                            incoming: Vec::new(),
                            relations: Vec::new(),
                            outgoing: vec![relation],
                        },
                        versions,
                    )
                    .unwrap()
            };
        assert_eq!(
            record(graph_symbol_from(target), relation.clone(), &versions).recorded,
            0
        );
        let mut missing = versions.clone();
        missing.clear();
        assert_eq!(
            record(graph_symbol_from(source), relation.clone(), &missing).recorded,
            0
        );
        let mut external = relation.clone();
        external.to.uri = "file:///outside-workspace/dependency.rs".into();
        assert_eq!(
            record(graph_symbol_from(source), external, &versions).recorded,
            0
        );
        let call_range = relation.from_ranges[0].clone();
        for ranges in [
            Vec::new(),
            vec![SourceRange {
                start: call_range.end,
                end: call_range.start,
            }],
            vec![SourceRange {
                start: call_range.start,
                end: call_range.start,
            }],
            vec![SourceRange {
                start: Position {
                    line: 999,
                    character: 0,
                },
                end: Position {
                    line: 999,
                    character: 1,
                },
            }],
            vec![target.selection_range.clone()],
        ] {
            let mut invalid = relation.clone();
            invalid.from_ranges = ranges;
            assert_eq!(
                record(graph_symbol_from(source), invalid, &versions).recorded,
                0
            );
        }
        assert_eq!(
            fixture
                .index
                .status(&fixture.snapshot().path, &fixture.cache)
                .unwrap()
                .verified_edges,
            0
        );
        assert_eq!(
            record(graph_symbol_from(source), relation.clone(), &versions).recorded,
            1
        );
        assert_eq!(fixture.graph(&caller.id).edges[0].evidence, "verified");
        assert_eq!(fixture.refresh().verified_edges, 1);
        fs::write(
            fixture.snapshot().path.join("sample.rs"),
            "fn caller() {}\nfn helper() {}\n",
        )
        .unwrap();
        assert_eq!(
            record(graph_symbol_from(source), relation, &versions).recorded,
            0
        );
        assert_eq!(fixture.refresh().verified_edges, 0);
    }

    #[test]
    fn ignores_build_hidden_and_oversized_files() {
        let fixture = Fixture::new(&[
            ("visible.rs", "fn visible() {}\n"),
            (".gitignore", "ignored.rs\n"),
            ("ignored.rs", "fn ignored() {}\n"),
            (
                "node_modules/package/source.ts",
                "function dependency() {}\n",
            ),
            ("target/generated.rs", "fn generated() {}\n"),
            (".private/source.ts", "function hidden() {}\n"),
            ("vendor/source.rb", "def vendor\nend\n"),
        ]);
        fs::write(
            fixture.snapshot().path.join("huge.rs"),
            "x".repeat(FILE_LIMIT + 1),
        )
        .unwrap();
        let status = fixture.refresh();
        assert_eq!((status.files, status.symbols), (1, 1));
        assert!(status.skipped >= 1);
        assert!(fixture.search("dependency").is_empty());
    }

    #[test]
    fn unicode_and_crlf_chunks_keep_exact_utf16_ranges_and_source() {
        let text = format!("{}\r\n{}\r{}", "🦀".repeat(1100), "é\n".repeat(80), "tail");
        let map = TextMap::new(&text);
        for offset in text
            .char_indices()
            .map(|(offset, _)| offset)
            .chain([text.len()])
        {
            assert_eq!(
                map.position(&text, offset),
                crate::lsp::byte_offset_to_position(&text, offset),
                "offset {offset}"
            );
        }
        assert!(
            TextMap::new("🦀")
                .offset(
                    "🦀",
                    Position {
                        line: 0,
                        character: 1
                    }
                )
                .is_none()
        );
        let mut offset = 0;
        let mut captured = String::new();
        while offset < text.len() {
            let end = snippet_end(&text, offset, CHUNK_BYTES, CHUNK_LINES);
            assert!(end > offset && end - offset <= CHUNK_BYTES);
            assert!(
                !(text.as_bytes()[end - 1] == b'\r' && text.as_bytes().get(end) == Some(&b'\n'))
            );
            let range = map.range(&text, offset, end);
            assert_eq!(map.offset(&text, range.start), Some(offset));
            assert_eq!(map.offset(&text, range.end), Some(end));
            captured.push_str(&text[offset..end]);
            offset = end;
        }
        assert_eq!(captured, text);
    }

    #[test]
    fn caches_are_separate_and_refresh_flag_clears_after_errors() {
        let fixture = Fixture::new(&[("first.rs", "fn first() {}\n")]);
        fixture.refresh();
        let original = fixture.snapshot().path;
        let retained_handle = fixture.index.handle(&original, &fixture.cache).unwrap();
        let second = fixture.directory.path().join("second");
        fs::create_dir(&second).unwrap();
        fs::write(second.join("second.rs"), "fn second() {}\n").unwrap();
        fixture.workspace.open_folder(&second).unwrap();
        assert_eq!(
            fixture
                .index
                .status(&fixture.snapshot().path, &fixture.cache)
                .unwrap()
                .files,
            0
        );
        fixture.refresh();
        assert!(fixture.search("first").is_empty());
        fixture.workspace.open_folder(&original).unwrap();
        let returned_handle = fixture.index.handle(&original, &fixture.cache).unwrap();
        assert!(Arc::ptr_eq(
            &retained_handle.status,
            &returned_handle.status
        ));
        assert_eq!(
            fixture
                .index
                .status(&original, &fixture.cache)
                .unwrap()
                .files,
            1
        );
        let handle = fixture.index.handle(&original, &fixture.cache).unwrap();
        fs::remove_file(&handle.database).unwrap();
        fs::create_dir(&handle.database).unwrap();
        assert_eq!(
            fixture
                .index
                .refresh(&fixture.snapshot(), &fixture.cache)
                .unwrap()
                .state,
            "error"
        );
        assert!(!fixture.index.refreshing.load(Ordering::Acquire));
        fixture.index.refreshing.store(true, Ordering::Release);
        assert!(
            fixture
                .index
                .refresh(&fixture.snapshot(), &fixture.cache)
                .unwrap_err()
                .contains("already running")
        );
        fixture.index.refreshing.store(false, Ordering::Release);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_and_replaced_root_paths_cannot_supply_outside_source() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new(&[("shared.rs", "fn inside() {}\n")]);
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("shared.rs"), "fn outside_secret() {}\n").unwrap();
        fs::write(outside.path().join("leak.rs"), "fn outside_only() {}\n").unwrap();
        symlink(outside.path(), fixture.snapshot().path.join("linked")).unwrap();
        symlink(
            outside.path().join("leak.rs"),
            fixture.snapshot().path.join("linked.rs"),
        )
        .unwrap();
        assert_eq!(fixture.refresh().files, 1);
        assert!(fixture.search("outside_secret").is_empty());
        let snapshot = fixture.snapshot();
        let retained = fixture.directory.path().join("retained");
        fs::rename(&snapshot.path, &retained).unwrap();
        symlink(outside.path(), &snapshot.path).unwrap();
        let status = fixture.index.refresh(&snapshot, &fixture.cache).unwrap();
        assert_eq!(status.state, "ready");
        assert!(fixture.search("outside_only").is_empty());
        assert!(fixture.search("outside_secret").is_empty());
    }
}
