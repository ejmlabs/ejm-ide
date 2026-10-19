use crate::{
    HostAccessState, NativeEvents,
    harness::{HarnessState, Outcome},
    lsp::{self, Language, LspClient, LspEvent},
    workspace::WorkspaceState,
};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State, WebviewWindow};

struct Session {
    root: PathBuf,
    client: Mutex<LspClient>,
    hierarchy_items: Mutex<HierarchyItems>,
}

#[derive(Default)]
pub struct LanguageState {
    sessions: Arc<Mutex<HashMap<Language, Arc<Session>>>>,
    requests: Arc<Mutex<RequestCancellations>>,
}

impl LanguageState {
    pub fn clear(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.clear();
        }
        if let Ok(mut requests) = self.requests.lock() {
            for request in requests.entries.values() {
                request.cancelled.store(true, Ordering::Release);
            }
            requests.entries.clear();
        }
    }
}

const MAX_CANCELLABLE_REQUESTS: usize = 2048;
const MAX_HIERARCHY_ITEMS: usize = 262_144;

struct RequestCancellation {
    root: PathBuf,
    cancelled: Arc<AtomicBool>,
    started: bool,
    created: Instant,
}

#[derive(Default)]
struct RequestCancellations {
    entries: HashMap<uuid::Uuid, RequestCancellation>,
}

impl RequestCancellations {
    fn entry(&mut self, root: &Path, id: uuid::Uuid) -> Result<&mut RequestCancellation, String> {
        self.entries.retain(|_, request| {
            if request.root != root {
                request.cancelled.store(true, Ordering::Release);
                return false;
            }
            request.started || request.created.elapsed() < Duration::from_secs(60)
        });
        if !self.entries.contains_key(&id) && self.entries.len() >= MAX_CANCELLABLE_REQUESTS {
            return Err("Too many cancellable language requests are pending.".into());
        }
        Ok(self
            .entries
            .entry(id)
            .or_insert_with(|| RequestCancellation {
                root: root.to_path_buf(),
                cancelled: Arc::new(AtomicBool::new(false)),
                started: false,
                created: Instant::now(),
            }))
    }

    fn start(&mut self, root: &Path, id: uuid::Uuid) -> Result<Arc<AtomicBool>, String> {
        let request = self.entry(root, id)?;
        if request.started {
            return Err("This language request token is already in use.".into());
        }
        request.started = true;
        Ok(request.cancelled.clone())
    }

    fn cancel(&mut self, root: &Path, id: uuid::Uuid) -> Result<(), String> {
        // Keep an early cancellation until its paired command reaches the host.
        self.entry(root, id)?
            .cancelled
            .store(true, Ordering::Release);
        Ok(())
    }

    fn finish(&mut self, id: uuid::Uuid, cancelled: &Arc<AtomicBool>) {
        if self
            .entries
            .get(&id)
            .is_some_and(|request| Arc::ptr_eq(&request.cancelled, cancelled))
        {
            self.entries.remove(&id);
        }
    }
}

#[derive(Default)]
struct HierarchyItems {
    observed: HashSet<[u8; 32]>,
}

impl HierarchyItems {
    fn fingerprint(item: &Value) -> Result<[u8; 32], String> {
        if !item.is_object() || item["uri"].as_str().is_none() {
            return Err("Call hierarchy item has no source URI.".into());
        }
        let bytes = serde_json::to_vec(item).map_err(|error| error.to_string())?;
        Ok(Sha256::digest(bytes).into())
    }

    fn check(&self, item: &Value) -> Result<(), String> {
        if !self.observed.contains(&Self::fingerprint(item)?) {
            return Err("This call hierarchy item was not returned by the active language server. Refresh the hierarchy.".into());
        }
        lsp::uri_to_path(item["uri"].as_str().unwrap()).map_err(|_| {
            "This call hierarchy dependency uses a source URI that ejm-ide cannot traverse."
                .to_owned()
        })?;
        Ok(())
    }

    fn observe(&mut self, method: &str, result: &Value) -> Result<(), String> {
        let field = match method {
            "textDocument/prepareCallHierarchy" => None,
            "callHierarchy/incomingCalls" => Some("from"),
            "callHierarchy/outgoingCalls" => Some("to"),
            _ => return Ok(()),
        };
        let mut incoming = HashSet::new();
        for value in result.as_array().into_iter().flatten() {
            let item = field.map_or(value, |field| &value[field]);
            incoming.insert(Self::fingerprint(item)?);
        }
        if self.observed.len() + incoming.difference(&self.observed).count() > MAX_HIERARCHY_ITEMS {
            return Err("Call graph traversal reached the limit of 262,144 observed symbols. The graph is incomplete.".into());
        }
        self.observed.extend(incoming);
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageStatus {
    language: &'static str,
    status: &'static str,
    capabilities: Option<Value>,
    message: Option<String>,
}

fn key(language: Language) -> &'static str {
    match language {
        Language::Rust => "rust",
        Language::Python => "python",
        Language::TypeScript => "typescript",
        Language::Ruby => "ruby",
        Language::Go => "go",
    }
}

fn node_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("WORKBENCH_NODE") {
        return lsp::find_executable(Path::new(&path))
            .ok_or_else(|| "WORKBENCH_NODE must name a Node.js executable.".into());
    }
    if let Some(path) = lsp::find_executable(Path::new("node")) {
        return Ok(path);
    }
    if let Some(home) = std::env::var_os("HOME") {
        for parent in [
            PathBuf::from(&home).join(".local/share/fnm/node-versions"),
            PathBuf::from(&home).join(".nvm/versions/node"),
        ] {
            let mut versions: Vec<_> = std::fs::read_dir(parent)
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .collect();
            versions.sort();
            for version in versions.into_iter().rev() {
                for candidate in [
                    version.join("installation/bin/node"),
                    version.join("bin/node"),
                ] {
                    if let Some(path) = lsp::find_executable(&candidate) {
                        return Ok(path);
                    }
                }
            }
        }
    }
    Err("Python and TypeScript intelligence need Node.js. Install Node.js or set WORKBENCH_NODE to its executable.".into())
}

/// Development uses npm's local packages; packaged apps use the same package layout in resources.
pub fn server_command(language: Language, resources: Option<&Path>) -> Result<Command, String> {
    let override_key = match language {
        Language::Rust => "EJM_IDE_RUST_LSP",
        Language::Python => "EJM_IDE_PYTHON_LSP",
        Language::TypeScript => "EJM_IDE_TYPESCRIPT_LSP",
        Language::Ruby => "EJM_IDE_RUBY_LSP",
        Language::Go => "EJM_IDE_GO_LSP",
    };
    if std::env::var_os(override_key).is_some()
        || matches!(language, Language::Rust | Language::Ruby | Language::Go)
    {
        let program = language.server_path().map_err(|error| error.to_string())?;
        let mut command = Command::new(&program);
        if let Some(parent) = program.parent() {
            let mut paths = vec![
                parent.to_path_buf(),
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/local/bin"),
            ];
            paths.extend(
                std::env::var_os("PATH")
                    .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
                    .unwrap_or_default(),
            );
            if let Ok(path) = std::env::join_paths(paths) {
                command.env("PATH", path);
            }
        }
        if matches!(language, Language::Python | Language::TypeScript) {
            command.arg("--stdio");
        }
        return Ok(command);
    }
    let (package, binary) = match language {
        Language::Python => ("pyright", "pyright-langserver"),
        Language::TypeScript => ("typescript-language-server", "typescript-language-server"),
        Language::Rust | Language::Ruby | Language::Go => unreachable!(),
    };
    let mut locations = Vec::new();
    if cfg!(debug_assertions) {
        locations.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../node_modules"));
    }
    if let Some(resources) = resources {
        locations.push(resources.join("node_modules"));
    }
    for location in locations {
        let package_root = location.join(package);
        let Ok(bytes) = std::fs::read(package_root.join("package.json")) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        let entry = manifest["bin"]
            .as_str()
            .or_else(|| manifest["bin"][binary].as_str());
        if let Some(entry) = entry {
            let script = package_root.join(entry);
            if !script.is_file() {
                continue;
            }
            let node = node_path()?;
            let mut command = Command::new(&node);
            command.arg(script).arg("--stdio");
            if let Some(parent) = node.parent() {
                let mut paths = vec![parent.to_path_buf()];
                paths.extend(
                    std::env::var_os("PATH")
                        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
                        .unwrap_or_default(),
                );
                if let Ok(path) = std::env::join_paths(paths) {
                    command.env("PATH", path);
                }
            }
            return Ok(command);
        }
    }
    let mut command = Command::new(language.server_path().map_err(|error| error.to_string())?);
    command.arg("--stdio");
    Ok(command)
}

pub fn server_initialization_options(language: Language, resources: Option<&Path>) -> Value {
    if language == Language::Rust {
        // The IDE runs Clippy on save, so rust-analyzer must not start a second Cargo check.
        return json!({ "checkOnSave": false });
    }
    if language == Language::Go {
        return json!({ "semanticTokens": true });
    }
    if language != Language::TypeScript {
        return json!({});
    }
    let mut locations = Vec::new();
    if cfg!(debug_assertions) {
        locations.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../node_modules"));
    }
    if let Some(resources) = resources {
        locations.push(resources.join("node_modules"));
    }
    let fallback = locations
        .iter()
        .flat_map(|modules| {
            [
                modules.join("typescript-lsp/lib/tsserver.js"),
                modules.join("typescript/lib/tsserver.js"),
            ]
        })
        .find(|path| path.is_file());
    json!({
        "hostInfo": "ejm-ide", "disableAutomaticTypingAcquisition": true,
        "maxTsServerMemory": 512,
        "tsserver": { "fallbackPath": fallback.map(|path| path.to_string_lossy().into_owned()) }
    })
}

fn session(
    sessions: &Mutex<HashMap<Language, Arc<Session>>>,
    root: &Path,
    language: Language,
    app: &AppHandle,
) -> Result<Arc<Session>, String> {
    {
        let mut sessions = sessions
            .lock()
            .map_err(|_| "Language services are unavailable")?;
        sessions.retain(|_, session| session.root == root);
        if let Some(existing) = sessions.get(&language) {
            return Ok(existing.clone());
        }
    }
    let resources = app.path().resource_dir().ok();
    let command = server_command(language, resources.as_deref())?;
    let options = server_initialization_options(language, resources.as_deref());
    let client = LspClient::start_with_options(root, language, command, options)
        .map_err(|error| error.to_string())?;
    let created = Arc::new(Session {
        root: root.to_path_buf(),
        client: Mutex::new(client),
        hierarchy_items: Mutex::new(HierarchyItems::default()),
    });
    let mut sessions = sessions
        .lock()
        .map_err(|_| "Language services are unavailable")?;
    if let Some(existing) = sessions.get(&language)
        && existing.root == root
    {
        return Ok(existing.clone());
    }
    sessions.insert(language, created.clone());
    drop(sessions);
    let weak = Arc::downgrade(&created);
    let app = app.clone();
    thread::spawn(move || {
        while let Some(session) = weak.upgrade() {
            let Ok(client) = session.client.lock() else {
                break;
            };
            let mut stopped = false;
            for _ in 0..100 {
                match client.try_recv() {
                    Ok(Some(LspEvent::Notification { method, params })) => app.state::<NativeEvents>().publish("language:event", json!({ "language": key(language), "root": session.root, "method": method, "params": params })),
                    Ok(Some(LspEvent::Error { id: None, message })) => {
                        app.state::<NativeEvents>().publish("language:event", json!({ "language": key(language), "root": session.root, "method": "workbench/status", "params": { "status": "error", "message": message } }));
                        stopped = true; break;
                    }
                    Ok(Some(_)) => {},
                    Ok(None) => break,
                    Err(_) => { stopped = true; break; }
                }
            }
            drop(client);
            drop(session);
            if stopped {
                break;
            }
            thread::sleep(Duration::from_millis(30));
        }
    });
    Ok(created)
}

fn checked_document(
    workspace: &WorkspaceState,
    path: &str,
    content: &str,
    version: i32,
) -> Result<(PathBuf, Option<Language>), String> {
    if content.len() > 2 * 1024 * 1024 {
        return Err("Language services support text files up to 2 MiB.".into());
    }
    if version < 1 {
        return Err("Document version must be positive.".into());
    }
    let path = workspace.validate_path(path, false)?;
    let language = Language::for_path(&path);
    Ok((path, language))
}

#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "Tauri injects host and workspace state alongside the document payload."
)]
pub async fn language_open(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    languages: State<'_, LanguageState>,
    auth: String,
    path: String,
    content: String,
    version: i32,
) -> Result<LanguageStatus, String> {
    host.check(&window, &auth)?;
    let mut activity = window
        .app_handle()
        .state::<HarnessState>()
        .begin_operation("language.open");
    activity
        .record_request(&serde_json::json!({"path": path, "content": content, "version": version}));
    let result: Result<LanguageStatus, String> = async {
        let (path, language) = checked_document(&workspace, &path, &content, version)?;
        let Some(language) = language else {
            return Ok(LanguageStatus {
                language: "plaintext",
                status: "unsupported",
                capabilities: None,
                message: None,
            });
        };
        let root = workspace.root_path()?;
        let sessions = languages.sessions.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let session = match session(&sessions, &root, language, &app) {
                Ok(session) => session,
                Err(message) => {
                    return Ok(LanguageStatus {
                        language: key(language),
                        status: "unavailable",
                        capabilities: None,
                        message: Some(message),
                    });
                }
            };
            let mut client = session
                .client
                .lock()
                .map_err(|_| "Language server is unavailable")?;
            client
                .open_version(&path, &content, version)
                .map_err(|error| error.to_string())?;
            Ok(LanguageStatus {
                language: key(language),
                status: "ready",
                capabilities: Some(client.capabilities().clone()),
                message: None,
            })
        })
        .await
        .map_err(|error| error.to_string())?
    }
    .await;
    match &result {
        Ok(value) if value.status == "unavailable" => {
            activity.record_response(&serde_json::json!(value));
            if let Some(message) = &value.message {
                activity.record_error(message);
            }
            activity.finish(
                value
                    .message
                    .as_deref()
                    .map_or(Outcome::Failed("unavailable"), Outcome::error),
            );
        }
        _ => activity.record_result(&result),
    }
    result
}

#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "Tauri injects host and workspace state alongside the document payload."
)]
pub async fn language_change(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    languages: State<'_, LanguageState>,
    auth: String,
    path: String,
    content: String,
    version: i32,
) -> Result<(), String> {
    host.check(&window, &auth)?;
    let (path, language) = checked_document(&workspace, &path, &content, version)?;
    let Some(language) = language else {
        return Ok(());
    };
    let root = workspace.root_path()?;
    let session = languages
        .sessions
        .lock()
        .map_err(|_| "Language services are unavailable")?
        .get(&language)
        .cloned();
    if let Some(session) = session.filter(|session| session.root == root) {
        session
            .client
            .lock()
            .map_err(|_| "Language server is unavailable")?
            .change_version(&path, &content, version)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "Tauri injects host and workspace state alongside the saved document payload."
)]
pub fn language_save(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    languages: State<'_, LanguageState>,
    auth: String,
    path: String,
    content: String,
    version: i32,
) -> Result<(), String> {
    host.check(&window, &auth)?;
    let mut activity = window
        .app_handle()
        .state::<HarnessState>()
        .begin_operation("language.save");
    activity
        .record_request(&serde_json::json!({"path": path, "content": content, "version": version}));
    let result: Result<(), String> = (|| {
        let (path, language) = checked_document(&workspace, &path, &content, version)?;
        let Some(language) = language else {
            return Ok(());
        };
        let root = workspace.root_path()?;
        let session = languages
            .sessions
            .lock()
            .map_err(|_| "Language services are unavailable")?
            .get(&language)
            .cloned()
            .filter(|session| session.root == root);
        if let Some(session) = session {
            if workspace.read_document(&path)?.content != content {
                return Err(
                    "The saved file changed before its language service was notified.".into(),
                );
            }
            session
                .client
                .lock()
                .map_err(|_| "Language server is unavailable")?
                .save_version(&path, &content, version)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    })();
    activity.record_result(&result);
    result
}

fn request_capability(method: &str) -> Option<&'static str> {
    match method {
        "textDocument/hover" => Some("hoverProvider"),
        "textDocument/definition" => Some("definitionProvider"),
        "textDocument/typeDefinition" => Some("typeDefinitionProvider"),
        "textDocument/implementation" => Some("implementationProvider"),
        "textDocument/references" => Some("referencesProvider"),
        "textDocument/prepareCallHierarchy"
        | "callHierarchy/incomingCalls"
        | "callHierarchy/outgoingCalls" => Some("callHierarchyProvider"),
        "textDocument/completion" | "completionItem/resolve" => Some("completionProvider"),
        "textDocument/signatureHelp" => Some("signatureHelpProvider"),
        "textDocument/documentSymbol" => Some("documentSymbolProvider"),
        "textDocument/formatting" => Some("documentFormattingProvider"),
        "textDocument/semanticTokens/full" | "textDocument/semanticTokens/range" => {
            Some("semanticTokensProvider")
        }
        _ => None,
    }
}

#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "Tauri injects host and workspace state alongside the LSP request payload."
)]
pub async fn language_request(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    languages: State<'_, LanguageState>,
    auth: String,
    path: String,
    method: String,
    mut params: Value,
    request_id: Option<String>,
) -> Result<Value, String> {
    host.check(&window, &auth)?;
    let mut activity = window
        .app_handle()
        .state::<HarnessState>()
        .begin_operation(&format!(
            "lsp.{}",
            if request_capability(&method).is_some() {
                method.as_str()
            } else {
                "unsupported"
            }
        ));
    activity.record_request(&serde_json::json!({"path": path, "method": method, "params": params, "requestId": request_id}));
    let result: Result<Value, String> = async {
        let capability = request_capability(&method)
            .ok_or("This language server request is not supported by ejm-ide.")?;
        if !params.is_object()
            || serde_json::to_vec(&params)
                .map_err(|error| error.to_string())?
                .len()
                > 256 * 1024
        {
            return Err(
                "Language server parameters must be an object smaller than 256 KiB.".into(),
            );
        }
        let path = workspace.validate_path(&path, false)?;
        let language = Language::for_path(&path).ok_or("This document has no language server.")?;
        if method.starts_with("textDocument/") {
            params["textDocument"] =
                json!({ "uri": lsp::path_to_uri(&path).map_err(|error| error.to_string())? });
        }
        activity.record_request(&json!({
            "path": path,
            "method": method,
            "params": params,
            "requestId": request_id,
        }));
        let root = workspace.root_path()?;
        let session = languages
            .sessions
            .lock()
            .map_err(|_| "Language services are unavailable")?
            .get(&language)
            .cloned()
            .filter(|session| session.root == root)
            .ok_or("Open this document's language service first.")?;
        if method.starts_with("callHierarchy/") {
            session
                .hierarchy_items
                .lock()
                .map_err(|_| "Call hierarchy items are unavailable")?
                .check(&params["item"])?;
        }
        let handle = {
            let client = session
                .client
                .lock()
                .map_err(|_| "Language server is unavailable")?;
            if client
                .capabilities()
                .get(capability)
                .is_none_or(|value| value.is_null() || value == false)
            {
                return Err(format!(
                    "{} language server does not support this action.",
                    language.name()
                ));
            }
            client.handle()
        };
        let request_id = request_id
            .map(|id| uuid::Uuid::parse_str(&id).map_err(|_| "Invalid language request token."))
            .transpose()?;
        let cancellation = request_id
            .map(|id| {
                languages
                    .requests
                    .lock()
                    .map_err(|_| "Language request cancellation is unavailable".to_owned())?
                    .start(&root, id)
            })
            .transpose()?;
        let requests = languages.requests.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let result = if let Some(cancelled) = &cancellation {
                handle.request_cancellable(&method, params, cancelled)
            } else {
                handle.request_blocking(&method, params)
            }
            .map_err(|error| error.to_string());
            if let (Some(id), Some(cancelled)) = (request_id, &cancellation)
                && let Ok(mut requests) = requests.lock()
            {
                requests.finish(id, cancelled);
            }
            let result = result?;
            session
                .hierarchy_items
                .lock()
                .map_err(|_| "Call hierarchy items are unavailable")?
                .observe(&method, &result)?;
            Ok(result)
        })
        .await
        .map_err(|error| error.to_string())?
    }
    .await;
    activity.record_result(&result);
    result
}

#[tauri::command]
pub fn language_cancel(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    languages: State<'_, LanguageState>,
    auth: String,
    request_id: String,
) -> Result<(), String> {
    host.check(&window, &auth)?;
    let root = workspace.root_path()?;
    let id = uuid::Uuid::parse_str(&request_id).map_err(|_| "Invalid language request token.")?;
    languages
        .requests
        .lock()
        .map_err(|_| "Language request cancellation is unavailable")?
        .cancel(&root, id)
}

#[tauri::command]
pub fn language_close(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    languages: State<'_, LanguageState>,
    auth: String,
    path: String,
) -> Result<(), String> {
    host.check(&window, &auth)?;
    let path = workspace.validate_path(&path, true)?;
    if let Some(language) = Language::for_path(&path)
        && let Some(session) = languages
            .sessions
            .lock()
            .map_err(|_| "Language services are unavailable")?
            .get(&language)
    {
        session
            .client
            .lock()
            .map_err(|_| "Language server is unavailable")?
            .close(&path)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(name: &str, uri: &str) -> Value {
        json!({
            "name": name, "kind": 12, "uri": uri,
            "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 3, "character": 1 } },
            "selectionRange": { "start": { "line": 0, "character": 3 }, "end": { "line": 0, "character": 8 } },
            "data": { "serverSymbol": name },
        })
    }

    #[test]
    fn hierarchy_traverses_observed_dependencies_but_rejects_fabricated_or_mutated_items() {
        let root = item("root", "file:///workspace/src/root.rs");
        let dependency = item("dependency", "file:///vendor/crate/src/dependency.rs");
        let caller = item("caller", "file:///workspace/src/caller.rs");
        let mut hierarchy = HierarchyItems::default();
        hierarchy
            .observe("textDocument/prepareCallHierarchy", &json!([root.clone()]))
            .unwrap();
        assert!(hierarchy.check(&root).is_ok());
        assert!(hierarchy.check(&dependency).is_err());
        hierarchy
            .observe(
                "callHierarchy/outgoingCalls",
                &json!([{ "to": dependency.clone(), "fromRanges": [] }]),
            )
            .unwrap();
        hierarchy
            .observe(
                "callHierarchy/incomingCalls",
                &json!([{ "from": caller.clone(), "fromRanges": [] }]),
            )
            .unwrap();
        assert!(hierarchy.check(&dependency).is_ok());
        assert!(hierarchy.check(&caller).is_ok());
        let mut changed = dependency.clone();
        changed["data"]["serverSymbol"] = json!("different");
        assert!(hierarchy.check(&changed).is_err());
        changed = dependency.clone();
        changed["uri"] = json!("file:///private/other.rs");
        assert!(hierarchy.check(&changed).is_err());
        assert!(HierarchyItems::default().check(&dependency).is_err());
    }

    #[test]
    fn non_file_dependency_sources_have_an_explicit_traversal_boundary() {
        let dependency = item("virtual", "rust-analyzer://virtual/library.rs");
        let mut hierarchy = HierarchyItems::default();
        hierarchy
            .observe(
                "textDocument/prepareCallHierarchy",
                &json!([dependency.clone()]),
            )
            .unwrap();
        assert!(
            hierarchy
                .check(&dependency)
                .unwrap_err()
                .contains("source URI")
        );
    }

    #[test]
    fn cancellation_tokens_handle_early_abort_duplicate_ids_and_workspace_changes() {
        let mut requests = RequestCancellations::default();
        let root = Path::new("/workspace");
        let id = uuid::Uuid::new_v4();
        requests.cancel(root, id).unwrap();
        let flag = requests.start(root, id).unwrap();
        assert!(flag.load(Ordering::Acquire));
        assert!(requests.start(root, id).is_err());
        requests.finish(id, &flag);
        assert!(requests.entries.is_empty());

        let first_id = uuid::Uuid::new_v4();
        let first_flag = requests.start(root, first_id).unwrap();
        let second_flag = requests
            .start(Path::new("/other-workspace"), uuid::Uuid::new_v4())
            .unwrap();
        assert!(first_flag.load(Ordering::Acquire));
        assert!(!second_flag.load(Ordering::Acquire));
        assert_eq!(requests.entries.len(), 1);
        requests.finish(first_id, &first_flag);
        assert_eq!(requests.entries.len(), 1);
    }
}
