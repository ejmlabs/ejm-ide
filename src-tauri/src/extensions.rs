use crate::{HostAccessState, terminal::run_bounded, workspace::WorkspaceState};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager, State, WebviewWindow};

const MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_BUNDLE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_EXTENSIONS: usize = 64;
const CAPABILITIES: &[&str] = &["context.read", "chat.attach", "source.open"];

#[derive(Default)]
pub struct ExtensionState {
    operation: Arc<Mutex<()>>,
    panels: Mutex<BTreeMap<String, MountedPanel>>,
}

struct MountedPanel {
    document: String,
    nonce: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionManifest {
    pub id: String,
    pub name: String,
    pub description: String,
    pub api_version: u32,
    pub entry: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub commands: Vec<ExtensionCommand>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ExtensionCommand {
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionSummary {
    pub id: String,
    pub manifest: Option<ExtensionManifest>,
    pub active_version: Option<String>,
    pub previous_version: Option<String>,
    pub last_build: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionBundle {
    pub version: String,
    pub manifest: ExtensionManifest,
    pub html: String,
    pub code: String,
    pub css: String,
    pub files: usize,
}

#[derive(Clone, Default, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionState {
    active: Option<String>,
    previous: Option<String>,
    last_build: Option<String>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Registry {
    #[serde(default)]
    extensions: BTreeMap<String, VersionState>,
}

#[derive(Deserialize)]
struct BuildOutput {
    code: String,
    css: String,
    files: usize,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 48
        && value.starts_with(|c: char| c.is_ascii_lowercase())
        && value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

fn check_id(id: &str) -> Result<(), String> {
    if valid_id(id) {
        Ok(())
    } else {
        Err("Extension ids must start with a lowercase letter and contain at most 48 lowercase letters, numbers, or hyphens.".into())
    }
}

fn check_version(version: &str) -> Result<(), String> {
    if version.len() == 64
        && version
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        Ok(())
    } else {
        Err("Invalid extension version.".into())
    }
}

fn validate_manifest(manifest: &ExtensionManifest, id: &str) -> Result<(), String> {
    check_id(&manifest.id)?;
    if manifest.id != id || manifest.api_version != 1 {
        return Err("The manifest id must match its directory and apiVersion must be 1.".into());
    }
    if manifest.name.trim().is_empty()
        || manifest.name.len() > 80
        || manifest.description.len() > 300
    {
        return Err("Extension name or description is missing or too long.".into());
    }
    let entry = Path::new(&manifest.entry);
    if entry.as_os_str().is_empty()
        || !entry
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
        || !matches!(
            entry.extension().and_then(|part| part.to_str()),
            Some("tsx" | "ts" | "jsx" | "js")
        )
    {
        return Err(
            "The entry must be a relative JavaScript or TypeScript file inside the extension."
                .into(),
        );
    }
    let unique: BTreeSet<_> = manifest.capabilities.iter().collect();
    if unique.len() != manifest.capabilities.len()
        || manifest
            .capabilities
            .iter()
            .any(|capability| !CAPABILITIES.contains(&capability.as_str()))
    {
        return Err("Unsupported or duplicate extension capability.".into());
    }
    let mut commands = BTreeSet::new();
    if manifest.commands.len() > 12
        || manifest.commands.iter().any(|command| {
            !valid_id(&command.id)
                || command.title.trim().is_empty()
                || command.title.len() > 80
                || !commands.insert(&command.id)
        })
    {
        return Err(
            "Extension commands need unique ids and short titles, with at most 12 commands.".into(),
        );
    }
    Ok(())
}

fn directory(root: &Path, segments: &[&str], create: bool) -> Result<PathBuf, String> {
    let mut path = root.canonicalize().map_err(|error| error.to_string())?;
    for segment in segments {
        if segment.is_empty()
            || !Path::new(segment)
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
        {
            return Err("Invalid extension storage path.".into());
        }
        path.push(segment);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(
                    "Extension storage cannot contain symlinks or non-directory paths.".into(),
                );
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {
                fs::create_dir(&path).map_err(|error| error.to_string())?
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(path)
}

fn read_bounded(path: &Path, limit: u64) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > limit {
        return Err(format!(
            "{} must be a regular file smaller than {} bytes.",
            path.display(),
            limit
        ));
    }
    let mut content = String::new();
    fs::File::open(path)
        .map_err(|error| error.to_string())?
        .take(limit + 1)
        .read_to_string(&mut content)
        .map_err(|error| error.to_string())?;
    if content.len() as u64 > limit {
        return Err("Extension file grew beyond its size limit.".into());
    }
    Ok(content)
}

fn read_manifest(root: &Path, id: &str) -> Result<ExtensionManifest, String> {
    check_id(id)?;
    let source = directory(root, &[".workbench", "extensions", id], false)?;
    let manifest: ExtensionManifest =
        serde_json::from_str(&read_bounded(&source.join("extension.json"), 16 * 1024)?)
            .map_err(|error| error.to_string())?;
    validate_manifest(&manifest, id)?;
    Ok(manifest)
}

fn read_registry(root: &Path) -> Result<Registry, String> {
    let parent = root.join(".workbench");
    if !parent.try_exists().map_err(|error| error.to_string())? {
        return Ok(Registry::default());
    }
    let path = directory(root, &[".workbench"], false)?.join("extension-state.json");
    if !path.try_exists().map_err(|error| error.to_string())? {
        return Ok(Registry::default());
    }
    let registry: Registry = serde_json::from_str(&read_bounded(&path, 64 * 1024)?)
        .map_err(|error| format!("Cannot read extension state: {error}"))?;
    if registry.extensions.len() > MAX_EXTENSIONS {
        return Err("Too many installed extensions.".into());
    }
    for (id, state) in &registry.extensions {
        check_id(id)?;
        for version in [&state.active, &state.previous, &state.last_build]
            .into_iter()
            .flatten()
        {
            check_version(version)?;
        }
    }
    Ok(registry)
}

fn write_registry(root: &Path, registry: &Registry) -> Result<(), String> {
    let parent = directory(root, &[".workbench"], true)?;
    let path = parent.join("extension-state.json");
    if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("Extension state cannot be a symlink.".into());
    }
    let temporary = parent.join(format!(".extension-state-{}.tmp", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&serde_json::to_vec_pretty(registry).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&temporary, &path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn summary(root: &Path, id: &str, state: &VersionState) -> ExtensionSummary {
    let manifest = read_manifest(root, id);
    ExtensionSummary {
        id: id.to_owned(),
        manifest: manifest.as_ref().ok().cloned(),
        active_version: state.active.clone(),
        previous_version: state.previous.clone(),
        last_build: state.last_build.clone(),
        error: manifest.err(),
    }
}

fn list(root: &Path) -> Result<Vec<ExtensionSummary>, String> {
    let registry = read_registry(root)?;
    let mut ids: BTreeSet<String> = registry.extensions.keys().cloned().collect();
    let extension_root = root.join(".workbench/extensions");
    if extension_root
        .try_exists()
        .map_err(|error| error.to_string())?
    {
        for entry in fs::read_dir(directory(root, &[".workbench", "extensions"], false)?)
            .map_err(|error| error.to_string())?
            .take(MAX_EXTENSIONS + 1)
        {
            let entry = entry.map_err(|error| error.to_string())?;
            let id = entry.file_name().to_string_lossy().into_owned();
            if valid_id(&id) {
                ids.insert(id);
            }
            if ids.len() > MAX_EXTENSIONS {
                return Err("At most 64 local extensions are supported.".into());
            }
        }
    }
    Ok(ids
        .into_iter()
        .map(|id| {
            summary(
                root,
                &id,
                registry
                    .extensions
                    .get(&id)
                    .unwrap_or(&VersionState::default()),
            )
        })
        .collect())
}

fn version_digest(bundle: &ExtensionBundle) -> Result<String, String> {
    let mut content = bundle.clone();
    content.version.clear();
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&content).map_err(|error| error.to_string())?)
    ))
}

fn load_bundle(root: &Path, id: &str, version: &str) -> Result<ExtensionBundle, String> {
    check_id(id)?;
    check_version(version)?;
    let directory = directory(
        root,
        &[".workbench", "extension-builds", id, version],
        false,
    )?;
    let bundle: ExtensionBundle = serde_json::from_str(&read_bounded(
        &directory.join("bundle.json"),
        MAX_BUNDLE_BYTES,
    )?)
    .map_err(|error| error.to_string())?;
    validate_manifest(&bundle.manifest, id)?;
    if bundle.version != version || version_digest(&bundle)? != version {
        return Err("The built extension changed on disk. Build it again before loading.".into());
    }
    Ok(bundle)
}

fn publish(root: &Path, mut bundle: ExtensionBundle) -> Result<ExtensionBundle, String> {
    bundle.version = version_digest(&bundle)?;
    let serialized = serde_json::to_vec(&bundle).map_err(|error| error.to_string())?;
    if serialized.len() as u64 > MAX_BUNDLE_BYTES {
        return Err("The checked extension bundle is too large.".into());
    }
    let parent = directory(
        root,
        &[".workbench", "extension-builds", &bundle.manifest.id],
        true,
    )?;
    let target = parent.join(&bundle.version);
    if target.try_exists().map_err(|error| error.to_string())? {
        return load_bundle(root, &bundle.manifest.id, &bundle.version);
    }
    let temporary = parent.join(format!(".build-{}", std::process::id()));
    fs::create_dir(&temporary).map_err(|error| error.to_string())?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(temporary.join("bundle.json"))
            .map_err(|error| error.to_string())?;
        file.write_all(&serialized)
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&temporary, target).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(temporary);
    }
    result?;
    Ok(bundle)
}

fn inspect_source(
    path: &Path,
    depth: usize,
    count: &mut usize,
    bytes: &mut u64,
) -> Result<(), String> {
    if depth > 8 {
        return Err("Extension source nesting exceeds 8 directories.".into());
    }
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("Extension source cannot contain symlinks.".into());
        }
        *count += 1;
        *bytes += metadata.len();
        if *count > 200 || *bytes > MAX_SOURCE_BYTES {
            return Err("Extension source exceeds 200 files or 2 MiB.".into());
        }
        if metadata.is_dir() {
            inspect_source(&entry.path(), depth + 1, count, bytes)?;
        } else if !metadata.is_file() {
            return Err("Extension source may contain only ordinary files and directories.".into());
        }
    }
    Ok(())
}

fn run_builder(driver: &Path, source: &Path, entry: &str) -> Result<BuildOutput, String> {
    let node = ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
        .into_iter()
        .find(|path| Path::new(path).is_file())
        .unwrap_or("node");
    let mut command = Command::new(node);
    command
        .arg(driver)
        .arg(source)
        .arg(entry)
        .current_dir(source)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH");
    let result = run_bounded(
        command,
        Duration::from_secs(45),
        MAX_BUNDLE_BYTES as usize + 1,
    )
    .map_err(|error| {
        format!("Cannot run extension builder. Install Node.js 22 or later. {error}")
    })?;
    if result.timed_out {
        return Err("The extension build exceeded 45 seconds.".into());
    }
    if result.exit_code != 0 {
        let errors = &result.stderr[..result.stderr.len().min(64 * 1024)];
        return Err(String::from_utf8_lossy(errors).trim().to_owned());
    }
    if result.output.len() as u64 > MAX_BUNDLE_BYTES {
        return Err("The extension build output is too large.".into());
    }
    serde_json::from_slice(&result.output)
        .map_err(|error| format!("Invalid extension build output: {error}"))
}

fn build(root: &Path, id: &str, driver: &Path) -> Result<ExtensionBundle, String> {
    let manifest = read_manifest(root, id)?;
    let source = directory(root, &[".workbench", "extensions", id], false)?;
    inspect_source(&source, 0, &mut 0, &mut 0)?;
    let entry = source
        .join(&manifest.entry)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !entry.starts_with(&source) {
        return Err("Extension entry is outside its source directory.".into());
    }
    let html = read_bounded(&source.join("panel.html"), 64 * 1024)?;
    let output = run_builder(driver, &source, &manifest.entry)?;
    let bundle = publish(
        root,
        ExtensionBundle {
            version: String::new(),
            manifest,
            html,
            code: output.code,
            css: output.css,
            files: output.files,
        },
    )?;
    let mut registry = read_registry(root)?;
    if !registry.extensions.contains_key(id) && registry.extensions.len() >= MAX_EXTENSIONS {
        return Err("Too many installed extensions.".into());
    }
    registry
        .extensions
        .entry(id.to_owned())
        .or_default()
        .last_build = Some(bundle.version.clone());
    write_registry(root, &registry)?;
    Ok(bundle)
}

fn activate(root: &Path, id: &str, version: &str) -> Result<ExtensionSummary, String> {
    load_bundle(root, id, version)?;
    let mut registry = read_registry(root)?;
    let state = registry
        .extensions
        .get_mut(id)
        .ok_or("Build this extension before enabling it.")?;
    if ![&state.active, &state.last_build, &state.previous]
        .into_iter()
        .flatten()
        .any(|known| known == version)
    {
        return Err("Only an active, checked draft, or previous version can be activated.".into());
    }
    if state.active.as_deref() != Some(version) {
        state.previous = state.active.replace(version.to_owned());
    }
    let result = summary(root, id, state);
    write_registry(root, &registry)?;
    Ok(result)
}

fn disable(root: &Path, id: &str) -> Result<ExtensionSummary, String> {
    check_id(id)?;
    let mut registry = read_registry(root)?;
    let state = registry
        .extensions
        .get_mut(id)
        .ok_or("Extension has not been built.")?;
    if let Some(active) = state.active.take() {
        state.previous = Some(active);
    }
    let result = summary(root, id, state);
    write_registry(root, &registry)?;
    Ok(result)
}

fn revert(root: &Path, id: &str) -> Result<ExtensionSummary, String> {
    check_id(id)?;
    let mut registry = read_registry(root)?;
    let state = registry
        .extensions
        .get_mut(id)
        .ok_or("Extension has not been built.")?;
    let previous = state
        .previous
        .as_ref()
        .ok_or("No previous version is available.")?
        .clone();
    load_bundle(root, id, &previous)?;
    state.previous = state.active.replace(previous);
    let result = summary(root, id, state);
    write_registry(root, &registry)?;
    Ok(result)
}

fn scaffold(root: &Path) -> Result<ExtensionSummary, String> {
    let id = "selection-notebook";
    let parent = directory(root, &[".workbench", "extensions"], true)?;
    let source = parent.join(id);
    fs::create_dir(&source).map_err(|error| {
        format!("Cannot create selection notebook; existing source is preserved. {error}")
    })?;
    for (name, contents) in [
        (
            "extension.json",
            include_str!("../../extension-template/extension.json"),
        ),
        (
            "panel.html",
            include_str!("../../extension-template/panel.html"),
        ),
        (
            "panel.tsx",
            include_str!("../../extension-template/panel.tsx"),
        ),
        (
            "panel.css",
            include_str!("../../extension-template/panel.css"),
        ),
        (
            "sdk.d.ts",
            include_str!("../../extension-template/sdk.d.ts"),
        ),
        (
            "SKILL.md",
            include_str!("../../extension-template/SKILL.md"),
        ),
    ] {
        fs::write(source.join(name), contents).map_err(|error| error.to_string())?;
    }
    Ok(summary(root, id, &VersionState::default()))
}

fn authorize(
    window: &WebviewWindow,
    auth: &str,
    host: &HostAccessState,
    workspace: &WorkspaceState,
) -> Result<PathBuf, String> {
    host.check(window, auth)?;
    workspace.root_path()
}

#[tauri::command]
pub fn extensions_list(
    window: WebviewWindow,
    auth: String,
    host: State<HostAccessState>,
    workspace: State<WorkspaceState>,
    state: State<ExtensionState>,
) -> Result<Vec<ExtensionSummary>, String> {
    let root = authorize(&window, &auth, &host, &workspace)?;
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "An extension operation is in progress. Try again when it finishes.")?;
    list(&root)
}

#[tauri::command]
pub fn extensions_scaffold(
    window: WebviewWindow,
    auth: String,
    host: State<HostAccessState>,
    workspace: State<WorkspaceState>,
    state: State<ExtensionState>,
) -> Result<ExtensionSummary, String> {
    let root = authorize(&window, &auth, &host, &workspace)?;
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "An extension operation is in progress. Try again when it finishes.")?;
    scaffold(&root)
}

#[tauri::command]
pub async fn extensions_build(
    app: AppHandle,
    window: WebviewWindow,
    auth: String,
    id: String,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    state: State<'_, ExtensionState>,
) -> Result<ExtensionBundle, String> {
    let root = authorize(&window, &auth, &host, &workspace)?;
    let lock = state.operation.clone();
    let driver = if cfg!(debug_assertions) {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../extension-template/host-build.mjs")
    } else {
        app.path()
            .resource_dir()
            .map_err(|error| error.to_string())?
            .join("extension-template/host-build.mjs")
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|_| "Extension state lock failed.")?;
        build(&root, &id, &driver)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn extensions_panel(
    window: WebviewWindow,
    auth: String,
    id: String,
    version: String,
    host: State<HostAccessState>,
    workspace: State<WorkspaceState>,
    state: State<ExtensionState>,
) -> Result<ExtensionBundle, String> {
    let root = authorize(&window, &auth, &host, &workspace)?;
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "An extension operation is in progress. Try again when it finishes.")?;
    let registry = read_registry(&root)?;
    let versions = registry
        .extensions
        .get(&id)
        .ok_or("Extension has not been built.")?;
    if ![&versions.active, &versions.previous, &versions.last_build]
        .into_iter()
        .flatten()
        .any(|known| known == &version)
    {
        return Err("This extension version is not registered.".into());
    }
    load_bundle(&root, &id, &version)
}

#[tauri::command]
pub fn extensions_activate(
    window: WebviewWindow,
    auth: String,
    id: String,
    version: String,
    host: State<HostAccessState>,
    workspace: State<WorkspaceState>,
    state: State<ExtensionState>,
) -> Result<ExtensionSummary, String> {
    let root = authorize(&window, &auth, &host, &workspace)?;
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "An extension operation is in progress. Try again when it finishes.")?;
    activate(&root, &id, &version)
}

#[tauri::command]
pub fn extensions_disable(
    window: WebviewWindow,
    auth: String,
    id: String,
    host: State<HostAccessState>,
    workspace: State<WorkspaceState>,
    state: State<ExtensionState>,
) -> Result<ExtensionSummary, String> {
    let root = authorize(&window, &auth, &host, &workspace)?;
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "An extension operation is in progress. Try again when it finishes.")?;
    disable(&root, &id)
}

#[tauri::command]
pub fn extensions_revert(
    window: WebviewWindow,
    auth: String,
    id: String,
    host: State<HostAccessState>,
    workspace: State<WorkspaceState>,
    state: State<ExtensionState>,
) -> Result<ExtensionSummary, String> {
    let root = authorize(&window, &auth, &host, &workspace)?;
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "An extension operation is in progress. Try again when it finishes.")?;
    revert(&root, &id)
}

#[tauri::command]
pub fn extensions_mount(
    window: WebviewWindow,
    auth: String,
    document: String,
    nonce: String,
    host: State<HostAccessState>,
    state: State<ExtensionState>,
) -> Result<String, String> {
    host.check(&window, &auth)?;
    if document.len() as u64 > MAX_BUNDLE_BYTES || uuid::Uuid::parse_str(&nonce).is_err() {
        return Err("Invalid extension document or nonce.".into());
    }
    let mut panels = state
        .panels
        .lock()
        .map_err(|_| "Extension panel lock failed.")?;
    if panels.len() >= 8 {
        return Err("At most eight extension previews may be open.".into());
    }
    let token = uuid::Uuid::new_v4().to_string();
    panels.insert(token.clone(), MountedPanel { document, nonce });
    Ok(token)
}

#[tauri::command]
pub fn extensions_unmount(
    window: WebviewWindow,
    auth: String,
    token: String,
    host: State<HostAccessState>,
    state: State<ExtensionState>,
) -> Result<(), String> {
    host.check(&window, &auth)?;
    state
        .panels
        .lock()
        .map_err(|_| "Extension panel lock failed.")?
        .remove(&token);
    Ok(())
}

pub fn serve_panel(
    app: &AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let state = app.state::<ExtensionState>();
    let token = request.uri().path().trim_start_matches('/');
    let panel = state.panels.lock().ok().and_then(|panels| {
        panels
            .get(token)
            .map(|panel| (panel.document.clone(), panel.nonce.clone()))
    });
    match panel {
        Some((document, nonce)) => tauri::http::Response::builder()
            .header("Content-Type", "text/html; charset=utf-8")
            .header("Cache-Control", "no-store")
            .header("X-Content-Type-Options", "nosniff")
            .header("Content-Security-Policy", format!("default-src 'none'; script-src 'nonce-{nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"))
            .body(document.into_bytes()).expect("static extension response headers"),
        None => tauri::http::Response::builder().status(404).header("Content-Type", "text/plain").body(b"Extension preview is closed.".to_vec()).expect("static extension error response"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = tempfile::Builder::new()
                .prefix("workbench-extensions-")
                .tempdir()
                .unwrap()
                .keep();
            Self(path)
        }
        fn bundle(&self, code: &str) -> ExtensionBundle {
            publish(
                &self.0,
                ExtensionBundle {
                    version: String::new(),
                    manifest: serde_json::from_str(include_str!(
                        "../../extension-template/extension.json"
                    ))
                    .unwrap(),
                    html: "<main></main>".into(),
                    code: code.into(),
                    css: String::new(),
                    files: 1,
                },
            )
            .unwrap()
        }
        fn checked(&self, bundle: &ExtensionBundle) {
            let mut registry = read_registry(&self.0).unwrap();
            registry
                .extensions
                .entry(bundle.manifest.id.clone())
                .or_default()
                .last_build = Some(bundle.version.clone());
            write_registry(&self.0, &registry).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn manifest_rejects_authority_and_path_escape() {
        let mut manifest: ExtensionManifest =
            serde_json::from_str(include_str!("../../extension-template/extension.json")).unwrap();
        manifest.capabilities.push("shell.execute".into());
        assert!(validate_manifest(&manifest, "selection-notebook").is_err());
        manifest.capabilities.pop();
        manifest.entry = "../secret.tsx".into();
        assert!(validate_manifest(&manifest, "selection-notebook").is_err());
        assert!(check_id("../../escape").is_err());
    }

    #[test]
    fn activate_disable_revert_and_failed_build_preserve_versions() {
        let fixture = Fixture::new();
        scaffold(&fixture.0).unwrap();
        let first = fixture.bundle("console.log(1)");
        fixture.checked(&first);
        activate(&fixture.0, "selection-notebook", &first.version).unwrap();
        let second = fixture.bundle("console.log(2)");
        fixture.checked(&second);
        activate(&fixture.0, "selection-notebook", &second.version).unwrap();
        assert_eq!(
            revert(&fixture.0, "selection-notebook")
                .unwrap()
                .active_version,
            Some(first.version.clone())
        );
        assert_eq!(
            disable(&fixture.0, "selection-notebook")
                .unwrap()
                .active_version,
            None
        );
        assert_eq!(
            revert(&fixture.0, "selection-notebook")
                .unwrap()
                .active_version,
            Some(first.version.clone())
        );
        fs::write(
            fixture
                .0
                .join(".workbench/extensions/selection-notebook/extension.json"),
            "broken",
        )
        .unwrap();
        assert!(
            build(
                &fixture.0,
                "selection-notebook",
                Path::new("missing-builder")
            )
            .is_err()
        );
        assert_eq!(
            read_registry(&fixture.0).unwrap().extensions["selection-notebook"].active,
            Some(first.version)
        );
    }

    #[test]
    fn immutable_version_detects_tampering() {
        let fixture = Fixture::new();
        let bundle = fixture.bundle("console.log(1)");
        let path = fixture
            .0
            .join(".workbench/extension-builds/selection-notebook")
            .join(&bundle.version)
            .join("bundle.json");
        let mut changed = bundle.clone();
        changed.code = "console.log('changed')".into();
        fs::write(path, serde_json::to_vec(&changed).unwrap()).unwrap();
        assert!(load_bundle(&fixture.0, "selection-notebook", &bundle.version).is_err());
    }

    #[test]
    fn active_version_can_reload_after_a_new_draft_without_losing_rollback() {
        let fixture = Fixture::new();
        scaffold(&fixture.0).unwrap();
        let first = fixture.bundle("console.log(1)");
        fixture.checked(&first);
        activate(&fixture.0, "selection-notebook", &first.version).unwrap();
        let second = fixture.bundle("console.log(2)");
        fixture.checked(&second);
        activate(&fixture.0, "selection-notebook", &second.version).unwrap();
        let draft = fixture.bundle("console.log(3)");
        fixture.checked(&draft);
        let reloaded = activate(&fixture.0, "selection-notebook", &second.version).unwrap();
        assert_eq!(reloaded.active_version, Some(second.version));
        assert_eq!(reloaded.previous_version, Some(first.version));
        assert_eq!(reloaded.last_build, Some(draft.version));
    }

    #[test]
    fn real_template_build_and_failed_update_keep_the_enabled_version() {
        let fixture = Fixture::new();
        scaffold(&fixture.0).unwrap();
        let driver =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../extension-template/host-build.mjs");
        let checked = build(&fixture.0, "selection-notebook", &driver).unwrap();
        assert!(checked.files > 2);
        assert!(checked.code.len() > 1_000);
        activate(&fixture.0, "selection-notebook", &checked.version).unwrap();
        fs::write(
            fixture
                .0
                .join(".workbench/extensions/selection-notebook/panel.tsx"),
            "export const broken = <",
        )
        .unwrap();
        assert!(build(&fixture.0, "selection-notebook", &driver).is_err());
        let state = read_registry(&fixture.0).unwrap();
        assert_eq!(
            state.extensions["selection-notebook"].active,
            Some(checked.version.clone())
        );
        assert_eq!(
            state.extensions["selection-notebook"].last_build,
            Some(checked.version.clone())
        );
        assert_eq!(
            disable(&fixture.0, "selection-notebook")
                .unwrap()
                .active_version,
            None
        );
        assert_eq!(
            revert(&fixture.0, "selection-notebook")
                .unwrap()
                .active_version,
            Some(checked.version)
        );
    }

    #[cfg(unix)]
    #[test]
    fn builder_finishes_without_waiting_for_descendant_pipes() {
        let fixture = Fixture::new();
        let driver = fixture.0.join("builder.mjs");
        fs::write(
            &driver,
            r#"import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
  stdio: ['ignore', 'inherit', 'inherit'],
});
child.unref();
process.stdout.write(JSON.stringify({ code: 'ready', css: '', files: 1 }), () => {
  process.exit(0);
});
"#,
        )
        .unwrap();
        let started = std::time::Instant::now();
        let result = run_builder(&driver, &fixture.0, "panel.tsx").unwrap();
        assert_eq!(result.code, "ready");
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "The extension builder waited for a descendant to close its pipes."
        );
    }

    #[test]
    fn builder_rejects_oversized_output() {
        let fixture = Fixture::new();
        let driver = fixture.0.join("builder.mjs");
        fs::write(
            &driver,
            "process.stdout.write(JSON.stringify({ code: 'x'.repeat(4 * 1024 * 1024), css: '', files: 1 }));",
        )
        .unwrap();
        assert_eq!(
            run_builder(&driver, &fixture.0, "panel.tsx").err().unwrap(),
            "The extension build output is too large."
        );
    }

    #[test]
    fn builder_limits_failure_diagnostics() {
        let fixture = Fixture::new();
        let driver = fixture.0.join("builder.mjs");
        fs::write(
            &driver,
            "process.stderr.write('x'.repeat(96 * 1024), () => process.exit(1));",
        )
        .unwrap();
        assert_eq!(
            run_builder(&driver, &fixture.0, "panel.tsx").err().unwrap(),
            "x".repeat(64 * 1024)
        );
    }

    #[cfg(unix)]
    #[test]
    fn storage_and_source_symlinks_are_rejected() {
        let fixture = Fixture::new();
        let outside = Fixture::new();
        std::os::unix::fs::symlink(&outside.0, fixture.0.join(".workbench")).unwrap();
        assert!(scaffold(&fixture.0).is_err());
        fs::remove_file(fixture.0.join(".workbench")).unwrap();
        scaffold(&fixture.0).unwrap();
        std::os::unix::fs::symlink(
            outside.0.join("secret.tsx"),
            fixture
                .0
                .join(".workbench/extensions/selection-notebook/leak.tsx"),
        )
        .unwrap();
        assert!(
            inspect_source(
                &fixture.0.join(".workbench/extensions/selection-notebook"),
                0,
                &mut 0,
                &mut 0
            )
            .is_err()
        );
    }
}
