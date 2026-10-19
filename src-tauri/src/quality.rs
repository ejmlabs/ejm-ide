use crate::{
    HostAccessState,
    harness::{HarnessState, Outcome},
    lsp::{self, Position, byte_offset_to_position, path_to_uri},
    terminal::{ProcessResult, run_bounded_input},
    workspace::WorkspaceState,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use tauri::{AppHandle, Manager, State, WebviewWindow};

const FILE_LIMIT: usize = 2 * 1024 * 1024;
const DIAGNOSTIC_LIMIT: usize = 500;

#[derive(Default)]
pub struct QualityState {
    lint: tokio::sync::Mutex<()>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatResult {
    content: String,
    tool: &'static str,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LintResult {
    path: String,
    version: String,
    tool: &'static str,
    status: &'static str,
    scope: &'static str,
    diagnostics: Vec<Diagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Debug, Serialize)]
struct SourceRange {
    start: Position,
    end: Position,
}

#[derive(Debug, Serialize)]
struct Diagnostic {
    uri: String,
    range: SourceRange,
    message: String,
    severity: u8,
    source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Tool {
    Biome,
    Ruff,
    Clippy,
    Rubocop,
    Gofmt,
}

impl Tool {
    fn name(self) -> &'static str {
        match self {
            Self::Biome => "biome",
            Self::Ruff => "ruff",
            Self::Clippy => "clippy",
            Self::Rubocop => "rubocop",
            Self::Gofmt => "gofmt",
        }
    }

    fn scope(self) -> &'static str {
        if self == Self::Clippy {
            "workspace"
        } else {
            "file"
        }
    }
}

fn tool_for_path(path: &Path) -> Option<Tool> {
    if matches!(
        path.file_name().and_then(|name| name.to_str()),
        Some("Gemfile" | "Rakefile" | "Guardfile" | "Brewfile")
    ) {
        return Some(Tool::Rubocop);
    }
    match path.extension()?.to_str()? {
        "js" | "jsx" | "mjs" | "cjs" | "ts" | "tsx" | "mts" | "cts" => Some(Tool::Biome),
        "py" | "pyi" => Some(Tool::Ruff),
        "rs" => Some(Tool::Clippy),
        "rb" | "rake" | "gemspec" | "ru" => Some(Tool::Rubocop),
        "go" => Some(Tool::Gofmt),
        _ => None,
    }
}

fn executable(path: &Path, workspace: Option<&Path>) -> bool {
    if !path.is_absolute() {
        return false;
    }
    let Ok(resolved) = path.canonicalize() else {
        return false;
    };
    if workspace.is_some_and(|root| path.starts_with(root) || resolved.starts_with(root)) {
        return false;
    }
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    metadata.is_file()
}

/// Ignore relative PATH entries and project executables. These commands use installed tools only.
fn installed_tool(name: &str, workspace: &Path) -> Option<PathBuf> {
    if let Some(path) =
        lsp::find_executable(Path::new(name)).filter(|path| executable(path, Some(workspace)))
    {
        return Some(path);
    }
    let mut locations: Vec<PathBuf> = env::var_os("PATH")
        .map(|path| env::split_paths(&path).collect())
        .unwrap_or_default();
    if let Some(home) = env::var_os("HOME") {
        locations.extend([
            PathBuf::from(&home).join(".local/bin"),
            PathBuf::from(&home).join(".cargo/bin"),
        ]);
    }
    locations.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
    ]);
    locations
        .into_iter()
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join(name))
        .find(|path| executable(path, Some(workspace)))
}

fn biome_binary(resources: Option<&Path>) -> Option<PathBuf> {
    let package = match (env::consts::OS, env::consts::ARCH) {
        ("macos", "aarch64") => "cli-darwin-arm64",
        ("macos", "x86_64") => "cli-darwin-x64",
        ("linux", "aarch64") => "cli-linux-arm64",
        ("linux", "x86_64") => "cli-linux-x64",
        _ => return None,
    };
    let mut locations = Vec::new();
    if let Some(resources) = resources {
        locations.push(resources.join("node_modules"));
    }
    if cfg!(debug_assertions) {
        locations.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../node_modules"));
    }
    locations
        .into_iter()
        .map(|modules| modules.join("@biomejs").join(package).join("biome"))
        .find(|path| executable(path, None))
}

fn program(tool: Tool, root: &Path, resources: Option<&Path>) -> Option<PathBuf> {
    match tool {
        Tool::Biome => biome_binary(resources),
        Tool::Clippy => installed_tool("cargo", root),
        tool => installed_tool(tool.name(), root),
    }
}

fn tool_command(program: PathBuf, root: &Path) -> Command {
    let mut command = Command::new(&program);
    command
        .current_dir(root)
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0")
        .env_remove("RUFF_OUTPUT_FILE")
        .env_remove("BIOME_LOG_FILE");
    // Finder-launched apps may have a minimal PATH. Cargo needs rustc beside it.
    if let Some(parent) = program.parent() {
        let mut paths = vec![parent.to_path_buf()];
        paths.extend(
            env::var_os("PATH")
                .map(|path| {
                    env::split_paths(&path)
                        .filter(|path| path.is_absolute())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default(),
        );
        if let Ok(path) = env::join_paths(paths) {
            command.env("PATH", path);
        }
    }
    command
}

fn process_error(result: &ProcessResult, tool: &str) -> Option<String> {
    if result.timed_out {
        Some(format!("{tool} reached its time limit."))
    } else if result.truncated {
        Some(format!("{tool} exceeded the output limit."))
    } else {
        None
    }
}

fn failure_message(result: &ProcessResult, tool: &str) -> String {
    let error = String::from_utf8_lossy(&result.stderr);
    let detail: String = error.trim().chars().take(1500).collect();
    if detail.is_empty() {
        format!("{tool} exited with status {}.", result.exit_code)
    } else {
        format!("{tool}: {detail}")
    }
}

#[tauri::command]
pub async fn quality_format(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    app: AppHandle,
    workspace: State<'_, WorkspaceState>,
    auth: String,
    path: String,
    content: String,
) -> Result<FormatResult, String> {
    host.check(&window, &auth)?;
    let mut activity = window
        .app_handle()
        .state::<HarnessState>()
        .begin_operation("quality.format");
    activity.record_request(&serde_json::json!({"path": path, "content": content}));
    let result: Result<FormatResult, String> = async {
        let root = workspace.root_path()?;
        let path = workspace.validate_path(&path, false)?;
        if content.len() > FILE_LIMIT || content.contains('\0') {
            return Err("Formatting requires a UTF-8 text buffer smaller than 2 MiB.".into());
        }
        let Some(tool @ (Tool::Biome | Tool::Ruff | Tool::Gofmt)) = tool_for_path(&path) else {
            return Ok(FormatResult {
                content,
                tool: "",
                status: "unsupported",
                message: None,
            });
        };
        let resources = app.path().resource_dir().ok();
        let Some(program) = program(tool, &root, resources.as_deref()) else {
            return Ok(FormatResult {
                content,
                tool: tool.name(),
                status: "unavailable",
                message: Some(format!(
                    "{} is not installed or bundled. Saved without formatting.",
                    tool.name()
                )),
            });
        };
        let mut command = tool_command(program, &root);
        match tool {
            Tool::Biome => {
                command
                    .arg("format")
                    .arg(format!("--stdin-file-path={}", path.display()));
            }
            Tool::Ruff => {
                command
                    .args(["format", "--no-cache", "--stdin-filename"])
                    .arg(&path)
                    .arg("-");
            }
            Tool::Gofmt => {}
            _ => unreachable!(),
        }
        let input = content.as_bytes().to_vec();
        let result = tauri::async_runtime::spawn_blocking(move || {
            run_bounded_input(command, Duration::from_secs(5), FILE_LIMIT + 1, input)
        })
        .await
        .map_err(|error| error.to_string())??;
        let error = process_error(&result, tool.name())
            .or_else(|| (result.exit_code != 0).then(|| failure_message(&result, tool.name())));
        if let Some(message) = error {
            return Ok(FormatResult {
                content,
                tool: tool.name(),
                status: "unavailable",
                message: Some(message),
            });
        }
        let formatted = String::from_utf8(result.output)
            .map_err(|_| "The formatter returned invalid UTF-8 text.")?;
        if formatted.len() > FILE_LIMIT || formatted.contains('\0') {
            return Err(
                "The formatter returned a buffer that exceeds the editor's text limits.".into(),
            );
        }
        Ok(FormatResult {
            content: formatted,
            tool: tool.name(),
            status: "ok",
            message: None,
        })
    }
    .await;
    match &result {
        Ok(value) => {
            activity.record_response(&serde_json::json!(value));
            if let Some(message) = &value.message {
                activity.record_error(message);
            }
            activity.finish(quality_outcome(value.status, value.message.as_deref()));
        }
        Err(_) => activity.record_result(&result),
    }
    result
}

fn lint_result(
    path: &Path,
    version: String,
    tool: Option<Tool>,
    status: &'static str,
    message: Option<String>,
) -> LintResult {
    LintResult {
        path: path.to_string_lossy().into_owned(),
        version,
        tool: tool.map_or("", Tool::name),
        scope: tool.map_or("file", Tool::scope),
        status,
        diagnostics: Vec::new(),
        message,
    }
}

fn cargo_directory(path: &Path, root: &Path) -> Option<PathBuf> {
    path.parent()?
        .ancestors()
        .take_while(|directory| directory.starts_with(root))
        .find(|directory| directory.join("Cargo.toml").is_file())
        .map(Path::to_path_buf)
}

fn saved_version_matches(
    workspace: &WorkspaceState,
    root: &Path,
    path: &Path,
    version: &str,
) -> bool {
    workspace.root_path().is_ok_and(|selected| selected == root)
        && workspace
            .read_document(path)
            .is_ok_and(|document| document.version == version)
}

#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "Tauri injects window, host, app, workspace, and quality state"
)]
pub async fn quality_lint(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    app: AppHandle,
    workspace: State<'_, WorkspaceState>,
    quality: State<'_, QualityState>,
    auth: String,
    path: String,
    version: String,
) -> Result<LintResult, String> {
    host.check(&window, &auth)?;
    let mut activity = window
        .app_handle()
        .state::<HarnessState>()
        .begin_operation("quality.lint");
    activity.record_request(&serde_json::json!({"path": path, "version": version}));
    let result: Result<LintResult, String> = async {
        let root = workspace.root_path()?;
        let path = workspace.validate_path(&path, false)?;
        let tool = tool_for_path(&path);
        if version.len() != 64 || !version.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Linting requires the saved file version.".into());
        }
        let _gate = quality.lint.lock().await;
        if !saved_version_matches(&workspace, &root, &path, &version) {
            return Ok(lint_result(&path, version, tool, "stale", None));
        }
        let document = workspace.read_document(&path)?;
        if document.version != version {
            return Ok(lint_result(&path, version, tool, "stale", None));
        }
        activity.record_request(&serde_json::json!({
            "path": path,
            "version": version,
            "content": document.content,
            "workspaceRoot": root,
        }));
        let Some(tool) = tool.filter(|tool| *tool != Tool::Gofmt) else {
            return Ok(lint_result(&path, version, tool, "unsupported", None));
        };
        let resources = app.path().resource_dir().ok();
        let Some(program) = program(tool, &root, resources.as_deref()) else {
            return Ok(lint_result(
                &path,
                version,
                Some(tool),
                "unavailable",
                Some(format!(
                    "{} is not installed or bundled. Language-server diagnostics remain available.",
                    tool.name()
                )),
            ));
        };
        let directory = if tool == Tool::Clippy {
            let Some(directory) = cargo_directory(&path, &root) else {
                return Ok(lint_result(
                    &path,
                    version,
                    Some(tool),
                    "unavailable",
                    Some("No Cargo.toml was found for this Rust file.".into()),
                ));
            };
            directory
        } else {
            root.clone()
        };
        let mut command = tool_command(program, &directory);
        let input = match tool {
            Tool::Biome => {
                command
                    .args([
                        "lint",
                        "--reporter=json",
                        "--colors=off",
                        "--max-diagnostics=500",
                        "--files-max-size=2097152",
                    ])
                    .arg(&path);
                Vec::new()
            }
            Tool::Ruff => {
                command
                    .args([
                        "check",
                        "--no-fix",
                        "--no-fix-only",
                        "--no-unsafe-fixes",
                        "--no-cache",
                        "--output-format",
                        "json",
                        "--stdin-filename",
                    ])
                    .arg(&path)
                    .arg("-");
                document.content.as_bytes().to_vec()
            }
            Tool::Clippy => {
                command.args([
                    "clippy",
                    "--offline",
                    "--locked",
                    "--no-deps",
                    "--message-format=json",
                ]);
                Vec::new()
            }
            Tool::Rubocop => {
                command
                    .args([
                        "--format",
                        "json",
                        "--cache",
                        "false",
                        "--no-server",
                        "--stdin",
                    ])
                    .arg(&path);
                document.content.as_bytes().to_vec()
            }
            Tool::Gofmt => unreachable!(),
        };
        let process = tauri::async_runtime::spawn_blocking(move || {
            run_bounded_input(command, Duration::from_secs(30), 4 * FILE_LIMIT, input)
        })
        .await
        .map_err(|error| error.to_string())?;
        if !saved_version_matches(&workspace, &root, &path, &version) {
            return Ok(lint_result(&path, version, Some(tool), "stale", None));
        }
        let process = match process {
            Ok(process) => process,
            Err(message) => {
                return Ok(lint_result(
                    &path,
                    version,
                    Some(tool),
                    "error",
                    Some(message),
                ));
            }
        };
        if let Some(message) = process_error(&process, tool.name()) {
            return Ok(lint_result(
                &path,
                version,
                Some(tool),
                "error",
                Some(message),
            ));
        }
        let mut read_source = |reported: &str| {
            let reported = Path::new(reported);
            let candidates = if reported.is_absolute() {
                vec![reported.to_path_buf()]
            } else {
                vec![directory.join(reported), root.join(reported)]
            };
            candidates.into_iter().find_map(|candidate| {
                let canonical = workspace.validate_path(candidate.to_str()?, false).ok()?;
                if tool != Tool::Clippy && canonical != path {
                    return None;
                }
                let content = if canonical == path {
                    document.content.clone()
                } else {
                    workspace.read_document(&canonical).ok()?.content
                };
                Some((canonical, content))
            })
        };
        let diagnostics = parse_diagnostics(tool, &process.output, &mut read_source);
        let diagnostics = match diagnostics {
            Ok(diagnostics) if process.exit_code == 0 || !diagnostics.is_empty() => diagnostics,
            Ok(_) => {
                return Ok(lint_result(
                    &path,
                    version,
                    Some(tool),
                    "error",
                    Some(failure_message(&process, tool.name())),
                ));
            }
            Err(message) => {
                return Ok(lint_result(
                    &path,
                    version,
                    Some(tool),
                    "error",
                    Some(message),
                ));
            }
        };
        let mut result = lint_result(&path, version, Some(tool), "ok", None);
        result.diagnostics = diagnostics;
        Ok(result)
    }
    .await;
    match &result {
        Ok(value) => {
            activity.record_response(&serde_json::json!(value));
            if let Some(message) = &value.message {
                activity.record_error(message);
            }
            activity.finish(quality_outcome(value.status, value.message.as_deref()));
        }
        Err(_) => activity.record_result(&result),
    }
    result
}

fn quality_outcome(status: &str, message: Option<&str>) -> Outcome {
    match status {
        "ok" | "unsupported" => Outcome::Completed,
        "stale" => Outcome::Cancelled,
        _ => message.map_or(Outcome::Failed("unavailable"), Outcome::error),
    }
}

fn severity(value: &str) -> u8 {
    match value {
        "fatal" | "error" => 1,
        "warning" | "warn" | "convention" | "refactor" => 2,
        "information" | "info" | "note" => 3,
        _ => 4,
    }
}

/// Both Biome and Ruff report one-based Unicode codepoint columns, not UTF-16 units.
fn scalar_position(text: &str, line: u64, column: u64) -> Position {
    let line = line.saturating_sub(1) as usize;
    let text = text.lines().nth(line).unwrap_or("");
    let character = text
        .chars()
        .take(column.saturating_sub(1) as usize)
        .map(char::len_utf16)
        .sum::<usize>();
    Position {
        line: line as u32,
        character: character as u32,
    }
}

fn parse_diagnostics(
    tool: Tool,
    output: &[u8],
    read_source: &mut impl FnMut(&str) -> Option<(PathBuf, String)>,
) -> Result<Vec<Diagnostic>, String> {
    let malformed = || format!("{} returned an invalid diagnostic report.", tool.name());
    let values = if tool == Tool::Clippy {
        let text = std::str::from_utf8(output).map_err(|_| malformed())?;
        text.lines()
            .filter(|line| !line.trim().is_empty())
            .map(serde_json::from_str::<Value>)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| malformed())?
    } else {
        vec![serde_json::from_slice::<Value>(output).map_err(|_| malformed())?]
    };
    let mut diagnostics = Vec::new();
    for report in values {
        match tool {
            Tool::Biome => {
                for entry in report["diagnostics"].as_array().ok_or_else(malformed)? {
                    let location = &entry["location"];
                    let Some((path, content)) =
                        location["path"].as_str().and_then(&mut *read_source)
                    else {
                        continue;
                    };
                    let start = &location["start"];
                    let end = &location["end"];
                    let range = SourceRange {
                        start: scalar_position(
                            &content,
                            start["line"].as_u64().unwrap_or(1),
                            start["column"].as_u64().unwrap_or(1),
                        ),
                        end: scalar_position(
                            &content,
                            end["line"].as_u64().unwrap_or(1),
                            end["column"].as_u64().unwrap_or(1),
                        ),
                    };
                    push_diagnostic(&mut diagnostics, tool, path, range, entry, "category")?;
                }
            }
            Tool::Ruff => {
                for entry in report.as_array().ok_or_else(malformed)? {
                    let Some((path, content)) =
                        entry["filename"].as_str().and_then(&mut *read_source)
                    else {
                        continue;
                    };
                    let start = &entry["location"];
                    let end = &entry["end_location"];
                    let range = SourceRange {
                        start: scalar_position(
                            &content,
                            start["row"].as_u64().unwrap_or(1),
                            start["column"].as_u64().unwrap_or(1),
                        ),
                        end: scalar_position(
                            &content,
                            end["row"].as_u64().unwrap_or(1),
                            end["column"].as_u64().unwrap_or(1),
                        ),
                    };
                    push_diagnostic(&mut diagnostics, tool, path, range, entry, "code")?;
                }
            }
            Tool::Clippy if report["reason"] == "compiler-message" => {
                let entry = &report["message"];
                for span in entry["spans"]
                    .as_array()
                    .ok_or_else(malformed)?
                    .iter()
                    .filter(|span| span["is_primary"] == true)
                {
                    let Some((path, content)) =
                        span["file_name"].as_str().and_then(&mut *read_source)
                    else {
                        continue;
                    };
                    let range = SourceRange {
                        start: byte_offset_to_position(
                            &content,
                            span["byte_start"].as_u64().unwrap_or(0) as usize,
                        ),
                        end: byte_offset_to_position(
                            &content,
                            span["byte_end"].as_u64().unwrap_or(0) as usize,
                        ),
                    };
                    let mut entry = entry.clone();
                    entry["severity"] = entry["level"].clone();
                    entry["code"] = entry["code"]["code"].clone();
                    push_diagnostic(&mut diagnostics, tool, path, range, &entry, "code")?;
                }
            }
            Tool::Rubocop => {
                for file in report["files"].as_array().ok_or_else(malformed)? {
                    let Some((path, content)) = file["path"].as_str().and_then(&mut *read_source)
                    else {
                        continue;
                    };
                    for entry in file["offenses"].as_array().ok_or_else(malformed)? {
                        let location = &entry["location"];
                        let line = location["start_line"]
                            .as_u64()
                            .or_else(|| location["line"].as_u64())
                            .unwrap_or(1);
                        let column = location["start_column"]
                            .as_u64()
                            .or_else(|| location["column"].as_u64())
                            .unwrap_or(1);
                        let end_line = location["last_line"].as_u64().unwrap_or(line);
                        let end_column = location["last_column"]
                            .as_u64()
                            .map(|column| column + 1)
                            .unwrap_or(column + location["length"].as_u64().unwrap_or(1));
                        let range = SourceRange {
                            start: scalar_position(&content, line, column),
                            end: scalar_position(&content, end_line, end_column),
                        };
                        push_diagnostic(
                            &mut diagnostics,
                            tool,
                            path.clone(),
                            range,
                            entry,
                            "cop_name",
                        )?;
                    }
                }
            }
            _ => {}
        }
    }
    diagnostics.truncate(DIAGNOSTIC_LIMIT);
    Ok(diagnostics)
}

fn push_diagnostic(
    diagnostics: &mut Vec<Diagnostic>,
    tool: Tool,
    path: PathBuf,
    range: SourceRange,
    entry: &Value,
    code: &str,
) -> Result<(), String> {
    if diagnostics.len() >= DIAGNOSTIC_LIMIT {
        return Ok(());
    }
    let message = entry["message"]
        .as_str()
        .ok_or_else(|| format!("{} returned a diagnostic without a message.", tool.name()))?;
    diagnostics.push(Diagnostic {
        uri: path_to_uri(&path).map_err(|error| error.to_string())?,
        range,
        message: message.chars().take(8192).collect(),
        severity: severity(entry["severity"].as_str().unwrap_or("error")),
        source: tool.name(),
        code: entry[code].as_str().map(str::to_owned),
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn trace_outcomes_preserve_stale_timeouts_and_tool_failures() {
        assert!(matches!(quality_outcome("ok", None), Outcome::Completed));
        assert!(matches!(
            quality_outcome("unsupported", None),
            Outcome::Completed
        ));
        assert!(matches!(quality_outcome("stale", None), Outcome::Cancelled));
        assert!(matches!(
            quality_outcome("unavailable", Some("gofmt reached its time limit.")),
            Outcome::Failed("timeout")
        ));
        assert!(matches!(
            quality_outcome("error", Some("ruff exceeded the output limit.")),
            Outcome::Failed("limit")
        ));
        assert!(matches!(
            quality_outcome("error", Some("formatter returned invalid UTF-8 text")),
            Outcome::Failed("protocol_error")
        ));
        assert!(matches!(
            quality_outcome("unavailable", None),
            Outcome::Failed(_)
        ));
    }

    #[test]
    fn biome_and_ruff_columns_use_utf16_after_non_bmp_characters() {
        let source = "console.log(\"😀\"); const unused = 1;\n";
        let path = PathBuf::from("/workspace/fixture.js");
        let biome = json!({"diagnostics": [{
            "message": "Unused variable", "severity": "warning", "category": "lint/unused",
            "location": {"path": "/workspace/fixture.js", "start": {"line": 1, "column": 25}, "end": {"line": 1, "column": 31}}
        }]});
        let result = parse_diagnostics(
            Tool::Biome,
            &serde_json::to_vec(&biome).unwrap(),
            &mut |reported| {
                (reported == "/workspace/fixture.js").then(|| (path.clone(), source.to_owned()))
            },
        )
        .unwrap();
        assert_eq!(
            result[0].range.start,
            Position {
                line: 0,
                character: 25
            }
        );
        assert_eq!(
            result[0].range.end,
            Position {
                line: 0,
                character: 31
            }
        );
        assert_eq!(result[0].severity, 2);

        let ruff = json!([{
            "message": "Undefined name", "code": "F821", "filename": "/workspace/fixture.py",
            "location": {"row": 1, "column": 8}, "end_location": {"row": 1, "column": 15}
        }]);
        let result =
            parse_diagnostics(Tool::Ruff, &serde_json::to_vec(&ruff).unwrap(), &mut |_| {
                Some((
                    PathBuf::from("/workspace/fixture.py"),
                    "x=\"😀\"; unknown(x)\n".to_owned(),
                ))
            })
            .unwrap();
        assert_eq!(
            result[0].range.start,
            Position {
                line: 0,
                character: 8
            }
        );
        assert_eq!(
            result[0].range.end,
            Position {
                line: 0,
                character: 15
            }
        );
        assert_eq!(result[0].code.as_deref(), Some("F821"));
    }

    #[test]
    fn clippy_uses_primary_byte_spans_and_filters_unreadable_files() {
        let source = "fn main() { let _ = \"😀\"; missing(); }\n";
        let start = source.find("missing").unwrap();
        let report = json!({"reason": "compiler-message", "message": {
            "message": "Cannot find function", "level": "error", "code": {"code": "E0425"},
            "spans": [
                {"file_name": "src/main.rs", "is_primary": true, "byte_start": start, "byte_end": start + 7},
                {"file_name": "src/main.rs", "is_primary": false, "byte_start": 0, "byte_end": 2},
                {"file_name": "/outside.rs", "is_primary": true, "byte_start": 0, "byte_end": 2}
            ]
        }});
        let result = parse_diagnostics(
            Tool::Clippy,
            &serde_json::to_vec(&report).unwrap(),
            &mut |path| {
                (path == "src/main.rs")
                    .then(|| (PathBuf::from("/workspace/src/main.rs"), source.to_owned()))
            },
        )
        .unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0].range.start,
            byte_offset_to_position(source, start)
        );
        assert_eq!(
            result[0].range.end,
            byte_offset_to_position(source, start + 7)
        );
        assert_eq!(result[0].code.as_deref(), Some("E0425"));
    }

    #[test]
    fn rubocop_conventions_use_scalar_columns_and_inclusive_end_positions() {
        let report = json!({"files": [{"path": "/workspace/fixture.rb", "offenses": [{
            "severity": "convention", "message": "Surrounding space missing for operator =.",
            "cop_name": "Layout/SpaceAroundOperators", "location": {
                "start_line": 1, "start_column": 19, "last_line": 1, "last_column": 19,
                "length": 1, "line": 1, "column": 19
            }
        }]}]});
        let result = parse_diagnostics(
            Tool::Rubocop,
            &serde_json::to_vec(&report).unwrap(),
            &mut |_| {
                Some((
                    PathBuf::from("/workspace/fixture.rb"),
                    "label = '😀'; value=1\n".into(),
                ))
            },
        )
        .unwrap();
        assert_eq!(
            result[0].range.start,
            Position {
                line: 0,
                character: 19
            }
        );
        assert_eq!(
            result[0].range.end,
            Position {
                line: 0,
                character: 20
            }
        );
        assert_eq!(result[0].severity, 2);
        assert_eq!(
            result[0].code.as_deref(),
            Some("Layout/SpaceAroundOperators")
        );
    }

    #[test]
    fn malformed_reports_are_errors_instead_of_clearing_diagnostics() {
        for tool in [Tool::Biome, Tool::Ruff, Tool::Clippy, Tool::Rubocop] {
            assert!(parse_diagnostics(tool, b"{truncated", &mut |_| None).is_err());
        }
        assert!(parse_diagnostics(Tool::Biome, b"{}", &mut |_| None).is_err());
    }

    #[test]
    fn lint_snapshot_expires_after_a_save_or_workspace_change() {
        let folder = tempfile::tempdir().unwrap();
        let root = folder.path().canonicalize().unwrap();
        let path = root.join("main.py");
        std::fs::write(&path, "x = 1\n").unwrap();
        let workspace = WorkspaceState::default();
        workspace.open_folder(&root).unwrap();
        let document = workspace.read_document(&path).unwrap();
        assert!(saved_version_matches(
            &workspace,
            &root,
            &path,
            &document.version
        ));
        std::fs::write(&path, "x = 2\n").unwrap();
        assert!(!saved_version_matches(
            &workspace,
            &root,
            &path,
            &document.version
        ));
        let next = tempfile::tempdir().unwrap();
        workspace.open_folder(next.path()).unwrap();
        assert!(!saved_version_matches(
            &workspace,
            &root,
            &path,
            &document.version
        ));
    }

    #[test]
    fn installed_tool_filter_rejects_project_and_relative_executables() {
        let folder = tempfile::tempdir().unwrap();
        let root = folder.path().canonicalize().unwrap();
        let path = root.join("ruff");
        std::fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::{PermissionsExt, symlink};
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert!(executable(&path, None));
            let link = tempfile::tempdir().unwrap();
            let link_path = link.path().join("ruff");
            symlink(&path, &link_path).unwrap();
            assert!(!executable(&link_path, Some(&root)));
        }
        assert!(!executable(&path, Some(&root)));
        assert!(!executable(Path::new("node_modules/.bin/ruff"), None));
    }
}
