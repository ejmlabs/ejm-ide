use super::*;

const PAGE_LIMIT: usize = 250;
// UI exploration reads one adjacency list. Full recursive traversal remains the agent default.
const DIRECT: &str = "WITH
  valid_edges AS (
    SELECT edges.* FROM edges
    JOIN entries source ON source.id=edges.from_id
    JOIN files source_file ON source_file.path=source.path AND source_file.version=edges.source_version
    JOIN entries target ON target.id=edges.to_id
    JOIN files target_file ON target_file.path=target.path AND target_file.version=edges.target_version
    WHERE source.path NOT IN (SELECT value FROM json_each(?5))
      AND target.path NOT IN (SELECT value FROM json_each(?5))
  ),
  ancestors(id) AS (
    SELECT ?1 UNION SELECT e.from_id FROM valid_edges e WHERE e.to_id=?1 AND ?2!='outgoing'
  ),
  descendants(id) AS (
    SELECT ?1 UNION SELECT e.to_id FROM valid_edges e WHERE e.from_id=?1 AND ?2!='incoming'
  ),
  reachable_edges(id) AS (
    SELECT e.id FROM valid_edges e WHERE e.to_id=?1 AND ?2!='outgoing'
    UNION
    SELECT e.id FROM valid_edges e WHERE e.from_id=?1 AND ?2!='incoming'
  ) ";
// UNION deduplicates cycles. Separate walks avoid taking a caller's other branches.
const REACHABLE: &str = "WITH RECURSIVE
  valid_edges AS (
    SELECT edges.* FROM edges
    JOIN entries source ON source.id=edges.from_id
    JOIN files source_file ON source_file.path=source.path AND source_file.version=edges.source_version
    JOIN entries target ON target.id=edges.to_id
    JOIN files target_file ON target_file.path=target.path AND target_file.version=edges.target_version
    WHERE source.path NOT IN (SELECT value FROM json_each(?5))
      AND target.path NOT IN (SELECT value FROM json_each(?5))
  ),
  ancestors(id) AS (
    SELECT ?1 UNION SELECT e.from_id FROM valid_edges e JOIN ancestors a ON e.to_id=a.id WHERE ?2!='outgoing'
  ),
  descendants(id) AS (
    SELECT ?1 UNION SELECT e.to_id FROM valid_edges e JOIN descendants d ON e.from_id=d.id WHERE ?2!='incoming'
  ),
  reachable_edges(id) AS (
    SELECT e.id FROM valid_edges e JOIN ancestors a ON e.to_id=a.id WHERE ?2!='outgoing'
    UNION
    SELECT e.id FROM valid_edges e JOIN descendants d ON e.from_id=d.id WHERE ?2!='incoming'
  ) ";

#[cfg(unix)]
#[derive(Clone, Eq, PartialEq)]
struct SourceStamp {
    device: u64,
    inode: u64,
    bytes: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}

#[cfg(unix)]
impl SourceStamp {
    fn read(path: &Path) -> Option<Self> {
        use std::os::unix::fs::MetadataExt;
        let metadata = fs::symlink_metadata(path).ok()?;
        metadata.is_file().then(|| Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            bytes: metadata.len(),
            modified: (metadata.mtime(), metadata.mtime_nsec()),
            changed: (metadata.ctime(), metadata.ctime_nsec()),
        })
    }
}

#[cfg(unix)]
pub(super) struct VerifiedSource {
    stamp: SourceStamp,
    version: String,
}

fn current_source_version(
    handle: &Handle,
    snapshot: &WorkspaceRoot,
    relative: &str,
) -> Option<String> {
    let path = snapshot.path.join(relative);
    #[cfg(unix)]
    {
        // Validate confinement before a cache hit; unchanged metadata cannot authorize a new symlink.
        let canonical = path.canonicalize().ok()?;
        if canonical != path || !canonical.starts_with(&snapshot.path) {
            return None;
        }
        let stamp = SourceStamp::read(&path)?;
        if let Ok(versions) = handle.source_versions.lock()
            && let Some(verified) = versions.get(relative)
            && verified.stamp == stamp
        {
            return Some(verified.version.clone());
        }
        let document = snapshot.read_document(&path).ok()?;
        if SourceStamp::read(&path).as_ref() != Some(&stamp)
            || path.canonicalize().ok().as_ref() != Some(&canonical)
        {
            return None;
        }
        if let Ok(mut versions) = handle.source_versions.lock() {
            if versions.len() >= FILE_COUNT_LIMIT && !versions.contains_key(relative) {
                versions.clear();
            }
            versions.insert(
                relative.into(),
                VerifiedSource {
                    stamp,
                    version: document.version.clone(),
                },
            );
        }
        Some(document.version)
    }
    #[cfg(not(unix))]
    {
        let _ = handle;
        snapshot
            .read_document(&path)
            .ok()
            .map(|document| document.version)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct IndexTraverse {
    pub symbol_id: String,
    pub direction: Option<IndexDirection>,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexTraversalPage {
    pub nodes: Vec<IndexNode>,
    pub edges: Vec<IndexEdge>,
    pub generation: u64,
    pub next_cursor: Option<String>,
    pub traversal_complete: bool,
    pub index_limited: bool,
    pub stale: bool,
    pub skipped_stale: usize,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    workspace: String,
    symbol_id: String,
    direction: IndexDirection,
    #[serde(default)]
    direct: bool,
    generation: u64,
    revision: u64,
    after: String,
    skipped_stale: usize,
    sources: String,
    signature: String,
}

impl Cursor {
    fn signature(&self, secret: &str) -> Result<String, String> {
        let binding = serde_json::to_vec(&(
            &self.workspace,
            &self.symbol_id,
            self.direction,
            self.direct,
            self.generation,
            self.revision,
            &self.after,
            self.skipped_stale,
            &self.sources,
        ))
        .map_err(error)?;
        Ok(hash([secret.as_bytes(), b"\0", &binding].concat()))
    }
}

pub(super) fn advance_graph_revision(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO metadata(key,value) VALUES('graphRevision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",
            [],
        )
        .map_err(error)?;
    Ok(())
}

fn revision(connection: &Connection) -> Result<u64, String> {
    let value: String = connection
        .query_row(
            "SELECT coalesce((SELECT value FROM metadata WHERE key='graphRevision'),'0')",
            [],
            |row| row.get(0),
        )
        .map_err(error)?;
    value.parse().map_err(error)
}

fn saved_status(connection: &Connection) -> Result<(u64, bool), String> {
    let value: Option<String> = connection
        .query_row("SELECT value FROM metadata WHERE key='status'", [], |row| {
            row.get(0)
        })
        .optional()
        .map_err(error)?;
    let value = value
        .map(|text| serde_json::from_str::<serde_json::Value>(&text))
        .transpose()
        .map_err(error)?;
    Ok(value.map_or((0, false), |value| {
        (
            value["generation"].as_u64().unwrap_or(0),
            value["limited"].as_bool().unwrap_or(false),
        )
    }))
}

impl IndexState {
    pub(crate) fn traverse(
        &self,
        snapshot: &WorkspaceRoot,
        cache_dir: &Path,
        request: &IndexTraverse,
    ) -> Result<IndexTraversalPage, String> {
        self.traverse_mode(snapshot, cache_dir, request, false)
    }

    pub(super) fn traverse_mode(
        &self,
        snapshot: &WorkspaceRoot,
        cache_dir: &Path,
        request: &IndexTraverse,
        direct: bool,
    ) -> Result<IndexTraversalPage, String> {
        let limit = request.limit.unwrap_or(100);
        if request.symbol_id.is_empty()
            || request.symbol_id.len() > 128
            || !(1..=PAGE_LIMIT).contains(&limit)
        {
            return Err(error(
                "graph traversal needs a symbol ID and 1 to 250 edges per page",
            ));
        }
        let direction = request.direction.unwrap_or_default();
        let workspace = hash(snapshot.path.as_os_str().as_encoded_bytes());
        let handle = self.handle(&snapshot.path, cache_dir)?;
        let connection = connect(&handle.database, false)?;
        let transaction = connection.unchecked_transaction().map_err(error)?;
        let (generation, index_limited) = saved_status(&transaction)?;
        let revision = revision(&transaction)?;
        let cursor = request
            .cursor
            .as_deref()
            .map(|text| {
                if text.len() > 2048 {
                    return Err(error("invalid graph continuation"));
                }
                serde_json::from_str::<Cursor>(text)
                    .map_err(|_| error("invalid graph continuation"))
            })
            .transpose()?;
        if cursor.as_ref().is_some_and(|cursor| {
            cursor.workspace != workspace
                || cursor.symbol_id != request.symbol_id
                || cursor.direction != direction
                || cursor.direct != direct
                || cursor.generation != generation
                || cursor.revision != revision
                || cursor.after.len() > 128
                || cursor.signature(&handle.cursor_secret).ok().as_ref() != Some(&cursor.signature)
        }) {
            return Err(error(
                "the graph changed or this continuation belongs to another traversal; start again",
            ));
        }
        let mut page = IndexTraversalPage {
            nodes: Vec::new(),
            edges: Vec::new(),
            generation,
            next_cursor: None,
            traversal_complete: true,
            index_limited,
            stale: false,
            skipped_stale: 0,
        };
        let mut versions = HashMap::new();
        let Some(anchor) =
            record(&transaction, &request.symbol_id)?.filter(|record| record.data.kind == "symbol")
        else {
            return Ok(page);
        };
        let anchor_version = current_source_version(&handle, snapshot, &anchor.data.path);
        if anchor_version.as_deref() != Some(anchor.version.as_str()) {
            page.stale = true;
            page.traversal_complete = false;
            page.skipped_stale = 1;
            if let Ok(mut status) = handle.status.lock() {
                status.stale = true;
            }
            if cursor.is_some() {
                return Err(error(
                    "graph source changed between pages; start the traversal again",
                ));
            }
            return Ok(page);
        }
        versions.insert(anchor.data.path.clone(), anchor_version);
        let mut nodes = BTreeMap::new();
        nodes.insert(anchor.data.id.clone(), anchor.node(&snapshot.path)?);
        let direction_name = match direction {
            IndexDirection::Incoming => "incoming",
            IndexDirection::Outgoing => "outgoing",
            IndexDirection::Both => "both",
        };
        let reachable = if direct { DIRECT } else { REACHABLE };
        let sources_sql = format!(
            "{reachable}SELECT DISTINCT e.path,f.version FROM entries e JOIN files f ON f.path=e.path WHERE e.id IN (SELECT id FROM ancestors UNION SELECT id FROM descendants)"
        );
        let mut sources_statement = transaction.prepare(&sources_sql).map_err(error)?;
        let source_rows = sources_statement
            .query_map(
                params![request.symbol_id, direction_name, "", 0, "[]"],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(error)?;
        let mut sources = BTreeMap::new();
        let mut stale_paths = Vec::new();
        for source in source_rows {
            let (path, expected) = source.map_err(error)?;
            let current = versions
                .entry(path.clone())
                .or_insert_with(|| current_source_version(&handle, snapshot, &path));
            if current.as_deref() != Some(expected.as_str()) {
                stale_paths.push(path.clone());
            }
            sources.insert(path, current.clone());
        }
        let sources = hash(serde_json::to_vec(&sources).map_err(error)?);
        if cursor
            .as_ref()
            .is_some_and(|cursor| cursor.sources != sources)
        {
            if let Ok(mut status) = handle.status.lock() {
                status.stale = true;
            }
            return Err(error(
                "graph source changed between pages; start the traversal again",
            ));
        }
        let stale_paths_json = serde_json::to_string(&stale_paths).map_err(error)?;
        if cursor.is_none() && !stale_paths.is_empty() {
            let count_sql = format!("{reachable}SELECT count(*) FROM reachable_edges");
            let count = |excluded: &str| -> Result<usize, String> {
                transaction
                    .query_row(
                        &count_sql,
                        params![request.symbol_id, direction_name, "", 0, excluded],
                        |row| row.get::<_, u32>(0).map(|count| count as usize),
                    )
                    .map_err(error)
            };
            page.skipped_stale = count("[]")?.saturating_sub(count(&stale_paths_json)?);
        }
        let sql = format!("{reachable}SELECT e.id,e.from_id,e.to_id,e.evidence,e.ranges_json,e.source_version,e.target_version
          FROM edges e JOIN reachable_edges r ON r.id=e.id
          WHERE e.id>?3 ORDER BY e.id LIMIT ?4");
        let after = cursor.as_ref().map_or("", |cursor| cursor.after.as_str());
        let mut statement = transaction.prepare(&sql).map_err(error)?;
        let mut rows = statement
            .query(params![
                request.symbol_id,
                direction_name,
                after,
                (limit + 1) as u32,
                stale_paths_json
            ])
            .map_err(error)?;
        let mut last_id = String::new();
        let mut more = false;
        for offset in 0..=limit {
            let Some(row) = rows.next().map_err(error)? else {
                break;
            };
            if offset == limit {
                more = true;
                break;
            }
            let id: String = row.get(0).map_err(error)?;
            last_id.clone_from(&id);
            let from: String = row.get(1).map_err(error)?;
            let to: String = row.get(2).map_err(error)?;
            let source_version: String = row.get(5).map_err(error)?;
            let target_version: String = row.get(6).map_err(error)?;
            let (Some(source), Some(target)) =
                (record(&transaction, &from)?, record(&transaction, &to)?)
            else {
                page.skipped_stale += 1;
                continue;
            };
            if source.version != source_version
                || target.version != target_version
                || !source.fresh(snapshot, &mut versions)
                || !target.fresh(snapshot, &mut versions)
            {
                page.skipped_stale += 1;
                continue;
            }
            nodes.insert(from.clone(), source.node(&snapshot.path)?);
            nodes.insert(to.clone(), target.node(&snapshot.path)?);
            let ranges: String = row.get(4).map_err(error)?;
            page.edges.push(IndexEdge {
                id,
                from,
                to,
                kind: "call".into(),
                evidence: row.get(3).map_err(error)?,
                ranges: serde_json::from_str(&ranges).map_err(error)?,
                source_version,
                target_version,
            });
        }
        let skipped_total =
            cursor.as_ref().map_or(0, |cursor| cursor.skipped_stale) + page.skipped_stale;
        page.stale = skipped_total > 0;
        page.traversal_complete = !more && !page.stale;
        if more {
            let mut cursor = Cursor {
                workspace,
                symbol_id: request.symbol_id.clone(),
                direction,
                direct,
                generation,
                revision,
                after: last_id,
                skipped_stale: skipped_total,
                sources,
                signature: String::new(),
            };
            cursor.signature = cursor.signature(&handle.cursor_secret)?;
            page.next_cursor = Some(serde_json::to_string(&cursor).map_err(error)?);
        }
        if page.stale
            && let Ok(mut status) = handle.status.lock()
        {
            status.stale = true;
        }
        page.nodes = nodes.into_values().collect();
        Ok(page)
    }

    pub(crate) fn symbol_at(
        &self,
        snapshot: &WorkspaceRoot,
        cache_dir: &Path,
        path: &Path,
        position: Position,
    ) -> Result<Option<IndexNode>, String> {
        let relative = path
            .strip_prefix(&snapshot.path)
            .map_err(|_| error("symbol path is outside the workspace"))?
            .to_string_lossy()
            .replace('\\', "/");
        let document = snapshot.read_document(path)?;
        let map = TextMap::new(&document.content);
        let Some(offset) = map.offset(&document.content, position) else {
            return Ok(None);
        };
        let handle = self.handle(&snapshot.path, cache_dir)?;
        let connection = connect(&handle.database, false)?;
        let mut statement = connection.prepare("SELECT id FROM entries WHERE path=?1 AND kind='symbol' AND symbol_kind IN ('function','method')").map_err(error)?;
        let ids = statement
            .query_map([relative], |row| row.get::<_, String>(0))
            .map_err(error)?;
        let mut selected: Option<(usize, IndexNode)> = None;
        for id in ids {
            let Some(record) = record(&connection, &id.map_err(error)?)? else {
                continue;
            };
            if record.version != document.version {
                if let Ok(mut status) = handle.status.lock() {
                    status.stale = true;
                }
                continue;
            }
            let Some(start) = map.offset(&document.content, record.data.range.start) else {
                continue;
            };
            let Some(end) = map.offset(&document.content, record.data.range.end) else {
                continue;
            };
            if start <= offset
                && offset < end
                && selected
                    .as_ref()
                    .is_none_or(|(size, _)| end - start < *size)
            {
                selected = Some((end - start, record.node(&snapshot.path)?));
            }
        }
        Ok(selected.map(|(_, node)| node))
    }
}

#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "Tauri injects host state alongside paged graph arguments"
)]
pub async fn index_traverse(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    index: State<'_, IndexState>,
    auth: String,
    symbol_id: String,
    direction: Option<IndexDirection>,
    cursor: Option<String>,
    limit: Option<usize>,
    direct: Option<bool>,
) -> Result<IndexTraversalPage, String> {
    host.check(&window, &auth)?;
    let snapshot = workspace.snapshot()?;
    let root = snapshot.path.clone();
    let cache = cache_dir(&app)?;
    let index = index.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let status = index.status(&snapshot.path, &cache)?;
        if cursor.is_none() && (status.state == "idle" || status.stale) {
            index.refresh(&snapshot, &cache)?;
        }
        index.traverse_mode(
            &snapshot,
            &cache,
            &IndexTraverse {
                symbol_id,
                direction,
                cursor,
                limit,
            },
            direct.unwrap_or(false),
        )
    })
    .await
    .map_err(error)??;
    check_workspace(&workspace, &root)?;
    Ok(result)
}

#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "Tauri injects host state alongside source position arguments"
)]
pub async fn index_symbol_at(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    index: State<'_, IndexState>,
    auth: String,
    path: String,
    position: Position,
) -> Result<Option<IndexNode>, String> {
    host.check(&window, &auth)?;
    let path = workspace.validate_path(&path, false)?;
    let snapshot = workspace.snapshot()?;
    let root = snapshot.path.clone();
    let cache = cache_dir(&app)?;
    let index = index.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let status = index.status(&snapshot.path, &cache)?;
        if status.state == "idle" || status.stale {
            index.refresh(&snapshot, &cache)?;
        }
        index.symbol_at(&snapshot, &cache, &path, position)
    })
    .await
    .map_err(error)??;
    check_workspace(&workspace, &root)?;
    Ok(result)
}
