use crate::providers::driver::{Message, Usage};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const PAGE: i64 = 30;
const MAX_HISTORY_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone)]
pub(crate) struct AgentStore(pub(crate) PathBuf);

#[derive(Clone)]
pub(crate) struct StoredTurn {
    pub(crate) id: String,
    pub(crate) thread_id: String,
    pub(crate) provider_id: String,
    pub(crate) model: String,
    pub(crate) status: String,
    pub(crate) error: Option<String>,
    pub(crate) items: Vec<Value>,
    pub(crate) messages: Vec<Message>,
    pub(crate) usage: Usage,
    pub(crate) last_usage: Option<Usage>,
}

#[derive(Deserialize, Serialize)]
#[serde(from = "StoredUsageRepr")]
struct StoredUsage {
    total: Usage,
    last: Option<Usage>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum StoredUsageRepr {
    Current {
        total: Usage,
        #[serde(default)]
        last: Option<Usage>,
    },
    Legacy(Usage),
}

impl From<StoredUsageRepr> for StoredUsage {
    fn from(value: StoredUsageRepr) -> Self {
        match value {
            StoredUsageRepr::Current { total, last } => Self { total, last },
            StoredUsageRepr::Legacy(total) => Self { total, last: None },
        }
    }
}

fn validate_harness_scope(root: &Path, thread: &str, session: Option<&str>) -> Result<(), String> {
    if !root.is_absolute()
        || root
            .to_str()
            .is_none_or(|root| root.len() > 4096 || root.chars().any(char::is_control))
        || root
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("Select an absolute workspace path without traversal components.".into());
    }
    for id in std::iter::once(thread).chain(session) {
        if !uuid::Uuid::parse_str(id)
            .is_ok_and(|parsed| !parsed.is_nil() && parsed.hyphenated().to_string() == id)
        {
            return Err("Use a valid chat and harness session identifier.".into());
        }
    }
    Ok(())
}

fn failure(_: impl std::fmt::Display) -> String {
    "The local chat database could not complete this operation.".into()
}

fn cursor_offset(cursor: Option<&str>) -> Result<i64, String> {
    match cursor {
        None => Ok(0),
        Some(cursor) if cursor.len() <= 12 => cursor
            .parse::<i64>()
            .ok()
            .filter(|n| *n >= 0 && *n <= 100_000)
            .ok_or("Invalid chat history cursor.".into()),
        _ => Err("Invalid chat history cursor.".into()),
    }
}

impl AgentStore {
    pub(crate) fn initialize(path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(failure)?;
        }
        let store = Self(path);
        let connection = store.open()?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS chats (
               id TEXT PRIMARY KEY, cwd TEXT NOT NULL, name TEXT, preview TEXT NOT NULL,
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0
             );
             CREATE INDEX IF NOT EXISTS chats_workspace ON chats(cwd,archived,updated_at);
             CREATE TABLE IF NOT EXISTS turns (
               sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
               thread_id TEXT NOT NULL REFERENCES chats(id), provider_id TEXT NOT NULL, model TEXT NOT NULL,
               status TEXT NOT NULL, error TEXT, items TEXT NOT NULL, messages TEXT NOT NULL, usage TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS turns_chat ON turns(thread_id,sequence);
             CREATE TABLE IF NOT EXISTS active_chats (cwd TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES chats(id));
             CREATE TABLE IF NOT EXISTS harness_sessions (
               thread_id TEXT PRIMARY KEY NOT NULL REFERENCES chats(id), session_id TEXT UNIQUE NOT NULL
             );
             UPDATE turns SET status='interrupted' WHERE status='inProgress';"
        ).map_err(failure)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&store.0, std::fs::Permissions::from_mode(0o600))
                .map_err(failure)?;
        }
        Ok(store)
    }

    fn open(&self) -> Result<Connection, String> {
        let connection = Connection::open(&self.0).map_err(failure)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(failure)?;
        connection
            .execute_batch("PRAGMA foreign_keys=ON;")
            .map_err(failure)?;
        Ok(connection)
    }

    pub(crate) fn ensure_chat(&self, root: &Path, text: &str) -> Result<(String, bool), String> {
        let mut connection = self.open()?;
        let transaction = connection.transaction().map_err(failure)?;
        let cwd = root.to_string_lossy();
        if let Some(id) = transaction.query_row(
            "SELECT c.id FROM active_chats a JOIN chats c ON c.id=a.thread_id WHERE a.cwd=?1 AND c.cwd=?1 AND c.archived=0",
            [cwd.as_ref()], |row| row.get::<_,String>(0)
        ).optional().map_err(failure)? { return Ok((id,false)); }
        let id = uuid::Uuid::new_v4().to_string();
        let preview: String = text
            .lines()
            .next()
            .unwrap_or(text)
            .chars()
            .take(180)
            .collect();
        transaction.execute("INSERT INTO chats(id,cwd,preview,created_at,updated_at) VALUES(?1,?2,?3,unixepoch(),unixepoch())", params![id,cwd,preview]).map_err(failure)?;
        transaction.execute("INSERT INTO active_chats(cwd,thread_id) VALUES(?1,?2) ON CONFLICT(cwd) DO UPDATE SET thread_id=excluded.thread_id", params![cwd,id]).map_err(failure)?;
        transaction.commit().map_err(failure)?;
        Ok((id, true))
    }

    fn scoped(connection: &Connection, root: &Path, thread: &str) -> Result<(), String> {
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM chats WHERE id=?1 AND cwd=?2)",
                params![thread, root.to_string_lossy()],
                |r| r.get(0),
            )
            .map_err(failure)?;
        if exists {
            Ok(())
        } else {
            Err("This chat does not belong to the selected workspace.".into())
        }
    }

    pub(crate) fn harness_session(
        &self,
        root: &Path,
        thread: &str,
    ) -> Result<Option<String>, String> {
        validate_harness_scope(root, thread, None)?;
        let connection = self.open()?;
        Self::scoped(&connection, root, thread)?;
        connection
            .query_row(
                "SELECT session_id FROM harness_sessions WHERE thread_id=?1",
                [thread],
                |row| row.get(0),
            )
            .optional()
            .map_err(failure)
    }

    /// Repeating the same binding is safe. Neither side can be reassigned.
    pub(crate) fn bind_harness_session(
        &self,
        root: &Path,
        thread: &str,
        session: &str,
    ) -> Result<(), String> {
        validate_harness_scope(root, thread, Some(session))?;
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(failure)?;
        Self::scoped(&transaction, root, thread)?;
        let existing: Option<String> = transaction
            .query_row(
                "SELECT session_id FROM harness_sessions WHERE thread_id=?1",
                [thread],
                |row| row.get(0),
            )
            .optional()
            .map_err(failure)?;
        if let Some(existing) = existing {
            return if existing == session {
                Ok(())
            } else {
                Err("This chat is already linked to a different harness session.".into())
            };
        }
        let used: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM harness_sessions WHERE session_id=?1)",
                [session],
                |row| row.get(0),
            )
            .map_err(failure)?;
        if used {
            return Err("This harness session is already linked to another chat.".into());
        }
        transaction
            .execute(
                "INSERT INTO harness_sessions(thread_id,session_id) VALUES(?1,?2)",
                params![thread, session],
            )
            .map_err(failure)?;
        transaction.commit().map_err(failure)
    }

    pub(crate) fn list(
        &self,
        root: &Path,
        archived: bool,
        search: Option<&str>,
        cursor: Option<&str>,
    ) -> Result<Value, String> {
        let offset = cursor_offset(cursor)?;
        let connection = self.open()?;
        let needle = search.unwrap_or("").trim();
        if needle.len() > 512 {
            return Err("Search for a chat with at most 512 bytes.".into());
        }
        let mut query = connection.prepare("SELECT id,name,preview,cwd,created_at,updated_at FROM chats WHERE cwd=?1 AND archived=?2 AND (?3='' OR instr(lower(coalesce(name,'')||' '||preview),lower(?3))>0) ORDER BY updated_at DESC,id DESC LIMIT ?4 OFFSET ?5").map_err(failure)?;
        let rows = query.query_map(params![root.to_string_lossy(),archived,needle,PAGE+1,offset], |row| Ok(json!({"id":row.get::<_,String>(0)?,"name":row.get::<_,Option<String>>(1)?,"preview":row.get::<_,String>(2)?,"cwd":row.get::<_,String>(3)?,"createdAt":row.get::<_,i64>(4)?,"updatedAt":row.get::<_,i64>(5)?,"status":{"type":"idle"},"turns":[]}))).map_err(failure)?;
        let mut data = rows.collect::<Result<Vec<_>, _>>().map_err(failure)?;
        let next = (data.len() > PAGE as usize).then(|| (offset + PAGE).to_string());
        data.truncate(PAGE as usize);
        let active: Option<String> = connection.query_row("SELECT a.thread_id FROM active_chats a JOIN chats c ON c.id=a.thread_id WHERE a.cwd=?1 AND c.cwd=?1 AND c.archived=0",[root.to_string_lossy().as_ref()],|r|r.get(0)).optional().map_err(failure)?;
        Ok(json!({"data":data,"nextCursor":next,"activeThreadId":active}))
    }

    pub(crate) fn open_chat(&self, root: &Path, thread: &str) -> Result<Value, String> {
        let connection = self.open()?;
        Self::scoped(&connection, root, thread)?;
        let archived: bool = connection
            .query_row("SELECT archived FROM chats WHERE id=?1", [thread], |r| {
                r.get(0)
            })
            .map_err(failure)?;
        if archived {
            return Err("Restore this chat before opening it.".into());
        }
        let value = connection.query_row("SELECT id,name,preview,cwd,created_at,updated_at FROM chats WHERE id=?1",[thread],|row| Ok(json!({"id":row.get::<_,String>(0)?,"name":row.get::<_,Option<String>>(1)?,"preview":row.get::<_,String>(2)?,"cwd":row.get::<_,String>(3)?,"createdAt":row.get::<_,i64>(4)?,"updatedAt":row.get::<_,i64>(5)?,"status":{"type":"idle"}}))).map_err(failure)?;
        connection.execute("INSERT INTO active_chats(cwd,thread_id) VALUES(?1,?2) ON CONFLICT(cwd) DO UPDATE SET thread_id=excluded.thread_id",params![root.to_string_lossy(),thread]).map_err(failure)?;
        Ok(value)
    }

    pub(crate) fn turns(
        &self,
        root: &Path,
        thread: &str,
        cursor: Option<&str>,
    ) -> Result<Value, String> {
        let offset = cursor_offset(cursor)?;
        let connection = self.open()?;
        Self::scoped(&connection, root, thread)?;
        let mut query = connection.prepare("SELECT id,status,error,items FROM turns WHERE thread_id=?1 ORDER BY sequence DESC LIMIT ?2 OFFSET ?3").map_err(failure)?;
        let rows = query
            .query_map(params![thread, PAGE + 1, offset], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(failure)?;
        let mut data = Vec::new();
        for row in rows {
            let (id, status, error, items) = row.map_err(failure)?;
            let items: Value = serde_json::from_str(&items).map_err(failure)?;
            data.push(json!({"id":id,"status":status,"error":error.map(|m|json!({"message":m})),"items":items}));
        }
        let next = (data.len() > PAGE as usize).then(|| (offset + PAGE).to_string());
        data.truncate(PAGE as usize);
        data.reverse();
        Ok(json!({"data":data,"nextCursor":next}))
    }

    pub(crate) fn history(
        &self,
        root: &Path,
        thread: &str,
        provider: &str,
        model: &str,
    ) -> Result<(Vec<Message>, Usage), String> {
        let connection = self.open()?;
        Self::scoped(&connection, root, thread)?;
        let mut query=connection.prepare("SELECT provider_id,model,messages,usage FROM turns WHERE thread_id=?1 ORDER BY sequence").map_err(failure)?;
        let rows = query
            .query_map([thread], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(failure)?;
        let mut messages = Vec::new();
        let mut usage = Usage::default();
        let mut bytes = 0;
        for row in rows {
            let (previous_provider, previous_model, encoded, counts) = row.map_err(failure)?;
            bytes += encoded.len();
            if bytes > MAX_HISTORY_BYTES {
                return Err("This conversation has reached its context history limit. Start a new chat and attach the relevant source.".into());
            }
            let mut page: Vec<Message> = serde_json::from_str(&encoded).map_err(failure)?;
            if previous_provider != provider || previous_model != model {
                for message in &mut page {
                    message.blocks.clear();
                    message.reasoning_content = None;
                    message.continuation = None;
                }
            }
            repair_messages(&mut page);
            messages.extend(page);
            let counts: StoredUsage = serde_json::from_str(&counts).map_err(failure)?;
            add_usage(&mut usage, &counts.total);
        }
        Ok((messages, usage))
    }

    pub(crate) fn usage(
        &self,
        root: &Path,
        thread: &str,
    ) -> Result<(Usage, Option<Usage>), String> {
        let connection = self.open()?;
        Self::scoped(&connection, root, thread)?;
        let mut query = connection
            .prepare("SELECT usage FROM turns WHERE thread_id=?1 ORDER BY sequence")
            .map_err(failure)?;
        let rows = query
            .query_map([thread], |row| row.get::<_, String>(0))
            .map_err(failure)?;
        let mut total = Usage::default();
        let mut last = None;
        for row in rows {
            let counts: StoredUsage =
                serde_json::from_str(&row.map_err(failure)?).map_err(failure)?;
            add_usage(&mut total, &counts.total);
            if counts.last.is_some() {
                last = counts.last;
            }
        }
        Ok((total, last))
    }

    pub(crate) fn save_turn(&self, root: &Path, turn: &StoredTurn) -> Result<(), String> {
        let mut connection = self.open()?;
        Self::scoped(&connection, root, &turn.thread_id)?;
        let transaction = connection.transaction().map_err(failure)?;
        transaction.execute("INSERT INTO turns(id,thread_id,provider_id,model,status,error,items,messages,usage) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(id) DO UPDATE SET status=excluded.status,error=excluded.error,items=excluded.items,messages=excluded.messages,usage=excluded.usage",params![turn.id,turn.thread_id,turn.provider_id,turn.model,turn.status,turn.error,serde_json::to_string(&turn.items).map_err(failure)?,serde_json::to_string(&turn.messages).map_err(failure)?,serde_json::to_string(&StoredUsage{total:turn.usage.clone(),last:turn.last_usage.clone()}).map_err(failure)?]).map_err(failure)?;
        transaction
            .execute(
                "UPDATE chats SET updated_at=unixepoch() WHERE id=?1",
                [&turn.thread_id],
            )
            .map_err(failure)?;
        transaction.commit().map_err(failure)?;
        Ok(())
    }

    pub(crate) fn new_chat(&self, root: &Path) -> Result<(), String> {
        self.open()?
            .execute(
                "DELETE FROM active_chats WHERE cwd=?1",
                [root.to_string_lossy().as_ref()],
            )
            .map_err(failure)?;
        Ok(())
    }

    pub(crate) fn rename(&self, root: &Path, thread: &str, title: &str) -> Result<(), String> {
        if title.trim().is_empty() || title.len() > 160 || title.chars().any(char::is_control) {
            return Err("Use a chat title of 1 to 160 bytes.".into());
        }
        let connection = self.open()?;
        Self::scoped(&connection, root, thread)?;
        connection
            .execute(
                "UPDATE chats SET name=?1,updated_at=unixepoch() WHERE id=?2",
                params![title.trim(), thread],
            )
            .map_err(failure)?;
        Ok(())
    }

    pub(crate) fn archive(&self, root: &Path, thread: &str, archived: bool) -> Result<(), String> {
        let mut connection = self.open()?;
        Self::scoped(&connection, root, thread)?;
        let transaction = connection.transaction().map_err(failure)?;
        transaction
            .execute(
                "UPDATE chats SET archived=?1,updated_at=unixepoch() WHERE id=?2",
                params![archived, thread],
            )
            .map_err(failure)?;
        if archived {
            transaction
                .execute("DELETE FROM active_chats WHERE thread_id=?1", [thread])
                .map_err(failure)?;
        }
        transaction.commit().map_err(failure)?;
        Ok(())
    }
}

pub(crate) fn add_usage(total: &mut Usage, counts: &Usage) {
    total.input_tokens = total.input_tokens.saturating_add(counts.input_tokens);
    add_reported(&mut total.cached_input_tokens, counts.cached_input_tokens);
    total.cache_write_input_tokens = total
        .cache_write_input_tokens
        .saturating_add(counts.cache_write_input_tokens);
    total.output_tokens = total.output_tokens.saturating_add(counts.output_tokens);
    add_reported(
        &mut total.reasoning_output_tokens,
        counts.reasoning_output_tokens,
    );
}

fn add_reported(total: &mut Option<u64>, counts: Option<u64>) {
    if let Some(counts) = counts {
        *total = Some(total.unwrap_or_default().saturating_add(counts));
    }
}

/// A crash or cancellation can leave assistant calls without all tool results.
pub(crate) fn repair_messages(messages: &mut Vec<Message>) {
    let mut repaired = Vec::new();
    let mut pending = Vec::<String>::new();
    for message in messages.drain(..) {
        if message.role == "assistant"
            && message.content.is_empty()
            && message.tool_calls.is_empty()
            && message.blocks.is_empty()
            && message.reasoning_content.is_none()
            && message.continuation.is_none()
            && !message.is_error
            && message.artifact.is_none()
        {
            continue;
        }
        if message.role != "tool" {
            for id in pending.drain(..) {
                repaired.push(cancelled_tool_message(id));
            }
        }
        if message.role == "assistant" {
            pending = message.tool_calls.iter().map(|c| c.id.clone()).collect();
        }
        if message.role == "tool" {
            let Some(id) = message.tool_call_id.as_ref() else {
                continue;
            };
            if !pending.contains(id) {
                continue;
            }
            pending.retain(|pending_id| pending_id != id);
        }
        repaired.push(message);
    }
    repaired.extend(pending.into_iter().map(cancelled_tool_message));
    *messages = repaired;
}

fn cancelled_tool_message(id: String) -> Message {
    Message {
        role: "tool".into(),
        content: "The tool was interrupted before its result was recorded. Read current source before retrying any edit.".into(),
        tool_calls: vec![],
        tool_call_id: Some(id),
        is_error: true,
        artifact: None,
        blocks: vec![],
        reasoning_content: None,
        continuation: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn continuation() -> ejm_harness::ProviderContinuation {
        ejm_harness::ProviderContinuation::OpenAiResponses {
            reasoning: vec![json!({
                "type": "reasoning",
                "id": "rs_stored",
                "encrypted_content": "opaque-ciphertext",
            })],
        }
    }

    #[test]
    fn failed_stream_placeholders_do_not_break_the_next_provider_request() {
        let mut messages = vec![
            Message {
                role: "user".into(),
                content: "Try this".into(),
                tool_calls: vec![],
                tool_call_id: None,
                is_error: false,
                artifact: None,
                blocks: vec![],
                reasoning_content: None,
                continuation: None,
            },
            Message {
                role: "assistant".into(),
                content: String::new(),
                tool_calls: vec![],
                tool_call_id: None,
                is_error: false,
                artifact: None,
                blocks: vec![],
                reasoning_content: None,
                continuation: None,
            },
        ];
        repair_messages(&mut messages);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "user");
    }
    #[test]
    fn chats_are_scoped_to_workspace_and_remain_available_across_providers() {
        let temp = tempfile::tempdir().unwrap();
        let store = AgentStore::initialize(temp.path().join("chat.sqlite")).unwrap();
        let root = Path::new("/workspace/a");
        let (id, new) = store.ensure_chat(root, "hello").unwrap();
        assert!(new);
        assert_eq!(
            store.ensure_chat(root, "next").unwrap(),
            (id.clone(), false)
        );
        assert!(store.open_chat(Path::new("/workspace/b"), &id).is_err());
        store.rename(root, &id, "Renamed").unwrap();
        assert_eq!(
            store.list(root, false, None, None).unwrap()["data"][0]["name"],
            "Renamed"
        );
        store.archive(root, &id, true).unwrap();
        assert!(store.open_chat(root, &id).is_err());
        assert_eq!(
            store.list(root, true, None, None).unwrap()["data"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        store.archive(root, &id, false).unwrap();
        store.open_chat(root, &id).unwrap();
        assert_eq!(
            store.list(root, false, None, None).unwrap()["activeThreadId"],
            id
        );
    }
    #[test]
    fn provider_state_survives_reopen_and_clears_when_provider_account_or_model_changes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("chat.sqlite");
        let store = AgentStore::initialize(path.clone()).unwrap();
        let root = Path::new("/workspace");
        let (id, _) = store.ensure_chat(root, "test").unwrap();
        let turn = StoredTurn {
            id: "turn".into(),
            thread_id: id.clone(),
            provider_id: "provider/account-a".into(),
            model: "first".into(),
            status: "completed".into(),
            error: None,
            items: vec![],
            messages: vec![Message {
                role: "assistant".into(),
                content: "hi".into(),
                tool_calls: vec![],
                tool_call_id: None,
                is_error: false,
                artifact: None,
                blocks: vec![json!({"type":"thinking","signature":"private"})],
                reasoning_content: Some("reasoning".into()),
                continuation: Some(continuation()),
            }],
            usage: Usage::default(),
            last_usage: None,
        };
        store.save_turn(root, &turn).unwrap();
        drop(store);
        let reopened = AgentStore::initialize(path).unwrap();
        let (same, _) = reopened
            .history(root, &id, "provider/account-a", "first")
            .unwrap();
        assert_eq!(json!(same), json!(turn.messages));
        for (provider, model) in [
            ("other-provider/account-a", "first"),
            ("provider/account-b", "first"),
            ("provider/account-a", "second"),
        ] {
            let (other, _) = reopened.history(root, &id, provider, model).unwrap();
            assert!(other[0].blocks.is_empty());
            assert!(other[0].reasoning_content.is_none());
            assert!(other[0].continuation.is_none());
            assert_eq!(other[0].content, "hi");
        }
        let (same_again, _) = reopened
            .history(root, &id, "provider/account-a", "first")
            .unwrap();
        assert_eq!(json!(same_again), json!(turn.messages));
    }

    #[test]
    fn repair_keeps_continuation_and_reasoning_only_assistants_but_drops_empty_placeholders() {
        let assistant = |continuation, reasoning_content| Message {
            role: "assistant".into(),
            content: String::new(),
            tool_calls: vec![],
            tool_call_id: None,
            is_error: false,
            artifact: None,
            blocks: vec![],
            reasoning_content,
            continuation,
        };
        let mut messages = vec![
            assistant(Some(continuation()), None),
            assistant(None, Some("provider reasoning".into())),
            assistant(None, None),
        ];
        repair_messages(&mut messages);
        assert_eq!(messages.len(), 2);
        assert_eq!(json!(messages[0].continuation), json!(Some(continuation())));
        assert_eq!(
            messages[1].reasoning_content.as_deref(),
            Some("provider reasoning")
        );
    }

    #[test]
    fn tool_evidence_survives_reopen_and_provider_account_or_model_changes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("chat.sqlite");
        let store = AgentStore::initialize(path.clone()).unwrap();
        let root = Path::new("/workspace");
        let (thread, _) = store.ensure_chat(root, "Read code").unwrap();
        let mut turn = usage_turn(&thread, "tool-evidence", Usage::default(), None);
        turn.messages.extend([
            Message {
                role: "assistant".into(),
                content: String::new(),
                tool_calls: vec![crate::providers::driver::ToolCall {
                    id: "call".into(),
                    name: "read".into(),
                    arguments: "{}".into(),
                }],
                tool_call_id: None,
                is_error: false,
                artifact: None,
                blocks: vec![],
                reasoning_content: None,
                continuation: None,
            },
            Message {
                role: "tool".into(),
                content: String::new(),
                tool_calls: vec![],
                tool_call_id: Some("call".into()),
                is_error: true,
                artifact: Some("/workspace/results/failure.json".into()),
                blocks: vec![],
                reasoning_content: None,
                continuation: None,
            },
        ]);
        store.save_turn(root, &turn).unwrap();
        drop(store);
        let reopened = AgentStore::initialize(path).unwrap();
        for (provider, model) in [
            ("provider", "model"),
            ("other-provider", "model"),
            ("provider/account-b", "model"),
            ("provider", "other-model"),
        ] {
            let (messages, _) = reopened.history(root, &thread, provider, model).unwrap();
            assert_eq!(messages.len(), 3);
            assert_eq!(json!(messages[2]), json!(turn.messages[2]));
        }
    }

    #[test]
    fn legacy_rows_without_tool_metadata_reopen_with_defaults() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("chat.sqlite");
        let store = AgentStore::initialize(path.clone()).unwrap();
        let root = Path::new("/workspace");
        let (thread, _) = store.ensure_chat(root, "Read code").unwrap();
        let turn = usage_turn(&thread, "legacy-metadata", Usage::default(), None);
        store.save_turn(root, &turn).unwrap();
        let mut legacy = json!(turn.messages);
        for message in legacy.as_array_mut().unwrap() {
            message.as_object_mut().unwrap().remove("isError");
            message.as_object_mut().unwrap().remove("artifact");
        }
        store
            .open()
            .unwrap()
            .execute(
                "UPDATE turns SET messages=?1 WHERE id=?2",
                rusqlite::params![legacy.to_string(), turn.id],
            )
            .unwrap();
        drop(store);
        let reopened = AgentStore::initialize(path).unwrap();
        let (messages, _) = reopened
            .history(root, &thread, "provider", "model")
            .unwrap();
        assert_eq!(json!(messages), json!(turn.messages));
        assert!(!messages[0].is_error);
        assert!(messages[0].artifact.is_none());
    }

    #[test]
    fn harness_session_binding_survives_reopen_and_same_binding_retries() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("chat.sqlite");
        let store = AgentStore::initialize(path.clone()).unwrap();
        let root = Path::new("/workspace/a");
        let (thread, _) = store.ensure_chat(root, "hello").unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        assert_eq!(store.harness_session(root, &thread).unwrap(), None);
        store.bind_harness_session(root, &thread, &session).unwrap();
        store.bind_harness_session(root, &thread, &session).unwrap();
        drop(store);
        let reopened = AgentStore::initialize(path).unwrap();
        assert_eq!(
            reopened.harness_session(root, &thread).unwrap(),
            Some(session)
        );
    }

    #[test]
    fn harness_bindings_reject_replacement_and_reuse_by_another_chat() {
        let temp = tempfile::tempdir().unwrap();
        let store = AgentStore::initialize(temp.path().join("chat.sqlite")).unwrap();
        let root = Path::new("/workspace/a");
        let (first, _) = store.ensure_chat(root, "first").unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        store.bind_harness_session(root, &first, &session).unwrap();
        let replacement = uuid::Uuid::new_v4().to_string();
        assert!(
            store
                .bind_harness_session(root, &first, &replacement)
                .is_err()
        );
        store.new_chat(root).unwrap();
        let (second, _) = store.ensure_chat(root, "second").unwrap();
        assert_ne!(first, second);
        assert!(store.bind_harness_session(root, &second, &session).is_err());
        assert_eq!(store.harness_session(root, &first).unwrap(), Some(session));
        assert_eq!(store.harness_session(root, &second).unwrap(), None);
    }

    #[test]
    fn harness_bindings_validate_workspace_scope_paths_and_ids() {
        let temp = tempfile::tempdir().unwrap();
        let store = AgentStore::initialize(temp.path().join("chat.sqlite")).unwrap();
        let root = Path::new("/workspace/a");
        let other = Path::new("/workspace/b");
        let (thread, _) = store.ensure_chat(root, "first").unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        assert!(store.harness_session(other, &thread).is_err());
        assert!(
            store
                .bind_harness_session(other, &thread, &session)
                .is_err()
        );
        assert_eq!(store.harness_session(root, &thread).unwrap(), None);
        for path in [
            Path::new("relative"),
            Path::new("/workspace/a/../b"),
            Path::new("/workspace/\n"),
        ] {
            assert!(store.harness_session(path, &thread).is_err());
            assert!(store.bind_harness_session(path, &thread, &session).is_err());
        }
        for invalid in [
            "",
            "../session",
            "bad\nidentifier",
            "00000000-0000-0000-0000-000000000000",
        ] {
            assert!(store.harness_session(root, invalid).is_err());
            assert!(store.bind_harness_session(root, &thread, invalid).is_err());
        }
        let unknown = uuid::Uuid::new_v4().to_string();
        assert!(store.harness_session(root, &unknown).is_err());
        assert!(
            store
                .bind_harness_session(root, &unknown, &session)
                .is_err()
        );
        let (other_thread, _) = store.ensure_chat(other, "other").unwrap();
        store.bind_harness_session(root, &thread, &session).unwrap();
        assert!(
            store
                .bind_harness_session(other, &other_thread, &session)
                .is_err()
        );
    }

    #[test]
    fn concurrent_harness_bindings_choose_one_session_without_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let store = AgentStore::initialize(temp.path().join("chat.sqlite")).unwrap();
        let root = Path::new("/workspace/a");
        let (thread, _) = store.ensure_chat(root, "hello").unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let sessions = [
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
        ];
        let workers = sessions.clone().map(|session| {
            let store = store.clone();
            let thread = thread.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                (
                    session.clone(),
                    store.bind_harness_session(Path::new("/workspace/a"), &thread, &session),
                )
            })
        });
        let results = workers.map(|worker| worker.join().unwrap());
        assert_eq!(
            results.iter().filter(|(_, result)| result.is_ok()).count(),
            1
        );
        let winner = results
            .into_iter()
            .find(|(_, result)| result.is_ok())
            .unwrap()
            .0;
        assert_eq!(store.harness_session(root, &thread).unwrap(), Some(winner));
    }

    fn usage_turn(thread: &str, id: &str, usage: Usage, last_usage: Option<Usage>) -> StoredTurn {
        StoredTurn {
            id: id.into(),
            thread_id: thread.into(),
            provider_id: "provider".into(),
            model: "model".into(),
            status: "completed".into(),
            error: None,
            items: vec![],
            messages: vec![Message {
                role: "user".into(),
                content: "hello".into(),
                tool_calls: vec![],
                tool_call_id: None,
                is_error: false,
                artifact: None,
                blocks: vec![],
                reasoning_content: None,
                continuation: None,
            }],
            usage,
            last_usage,
        }
    }

    #[test]
    fn usage_restores_totals_and_last_request_across_reopen_and_empty_turns() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("chat.sqlite");
        let store = AgentStore::initialize(path.clone()).unwrap();
        let root = Path::new("/workspace/a");
        let (thread, _) = store.ensure_chat(root, "hello").unwrap();
        let first = Usage {
            input_tokens: 80,
            cached_input_tokens: Some(20),
            cache_write_input_tokens: 10,
            output_tokens: 12,
            reasoning_output_tokens: Some(2),
        };
        let second = Usage {
            input_tokens: 40,
            cached_input_tokens: Some(5),
            cache_write_input_tokens: 0,
            output_tokens: 7,
            reasoning_output_tokens: Some(1),
        };
        let last = Usage {
            input_tokens: 25,
            cached_input_tokens: Some(3),
            cache_write_input_tokens: 0,
            output_tokens: 4,
            reasoning_output_tokens: Some(1),
        };
        store
            .save_turn(
                root,
                &usage_turn(&thread, "first", first.clone(), Some(first)),
            )
            .unwrap();
        store
            .save_turn(
                root,
                &usage_turn(&thread, "second", second, Some(last.clone())),
            )
            .unwrap();
        store
            .save_turn(root, &usage_turn(&thread, "empty", Usage::default(), None))
            .unwrap();
        drop(store);
        let reopened = AgentStore::initialize(path).unwrap();
        let (total, restored_last) = reopened.usage(root, &thread).unwrap();
        assert_eq!(
            json!(total),
            json!(Usage {
                input_tokens: 120,
                cached_input_tokens: Some(25),
                cache_write_input_tokens: 10,
                output_tokens: 19,
                reasoning_output_tokens: Some(3)
            })
        );
        assert_eq!(json!(restored_last), json!(Some(last)));
        let (_, history_total) = reopened
            .history(root, &thread, "provider", "model")
            .unwrap();
        assert_eq!(json!(history_total), json!(total));
        assert!(reopened.usage(Path::new("/workspace/b"), &thread).is_err());
    }

    #[test]
    fn legacy_flat_usage_rows_restore_with_no_last_request() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("chat.sqlite");
        let store = AgentStore::initialize(path.clone()).unwrap();
        let root = Path::new("/workspace/a");
        let (thread, _) = store.ensure_chat(root, "hello").unwrap();
        let legacy = Usage {
            input_tokens: 22,
            cached_input_tokens: Some(7),
            cache_write_input_tokens: 2,
            output_tokens: 9,
            reasoning_output_tokens: Some(3),
        };
        store
            .save_turn(root, &usage_turn(&thread, "legacy", legacy.clone(), None))
            .unwrap();
        store
            .open()
            .unwrap()
            .execute(
                "UPDATE turns SET usage=?1 WHERE id='legacy'",
                [serde_json::to_string(&legacy).unwrap()],
            )
            .unwrap();
        drop(store);
        let reopened = AgentStore::initialize(path).unwrap();
        let (total, last) = reopened.usage(root, &thread).unwrap();
        assert_eq!(json!(total), json!(legacy));
        assert!(last.is_none());
        let (history, history_total) = reopened
            .history(root, &thread, "provider", "model")
            .unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(json!(history_total), json!(legacy));
        let new = Usage {
            input_tokens: 5,
            output_tokens: 2,
            ..Usage::default()
        };
        reopened
            .save_turn(
                root,
                &usage_turn(&thread, "new", new.clone(), Some(new.clone())),
            )
            .unwrap();
        let (mixed, last) = reopened.usage(root, &thread).unwrap();
        assert_eq!(mixed.input_tokens, 27);
        assert_eq!(mixed.output_tokens, 11);
        assert_eq!(json!(last), json!(Some(new)));
    }

    #[test]
    fn legacy_records_without_continuation_or_usage_details_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("chat.sqlite");
        let store = AgentStore::initialize(path.clone()).unwrap();
        let root = Path::new("/workspace/a");
        let (thread, _) = store.ensure_chat(root, "hello").unwrap();
        store
            .save_turn(root, &usage_turn(&thread, "legacy", Usage::default(), None))
            .unwrap();
        store.open().unwrap().execute(
            "UPDATE turns SET messages=?1,usage=?2 WHERE id='legacy'",
            params![
                r#"[{"role":"assistant","content":"hello","toolCalls":[],"toolCallId":null,"blocks":[],"reasoningContent":null}]"#,
                r#"{"inputTokens":22,"outputTokens":9}"#,
            ],
        ).unwrap();
        drop(store);
        let reopened = AgentStore::initialize(path).unwrap();
        let (history, counts) = reopened
            .history(root, &thread, "provider", "model")
            .unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].content, "hello");
        assert!(history[0].continuation.is_none());
        assert_eq!(counts.input_tokens, 22);
        assert_eq!(counts.output_tokens, 9);
        assert!(counts.cached_input_tokens.is_none());
        assert!(counts.reasoning_output_tokens.is_none());
        assert_eq!(counts.cache_write_input_tokens, 0);
        let (total, last) = reopened.usage(root, &thread).unwrap();
        assert_eq!(json!(total), json!(counts));
        assert!(last.is_none());
        assert!(json!(total).get("cachedInputTokens").is_none());
        assert!(json!(total).get("reasoningOutputTokens").is_none());
    }

    #[test]
    fn partial_usage_details_sum_only_reported_values_across_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("chat.sqlite");
        let store = AgentStore::initialize(path.clone()).unwrap();
        let root = Path::new("/workspace/a");
        let (thread, _) = store.ensure_chat(root, "hello").unwrap();
        let unknown = Usage {
            input_tokens: 10,
            output_tokens: 4,
            ..Usage::default()
        };
        let reported = Usage {
            input_tokens: 10,
            output_tokens: 4,
            cached_input_tokens: Some(3),
            reasoning_output_tokens: Some(2),
            ..Usage::default()
        };
        let last = Usage {
            input_tokens: 7,
            output_tokens: 1,
            ..Usage::default()
        };
        for (id, counts) in [
            ("unknown", unknown),
            ("reported", reported),
            ("last", last.clone()),
        ] {
            store
                .save_turn(root, &usage_turn(&thread, id, counts.clone(), Some(counts)))
                .unwrap();
        }
        drop(store);
        let reopened = AgentStore::initialize(path).unwrap();
        let (total, restored_last) = reopened.usage(root, &thread).unwrap();
        assert_eq!(total.input_tokens, 27);
        assert_eq!(total.output_tokens, 9);
        assert_eq!(total.cached_input_tokens, Some(3));
        assert_eq!(total.reasoning_output_tokens, Some(2));
        assert_eq!(json!(restored_last), json!(Some(last)));
        let (_, history_total) = reopened
            .history(root, &thread, "provider", "model")
            .unwrap();
        assert_eq!(json!(history_total), json!(total));
    }

    #[test]
    fn usage_aggregation_distinguishes_missing_and_reported_zero_and_saturates() {
        let mut total = Usage::default();
        add_usage(&mut total, &Usage::default());
        assert!(total.cached_input_tokens.is_none());
        assert!(total.reasoning_output_tokens.is_none());
        add_usage(
            &mut total,
            &Usage {
                cached_input_tokens: Some(0),
                reasoning_output_tokens: Some(0),
                ..Usage::default()
            },
        );
        assert_eq!(total.cached_input_tokens, Some(0));
        assert_eq!(total.reasoning_output_tokens, Some(0));
        total = Usage {
            input_tokens: u64::MAX,
            output_tokens: u64::MAX,
            cached_input_tokens: Some(u64::MAX),
            reasoning_output_tokens: Some(u64::MAX),
            cache_write_input_tokens: u64::MAX,
        };
        add_usage(
            &mut total,
            &Usage {
                input_tokens: 1,
                output_tokens: 1,
                cached_input_tokens: Some(1),
                reasoning_output_tokens: Some(1),
                cache_write_input_tokens: 1,
            },
        );
        assert_eq!(total.input_tokens, u64::MAX);
        assert_eq!(total.output_tokens, u64::MAX);
        assert_eq!(total.cached_input_tokens, Some(u64::MAX));
        assert_eq!(total.reasoning_output_tokens, Some(u64::MAX));
        assert_eq!(total.cache_write_input_tokens, u64::MAX);
    }

    #[test]
    fn pending_calls_receive_results_before_following_user_messages() {
        let mut messages = vec![
            Message {
                role: "assistant".into(),
                content: String::new(),
                tool_calls: vec![crate::providers::driver::ToolCall {
                    id: "call".into(),
                    name: "read".into(),
                    arguments: "{}".into(),
                }],
                tool_call_id: None,
                is_error: false,
                artifact: None,
                blocks: vec![],
                reasoning_content: None,
                continuation: None,
            },
            Message {
                role: "user".into(),
                content: "next".into(),
                tool_calls: vec![],
                tool_call_id: None,
                is_error: false,
                artifact: None,
                blocks: vec![],
                reasoning_content: None,
                continuation: None,
            },
        ];
        repair_messages(&mut messages);
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[1].tool_call_id.as_deref(), Some("call"));
        assert!(messages[1].is_error);
        assert!(messages[1].artifact.is_none());
        assert_eq!(messages[2].role, "user");
    }
    #[test]
    fn repair_preserves_out_of_order_tool_evidence_and_only_fails_missing_results() {
        let mut assistant = usage_turn("thread", "turn", Usage::default(), None)
            .messages
            .remove(0);
        assistant.role = "assistant".into();
        assistant.content.clear();
        assistant.tool_calls = ["a", "b", "c"]
            .into_iter()
            .map(|id| crate::providers::driver::ToolCall {
                id: id.into(),
                name: "read".into(),
                arguments: "{}".into(),
            })
            .collect();
        let result = |id: &str, is_error| Message {
            role: "tool".into(),
            content: String::new(),
            tool_calls: vec![],
            tool_call_id: Some(id.into()),
            is_error,
            artifact: Some(format!("/workspace/results/{id}.json").into()),
            blocks: vec![],
            reasoning_content: None,
            continuation: None,
        };
        let failure = result("b", true);
        let success = result("a", false);
        let user = usage_turn("thread", "next", Usage::default(), None)
            .messages
            .remove(0);
        let mut messages = vec![assistant, failure.clone(), success.clone(), user];
        repair_messages(&mut messages);
        assert_eq!(messages.len(), 5);
        assert_eq!(json!(messages[1]), json!(failure));
        assert_eq!(json!(messages[2]), json!(success));
        assert_eq!(messages[3].tool_call_id.as_deref(), Some("c"));
        assert!(messages[3].is_error);
        assert!(messages[3].artifact.is_none());
        assert_eq!(messages[4].role, "user");
        let once = json!(messages);
        repair_messages(&mut messages);
        assert_eq!(json!(messages), once);
    }

    #[test]
    fn cursor_is_bounded() {
        for c in ["-1", "abc", "100001", "999999999999999999999"] {
            assert!(cursor_offset(Some(c)).is_err());
        }
    }
}
