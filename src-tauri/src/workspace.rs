use crate::{HostAccessState, harness::HarnessState, terminal::run_bounded};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

const FILE_LIMIT: u64 = 2 * 1024 * 1024;
const TREE_LIMIT: usize = 10_000;

#[derive(Clone)]
pub(crate) struct WorkspaceRoot {
    pub(crate) path: PathBuf,
    pub(crate) directory: Arc<Dir>,
    trusted: bool,
}

#[derive(Clone, Default)]
pub struct WorkspaceState {
    root: Arc<Mutex<Option<WorkspaceRoot>>>,
    saves: Arc<Mutex<()>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub name: String,
    pub kind: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub root: String,
    pub name: String,
    pub trusted: bool,
    pub entries: Vec<Entry>,
    pub branch: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub path: String,
    pub content: String,
    pub version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line: u64,
    pub text: String,
}

#[derive(Serialize)]
pub struct GitChange {
    pub path: String,
    pub status: String,
}

impl WorkspaceState {
    pub(crate) fn snapshot(&self) -> Result<WorkspaceRoot, String> {
        self.root
            .lock()
            .map_err(|_| "Workspace state is unavailable")?
            .clone()
            .ok_or_else(|| "Open a workspace folder first.".into())
    }

    pub fn root_path(&self) -> Result<PathBuf, String> {
        Ok(self.snapshot()?.path)
    }

    pub fn trusted_root_path(&self) -> Result<PathBuf, String> {
        let root = self.snapshot()?;
        if !root.trusted {
            return Err(
                "Trust this workspace before starting language servers or project quality tools."
                    .into(),
            );
        }
        Ok(root.path)
    }

    pub fn trust(&self, expected_root: &Path) -> Result<(), String> {
        let mut selected = self
            .root
            .lock()
            .map_err(|_| "Workspace state is unavailable")?;
        let root = selected.as_mut().ok_or("Open a workspace folder first.")?;
        if root.path != expected_root {
            return Err(
                "The workspace changed. Review the current folder before trusting it.".into(),
            );
        }
        root.trusted = true;
        Ok(())
    }

    pub fn validate_path(&self, path: &str, allow_missing: bool) -> Result<PathBuf, String> {
        let root = self.snapshot()?;
        let path = Path::new(path);
        relative_path(&root.path, path)?;
        let resolved = if path.exists() {
            path.canonicalize().map_err(|error| error.to_string())?
        } else if allow_missing {
            let parent = path
                .parent()
                .ok_or("File has no parent directory")?
                .canonicalize()
                .map_err(|error| error.to_string())?;
            parent.join(path.file_name().ok_or("File has no name")?)
        } else {
            return Err("The workspace file no longer exists.".into());
        };
        if !resolved.starts_with(&root.path) {
            return Err("Path points outside the selected workspace.".into());
        }
        Ok(resolved)
    }

    pub fn open_folder(&self, path: &Path) -> Result<Workspace, String> {
        let path = path
            .canonicalize()
            .map_err(|error| format!("Cannot open folder: {error}"))?;
        if !path.is_dir() {
            return Err("Choose a workspace directory.".into());
        }
        let directory = Dir::open_ambient_dir(&path, ambient_authority())
            .map_err(|error| format!("Cannot open workspace: {error}"))?;
        let root = WorkspaceRoot {
            path,
            directory: Arc::new(directory),
            trusted: false,
        };
        let view = root.view()?;
        *self
            .root
            .lock()
            .map_err(|_| "Workspace state is unavailable")? = Some(root);
        Ok(view)
    }

    pub fn read_document(&self, path: &Path) -> Result<Document, String> {
        self.snapshot()?.read_document(path)
    }

    pub fn save_document(
        &self,
        path: &Path,
        content: &str,
        expected_version: &str,
    ) -> Result<Document, String> {
        let _save = self
            .saves
            .lock()
            .map_err(|_| "Save service is unavailable")?;
        self.snapshot()?
            .save_document(path, content, expected_version)
    }

    pub fn create_document(&self, path: &Path, content: &str) -> Result<Document, String> {
        let _save = self
            .saves
            .lock()
            .map_err(|_| "Save service is unavailable")?;
        self.snapshot()?.create_document(path, content)
    }

    pub(crate) fn apply_agent_write(
        &self,
        snapshot: &WorkspaceRoot,
        path: &Path,
        content: &str,
        expected_version: Option<&str>,
        cancel: &AtomicBool,
    ) -> Result<Document, String> {
        let _save = self
            .saves
            .lock()
            .map_err(|_| "Save service is unavailable")?;
        // Hold selection through publication so a folder switch cannot redirect an approved write.
        let selected = self
            .root
            .lock()
            .map_err(|_| "Workspace state is unavailable")?;
        let selected = selected.as_ref().ok_or("Open a workspace folder first.")?;
        if selected.path != snapshot.path
            || !Arc::ptr_eq(&selected.directory, &snapshot.directory)
            || cancel.load(Ordering::Acquire)
        {
            return Err(
                "The agent turn or selected workspace changed. The file was not written.".into(),
            );
        }
        let parent = snapshot.agent_file_root(path)?;
        match expected_version {
            Some(version) => parent.save_document(path, content, version),
            None => parent.create_document(path, content),
        }
    }
}

fn relative_path(root: &Path, path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Workspace paths must be absolute.".into());
    }
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Path is outside the selected workspace.")?;
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return Err("Workspace paths cannot contain parent traversal.".into());
    }
    Ok(relative.to_path_buf())
}

fn version(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}

fn read_file(directory: &Dir, path: &Path) -> Result<String, String> {
    let file = directory
        .open(path)
        .map_err(|error| format!("Cannot read file: {error}"))?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Choose a regular text file.".into());
    }
    if metadata.len() > FILE_LIMIT {
        return Err("This file exceeds the 2 MiB editor limit.".into());
    }
    let mut content = String::new();
    file.take(FILE_LIMIT + 1)
        .read_to_string(&mut content)
        .map_err(|_| "This file is not UTF-8 text.".to_string())?;
    if content.len() as u64 > FILE_LIMIT {
        return Err("This file exceeds the 2 MiB editor limit.".into());
    }
    if content.contains('\0') {
        return Err("This file contains binary data.".into());
    }
    Ok(content)
}

impl WorkspaceRoot {
    pub(crate) fn agent_file_root(&self, path: &Path) -> Result<Self, String> {
        let relative = relative_path(&self.path, path)?;
        if relative.as_os_str().is_empty()
            || relative.components().any(|component| {
                component
                    .as_os_str()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(".git")
            })
        {
            return Err(
                "Agent file tools cannot access Git metadata or the workspace directory.".into(),
            );
        }
        let mut directory = self
            .directory
            .try_clone()
            .map_err(|error| error.to_string())?;
        let mut parent_path = self.path.clone();
        for component in relative.parent().into_iter().flat_map(Path::components) {
            let Component::Normal(name) = component else {
                continue;
            };
            #[cfg(unix)]
            {
                use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
                use cap_std::fs::OpenOptionsExt;
                let mut options = OpenOptions::new();
                options
                    .read(true)
                    .follow(FollowSymlinks::No)
                    .custom_flags(libc::O_DIRECTORY);
                let opened = directory.open_with(name, &options).map_err(|error| {
                    format!("Agent paths need existing directories without symbolic links: {error}")
                })?;
                directory = Dir::from_std_file(opened.into_std());
            }
            #[cfg(not(unix))]
            {
                return Err("Agent file tools currently support macOS and Linux.".into());
            }
            parent_path.push(name);
        }
        Ok(Self {
            path: parent_path,
            directory: Arc::new(directory),
            trusted: self.trusted,
        })
    }

    fn view(&self) -> Result<Workspace, String> {
        Ok(Workspace {
            root: self.path.to_string_lossy().into_owned(),
            trusted: self.trusted,
            name: self
                .path
                .file_name()
                .unwrap_or(self.path.as_os_str())
                .to_string_lossy()
                .into_owned(),
            entries: self.entries(&self.path)?,
            branch: git_output(&self.path, &["branch", "--show-current"], 4096)
                .ok()
                .filter(|result| result.exit_code == 0)
                .map(|result| String::from_utf8_lossy(&result.output).trim().to_owned())
                .filter(|branch| !branch.is_empty()),
        })
    }

    fn entries(&self, path: &Path) -> Result<Vec<Entry>, String> {
        let relative = relative_path(&self.path, path)?;
        let mut entries = Vec::new();
        let relative = if relative.as_os_str().is_empty() {
            Path::new(".")
        } else {
            &relative
        };
        for entry in self
            .directory
            .read_dir(relative)
            .map_err(|error| format!("Cannot list folder: {error}"))?
        {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry.file_name();
            if matches!(
                name.to_str(),
                Some(".git" | "node_modules" | "target" | ".venv" | "__pycache__")
            ) {
                continue;
            }
            let file_type = entry.file_type().map_err(|error| error.to_string())?;
            if file_type.is_symlink() || (!file_type.is_file() && !file_type.is_dir()) {
                continue;
            }
            entries.push(Entry {
                path: path.join(&name).to_string_lossy().into_owned(),
                name: name.to_string_lossy().into_owned(),
                kind: if file_type.is_dir() {
                    "directory"
                } else {
                    "file"
                },
            });
            if entries.len() >= TREE_LIMIT {
                return Err("This folder has too many entries. Use workspace search.".into());
            }
        }
        entries.sort_by(|a, b| {
            (a.kind != "directory", a.name.to_lowercase())
                .cmp(&(b.kind != "directory", b.name.to_lowercase()))
        });
        Ok(entries)
    }

    pub(crate) fn read_document(&self, path: &Path) -> Result<Document, String> {
        let relative = relative_path(&self.path, path)?;
        let content = read_file(&self.directory, &relative)?;
        Ok(Document {
            path: path.to_string_lossy().into_owned(),
            version: version(content.as_bytes()),
            content,
        })
    }

    fn create_document(&self, path: &Path, content: &str) -> Result<Document, String> {
        if content.len() as u64 > FILE_LIMIT {
            return Err("This file exceeds the 2 MiB editor limit.".into());
        }
        if content.contains('\0') {
            return Err("Text files cannot contain binary NUL bytes.".into());
        }
        let relative = relative_path(&self.path, path)?;
        let name = relative.file_name().ok_or("Choose a filename to save.")?;
        let parent_path = relative
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let parent = self
            .directory
            .open_dir(parent_path)
            .map_err(|error| format!("Cannot access file directory: {error}"))?;
        let temporary = format!(".workbench-create-{}.tmp", uuid::Uuid::new_v4());
        let result = (|| -> Result<(), String> {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            let mut file = parent
                .open_with(&temporary, &options)
                .map_err(|error| format!("Cannot create file: {error}"))?;
            file.write_all(content.as_bytes())
                .map_err(|error| format!("Cannot write new file: {error}"))?;
            file.sync_all().map_err(|error| error.to_string())?;
            // Linking publishes complete bytes and refuses an existing destination atomically.
            parent
                .hard_link(&temporary, &parent, name)
                .map_err(|error| {
                    if error.kind() == std::io::ErrorKind::AlreadyExists {
                        "A file already exists at this path. Choose another name.".into()
                    } else {
                        format!("Cannot create file: {error}")
                    }
                })?;
            parent
                .open(".")
                .map_err(|error| error.to_string())?
                .sync_all()
                .map_err(|error| format!("Cannot sync file directory: {error}"))?;
            Ok(())
        })();
        let _ = parent.remove_file(&temporary);
        result?;
        Ok(Document {
            path: path.to_string_lossy().into_owned(),
            content: content.into(),
            version: version(content.as_bytes()),
        })
    }

    fn save_document(
        &self,
        path: &Path,
        content: &str,
        expected_version: &str,
    ) -> Result<Document, String> {
        if content.len() as u64 > FILE_LIMIT {
            return Err("This file exceeds the 2 MiB editor limit.".into());
        }
        if content.contains('\0') {
            return Err("Text files cannot contain binary NUL bytes.".into());
        }
        let relative = relative_path(&self.path, path)?;
        let name = relative.file_name().ok_or("Choose a file to save.")?;
        let parent_path = relative
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let parent = self
            .directory
            .open_dir(parent_path)
            .map_err(|error| format!("Cannot access file directory: {error}"))?;
        let metadata = parent
            .symlink_metadata(name)
            .map_err(|error| format!("Cannot save file: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Saving through a symbolic link or special file is not supported.".into());
        }
        let current = read_file(&parent, Path::new(name))?;
        if version(current.as_bytes()) != expected_version {
            return Err("This file changed on disk. Reload it before saving so those changes are preserved.".into());
        }
        let temporary = format!(".workbench-save-{}.tmp", uuid::Uuid::new_v4());
        let result = (|| -> Result<(), String> {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            let mut file = parent
                .open_with(&temporary, &options)
                .map_err(|error| error.to_string())?;
            file.write_all(content.as_bytes())
                .map_err(|error| error.to_string())?;
            file.set_permissions(metadata.permissions())
                .map_err(|error| error.to_string())?;
            file.sync_all().map_err(|error| error.to_string())?;
            if parent
                .symlink_metadata(name)
                .map_err(|error| error.to_string())?
                .file_type()
                .is_symlink()
                || version(read_file(&parent, Path::new(name))?.as_bytes()) != expected_version
            {
                return Err(
                    "This file changed while saving. Reload it before trying again.".into(),
                );
            }
            parent
                .rename(&temporary, &parent, name)
                .map_err(|error| format!("Cannot replace file: {error}"))?;
            parent
                .open(".")
                .map_err(|error| error.to_string())?
                .sync_all()
                .map_err(|error| format!("Cannot sync file directory: {error}"))?;
            Ok(())
        })();
        if result.is_err() {
            let _ = parent.remove_file(&temporary);
        }
        result?;
        Ok(Document {
            path: path.to_string_lossy().into_owned(),
            content: content.into(),
            version: version(content.as_bytes()),
        })
    }
}

fn git_output(
    root: &Path,
    args: &[&str],
    limit: usize,
) -> Result<crate::terminal::ProcessResult, String> {
    let mut command = Command::new("git");
    command
        .args([
            "--no-pager",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.quotepath=false",
        ])
        .args(args)
        .current_dir(root)
        .env("GIT_OPTIONAL_LOCKS", "0");
    let result = run_bounded(command, Duration::from_secs(5), limit)?;
    if result.timed_out {
        return Err("Git took longer than 5 seconds.".into());
    }
    Ok(result)
}

#[tauri::command]
pub async fn workspace_open(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    languages: State<'_, crate::language::LanguageState>,
    auth: String,
    path: Option<String>,
) -> Result<Workspace, String> {
    host.check(&window, &auth)?;
    let path = match path {
        Some(path) => PathBuf::from(path),
        None => tauri::async_runtime::spawn_blocking(move || {
            app.dialog()
                .file()
                .set_title("Open workspace folder")
                .blocking_pick_folder()
                .ok_or_else(|| "Folder selection cancelled.".to_string())?
                .into_path()
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())??,
    };
    let workspace = workspace.inner().root.clone();
    let opened = tauri::async_runtime::spawn_blocking(move || {
        let temporary_state = WorkspaceState::default();
        let view = temporary_state.open_folder(&path)?;
        *workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable")? = Some(temporary_state.snapshot()?);
        Ok(view)
    })
    .await
    .map_err(|error| error.to_string())?;
    if opened.is_ok() {
        languages.clear();
    }
    opened
}

#[tauri::command]
pub fn workspace_trust(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    auth: String,
    root: String,
) -> Result<(), String> {
    host.check(&window, &auth)?;
    workspace.trust(Path::new(&root))
}

#[tauri::command]
pub async fn workspace_current(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    auth: String,
) -> Result<Option<Workspace>, String> {
    host.check(&window, &auth)?;
    if workspace.root_path().is_err() {
        if let Some(path) = std::env::var_os("WORKBENCH_WORKSPACE") {
            return workspace.open_folder(Path::new(&path)).map(Some);
        }
        #[cfg(debug_assertions)]
        {
            let sample = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/harbor");
            if sample.is_dir() {
                return workspace.open_folder(&sample).map(Some);
            }
        }
        return Ok(None);
    }
    let root = workspace.snapshot()?;
    tauri::async_runtime::spawn_blocking(move || root.view().map(Some))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn workspace_entries(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    auth: String,
    path: String,
) -> Result<Vec<Entry>, String> {
    host.check(&window, &auth)?;
    let root = workspace.snapshot()?;
    tauri::async_runtime::spawn_blocking(move || root.entries(Path::new(&path)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn workspace_read(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    auth: String,
    path: String,
) -> Result<Document, String> {
    host.check(&window, &auth)?;
    let root = workspace.snapshot()?;
    tauri::async_runtime::spawn_blocking(move || root.read_document(Path::new(&path)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn workspace_save(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    auth: String,
    path: String,
    content: String,
    expected_version: String,
) -> Result<Document, String> {
    host.check(&window, &auth)?;
    let mut activity = window
        .app_handle()
        .state::<HarnessState>()
        .begin_operation("workspace.save");
    activity.record_request(
        &serde_json::json!({"path": path, "content": content, "expectedVersion": expected_version}),
    );
    let result: Result<Document, String> = async {
        let root = workspace.snapshot()?;
        let save_lock = workspace.inner().saves.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _save = save_lock
                .lock()
                .map_err(|_| "Save service is unavailable")?;
            root.save_document(Path::new(&path), &content, &expected_version)
        })
        .await
        .map_err(|error| error.to_string())?
    }
    .await;
    activity.record_result(&result);
    result
}

#[tauri::command]
pub async fn workspace_create(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    auth: String,
    path: String,
    content: String,
) -> Result<Document, String> {
    host.check(&window, &auth)?;
    let mut activity = window
        .app_handle()
        .state::<HarnessState>()
        .begin_operation("workspace.create");
    activity.record_request(&serde_json::json!({"path": path, "content": content}));
    let result: Result<Document, String> = async {
        let root = workspace.snapshot()?;
        let save_lock = workspace.inner().saves.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _save = save_lock
                .lock()
                .map_err(|_| "Save service is unavailable")?;
            root.create_document(Path::new(&path), &content)
        })
        .await
        .map_err(|error| error.to_string())?
    }
    .await;
    activity.record_result(&result);
    result
}

fn search_workspace(root: &WorkspaceRoot, query: &str) -> Result<Vec<SearchMatch>, String> {
    let started = std::time::Instant::now();
    let walker = ignore::WalkBuilder::new(&root.path)
        .hidden(false)
        .follow_links(false)
        .filter_entry(|entry| {
            !matches!(
                entry.file_name().to_str(),
                Some(".git" | "node_modules" | "target" | ".venv" | "__pycache__")
            )
        })
        .build();
    let mut matches = Vec::new();
    for entry in walker.take(50_000) {
        if started.elapsed() > Duration::from_secs(5) {
            break;
        }
        let Ok(entry) = entry else {
            continue;
        };
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let Ok(document) = root.read_document(entry.path()) else {
            continue;
        };
        let mut file_matches = 0;
        for (line, text) in document.content.lines().enumerate() {
            if text.contains(query) {
                matches.push(SearchMatch {
                    path: document.path.clone(),
                    line: line as u64 + 1,
                    text: text.chars().take(2000).collect(),
                });
                file_matches += 1;
                if matches.len() == 500 {
                    return Ok(matches);
                }
                if file_matches == 30 {
                    break;
                }
            }
        }
    }
    Ok(matches)
}

#[tauri::command]
pub async fn workspace_search(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    auth: String,
    query: String,
) -> Result<Vec<SearchMatch>, String> {
    host.check(&window, &auth)?;
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    if query.len() > 1024 {
        return Err("Search text must be shorter than 1 KiB.".into());
    }
    let root = workspace.snapshot()?;
    tauri::async_runtime::spawn_blocking(move || search_workspace(&root, &query))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn workspace_changes(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    auth: String,
) -> Result<Vec<GitChange>, String> {
    host.check(&window, &auth)?;
    let root = workspace.root_path()?;
    tauri::async_runtime::spawn_blocking(move || {
        let repository = git_output(&root, &["rev-parse", "--show-toplevel"], 4096)?;
        if repository.exit_code != 0 {
            return Err(String::from_utf8_lossy(&repository.stderr).into_owned());
        }
        let repository = PathBuf::from(String::from_utf8_lossy(&repository.output).trim())
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let result = git_output(
            &root,
            &["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
            1024 * 1024,
        )?;
        if result.exit_code != 0 {
            return Err(String::from_utf8_lossy(&result.stderr).into_owned());
        }
        let mut changes = Vec::new();
        let mut records = result.output.split(|byte| *byte == 0);
        while let Some(record) = records.next() {
            if record.len() < 4 {
                continue;
            }
            let status = String::from_utf8_lossy(&record[..2]).trim().to_owned();
            let Ok(path) = std::str::from_utf8(&record[3..]) else {
                continue;
            };
            let path = repository.join(path);
            if relative_path(&root, &path).is_ok() {
                changes.push(GitChange {
                    path: path.to_string_lossy().into_owned(),
                    status: status.clone(),
                });
            }
            if status.contains('R') || status.contains('C') {
                records.next();
            }
            if changes.len() == 2000 {
                break;
            }
        }
        Ok(changes)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn workspace_diff(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    auth: String,
    path: String,
) -> Result<String, String> {
    host.check(&window, &auth)?;
    let root = workspace.snapshot()?;
    let relative = relative_path(&root.path, Path::new(&path))?;
    tauri::async_runtime::spawn_blocking(move || {
        let relative = relative.to_str().ok_or("Git paths must be UTF-8")?;
        let tracked = git_output(
            &root.path,
            &["ls-files", "--error-unmatch", "--", relative],
            4096,
        )?;
        if tracked.exit_code != 0 {
            let document = root.read_document(Path::new(&path))?;
            return Ok(format!(
                "--- /dev/null\n+++ b/{relative}\n@@ -0,0 +1,{} @@\n{}",
                document.content.lines().count(),
                document
                    .content
                    .lines()
                    .map(|line| format!("+{line}\n"))
                    .collect::<String>()
            ));
        }
        let mut result = git_output(
            &root.path,
            &[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "HEAD",
                "--",
                relative,
            ],
            2 * 1024 * 1024,
        )?;
        if result.exit_code != 0 {
            result = git_output(
                &root.path,
                &["diff", "--no-ext-diff", "--no-textconv", "--", relative],
                2 * 1024 * 1024,
            )?;
        }
        if result.exit_code != 0 {
            return Err(String::from_utf8_lossy(&result.stderr).into_owned());
        }
        let mut diff = String::from_utf8_lossy(&result.output).into_owned();
        if result.truncated {
            diff.push_str("\n[Diff truncated]\n");
        }
        Ok(diff)
    })
    .await
    .map_err(|error| error.to_string())?
}
