use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    env,
    io::{self, BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex, TryLockError,
        atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender, TryRecvError},
    },
    thread,
    time::{Duration, Instant},
};
use url::Url;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_PENDING: usize = 256;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Language {
    Rust,
    Python,
    TypeScript,
    Ruby,
    Go,
}

impl Language {
    pub fn for_path(path: &Path) -> Option<Self> {
        if matches!(
            path.file_name()?.to_str()?,
            "Gemfile" | "Rakefile" | "Guardfile" | "Brewfile"
        ) {
            return Some(Self::Ruby);
        }
        match path.extension()?.to_str()? {
            "rs" => Some(Self::Rust),
            "py" | "pyi" => Some(Self::Python),
            "ts" | "tsx" | "mts" | "cts" | "js" | "jsx" | "mjs" | "cjs" => Some(Self::TypeScript),
            "rb" | "rake" | "gemspec" | "ru" => Some(Self::Ruby),
            "go" => Some(Self::Go),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Rust => "Rust",
            Self::Python => "Python",
            Self::TypeScript => "TypeScript",
            Self::Ruby => "Ruby",
            Self::Go => "Go",
        }
    }

    pub fn setup_hint(self) -> &'static str {
        match self {
            Self::Rust => "Install rust-analyzer: rustup component add rust-analyzer",
            Self::Python => "Install Pyright: npm install --global pyright",
            Self::TypeScript => {
                "Install TypeScript support: npm install --global typescript typescript-language-server"
            }
            Self::Ruby => "Install Ruby LSP: gem install ruby-lsp",
            Self::Go => "Install gopls: go install golang.org/x/tools/gopls@latest",
        }
    }

    pub fn server_path(self) -> Result<PathBuf> {
        let (override_name, candidates): (&str, &[&str]) = match self {
            Self::Rust => ("EJM_IDE_RUST_LSP", &["rust-analyzer"]),
            Self::Python => (
                "EJM_IDE_PYTHON_LSP",
                &["pyright-langserver", "basedpyright-langserver"],
            ),
            Self::TypeScript => ("EJM_IDE_TYPESCRIPT_LSP", &["typescript-language-server"]),
            Self::Ruby => ("EJM_IDE_RUBY_LSP", &["ruby-lsp"]),
            Self::Go => ("EJM_IDE_GO_LSP", &["gopls"]),
        };
        if let Some(value) = env::var_os(override_name) {
            return find_executable(Path::new(&value)).ok_or_else(|| {
                anyhow!(
                    "{override_name} does not name an executable. {}",
                    self.setup_hint()
                )
            });
        }
        candidates
            .iter()
            .find_map(|name| find_executable(Path::new(name)))
            .ok_or_else(|| {
                anyhow!(
                    "{} language server is missing. {} You can set {override_name} to its executable path.",
                    self.name(),
                    self.setup_hint()
                )
            })
    }

    fn language_id(self, path: &Path) -> &'static str {
        match self {
            Self::Rust => "rust",
            Self::Python => "python",
            Self::Ruby => "ruby",
            Self::Go => "go",
            Self::TypeScript => match path.extension().and_then(|part| part.to_str()) {
                Some("tsx") => "typescriptreact",
                Some("jsx") => "javascriptreact",
                Some("js" | "mjs" | "cjs") => "javascript",
                _ => "typescript",
            },
        }
    }
}

pub(crate) fn find_executable(name: &Path) -> Option<PathBuf> {
    fn executable(path: &Path) -> bool {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            path.metadata()
                .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        }
        #[cfg(not(unix))]
        {
            path.is_file()
        }
    }
    if name.is_absolute() || name.components().count() > 1 {
        return executable(name).then(|| name.to_path_buf());
    }
    let mut paths: Vec<PathBuf> = env::var_os("PATH")
        .map(|value| env::split_paths(&value).collect())
        .unwrap_or_default();
    // Finder-launched macOS apps often inherit a minimal PATH.
    if let Some(home) = env::var_os("HOME") {
        let home = PathBuf::from(home);
        paths.extend([home.join(".cargo/bin"), home.join("go/bin")]);
        for parent in [home.join(".local/share/gem/ruby"), home.join(".gem/ruby")] {
            append_version_bins(&mut paths, &parent);
        }
    }
    for variable in ["GOBIN", "GEM_HOME"] {
        if let Some(path) = env::var_os(variable) {
            let path = PathBuf::from(path);
            paths.push(if variable == "GEM_HOME" {
                path.join("bin")
            } else {
                path
            });
        }
    }
    for variable in ["GOPATH", "GEM_PATH"] {
        if let Some(value) = env::var_os(variable) {
            paths.extend(env::split_paths(&value).map(|path| path.join("bin")));
        }
    }
    paths.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/opt/ruby/bin"),
        PathBuf::from("/usr/local/opt/ruby/bin"),
    ]);
    for parent in [
        Path::new("/opt/homebrew/lib/ruby/gems"),
        Path::new("/usr/local/lib/ruby/gems"),
    ] {
        append_version_bins(&mut paths, parent);
    }
    paths
        .into_iter()
        .map(|directory| directory.join(name))
        .find(|candidate| executable(candidate))
}

fn append_version_bins(paths: &mut Vec<PathBuf>, parent: &Path) {
    let mut versions: Vec<_> = std::fs::read_dir(parent)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect();
    versions.sort();
    paths.extend(versions.into_iter().rev().map(|path| path.join("bin")));
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct Position {
    pub line: u32,
    pub character: u32,
}

pub fn path_to_uri(path: &Path) -> Result<String> {
    if !path.is_absolute() {
        bail!("Language server paths must be absolute: {}", path.display());
    }
    Url::from_file_path(path)
        .map(String::from)
        .map_err(|_| anyhow!("Cannot create a file URI for {}", path.display()))
}

pub fn uri_to_path(uri: &str) -> Result<PathBuf> {
    Url::parse(uri)?
        .to_file_path()
        .map_err(|_| anyhow!("Navigation target is not a local file: {uri}"))
}

/// Convert editor byte offsets to the UTF-16 positions required by LSP.
pub fn byte_offset_to_position(text: &str, offset: usize) -> Position {
    let mut offset = offset.min(text.len());
    while !text.is_char_boundary(offset) {
        offset -= 1;
    }
    let mut line = 0;
    let mut start = 0;
    while start < text.len() {
        let (end, next) = line_end(text, start);
        if offset < next || next == end {
            return Position {
                line,
                character: text[start..offset.min(end)].encode_utf16().count() as u32,
            };
        }
        line += 1;
        start = next;
    }
    Position { line, character: 0 }
}

pub fn position_to_byte_offset(text: &str, position: Position) -> usize {
    let mut start = 0;
    for _ in 0..position.line {
        let (end, next) = line_end(text, start);
        if next == end {
            return text.len();
        }
        start = next;
    }
    let (end, _) = line_end(text, start);
    let mut units = 0;
    for (offset, character) in text[start..end].char_indices() {
        let next_units = units + character.len_utf16() as u32;
        if next_units > position.character {
            return start + offset;
        }
        units = next_units;
    }
    end
}

fn line_end(text: &str, start: usize) -> (usize, usize) {
    let bytes = text.as_bytes();
    let end = (start..bytes.len())
        .find(|&index| matches!(bytes[index], b'\r' | b'\n'))
        .unwrap_or(bytes.len());
    let next = match bytes.get(end) {
        Some(b'\r') if bytes.get(end + 1) == Some(&b'\n') => end + 2,
        Some(_) => end + 1,
        None => end,
    };
    (end, next)
}

#[derive(Debug)]
pub enum LspEvent {
    Response { id: u64, result: Value },
    Error { id: Option<u64>, message: String },
    Notification { method: String, params: Value },
}

enum Reply {
    Event,
    Waiting(mpsc::Sender<std::result::Result<Value, String>>),
}

struct Pending {
    deadline: Instant,
    reply: Reply,
}

struct RubyRevision {
    version: AtomicI32,
    symbols: Mutex<i32>,
}

struct Shared {
    outgoing: SyncSender<Value>,
    events: mpsc::Sender<LspEvent>,
    pending: Mutex<HashMap<u64, Pending>>,
    next_id: AtomicU64,
    closed: AtomicBool,
    ruby_documents: Mutex<HashMap<String, Arc<RubyRevision>>>,
}

impl Shared {
    fn enqueue(&self, value: Value) -> Result<()> {
        if self.closed.load(Ordering::Acquire) {
            bail!("Language server has stopped");
        }
        if serde_json::to_vec(&value)?.len() > MAX_FRAME_BYTES {
            bail!("Language server message exceeds 16 MiB");
        }
        self.outgoing.try_send(value).map_err(|error| match error {
            mpsc::TrySendError::Full(_) => anyhow!("Language server is busy; try again shortly"),
            mpsc::TrySendError::Disconnected(_) => anyhow!("Language server has stopped"),
        })
    }

    fn complete(&self, id: u64, result: std::result::Result<Value, String>) {
        let pending = self.pending.lock().unwrap().remove(&id);
        if let Some(pending) = pending {
            self.deliver(id, pending.reply, result);
        }
    }

    fn deliver(&self, id: u64, reply: Reply, result: std::result::Result<Value, String>) {
        match reply {
            Reply::Event => {
                let event = match result {
                    Ok(result) => LspEvent::Response { id, result },
                    Err(message) => LspEvent::Error {
                        id: Some(id),
                        message,
                    },
                };
                let _ = self.events.send(event);
            }
            Reply::Waiting(sender) => {
                let _ = sender.send(result);
            }
        }
    }

    fn stop(&self, message: String) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        let pending = std::mem::take(&mut *self.pending.lock().unwrap());
        for (id, pending) in pending {
            self.deliver(id, pending.reply, Err(message.clone()));
        }
        let _ = self.events.send(LspEvent::Error { id: None, message });
    }
}

/// Clone this handle into background tasks; it never owns the child process.
#[derive(Clone)]
pub struct LspHandle {
    shared: Arc<Shared>,
}

impl LspHandle {
    pub fn request(&self, method: &str, params: Value) -> Result<u64> {
        self.send_request(method, params, Reply::Event, REQUEST_TIMEOUT)
    }

    pub fn request_blocking(&self, method: &str, params: Value) -> Result<Value> {
        self.request_cancellable_inner(method, params, None)
    }

    pub fn request_cancellable(
        &self,
        method: &str,
        params: Value,
        cancelled: &AtomicBool,
    ) -> Result<Value> {
        self.request_cancellable_inner(method, params, Some(cancelled))
    }

    fn request_cancellable_inner(
        &self,
        method: &str,
        params: Value,
        cancelled: Option<&AtomicBool>,
    ) -> Result<Value> {
        check_cancelled(cancelled)?;
        if method.starts_with("textDocument/") {
            self.refresh_ruby_symbols(&params, cancelled)?;
        }
        self.request_with_timeout_cancellable(method, params, REQUEST_TIMEOUT, cancelled)
    }

    fn refresh_ruby_symbols(&self, params: &Value, cancelled: Option<&AtomicBool>) -> Result<()> {
        let Some(uri) = params["textDocument"]["uri"].as_str() else {
            return Ok(());
        };
        let revision = self.shared.ruby_documents.lock().unwrap().get(uri).cloned();
        let Some(revision) = revision else {
            return Ok(());
        };
        let mut symbols = loop {
            check_cancelled(cancelled)?;
            match revision.symbols.try_lock() {
                Ok(symbols) => break symbols,
                Err(TryLockError::Poisoned(_)) => bail!("Ruby symbols are unavailable"),
                Err(TryLockError::WouldBlock) => thread::sleep(Duration::from_millis(20)),
            }
        };
        let version = revision.version.load(Ordering::Acquire);
        if *symbols == version {
            return Ok(());
        }
        let document = json!({ "uri": uri });
        // Ruby LSP queues edits before parsing requests; wait for the edit before indexing.
        self.request_with_timeout_cancellable(
            "textDocument/documentHighlight",
            json!({ "textDocument": document, "position": { "line": 0, "character": 0 } }),
            REQUEST_TIMEOUT,
            cancelled,
        )?;
        self.request_with_timeout_cancellable(
            "textDocument/documentSymbol",
            json!({ "textDocument": document }),
            REQUEST_TIMEOUT,
            cancelled,
        )?;
        if revision.version.load(Ordering::Acquire) == version {
            *symbols = version;
        }
        Ok(())
    }

    fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value> {
        self.request_with_timeout_cancellable(method, params, timeout, None)
    }

    fn request_with_timeout_cancellable(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        cancelled: Option<&AtomicBool>,
    ) -> Result<Value> {
        check_cancelled(cancelled)?;
        let (sender, receiver) = mpsc::channel();
        let id = self.send_request(method, params, Reply::Waiting(sender), timeout)?;
        let deadline = Instant::now() + timeout + Duration::from_millis(200);
        loop {
            if let Err(error) = check_cancelled(cancelled) {
                self.cancel_pending(id);
                return Err(error);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            let wait = if cancelled.is_some() {
                remaining.min(Duration::from_millis(20))
            } else {
                remaining
            };
            match receiver.recv_timeout(wait) {
                Ok(result) => {
                    check_cancelled(cancelled)?;
                    return result.map_err(anyhow::Error::msg);
                }
                Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() < deadline => {}
                Err(_) => {
                    self.cancel_pending(id);
                    bail!("Language server request timed out: {method}")
                }
            }
        }
    }

    fn cancel_pending(&self, id: u64) {
        if self.shared.pending.lock().unwrap().remove(&id).is_some() {
            let _ = self.notify("$/cancelRequest", json!({ "id": id }));
        }
    }

    fn send_request(
        &self,
        method: &str,
        params: Value,
        reply: Reply,
        timeout: Duration,
    ) -> Result<u64> {
        let id = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        {
            let mut pending = self.shared.pending.lock().unwrap();
            if pending.len() >= MAX_PENDING {
                bail!("Too many pending language server requests");
            }
            pending.insert(
                id,
                Pending {
                    deadline: Instant::now() + timeout,
                    reply,
                },
            );
        }
        if let Err(error) = self.shared.enqueue(json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params
        })) {
            self.shared.pending.lock().unwrap().remove(&id);
            return Err(error);
        }
        Ok(id)
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.shared
            .enqueue(json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }
}

fn check_cancelled(cancelled: Option<&AtomicBool>) -> Result<()> {
    if cancelled.is_some_and(|cancelled| cancelled.load(Ordering::Acquire)) {
        bail!("Language server request cancelled");
    }
    Ok(())
}

/// One workspace language server. Start it lazily when its first document opens.
pub struct LspClient {
    handle: LspHandle,
    events: Receiver<LspEvent>,
    child: Child,
    language: Language,
    documents: HashMap<PathBuf, OpenDocument>,
    capabilities: Value,
    stderr: Arc<Mutex<String>>,
}

struct OpenDocument {
    version: i32,
    text: String,
}

impl OpenDocument {
    fn new(text: &str, version: i32) -> Self {
        Self {
            version,
            text: text.to_owned(),
        }
    }
}

impl LspClient {
    /// This waits for initialization; call it on a background thread.
    pub fn start(root: impl AsRef<Path>, language: Language) -> Result<Self> {
        let program = language.server_path()?;
        let mut command = Command::new(&program);
        if matches!(language, Language::Python | Language::TypeScript) {
            command.arg("--stdio");
        }
        Self::start_with_command(root, language, command)
    }

    pub fn start_with_command(
        root: impl AsRef<Path>,
        language: Language,
        command: Command,
    ) -> Result<Self> {
        Self::start_with_options(root, language, command, json!({}))
    }

    pub fn start_with_options(
        root: impl AsRef<Path>,
        language: Language,
        mut command: Command,
        initialization_options: Value,
    ) -> Result<Self> {
        let root = root
            .as_ref()
            .canonicalize()
            .context("Cannot open workspace root")?;
        if !root.is_dir() {
            bail!("Workspace root must be a directory");
        }
        let root_uri = path_to_uri(&root)?;
        let mut child = command
            .current_dir(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| {
                format!(
                    "Cannot start {}. {}",
                    language.name(),
                    language.setup_hint()
                )
            })?;
        let stdin = child
            .stdin
            .take()
            .context("Language server stdin is unavailable")?;
        let stdout = child
            .stdout
            .take()
            .context("Language server stdout is unavailable")?;
        let stderr_pipe = child
            .stderr
            .take()
            .context("Language server stderr is unavailable")?;
        let stderr = Arc::new(Mutex::new(String::new()));
        let stderr_buffer = stderr.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(stderr_pipe);
            let mut bytes = [0; 2048];
            while let Ok(count) = reader.read(&mut bytes) {
                if count == 0 {
                    break;
                }
                let mut tail = stderr_buffer.lock().unwrap();
                tail.push_str(&String::from_utf8_lossy(&bytes[..count]));
                if tail.len() > MAX_HEADER_BYTES {
                    let mut boundary = tail.len() - MAX_HEADER_BYTES;
                    while !tail.is_char_boundary(boundary) {
                        boundary += 1;
                    }
                    tail.drain(..boundary);
                }
            }
        });

        let (outgoing, writes) = mpsc::sync_channel(64);
        let (event_sender, events) = mpsc::channel();
        let shared = Arc::new(Shared {
            outgoing,
            events: event_sender,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            closed: AtomicBool::new(false),
            ruby_documents: Mutex::new(HashMap::new()),
        });
        let write_shared = shared.clone();
        thread::spawn(move || {
            let mut stdin = stdin;
            while !write_shared.closed.load(Ordering::Acquire) {
                match writes.recv_timeout(Duration::from_millis(100)) {
                    Ok(message) => {
                        if let Err(error) = write_frame(&mut stdin, &message) {
                            write_shared.stop(format!("Cannot write to language server: {error}"));
                            break;
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });
        let read_shared = shared.clone();
        let folders = json!([{ "uri": root_uri, "name": root.file_name().unwrap_or_default().to_string_lossy() }]);
        thread::spawn(move || {
            let mut stdout = BufReader::new(stdout);
            loop {
                match read_frame(&mut stdout) {
                    Ok(Some(message)) => dispatch(&read_shared, message, &folders),
                    Ok(None) => {
                        read_shared.stop("Language server closed its output".into());
                        break;
                    }
                    Err(error) => {
                        read_shared.stop(format!("Invalid language server response: {error}"));
                        break;
                    }
                }
            }
        });
        let timeout_shared = shared.clone();
        thread::spawn(move || {
            while !timeout_shared.closed.load(Ordering::Acquire) {
                thread::sleep(Duration::from_millis(100));
                let expired: Vec<u64> = timeout_shared
                    .pending
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|(_, pending)| pending.deadline <= Instant::now())
                    .map(|(&id, _)| id)
                    .collect();
                for id in expired {
                    timeout_shared.complete(id, Err("Language server request timed out".into()));
                    let _ = timeout_shared.enqueue(json!({
                        "jsonrpc": "2.0", "method": "$/cancelRequest", "params": { "id": id }
                    }));
                }
            }
        });

        let mut client = Self {
            handle: LspHandle { shared },
            events,
            child,
            language,
            documents: HashMap::new(),
            capabilities: Value::Null,
            stderr,
        };
        let initialization = client.handle.request_blocking("initialize", json!({
            "processId": std::process::id(),
            "clientInfo": { "name": "ejm-ide", "version": env!("CARGO_PKG_VERSION") },
            "rootUri": root_uri,
            "workspaceFolders": [{ "uri": root_uri, "name": root.file_name().unwrap_or_default().to_string_lossy() }],
            "initializationOptions": initialization_options,
            "capabilities": {
                "general": { "positionEncodings": ["utf-16"] },
                "workspace": { "configuration": true, "workspaceFolders": true, "applyEdit": false },
                "textDocument": {
                    "synchronization": { "dynamicRegistration": false, "didSave": true },
                    "hover": { "dynamicRegistration": false, "contentFormat": ["markdown", "plaintext"] },
                    "definition": { "dynamicRegistration": false, "linkSupport": true },
                    "implementation": { "dynamicRegistration": false, "linkSupport": true },
                    "references": { "dynamicRegistration": false },
                    "documentSymbol": { "dynamicRegistration": false, "hierarchicalDocumentSymbolSupport": true },
                    "callHierarchy": { "dynamicRegistration": false },
                    "formatting": { "dynamicRegistration": false },
                    "completion": {
                        "dynamicRegistration": false, "contextSupport": true,
                        "completionItem": {
                            "snippetSupport": true, "commitCharactersSupport": true,
                            "documentationFormat": ["markdown", "plaintext"],
                            "deprecatedSupport": true, "preselectSupport": true,
                            "tagSupport": { "valueSet": [1] }, "insertReplaceSupport": true,
                            "labelDetailsSupport": true,
                            "resolveSupport": { "properties": ["documentation", "detail", "additionalTextEdits"] },
                            "insertTextModeSupport": { "valueSet": [1, 2] }
                        },
                        "completionList": { "itemDefaults": ["commitCharacters", "editRange", "insertTextFormat", "insertTextMode", "data"] }
                    },
                    "semanticTokens": {
                        "dynamicRegistration": false,
                        "requests": { "range": true, "full": true },
                        "tokenTypes": ["namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property", "enumMember", "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator", "decorator"],
                        "tokenModifiers": ["declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary"],
                        "formats": ["relative"], "overlappingTokenSupport": false,
                        "multilineTokenSupport": false, "augmentsSyntaxTokens": true
                    },
                    "publishDiagnostics": { "versionSupport": true }
                }
            }
        }));
        let initialized = initialization.map_err(|error| {
            anyhow!(
                "{} language server failed to initialize: {error}. {} {}",
                language.name(),
                language.setup_hint(),
                client.stderr_tail().trim()
            )
        })?;
        client.capabilities = initialized
            .get("capabilities")
            .cloned()
            .context("Language server initialization omitted capabilities")?;
        if let Some(encoding) = client
            .capabilities
            .get("positionEncoding")
            .and_then(Value::as_str)
            && encoding != "utf-16"
        {
            bail!("Language server selected unsupported position encoding: {encoding}");
        }
        client.handle.notify("initialized", json!({}))?;
        Ok(client)
    }

    pub fn handle(&self) -> LspHandle {
        self.handle.clone()
    }

    pub fn capabilities(&self) -> &Value {
        &self.capabilities
    }

    pub fn stderr_tail(&self) -> String {
        self.stderr.lock().unwrap().clone()
    }

    pub fn open(&mut self, path: &Path, text: &str) -> Result<()> {
        if self.documents.contains_key(path) {
            return self.change(path, text);
        }
        self.open_version(path, text, 1)
    }

    pub fn open_version(&mut self, path: &Path, text: &str, version: i32) -> Result<()> {
        if self.documents.contains_key(path) {
            return self.change_version(path, text, version);
        }
        self.handle.notify(
            "textDocument/didOpen",
            json!({ "textDocument": {
                "uri": path_to_uri(path)?, "languageId": self.language.language_id(path),
                "version": version, "text": text
            }}),
        )?;
        self.documents
            .insert(path.to_path_buf(), OpenDocument::new(text, version));
        if self.language == Language::Ruby {
            self.handle.shared.ruby_documents.lock().unwrap().insert(
                path_to_uri(path)?,
                Arc::new(RubyRevision {
                    version: AtomicI32::new(version),
                    symbols: Mutex::new(0),
                }),
            );
        }
        Ok(())
    }

    pub fn change(&mut self, path: &Path, text: &str) -> Result<()> {
        let Some(previous) = self.documents.get(path) else {
            return self.open(path, text);
        };
        let version = previous
            .version
            .checked_add(1)
            .context("Document version overflow")?;
        self.change_version(path, text, version)
    }

    pub fn change_version(&mut self, path: &Path, text: &str, version: i32) -> Result<()> {
        let Some(previous) = self.documents.get(path) else {
            return self.open_version(path, text, version);
        };
        if version <= previous.version {
            return Ok(());
        }
        let change = document_change(&self.capabilities, &previous.text, text);
        if self.language == Language::Ruby && ruby_needs_reopen(&change) {
            // Ruby LSP checks only an edit's start when deciding to reindex declarations.
            self.close(path)?;
            return self.open_version(path, text, version);
        }
        self.handle.notify(
            "textDocument/didChange",
            json!({
                "textDocument": { "uri": path_to_uri(path)?, "version": version },
                "contentChanges": [change]
            }),
        )?;
        self.documents
            .insert(path.to_path_buf(), OpenDocument::new(text, version));
        if let Some(revision) = self
            .handle
            .shared
            .ruby_documents
            .lock()
            .unwrap()
            .get(&path_to_uri(path)?)
        {
            revision.version.store(version, Ordering::Release);
        }
        Ok(())
    }

    pub fn close(&mut self, path: &Path) -> Result<()> {
        if self.documents.contains_key(path) {
            self.handle.notify(
                "textDocument/didClose",
                json!({ "textDocument": { "uri": path_to_uri(path)? } }),
            )?;
            self.documents.remove(path);
            self.handle
                .shared
                .ruby_documents
                .lock()
                .unwrap()
                .remove(&path_to_uri(path)?);
        }
        Ok(())
    }

    pub fn save_version(&self, path: &Path, text: &str, version: i32) -> Result<()> {
        // A newer unsaved buffer must not receive diagnostics for an earlier save.
        if self.documents.get(path).map(|document| document.version) != Some(version) {
            return Ok(());
        }
        if let Some(params) = saved_document_params(&self.capabilities, path, text)? {
            self.handle.notify("textDocument/didSave", params)?;
        }
        Ok(())
    }

    pub fn request(&self, method: &str, params: Value) -> Result<u64> {
        self.handle.request(method, params)
    }

    pub fn try_recv(&self) -> Result<Option<LspEvent>> {
        match self.events.try_recv() {
            Ok(event) => Ok(Some(event)),
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => bail!("Language server event channel closed"),
        }
    }
}

fn document_change(capabilities: &Value, previous: &str, text: &str) -> Value {
    let sync = &capabilities["textDocumentSync"];
    let mut change = json!({ "text": text });
    if sync == 2 || sync["change"] == 2 {
        let splits_crlf = |source: &str, offset: usize| {
            offset > 0
                && source.as_bytes().get(offset - 1) == Some(&b'\r')
                && source.as_bytes().get(offset) == Some(&b'\n')
        };
        let mut prefix: usize = previous
            .chars()
            .zip(text.chars())
            .take_while(|(old, new)| old == new)
            .map(|(character, _)| character.len_utf8())
            .sum();
        if splits_crlf(previous, prefix) || splits_crlf(text, prefix) {
            prefix -= 1;
        }
        let mut suffix: usize = previous[prefix..]
            .chars()
            .rev()
            .zip(text[prefix..].chars().rev())
            .take_while(|(old, new)| old == new)
            .map(|(character, _)| character.len_utf8())
            .sum();
        while suffix > 0
            && (splits_crlf(previous, previous.len() - suffix)
                || splits_crlf(text, text.len() - suffix))
        {
            suffix -= 1;
        }
        change["text"] = json!(&text[prefix..text.len() - suffix]);
        change["range"] = json!({
            "start": byte_offset_to_position(previous, prefix),
            "end": byte_offset_to_position(previous, previous.len() - suffix)
        });
    }
    change
}

fn ruby_needs_reopen(change: &Value) -> bool {
    change["range"]["start"]["line"] != change["range"]["end"]["line"]
        || change["text"]
            .as_str()
            .is_some_and(|text| text.contains('\n') || text.contains('\r'))
}

fn saved_document_params(capabilities: &Value, path: &Path, text: &str) -> Result<Option<Value>> {
    let save = &capabilities["textDocumentSync"]["save"];
    if save != true && !save.is_object() {
        return Ok(None);
    }
    let mut params = json!({ "textDocument": { "uri": path_to_uri(path)? } });
    if save["includeText"] == true {
        params["text"] = Value::String(text.into());
    }
    Ok(Some(params))
}

impl Drop for LspClient {
    fn drop(&mut self) {
        if !self.handle.shared.closed.load(Ordering::Acquire) {
            let _ = self.handle.request_with_timeout(
                "shutdown",
                Value::Null,
                Duration::from_millis(150),
            );
            let _ = self.handle.notify("exit", Value::Null);
        }
        self.handle.shared.stop("Language server stopped".into());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn dispatch(shared: &Shared, message: Value, folders: &Value) {
    if let Some(method) = message.get("method").and_then(Value::as_str) {
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        if let Some(id) = message.get("id") {
            let result = match method {
                "workspace/configuration" => Some(Value::Array(vec![
                    Value::Null;
                    params["items"]
                        .as_array()
                        .map_or(0, Vec::len)
                ])),
                "workspace/workspaceFolders" => Some(folders.clone()),
                "window/workDoneProgress/create" | "window/showMessageRequest" => Some(Value::Null),
                "workspace/applyEdit" => Some(
                    json!({ "applied": false, "failureReason": "Workspace edits require review." }),
                ),
                _ => None,
            };
            let response = match result {
                Some(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                None => {
                    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Client method is not supported" } })
                }
            };
            let _ = shared.enqueue(response);
        } else {
            let _ = shared.events.send(LspEvent::Notification {
                method: method.to_owned(),
                params,
            });
        }
    } else if let Some(id) = message.get("id").and_then(Value::as_u64) {
        if let Some(error) = message.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Language server request failed");
            shared.complete(id, Err(message.to_owned()));
        } else {
            shared.complete(
                id,
                Ok(message.get("result").cloned().unwrap_or(Value::Null)),
            );
        }
    }
}

fn write_frame(writer: &mut impl Write, message: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(message)?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "LSP frame exceeds 16 MiB",
        ));
    }
    write!(writer, "Content-Length: {}\r\n\r\n", bytes.len())?;
    writer.write_all(&bytes)?;
    writer.flush()
}

fn read_frame(reader: &mut impl BufRead) -> io::Result<Option<Value>> {
    let mut header_bytes = 0;
    let mut content_length = None;
    loop {
        let mut line = Vec::new();
        let count = reader
            .take((MAX_HEADER_BYTES - header_bytes + 1) as u64)
            .read_until(b'\n', &mut line)?;
        if count == 0 && header_bytes == 0 {
            return Ok(None);
        }
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Incomplete LSP headers",
            ));
        }
        header_bytes += count;
        if header_bytes > MAX_HEADER_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "LSP headers exceed 16 KiB",
            ));
        }
        let line = std::str::from_utf8(&line)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?
            .trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Malformed LSP header",
            ));
        };
        if key.eq_ignore_ascii_case("Content-Length") {
            let value = value.trim();
            if content_length.is_some()
                || value.is_empty()
                || !value.bytes().all(|byte| byte.is_ascii_digit())
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Invalid LSP Content-Length",
                ));
            }
            let length = value
                .parse::<usize>()
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            if length > MAX_FRAME_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "LSP frame exceeds 16 MiB",
                ));
            }
            content_length = Some(length);
        }
    }
    let length = content_length
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Missing LSP Content-Length"))?;
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes)?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn request_harness() -> (LspHandle, Receiver<Value>) {
        let (outgoing, writes) = mpsc::sync_channel(16);
        let (events, _) = mpsc::channel();
        (
            LspHandle {
                shared: Arc::new(Shared {
                    outgoing,
                    events,
                    pending: Mutex::new(HashMap::new()),
                    next_id: AtomicU64::new(1),
                    closed: AtomicBool::new(false),
                    ruby_documents: Mutex::new(HashMap::new()),
                }),
            },
            writes,
        )
    }

    #[test]
    fn cancellation_sends_only_its_own_pending_request_id_and_discards_late_responses() {
        let (handle, writes) = request_harness();
        let other_id = handle.request("textDocument/hover", json!({})).unwrap();
        writes.recv_timeout(Duration::from_secs(1)).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let request_cancelled = cancelled.clone();
        let request_handle = handle.clone();
        let request = thread::spawn(move || {
            request_handle.request_cancellable(
                "callHierarchy/outgoingCalls",
                json!({}),
                &request_cancelled,
            )
        });
        let started = writes.recv_timeout(Duration::from_secs(1)).unwrap();
        let request_id = started["id"].as_u64().unwrap();
        assert_ne!(request_id, other_id);
        cancelled.store(true, Ordering::Release);
        let cancellation = writes.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(cancellation["method"], "$/cancelRequest");
        assert_eq!(cancellation["params"]["id"], request_id);
        assert!(
            request
                .join()
                .unwrap()
                .unwrap_err()
                .to_string()
                .contains("cancelled")
        );
        assert!(
            handle
                .shared
                .pending
                .lock()
                .unwrap()
                .contains_key(&other_id)
        );
        dispatch(
            &handle.shared,
            json!({ "id": request_id, "result": [{ "stale": true }] }),
            &json!([]),
        );
        assert_eq!(handle.shared.pending.lock().unwrap().len(), 1);
    }

    #[test]
    fn pre_cancelled_requests_never_reach_the_server() {
        let (handle, writes) = request_harness();
        let error = handle
            .request_cancellable(
                "callHierarchy/outgoingCalls",
                json!({}),
                &AtomicBool::new(true),
            )
            .unwrap_err();
        assert!(error.to_string().contains("cancelled"));
        assert!(writes.try_recv().is_err());
        assert!(handle.shared.pending.lock().unwrap().is_empty());
    }

    #[test]
    fn ruby_refresh_can_be_cancelled_while_another_revision_is_being_indexed() {
        let (handle, writes) = request_harness();
        let uri = "file:///tmp/orders.rb";
        let revision = Arc::new(RubyRevision {
            version: AtomicI32::new(1),
            symbols: Mutex::new(0),
        });
        handle
            .shared
            .ruby_documents
            .lock()
            .unwrap()
            .insert(uri.to_owned(), revision.clone());
        let guard = revision.symbols.lock().unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let request_cancelled = cancelled.clone();
        let (sender, receiver) = mpsc::channel();
        let request = thread::spawn(move || {
            let result = handle.request_cancellable(
                "textDocument/prepareCallHierarchy",
                json!({ "textDocument": { "uri": uri } }),
                &request_cancelled,
            );
            sender.send(result).unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(1);
        while Arc::strong_count(&revision) < 3 && Instant::now() < deadline {
            thread::yield_now();
        }
        assert_eq!(Arc::strong_count(&revision), 3);
        cancelled.store(true, Ordering::Release);
        let result = receiver.recv_timeout(Duration::from_secs(1));
        drop(guard);
        request.join().unwrap();
        assert!(
            result
                .unwrap()
                .unwrap_err()
                .to_string()
                .contains("cancelled")
        );
        assert!(writes.try_recv().is_err());
    }

    #[test]
    fn detects_ruby_and_go_documents() {
        for path in [
            "orders.rb",
            "Gemfile",
            "Rakefile",
            "order.gemspec",
            "config.ru",
        ] {
            assert_eq!(Language::for_path(Path::new(path)), Some(Language::Ruby));
        }
        assert_eq!(
            Language::for_path(Path::new("orders.go")),
            Some(Language::Go)
        );
        assert_eq!(Language::Ruby.language_id(Path::new("Gemfile")), "ruby");
        assert_eq!(Language::Go.language_id(Path::new("orders.go")), "go");
        assert_eq!(Language::for_path(Path::new("go.mod")), None);
    }

    #[test]
    fn save_notifications_follow_server_capabilities() {
        let path = Path::new("/tmp/orders.go");
        for capabilities in [
            json!({}),
            json!({ "textDocumentSync": 1 }),
            json!({ "textDocumentSync": { "save": false } }),
        ] {
            assert!(
                saved_document_params(&capabilities, path, "saved")
                    .unwrap()
                    .is_none()
            );
        }
        for save in [json!(true), json!({}), json!({ "includeText": false })] {
            let params = saved_document_params(
                &json!({ "textDocumentSync": { "save": save } }),
                path,
                "saved",
            )
            .unwrap()
            .unwrap();
            assert_eq!(
                params,
                json!({ "textDocument": { "uri": "file:///tmp/orders.go" } })
            );
        }
        let params = saved_document_params(
            &json!({ "textDocumentSync": { "save": { "includeText": true } } }),
            path,
            "saved",
        )
        .unwrap()
        .unwrap();
        assert_eq!(params["text"], "saved");
    }

    #[test]
    fn incremental_changes_keep_the_common_prefix_and_suffix_in_utf16() {
        for sync in [json!(2), json!({ "change": 2 })] {
            assert_eq!(
                document_change(
                    &json!({ "textDocumentSync": sync }),
                    "a😀old\r\nend",
                    "a😀new\r\nend"
                ),
                json!({ "text": "new", "range": {
                    "start": { "line": 0, "character": 3 },
                    "end": { "line": 0, "character": 6 }
                } })
            );
        }
        assert_eq!(
            document_change(
                &json!({ "textDocumentSync": { "change": 1 } }),
                "a😀old\r\nend",
                "updated"
            ),
            json!({ "text": "updated" })
        );
    }

    #[test]
    fn incremental_changes_round_trip_insertions_deletions_and_line_endings() {
        for (previous, updated) in [
            ("", "😀\n"),
            ("😀\n", ""),
            ("a😀b", "a🦀b"),
            ("a\r\nb", "a\nb"),
            ("a\nb", "a\r\nb"),
            ("a\r\nb", "a\rX\nb"),
            ("a\rb", "a\r\nb"),
            ("same\r\n", "same\r\n"),
            (
                "# note\ndef old; end\nold\n",
                "# note\ndef updated; end\nupdated\n",
            ),
        ] {
            let change = document_change(&json!({ "textDocumentSync": 2 }), previous, updated);
            let start = serde_json::from_value(change["range"]["start"].clone()).unwrap();
            let end = serde_json::from_value(change["range"]["end"].clone()).unwrap();
            let mut result = previous.to_owned();
            result.replace_range(
                position_to_byte_offset(previous, start)..position_to_byte_offset(previous, end),
                change["text"].as_str().unwrap(),
            );
            assert_eq!(result, updated, "{previous:?} -> {updated:?}: {change}");
        }
    }

    #[test]
    fn ruby_reopens_bulk_edits_but_keeps_typing_as_incremental_changes() {
        let capabilities = json!({ "textDocumentSync": 2 });
        assert!(!ruby_needs_reopen(&document_change(
            &capabilities,
            "# note\ndef old; end\n",
            "# note\ndef updated; end\n"
        )));
        for (previous, updated) in [
            ("# old\ndef old; end\n", "# updated\ndef updated; end\n"),
            ("", "# pasted\ndef added; end\n"),
            ("# note\ndef old; end\n", "# note\n"),
        ] {
            assert!(ruby_needs_reopen(&document_change(
                &capabilities,
                previous,
                updated
            )));
        }
    }

    #[test]
    fn ruby_symbols_refresh_once_per_revision_and_keep_newer_edits_pending() {
        let uri = "file:///tmp/orders.rb";
        let revision = Arc::new(RubyRevision {
            version: AtomicI32::new(1),
            symbols: Mutex::new(0),
        });
        let (outgoing, writes) = mpsc::sync_channel(16);
        let (events, _) = mpsc::channel();
        let shared = Arc::new(Shared {
            outgoing,
            events,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            closed: AtomicBool::new(false),
            ruby_documents: Mutex::new(HashMap::from([(uri.to_owned(), revision.clone())])),
        });
        let handle = LspHandle {
            shared: shared.clone(),
        };
        let during_request = revision.clone();
        let responses = thread::spawn(move || {
            let mut methods = Vec::new();
            let mut symbol_requests = 0;
            for _ in 0..11 {
                let request = writes.recv_timeout(Duration::from_secs(2)).unwrap();
                let method = request["method"].as_str().unwrap().to_owned();
                if method == "textDocument/documentSymbol" {
                    symbol_requests += 1;
                    if symbol_requests == 2 {
                        // Typing must remain independent of the symbol refresh lock.
                        during_request.version.store(3, Ordering::Release);
                    }
                }
                methods.push(method);
                shared.complete(request["id"].as_u64().unwrap(), Ok(Value::Null));
            }
            methods
        });
        let params = json!({ "textDocument": { "uri": uri } });
        for _ in 0..2 {
            handle
                .request_blocking("textDocument/hover", params.clone())
                .unwrap();
        }
        revision.version.store(2, Ordering::Release);
        for _ in 0..3 {
            handle
                .request_blocking("textDocument/hover", params.clone())
                .unwrap();
        }
        assert_eq!(
            responses.join().unwrap(),
            [
                "textDocument/documentHighlight",
                "textDocument/documentSymbol",
                "textDocument/hover",
                "textDocument/hover",
                "textDocument/documentHighlight",
                "textDocument/documentSymbol",
                "textDocument/hover",
                "textDocument/documentHighlight",
                "textDocument/documentSymbol",
                "textDocument/hover",
                "textDocument/hover",
            ]
        );
    }

    #[test]
    fn frames_round_trip_unicode_and_adjacent_messages() {
        let messages = [
            json!({ "result": "🦀 café" }),
            json!({ "id": 2, "result": null }),
        ];
        let mut bytes = Vec::new();
        for message in &messages {
            write_frame(&mut bytes, message).unwrap();
        }
        let mut reader = Cursor::new(bytes);
        for message in messages {
            assert_eq!(read_frame(&mut reader).unwrap(), Some(message));
        }
        assert!(read_frame(&mut reader).unwrap().is_none());
    }

    #[test]
    fn rejects_unbounded_ambiguous_and_truncated_frames() {
        for bytes in [
            b"Content-Length: 16777217\r\n\r\n".as_slice(),
            b"Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}",
            b"Content-Type: application/json\r\n\r\n{}",
            b"Content-Length: 4\r\n\r\n{}",
            b"Content-Length: -1\r\n\r\n",
        ] {
            assert!(read_frame(&mut Cursor::new(bytes)).is_err());
        }
        assert!(read_frame(&mut Cursor::new(vec![b'x'; MAX_HEADER_BYTES + 1])).is_err());
    }

    #[test]
    fn utf16_positions_round_trip_at_character_boundaries() {
        let text = "fn 🦀() { café }\n变量 = 1\n";
        for (offset, _) in text
            .char_indices()
            .chain(std::iter::once((text.len(), '\0')))
        {
            let position = byte_offset_to_position(text, offset);
            assert_eq!(
                position_to_byte_offset(text, position),
                offset,
                "{position:?}"
            );
        }
        assert_eq!(
            byte_offset_to_position("a🦀b", 5),
            Position {
                line: 0,
                character: 3
            }
        );
        assert_eq!(
            position_to_byte_offset(
                "a🦀b",
                Position {
                    line: 0,
                    character: 2
                }
            ),
            1
        );
    }

    #[test]
    fn positions_clamp_and_support_crlf_and_cr() {
        let text = "a\r\nb\rc";
        assert_eq!(
            byte_offset_to_position(text, 2),
            Position {
                line: 0,
                character: 1
            }
        );
        assert_eq!(
            byte_offset_to_position(text, 3),
            Position {
                line: 1,
                character: 0
            }
        );
        assert_eq!(
            byte_offset_to_position(text, text.len()),
            Position {
                line: 2,
                character: 1
            }
        );
        assert_eq!(
            position_to_byte_offset(
                text,
                Position {
                    line: 1,
                    character: 99
                }
            ),
            4
        );
        assert_eq!(
            position_to_byte_offset(
                text,
                Position {
                    line: 99,
                    character: 0
                }
            ),
            text.len()
        );
    }

    #[test]
    fn file_uris_preserve_spaces_and_unicode() {
        let path = Path::new("/tmp/a folder/🦀.rs");
        assert_eq!(uri_to_path(&path_to_uri(path).unwrap()).unwrap(), path);
        assert!(path_to_uri(Path::new("relative.rs")).is_err());
        assert!(uri_to_path("https://example.com/file.rs").is_err());
    }
}
