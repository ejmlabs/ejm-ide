use crate::{
    HostAccessState,
    harness::HarnessState,
    terminal::{ProcessResult, run_bounded, run_bounded_input},
    workspace::{WorkspaceRoot, WorkspaceState},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Read,
    path::{Component, Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Manager, State, WebviewWindow};

const OUTPUT_LIMIT: usize = 4 * 1024 * 1024;
const FILE_LIMIT: usize = 2 * 1024 * 1024;
const CHANGE_LIMIT: usize = 2_000;
const COMMIT_FORMAT: &str = "%H%x00%P%x00%s%x00%an%x00%ae%x00%at%x00%D%x00";

#[derive(Default)]
pub struct GitState(Arc<Mutex<()>>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    path: String,
    relative_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    original_path: Option<String>,
    index_status: String,
    worktree_status: String,
    untracked: bool,
    conflicted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    available: bool,
    repository_root: Option<String>,
    branch: Option<String>,
    head: Option<String>,
    upstream: Option<String>,
    ahead: usize,
    behind: usize,
    index_version: String,
    changes: Vec<GitFileChange>,
    truncated: bool,
}

impl GitStatus {
    fn unavailable() -> Self {
        Self {
            available: false,
            repository_root: None,
            branch: None,
            head: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            index_version: String::new(),
            changes: Vec::new(),
            truncated: false,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    id: String,
    parents: Vec<String>,
    subject: String,
    author: String,
    email: String,
    date: i64,
    refs: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHistory {
    commits: Vec<GitCommit>,
    has_more: bool,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRef {
    name: String,
    full_name: String,
    kind: String,
    current: bool,
    upstream: Option<String>,
    id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStat {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    original_path: Option<String>,
    status: String,
    additions: Option<usize>,
    deletions: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetail {
    commit: GitCommit,
    message: String,
    files: Vec<GitFileStat>,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCompare {
    base: String,
    head: String,
    merge_base: Option<String>,
    ahead: usize,
    behind: usize,
    files: Vec<GitFileStat>,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBlameLine {
    line: usize,
    original_line: usize,
    commit: String,
    author: String,
    date: i64,
    summary: String,
    uncommitted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBlame {
    path: String,
    lines: Vec<GitBlameLine>,
    truncated: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitDiffRequest {
    scope: DiffScope,
    path: Option<String>,
    original_path: Option<String>,
    revision: Option<String>,
    base: Option<String>,
    head: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum DiffScope {
    Worktree,
    Index,
    Commit,
    Compare,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    original: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified: Option<String>,
    binary: bool,
    truncated: bool,
}

fn command(root: &Path, args: &[&str], write: bool) -> Command {
    let mut command = Command::new("git");
    command
        .args([
            "--no-pager",
            "--literal-pathspecs",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.quotepath=false",
            "-c",
            "color.ui=false",
        ])
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0");
    for name in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
        "GIT_NAMESPACE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_PARAMETERS",
        "GIT_PREFIX",
    ] {
        command.env_remove(name);
    }
    if !write {
        command.env("GIT_OPTIONAL_LOCKS", "0");
    }
    command
}

fn execute(
    root: &Path,
    args: &[&str],
    limit: usize,
    input: Option<Vec<u8>>,
    write: bool,
) -> Result<ProcessResult, String> {
    let timeout = Duration::from_secs(if write { 60 } else { 10 });
    let command = command(root, args, write);
    let result = match input {
        Some(input) => run_bounded_input(command, timeout, limit, input)?,
        None => run_bounded(command, timeout, limit)?,
    };
    if result.timed_out {
        return Err(if write {
            "Git timed out. Refresh the repository before retrying; the operation may have finished."
        } else {
            "Git took longer than 10 seconds. Narrow the request and retry."
        }
        .into());
    }
    Ok(result)
}

fn checked(result: ProcessResult) -> Result<ProcessResult, String> {
    if result.exit_code == 0 {
        Ok(result)
    } else {
        let bytes = if result.stderr.is_empty() {
            &result.output
        } else {
            &result.stderr
        };
        let message = String::from_utf8_lossy(bytes).trim().to_owned();
        Err(if message.is_empty() {
            format!("Git failed with exit code {}.", result.exit_code)
        } else {
            message
        })
    }
}

fn text(bytes: &[u8]) -> Result<&str, String> {
    std::str::from_utf8(bytes).map_err(|_| "Git returned a non-UTF-8 path or record.".into())
}

fn complete_records(bytes: &[u8], truncated: bool, separator: u8) -> &[u8] {
    if truncated {
        &bytes[..bytes
            .iter()
            .rposition(|byte| *byte == separator)
            .map_or(0, |end| end + 1)]
    } else {
        bytes
    }
}

struct Repository {
    workspace: WorkspaceRoot,
    root: PathBuf,
}

struct StatusRead {
    status: GitStatus,
    hidden_staged: bool,
    conflicted: bool,
}

enum Content {
    Text(String),
    Binary,
    Large,
}

impl Repository {
    fn discover(workspace: WorkspaceRoot) -> Result<Option<Self>, String> {
        Self::check_workspace(&workspace)?;
        let result = execute(
            &workspace.path,
            &["rev-parse", "--show-toplevel"],
            16 * 1024,
            None,
            false,
        )?;
        if result.exit_code != 0
            && String::from_utf8_lossy(&result.stderr).contains("not a git repository")
        {
            return Ok(None);
        }
        let result = checked(result)?;
        if result.truncated {
            return Err("The Git repository path is too long.".into());
        }
        let output = text(&result.output)?;
        let root = PathBuf::from(output.strip_suffix('\n').unwrap_or(output))
            .canonicalize()
            .map_err(|error| format!("Cannot open Git repository: {error}"))?;
        if !workspace.path.starts_with(&root) {
            return Err("The Git repository does not contain the selected workspace.".into());
        }
        Ok(Some(Self { workspace, root }))
    }

    fn required(workspace: WorkspaceRoot) -> Result<Self, String> {
        Self::discover(workspace)?.ok_or_else(|| "This workspace has no Git repository.".into())
    }

    fn check_workspace(workspace: &WorkspaceRoot) -> Result<(), String> {
        let canonical = workspace
            .path
            .canonicalize()
            .map_err(|_| "The workspace directory is no longer available.")?;
        if canonical != workspace.path {
            return Err(
                "The workspace directory has moved. Open it again before using Git.".into(),
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let pinned = workspace
                .directory
                .try_clone()
                .map_err(|error| error.to_string())?
                .into_std_file()
                .metadata()
                .map_err(|error| error.to_string())?;
            let current = std::fs::metadata(&workspace.path).map_err(|error| error.to_string())?;
            if pinned.dev() != current.dev() || pinned.ino() != current.ino() {
                return Err(
                    "The workspace directory was replaced. Open it again before using Git.".into(),
                );
            }
        }
        Ok(())
    }

    fn run(&self, args: &[&str], limit: usize) -> Result<ProcessResult, String> {
        checked(execute(&self.root, args, limit, None, false)?)
    }

    fn resolve(&self, revision: &str) -> Result<String, String> {
        if revision.is_empty() || revision.len() > 1024 || revision.chars().any(char::is_control) {
            return Err("Choose a valid Git revision shorter than 1 KiB.".into());
        }
        let revision = format!("{revision}^{{commit}}");
        let result = self.run(
            &["rev-parse", "--verify", "--end-of-options", &revision],
            1024,
        )?;
        let id = text(&result.output)?.trim();
        if result.truncated || !valid_oid(id) {
            return Err("Git did not resolve this revision to a commit.".into());
        }
        Ok(id.into())
    }

    fn head(&self) -> Result<Option<String>, String> {
        let result = execute(
            &self.root,
            &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
            1024,
            None,
            false,
        )?;
        if result.exit_code == 1 {
            return Ok(None);
        }
        let result = checked(result)?;
        let id = text(&result.output)?.trim();
        if result.truncated || !valid_oid(id) {
            return Err("Git returned an invalid HEAD.".into());
        }
        Ok(Some(id.into()))
    }

    fn path(&self, value: &str) -> Result<String, String> {
        if value.is_empty() || value.len() > 16 * 1024 || value.contains('\0') {
            return Err("Choose a valid workspace file path.".into());
        }
        let value = Path::new(value);
        if value.components().any(|part| {
            !matches!(
                part,
                Component::Normal(_) | Component::CurDir | Component::RootDir
            )
        }) {
            return Err("Git paths cannot contain parent traversal.".into());
        }
        let absolute = if value.is_absolute() {
            value.to_path_buf()
        } else {
            self.root.join(value)
        };
        if !absolute.starts_with(&self.workspace.path)
            || absolute == self.workspace.path
            || absolute.components().any(|part| part.as_os_str() == ".git")
        {
            return Err("Git paths must name files inside the selected workspace.".into());
        }
        let mut existing = absolute.as_path();
        while !existing.exists() {
            existing = existing
                .parent()
                .ok_or("Git path has no existing parent.")?;
        }
        let resolved = existing.canonicalize().map_err(|error| error.to_string())?;
        if !resolved.starts_with(&self.workspace.path) {
            return Err("The Git path points outside the selected workspace.".into());
        }
        let relative = absolute
            .strip_prefix(&self.root)
            .map_err(|_| "Git path is outside this repository.")?;
        relative
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| "Git paths must be UTF-8.".into())
    }

    fn absolute(&self, relative: &str) -> Option<String> {
        let path = self.root.join(relative);
        if Path::new(relative).is_absolute()
            || Path::new(relative)
                .components()
                .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
            || !path.starts_with(&self.workspace.path)
            || path == self.workspace.path
        {
            return None;
        }
        Some(path.to_string_lossy().into_owned())
    }

    fn scope(&self) -> &str {
        self.workspace
            .path
            .strip_prefix(&self.root)
            .ok()
            .and_then(Path::to_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(".")
    }

    fn status(&self) -> Result<StatusRead, String> {
        let result = self.run(
            &[
                "status",
                "--porcelain=v2",
                "-z",
                "--branch",
                "--untracked-files=all",
            ],
            OUTPUT_LIMIT,
        )?;
        let mut status = GitStatus {
            available: true,
            repository_root: Some(self.root.to_string_lossy().into_owned()),
            ..GitStatus::unavailable()
        };
        status.truncated = result.truncated;
        let mut hidden_staged = false;
        let mut conflicted = false;
        let records = complete_records(&result.output, result.truncated, 0);
        let mut records = records
            .split(|byte| *byte == 0)
            .filter(|record| !record.is_empty());
        while let Some(bytes) = records.next() {
            if bytes.is_empty() {
                continue;
            }
            let record = text(bytes)?;
            if let Some(id) = record.strip_prefix("# branch.oid ") {
                if valid_oid(id) {
                    status.head = Some(id.into());
                }
                continue;
            }
            if let Some(branch) = record.strip_prefix("# branch.head ") {
                if branch != "(detached)" {
                    status.branch = Some(branch.into());
                }
                continue;
            }
            if let Some(upstream) = record.strip_prefix("# branch.upstream ") {
                status.upstream = Some(upstream.into());
                continue;
            }
            if let Some(counts) = record.strip_prefix("# branch.ab ") {
                let mut counts = counts.split_whitespace();
                status.ahead = counts
                    .next()
                    .unwrap_or("+0")
                    .trim_start_matches('+')
                    .parse()
                    .unwrap_or(0);
                status.behind = counts
                    .next()
                    .unwrap_or("-0")
                    .trim_start_matches('-')
                    .parse()
                    .unwrap_or(0);
                continue;
            }
            let (xy, relative, old, untracked, conflict) = match record.as_bytes()[0] {
                b'1' => {
                    let fields: Vec<_> = record.splitn(9, ' ').collect();
                    if fields.len() != 9 {
                        return Err("Git returned an incomplete status record.".into());
                    }
                    (fields[1], fields[8], None, false, false)
                }
                b'2' => {
                    let fields: Vec<_> = record.splitn(10, ' ').collect();
                    if fields.len() != 10 {
                        return Err("Git returned an incomplete rename record.".into());
                    }
                    let old = records.next().map(text).transpose()?;
                    if old.is_none() {
                        status.truncated = true;
                    }
                    (fields[1], fields[9], old, false, false)
                }
                b'u' => {
                    let fields: Vec<_> = record.splitn(11, ' ').collect();
                    if fields.len() != 11 {
                        return Err("Git returned an incomplete conflict record.".into());
                    }
                    (fields[1], fields[10], None, false, true)
                }
                b'?' => (
                    "??",
                    record.get(2..).ok_or("Invalid Git untracked record.")?,
                    None,
                    true,
                    false,
                ),
                b'#' | b'!' => continue,
                _ if result.truncated => {
                    status.truncated = true;
                    break;
                }
                _ => return Err("Git returned an unknown status record.".into()),
            };
            if xy.len() != 2 {
                return Err("Git returned an invalid file status.".into());
            }
            let index = &xy[..1];
            let worktree = &xy[1..];
            conflicted |= conflict;
            let Some(path) = self.absolute(relative) else {
                hidden_staged |= index != "." && !untracked;
                continue;
            };
            if old.is_some_and(|old| self.absolute(old).is_none()) {
                hidden_staged |= index != ".";
            }
            if status.changes.len() == CHANGE_LIMIT {
                status.truncated = true;
                continue;
            }
            status.changes.push(GitFileChange {
                path,
                relative_path: relative.into(),
                original_path: old.and_then(|old| self.absolute(old)),
                index_status: if index == "." { "" } else { index }.into(),
                worktree_status: if worktree == "." { "" } else { worktree }.into(),
                untracked,
                conflicted: conflict,
            });
        }
        let raw = self.run(
            &[
                "diff",
                "--cached",
                "--raw",
                "--no-abbrev",
                "-z",
                "--no-ext-diff",
                "--no-textconv",
            ],
            OUTPUT_LIMIT,
        )?;
        status.truncated |= raw.truncated;
        let mut digest = Sha256::new();
        digest.update(status.head.as_deref().unwrap_or("unborn").as_bytes());
        digest.update([0]);
        digest.update(&raw.output);
        status.index_version = format!("{:x}", digest.finalize());
        Ok(StatusRead {
            status,
            hidden_staged,
            conflicted,
        })
    }

    fn refs(&self) -> Result<Vec<GitRef>, String> {
        let result = self.run(&[
            "for-each-ref", "--sort=-committerdate", "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(HEAD)%00%(upstream:short)%00",
            "refs/heads", "refs/remotes", "refs/tags",
        ], OUTPUT_LIMIT)?;
        if result.truncated {
            return Err("There are too many Git references to display safely.".into());
        }
        let mut refs = Vec::new();
        for row in result
            .output
            .split(|byte| *byte == b'\n')
            .filter(|row| !row.is_empty())
        {
            let fields: Vec<_> = row.split(|byte| *byte == 0).collect();
            if fields.len() < 5 {
                return Err("Git returned an incomplete reference.".into());
            }
            let full_name = text(fields[0])?;
            let kind = if full_name.starts_with("refs/heads/") {
                "branch"
            } else if full_name.starts_with("refs/remotes/") {
                "remote"
            } else {
                "tag"
            };
            refs.push(GitRef {
                full_name: full_name.into(),
                name: text(fields[1])?.into(),
                kind: kind.into(),
                id: text(fields[2])?.into(),
                current: fields[3] == b"*",
                upstream: (!fields[4].is_empty())
                    .then(|| String::from_utf8_lossy(fields[4]).into_owned()),
            });
        }
        Ok(refs)
    }

    fn history(
        &self,
        revision: Option<&str>,
        path: Option<&str>,
        query: Option<&str>,
        skip: usize,
        limit: usize,
    ) -> Result<GitHistory, String> {
        if skip > 100_000 || !(1..=200).contains(&limit) {
            return Err(
                "Git history pages must contain 1 to 200 commits within the first 100,000 results."
                    .into(),
            );
        }
        if query.is_some_and(|query| query.len() > 1024 || query.contains('\0')) {
            return Err("Git history search must be shorter than 1 KiB.".into());
        }
        let has_head = self.head()?;
        let resolved = revision
            .map(|revision| self.resolve(revision))
            .transpose()?;
        let path = path.map(|path| self.path(path)).transpose()?;
        let format = format!("--format={COMMIT_FORMAT}");
        let skip = format!("--skip={skip}");
        let count = format!("--max-count={}", limit + 1);
        let mut args = vec![
            "log",
            "--topo-order",
            "--full-history",
            "--decorate=short",
            &format,
            &skip,
            &count,
        ];
        if path.is_some() {
            args.push("--follow");
        }
        if query.is_some_and(|query| !query.trim().is_empty()) {
            args.extend([
                "--fixed-strings",
                "--regexp-ignore-case",
                "--grep",
                query.unwrap(),
            ]);
        }
        if let Some(revision) = &resolved {
            args.push(revision);
        } else {
            args.push("--all");
            if let Some(head) = &has_head {
                args.push(head);
            }
        }
        args.push("--");
        if let Some(path) = &path {
            args.push(path);
        } else if self.scope() != "." {
            args.push(self.scope());
        }
        let result = self.run(&args, OUTPUT_LIMIT)?;
        let mut commits = parse_commits(complete_records(&result.output, result.truncated, 0))?;
        let has_more = commits.len() > limit || result.truncated;
        commits.truncate(limit);
        Ok(GitHistory {
            commits,
            has_more,
            truncated: result.truncated,
        })
    }

    fn commit(&self, revision: &str) -> Result<GitCommit, String> {
        let format = format!("--format={COMMIT_FORMAT}");
        let result = self.run(
            &["show", "--no-patch", "--decorate=short", &format, revision],
            128 * 1024,
        )?;
        if result.truncated {
            return Err("This Git commit metadata exceeds the display limit.".into());
        }
        parse_commits(&result.output)?
            .into_iter()
            .next()
            .ok_or_else(|| "Git returned no commit.".into())
    }

    fn file_stats(
        &self,
        before: Option<&str>,
        after: &str,
    ) -> Result<(Vec<GitFileStat>, bool), String> {
        let mut base = if let Some(before) = before {
            vec!["diff", before, after]
        } else {
            vec!["diff-tree", "--root", "--no-commit-id", "-r", after]
        };
        base.extend(["--no-ext-diff", "--no-textconv", "--find-renames", "-z"]);
        let mut args = base.clone();
        args.extend(["--name-status", "--", self.scope()]);
        let names = self.run(&args, OUTPUT_LIMIT)?;
        let mut args = base;
        args.extend(["--numstat", "--", self.scope()]);
        let numbers = self.run(&args, OUTPUT_LIMIT)?;
        let mut counts = HashMap::new();
        let rows = complete_records(&numbers.output, numbers.truncated, 0);
        let mut records = rows.split(|byte| *byte == 0);
        while let Some(record) = records.next().filter(|record| !record.is_empty()) {
            let fields: Vec<_> = text(record)?.splitn(3, '\t').collect();
            if fields.len() != 3 {
                if numbers.truncated {
                    break;
                }
                return Err("Git returned an invalid change count.".into());
            }
            let path = if fields[2].is_empty() {
                records.next();
                let Some(path) = records.next() else {
                    break;
                };
                text(path)?
            } else {
                fields[2]
            };
            counts.insert(
                path.to_owned(),
                (fields[0].parse().ok(), fields[1].parse().ok()),
            );
        }
        let mut files = Vec::new();
        let rows = complete_records(&names.output, names.truncated, 0);
        let mut records = rows.split(|byte| *byte == 0);
        let mut truncated = names.truncated || numbers.truncated;
        while let Some(status) = records.next().filter(|record| !record.is_empty()) {
            let status = text(status)?;
            let Some(path) = records.next() else {
                truncated = true;
                break;
            };
            let path = text(path)?;
            let (old, path) = if status.starts_with(['R', 'C']) {
                let Some(new) = records.next() else {
                    truncated = true;
                    break;
                };
                (self.absolute(path), text(new)?)
            } else {
                (None, path)
            };
            let Some(absolute) = self.absolute(path) else {
                continue;
            };
            if files.len() == CHANGE_LIMIT {
                truncated = true;
                break;
            }
            let (additions, deletions) = counts.remove(path).unwrap_or((None, None));
            files.push(GitFileStat {
                path: absolute,
                original_path: old,
                status: status.into(),
                additions,
                deletions,
            });
        }
        Ok((files, truncated))
    }

    fn detail(&self, revision: &str) -> Result<GitCommitDetail, String> {
        let revision = self.resolve(revision)?;
        let commit = self.commit(&revision)?;
        let message = self.run(
            &["show", "--no-patch", "--format=%B", &revision],
            128 * 1024,
        )?;
        let (files, truncated) =
            self.file_stats(commit.parents.first().map(String::as_str), &revision)?;
        Ok(GitCommitDetail {
            commit,
            message: String::from_utf8_lossy(&message.output).trim_end().into(),
            files,
            truncated: truncated || message.truncated,
        })
    }

    fn compare(&self, base: &str, head: &str) -> Result<GitCompare, String> {
        let base = self.resolve(base)?;
        let head = self.resolve(head)?;
        let range = format!("{base}...{head}");
        let result = self.run(&["rev-list", "--left-right", "--count", &range], 4096)?;
        let counts: Vec<_> = text(&result.output)?.split_whitespace().collect();
        if counts.len() != 2 {
            return Err("Git returned invalid comparison counts.".into());
        }
        let behind = counts[0]
            .parse()
            .map_err(|_| "Invalid Git comparison count.")?;
        let ahead = counts[1]
            .parse()
            .map_err(|_| "Invalid Git comparison count.")?;
        let merge = execute(&self.root, &["merge-base", &base, &head], 4096, None, false)?;
        let merge_base = if merge.exit_code == 1 {
            None
        } else {
            Some(text(&checked(merge)?.output)?.trim().into())
        };
        let (files, truncated) = self.file_stats(Some(&base), &head)?;
        Ok(GitCompare {
            base,
            head,
            merge_base,
            ahead,
            behind,
            files,
            truncated,
        })
    }

    fn blob(&self, id: &str) -> Result<Content, String> {
        let size = self.run(&["cat-file", "-s", id], 4096)?;
        let size: usize = text(&size.output)?
            .trim()
            .parse()
            .map_err(|_| "Invalid Git blob size.")?;
        if size > FILE_LIMIT {
            return Ok(Content::Large);
        }
        let result = self.run(&["cat-file", "blob", id], FILE_LIMIT + 1)?;
        Ok(decode_content(result.output, result.truncated))
    }

    fn tree_content(&self, revision: Option<&str>, path: &str) -> Result<Content, String> {
        let Some(revision) = revision else {
            return Ok(Content::Text(String::new()));
        };
        let result = self.run(&["ls-tree", "-z", revision, "--", path], 32 * 1024)?;
        if result.truncated {
            return Ok(Content::Large);
        }
        let Some(record) = result
            .output
            .split(|byte| *byte == 0)
            .find(|row| !row.is_empty())
        else {
            return Ok(Content::Text(String::new()));
        };
        let metadata = text(record)?
            .split_once('\t')
            .ok_or("Invalid Git tree entry.")?
            .0;
        let fields: Vec<_> = metadata.split_whitespace().collect();
        if fields.len() != 3 {
            return Err("Invalid Git tree metadata.".into());
        }
        if fields[1] != "blob" {
            return Ok(Content::Binary);
        }
        self.blob(fields[2])
    }

    fn index_oid(&self, path: &str) -> Result<Option<String>, String> {
        let result = self.run(&["ls-files", "--stage", "-z", "--", path], 32 * 1024)?;
        if result.truncated {
            return Err("The index entry exceeds the display limit.".into());
        }
        for record in result
            .output
            .split(|byte| *byte == 0)
            .filter(|row| !row.is_empty())
        {
            let (metadata, name) = text(record)?
                .split_once('\t')
                .ok_or("Invalid Git index entry.")?;
            let fields: Vec<_> = metadata.split_whitespace().collect();
            if fields.len() != 3 {
                return Err("Invalid Git index metadata.".into());
            }
            if name == path && fields[2] == "0" {
                if fields[0] == "160000" {
                    return Ok(None);
                }
                return Ok(Some(fields[1].into()));
            }
        }
        Ok(None)
    }

    fn index_content(&self, path: &str) -> Result<Content, String> {
        match self.index_oid(path)? {
            Some(id) => self.blob(&id),
            None => Ok(Content::Text(String::new())),
        }
    }

    fn working_content(&self, path: &str) -> Result<Content, String> {
        let absolute = self.root.join(path);
        let relative = absolute
            .strip_prefix(&self.workspace.path)
            .map_err(|_| "File is outside the workspace.")?;
        let metadata = match self.workspace.directory.symlink_metadata(relative) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Content::Text(String::new()));
            }
            Err(error) => return Err(format!("Cannot inspect the working file: {error}")),
        };
        if metadata.file_type().is_symlink() {
            let target = self
                .workspace
                .directory
                .read_link_contents(relative)
                .map_err(|error| format!("Cannot read the working symlink: {error}"))?;
            return Ok(match target.to_str() {
                Some(target) => Content::Text(target.into()),
                None => Content::Binary,
            });
        }
        let file = match self.workspace.directory.open(relative) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Content::Text(String::new()));
            }
            Err(error) => return Err(format!("Cannot read the working file: {error}")),
        };
        let metadata = file.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_file() {
            return Ok(Content::Binary);
        }
        if metadata.len() > FILE_LIMIT as u64 {
            return Ok(Content::Large);
        }
        let mut bytes = Vec::new();
        file.take((FILE_LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        Ok(decode_content(bytes, false))
    }

    fn diff(&self, request: GitDiffRequest) -> Result<GitDiff, String> {
        let path = request
            .path
            .as_deref()
            .map(|path| self.path(path))
            .transpose()?;
        let old = request
            .original_path
            .as_deref()
            .map(|path| self.path(path))
            .transpose()?;
        let old_path = old.as_deref().or(path.as_deref());
        let (before, after) = match request.scope {
            DiffScope::Commit => {
                let id = self.resolve(
                    request
                        .revision
                        .as_deref()
                        .ok_or("Choose a commit to inspect.")?,
                )?;
                let commit = self.commit(&id)?;
                (commit.parents.into_iter().next(), Some(id))
            }
            DiffScope::Compare => (
                Some(self.resolve(request.base.as_deref().ok_or("Choose a comparison base.")?)?),
                Some(self.resolve(request.head.as_deref().ok_or("Choose a comparison head.")?)?),
            ),
            DiffScope::Index => (self.status()?.status.head, None),
            DiffScope::Worktree => (None, None),
        };
        let mut args = match request.scope {
            DiffScope::Commit if before.is_none() => {
                vec!["show", "--format=", "--root", after.as_deref().unwrap()]
            }
            DiffScope::Commit | DiffScope::Compare => vec![
                "diff",
                before.as_deref().unwrap(),
                after.as_deref().unwrap(),
            ],
            DiffScope::Index => {
                let mut args = vec!["diff", "--cached"];
                if let Some(before) = &before {
                    args.push(before);
                }
                args
            }
            DiffScope::Worktree => vec!["diff"],
        };
        args.extend([
            "--no-ext-diff",
            "--no-textconv",
            "--find-renames",
            "--unified=3",
            "--",
        ]);
        args.push(path.as_deref().unwrap_or(self.scope()));
        if let Some(old) = &old
            && path.as_ref() != Some(old)
        {
            args.push(old);
        }
        let mut result = self.run(&args, OUTPUT_LIMIT)?;
        let mut original = None;
        let mut modified = None;
        let mut binary = false;
        let mut truncated = result.truncated;
        if let Some(path) = &path {
            let (left, right) = match request.scope {
                DiffScope::Worktree => (self.index_content(path)?, self.working_content(path)?),
                DiffScope::Index => (
                    self.tree_content(before.as_deref(), old_path.unwrap())?,
                    self.index_content(path)?,
                ),
                DiffScope::Commit | DiffScope::Compare => (
                    self.tree_content(before.as_deref(), old_path.unwrap())?,
                    self.tree_content(after.as_deref(), path)?,
                ),
            };
            if matches!(request.scope, DiffScope::Worktree)
                && self.index_oid(path)?.is_none()
                && std::fs::symlink_metadata(self.root.join(path))
                    .is_ok_and(|metadata| metadata.is_file() || metadata.file_type().is_symlink())
            {
                result = execute(
                    &self.root,
                    &[
                        "diff",
                        "--no-index",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--",
                        "/dev/null",
                        path,
                    ],
                    OUTPUT_LIMIT,
                    None,
                    false,
                )?;
                if !matches!(result.exit_code, 0 | 1) {
                    return checked(result).map(|_| unreachable!());
                }
                truncated |= result.truncated;
            }
            match (left, right) {
                (Content::Text(left), Content::Text(right)) => {
                    original = Some(left);
                    modified = Some(right);
                }
                (Content::Large, _) | (_, Content::Large) => {
                    truncated = true;
                }
                _ => {
                    binary = true;
                }
            }
        }
        let text = String::from_utf8_lossy(&result.output).into_owned();
        binary |= text.contains("Binary files ") || text.contains("GIT binary patch");
        Ok(GitDiff {
            text,
            path: path.and_then(|path| self.absolute(&path)),
            original,
            modified,
            binary,
            truncated,
        })
    }

    fn blame(
        &self,
        path: &str,
        start: Option<usize>,
        end: Option<usize>,
        content: Option<String>,
    ) -> Result<GitBlame, String> {
        let path = self.path(path)?;
        let start = start.unwrap_or(1);
        let end = end.unwrap_or(start.saturating_add(999));
        if start == 0 || end < start || end - start >= 2_000 {
            return Err("Blame must request 1 to 2,000 lines with one-based line numbers.".into());
        }
        if content
            .as_ref()
            .is_some_and(|content| content.len() > FILE_LIMIT || content.contains('\0'))
        {
            return Err("Blame accepts UTF-8 text up to 2 MiB.".into());
        }
        let content = match content {
            Some(content) => content,
            None => match self.working_content(&path)? {
                Content::Text(content) => content,
                _ => return Err("Blame is available for text files up to 2 MiB.".into()),
            },
        };
        let line_count = content.lines().count();
        if line_count == 0 || start > line_count {
            return Ok(GitBlame {
                path: self.absolute(&path).unwrap(),
                lines: Vec::new(),
                truncated: false,
            });
        }
        let head = self.head()?;
        let committed = match head {
            Some(head) => !self
                .run(&["ls-tree", "-z", &head, "--", &path], 32 * 1024)?
                .output
                .is_empty(),
            None => false,
        };
        if !committed {
            return Ok(GitBlame {
                path: self.absolute(&path).unwrap(),
                lines: (start..=end.min(line_count))
                    .map(|line| GitBlameLine {
                        line,
                        original_line: line,
                        commit: "0".repeat(40),
                        author: "Not Committed Yet".into(),
                        date: 0,
                        summary: "Uncommitted changes".into(),
                        uncommitted: true,
                    })
                    .collect(),
                truncated: line_count > end,
            });
        }
        let range = format!("{start},{}", end.min(line_count));
        let result = checked(execute(
            &self.root,
            &[
                "blame",
                "--line-porcelain",
                "--contents",
                "-",
                "-L",
                &range,
                "--",
                &path,
            ],
            OUTPUT_LIMIT,
            Some(content.into_bytes()),
            false,
        )?)?;
        let mut lines = Vec::new();
        let mut current: Option<GitBlameLine> = None;
        for row in text(complete_records(&result.output, result.truncated, b'\n'))?.lines() {
            if let Some(value) = current.as_mut() {
                if row.starts_with('\t') {
                    lines.push(current.take().unwrap());
                    continue;
                }
                if let Some(author) = row.strip_prefix("author ") {
                    value.author = author.into();
                }
                if let Some(date) = row.strip_prefix("author-time ") {
                    value.date = date.parse().unwrap_or(0);
                }
                if let Some(summary) = row.strip_prefix("summary ") {
                    value.summary = summary.into();
                }
            } else {
                let fields: Vec<_> = row.split_whitespace().collect();
                if fields.len() < 3 || !valid_oid(fields[0]) {
                    return Err("Git returned invalid blame data.".into());
                }
                current = Some(GitBlameLine {
                    commit: fields[0].into(),
                    original_line: fields[1].parse().map_err(|_| "Invalid Git blame line.")?,
                    line: fields[2].parse().map_err(|_| "Invalid Git blame line.")?,
                    author: String::new(),
                    date: 0,
                    summary: String::new(),
                    uncommitted: fields[0].bytes().all(|byte| byte == b'0'),
                });
            }
        }
        Ok(GitBlame {
            path: self.absolute(&path).unwrap(),
            lines,
            truncated: result.truncated || line_count > end,
        })
    }

    fn paths(&self, paths: Vec<String>) -> Result<Vec<String>, String> {
        if paths.is_empty() || paths.len() > CHANGE_LIMIT {
            return Err("Select 1 to 2,000 files for this Git action.".into());
        }
        let mut result = Vec::new();
        for path in paths {
            let relative = self.path(&path)?;
            if self.root.join(&relative).is_dir() {
                return Err("Select individual files rather than a whole directory.".into());
            }
            if !result.contains(&relative) {
                result.push(relative);
            }
        }
        Ok(result)
    }

    fn stage(&self, paths: Vec<String>, unstage: bool) -> Result<GitStatus, String> {
        let mut paths = self.paths(paths)?;
        let status = self.status()?;
        if unstage {
            for change in &status.status.changes {
                if paths.contains(&change.relative_path)
                    && let Some(original) = &change.original_path
                {
                    let original = self.path(original)?;
                    if !paths.contains(&original) {
                        paths.push(original);
                    }
                }
            }
        }
        let mut args = if unstage {
            if status.status.head.is_some() {
                vec!["restore", "--staged", "--"]
            } else {
                vec!["rm", "--cached", "--force", "--ignore-unmatch", "--"]
            }
        } else {
            vec!["add", "--"]
        };
        args.extend(paths.iter().map(String::as_str));
        checked(execute(&self.root, &args, OUTPUT_LIMIT, None, true)?)?;
        Ok(self.status()?.status)
    }

    fn create_commit(
        &self,
        message: String,
        expected_head: Option<String>,
        expected_index: String,
    ) -> Result<GitStatus, String> {
        if message.trim().is_empty() || message.len() > 64 * 1024 || message.contains('\0') {
            return Err("Enter a commit message shorter than 64 KiB.".into());
        }
        let snapshot = self.status()?;
        if snapshot.status.truncated || snapshot.hidden_staged || snapshot.conflicted {
            return Err("Resolve conflicts and open the repository root to review every staged file before committing.".into());
        }
        if snapshot.status.head != expected_head || snapshot.status.index_version != expected_index
        {
            return Err(
                "HEAD or the staged files changed. Refresh and review them before committing."
                    .into(),
            );
        }
        if !snapshot
            .status
            .changes
            .iter()
            .any(|change| !change.index_status.is_empty() && !change.untracked)
        {
            return Err("Stage at least one change before committing.".into());
        }
        // Keep the user's normal hooks and signing behavior for an explicit commit.
        checked(execute(
            &self.root,
            &["commit", "--file=-"],
            OUTPUT_LIMIT,
            Some(message.into_bytes()),
            true,
        )?)?;
        Ok(self.status()?.status)
    }
}

fn decode_content(bytes: Vec<u8>, truncated: bool) -> Content {
    if truncated || bytes.len() > FILE_LIMIT {
        return Content::Large;
    }
    if bytes.contains(&0) {
        return Content::Binary;
    }
    match String::from_utf8(bytes) {
        Ok(content) => Content::Text(content),
        Err(_) => Content::Binary,
    }
}

async fn read_repository<T: Send + 'static>(
    snapshot: WorkspaceRoot,
    action: impl FnOnce(Repository) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || action(Repository::required(snapshot)?))
        .await
        .map_err(|error| error.to_string())?
}

async fn write_repository(
    snapshot: WorkspaceRoot,
    mutations: Arc<Mutex<()>>,
    expected_root: String,
    action: impl FnOnce(Repository) -> Result<GitStatus, String> + Send + 'static,
) -> Result<GitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _mutation = mutations
            .lock()
            .map_err(|_| "Git write service is unavailable.")?;
        if Path::new(&expected_root) != snapshot.path {
            return Err("The selected workspace changed. Refresh Git before retrying.".into());
        }
        let repository = Repository::required(snapshot)?;
        action(repository)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_status(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    auth: String,
) -> Result<GitStatus, String> {
    host.check(&window, &auth)?;
    let mut activity = window
        .app_handle()
        .state::<HarnessState>()
        .begin_operation("git.status");
    activity.record_request(&serde_json::json!({}));
    let result: Result<GitStatus, String> = async {
        let snapshot = workspace.snapshot()?;
        tauri::async_runtime::spawn_blocking(move || match Repository::discover(snapshot)? {
            Some(repository) => Ok(repository.status()?.status),
            None => Ok(GitStatus::unavailable()),
        })
        .await
        .map_err(|error| error.to_string())?
    }
    .await;
    activity.record_result(&result);
    result
}

#[tauri::command]
pub async fn git_refs(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    auth: String,
) -> Result<Vec<GitRef>, String> {
    host.check(&window, &auth)?;
    let mut activity = window
        .app_handle()
        .state::<HarnessState>()
        .begin_operation("git.refs");
    activity.record_request(&serde_json::json!({}));
    let result: Result<Vec<GitRef>, String> =
        async { read_repository(workspace.snapshot()?, |repository| repository.refs()).await }
            .await;
    activity.record_result(&result);
    result
}

#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "Tauri injects host state alongside the history filters"
)]
pub async fn git_history(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    auth: String,
    revision: Option<String>,
    path: Option<String>,
    query: Option<String>,
    skip: Option<usize>,
    limit: Option<usize>,
) -> Result<GitHistory, String> {
    host.check(&window, &auth)?;
    let mut activity = window
        .app_handle()
        .state::<HarnessState>()
        .begin_operation("git.history");
    activity.record_request(&serde_json::json!({"revision": revision, "path": path, "query": query, "skip": skip, "limit": limit}));
    let result: Result<GitHistory, String> = async {
        read_repository(workspace.snapshot()?, move |repository| {
            repository.history(
                revision.as_deref(),
                path.as_deref(),
                query.as_deref(),
                skip.unwrap_or(0),
                limit.unwrap_or(50),
            )
        })
        .await
    }
    .await;
    activity.record_result(&result);
    result
}

#[tauri::command]
pub async fn git_commit_detail(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    auth: String,
    revision: String,
) -> Result<GitCommitDetail, String> {
    host.check(&window, &auth)?;
    let mut activity = window
        .app_handle()
        .state::<HarnessState>()
        .begin_operation("git.commit_detail");
    activity.record_request(&serde_json::json!({"revision": revision}));
    let result: Result<GitCommitDetail, String> = async {
        read_repository(workspace.snapshot()?, move |repository| {
            repository.detail(&revision)
        })
        .await
    }
    .await;
    activity.record_result(&result);
    result
}

#[tauri::command]
pub async fn git_diff(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    auth: String,
    request: GitDiffRequest,
) -> Result<GitDiff, String> {
    host.check(&window, &auth)?;
    let mut activity = window
        .app_handle()
        .state::<HarnessState>()
        .begin_operation("git.diff");
    activity.record_request(&serde_json::json!({"request": request}));
    let result: Result<GitDiff, String> = async {
        read_repository(workspace.snapshot()?, move |repository| {
            repository.diff(request)
        })
        .await
    }
    .await;
    activity.record_result(&result);
    result
}

#[tauri::command]
pub async fn git_compare(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    auth: String,
    base: String,
    head: String,
) -> Result<GitCompare, String> {
    host.check(&window, &auth)?;
    let mut activity = window
        .app_handle()
        .state::<HarnessState>()
        .begin_operation("git.compare");
    activity.record_request(&serde_json::json!({"base": base, "head": head}));
    let result: Result<GitCompare, String> = async {
        read_repository(workspace.snapshot()?, move |repository| {
            repository.compare(&base, &head)
        })
        .await
    }
    .await;
    activity.record_result(&result);
    result
}

#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "Tauri injects host state alongside the requested source range"
)]
pub async fn git_blame(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    auth: String,
    path: String,
    start_line: Option<usize>,
    end_line: Option<usize>,
    content: Option<String>,
) -> Result<GitBlame, String> {
    host.check(&window, &auth)?;
    let mut activity = window
        .app_handle()
        .state::<HarnessState>()
        .begin_operation("git.blame");
    activity.record_request(&serde_json::json!({"path": path, "startLine": start_line, "endLine": end_line, "content": content}));
    let result: Result<GitBlame, String> = async {
        read_repository(workspace.snapshot()?, move |repository| {
            repository.blame(&path, start_line, end_line, content)
        })
        .await
    }
    .await;
    activity.record_result(&result);
    result
}

#[tauri::command]
pub async fn git_stage(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    git: State<'_, GitState>,
    auth: String,
    paths: Vec<String>,
    expected_root: String,
) -> Result<GitStatus, String> {
    host.check(&window, &auth)?;
    let mut activity = window
        .app_handle()
        .state::<HarnessState>()
        .begin_operation("git.stage");
    activity.record_request(&serde_json::json!({"paths": paths, "expectedRoot": expected_root}));
    let result: Result<GitStatus, String> = async {
        write_repository(
            workspace.snapshot()?,
            git.0.clone(),
            expected_root,
            move |repository| repository.stage(paths, false),
        )
        .await
    }
    .await;
    activity.record_result(&result);
    result
}

#[tauri::command]
pub async fn git_unstage(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    git: State<'_, GitState>,
    auth: String,
    paths: Vec<String>,
    expected_root: String,
) -> Result<GitStatus, String> {
    host.check(&window, &auth)?;
    let mut activity = window
        .app_handle()
        .state::<HarnessState>()
        .begin_operation("git.unstage");
    activity.record_request(&serde_json::json!({"paths": paths, "expectedRoot": expected_root}));
    let result: Result<GitStatus, String> = async {
        write_repository(
            workspace.snapshot()?,
            git.0.clone(),
            expected_root,
            move |repository| repository.stage(paths, true),
        )
        .await
    }
    .await;
    activity.record_result(&result);
    result
}

#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "Tauri injects host state alongside the commit preconditions"
)]
pub async fn git_commit(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    git: State<'_, GitState>,
    auth: String,
    message: String,
    expected_root: String,
    expected_head: Option<String>,
    expected_index: String,
) -> Result<GitStatus, String> {
    host.check(&window, &auth)?;
    let mut activity = window
        .app_handle()
        .state::<HarnessState>()
        .begin_operation("git.commit");
    activity.record_request(&serde_json::json!({"message": message, "expectedRoot": expected_root, "expectedHead": expected_head, "expectedIndex": expected_index}));
    let result: Result<GitStatus, String> = async {
        write_repository(
            workspace.snapshot()?,
            git.0.clone(),
            expected_root,
            move |repository| repository.create_commit(message, expected_head, expected_index),
        )
        .await
    }
    .await;
    activity.record_result(&result);
    result
}

fn valid_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn parse_commits(bytes: &[u8]) -> Result<Vec<GitCommit>, String> {
    let mut fields = bytes.split(|byte| *byte == 0);
    let mut commits = Vec::new();
    while let Some(id) = fields.next() {
        let id = text(id)?.trim_start_matches('\n');
        if id.is_empty() {
            continue;
        }
        let row: Vec<_> = fields.by_ref().take(6).collect();
        if row.len() != 6 {
            break;
        }
        if !valid_oid(id) {
            return Err("Git returned an invalid commit identifier.".into());
        }
        commits.push(GitCommit {
            id: id.into(),
            parents: text(row[0])?
                .split_whitespace()
                .map(str::to_owned)
                .collect(),
            subject: text(row[1])?.into(),
            author: text(row[2])?.into(),
            email: text(row[3])?.into(),
            date: text(row[4])?
                .parse()
                .map_err(|_| "Git returned an invalid commit date.")?,
            refs: text(row[5])?
                .split(", ")
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect(),
        });
    }
    Ok(commits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Fixture {
        _folder: tempfile::TempDir,
        root: PathBuf,
        workspace: WorkspaceState,
    }

    impl Fixture {
        fn new() -> Self {
            let folder = tempfile::tempdir().unwrap();
            let root = folder.path().canonicalize().unwrap();
            let workspace = WorkspaceState::default();
            let fixture = Self {
                _folder: folder,
                root,
                workspace,
            };
            fixture.git(&["init", "-q", "-b", "main"]);
            fixture.git(&["config", "user.name", "Workbench Test"]);
            fixture.git(&["config", "user.email", "workbench@example.test"]);
            fixture.git(&["config", "commit.gpgSign", "false"]);
            fixture.git(&["config", "core.hooksPath", ".git/hooks"]);
            fixture.workspace.open_folder(&fixture.root).unwrap();
            fixture
        }

        fn git(&self, args: &[&str]) -> String {
            let output = command(&self.root, args, true).output().unwrap();
            assert!(
                output.status.success(),
                "{:?}: {}",
                args,
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap().trim().into()
        }

        fn write(&self, path: &str, content: &str) {
            let path = self.root.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }

        fn commit(&self, message: &str) -> String {
            self.git(&["add", "--all"]);
            self.git(&["commit", "-qm", message]);
            self.git(&["rev-parse", "HEAD"])
        }

        fn repository(&self) -> Repository {
            Repository::required(self.workspace.snapshot().unwrap()).unwrap()
        }
    }

    fn diff_request(scope: DiffScope, path: &str) -> GitDiffRequest {
        GitDiffRequest {
            scope,
            path: Some(path.into()),
            original_path: None,
            revision: None,
            base: None,
            head: None,
        }
    }

    #[test]
    fn no_repository_is_distinct_from_a_git_failure() {
        let folder = tempfile::tempdir().unwrap();
        let workspace = WorkspaceState::default();
        workspace.open_folder(folder.path()).unwrap();
        assert!(
            Repository::discover(workspace.snapshot().unwrap())
                .unwrap()
                .is_none()
        );
        let result = execute(folder.path(), &["not-a-real-command"], 4096, None, false).unwrap();
        assert!(checked(result).is_err());
    }

    #[test]
    fn staged_and_working_versions_remain_separate_and_unstage_preserves_text() {
        let fixture = Fixture::new();
        fixture.write("space name.rs", "base\n");
        fixture.commit("Initial");
        fixture.write("space name.rs", "staged\n");
        let repository = fixture.repository();
        repository
            .stage(vec!["space name.rs".into()], false)
            .unwrap();
        fixture.write("space name.rs", "working\n");
        let status = repository.status().unwrap().status;
        assert_eq!(status.changes.len(), 1);
        assert_eq!(status.changes[0].index_status, "M");
        assert_eq!(status.changes[0].worktree_status, "M");
        let staged = repository
            .diff(diff_request(DiffScope::Index, "space name.rs"))
            .unwrap();
        assert_eq!(staged.original.as_deref(), Some("base\n"));
        assert_eq!(staged.modified.as_deref(), Some("staged\n"));
        let working = repository
            .diff(diff_request(DiffScope::Worktree, "space name.rs"))
            .unwrap();
        assert_eq!(working.original.as_deref(), Some("staged\n"));
        assert_eq!(working.modified.as_deref(), Some("working\n"));
        let status = repository
            .stage(vec!["space name.rs".into()], true)
            .unwrap();
        assert!(status.changes[0].index_status.is_empty());
        assert_eq!(
            fs::read_to_string(fixture.root.join("space name.rs")).unwrap(),
            "working\n"
        );
    }

    #[test]
    fn first_commit_and_unborn_unstage_work_and_stale_snapshots_are_rejected() {
        let fixture = Fixture::new();
        fixture.write("new.rs", "first\n");
        let repository = fixture.repository();
        let empty = repository.status().unwrap().status;
        assert!(empty.head.is_none());
        assert!(
            repository
                .history(None, None, None, 0, 50)
                .unwrap()
                .commits
                .is_empty()
        );
        let untracked = repository
            .diff(diff_request(DiffScope::Worktree, "new.rs"))
            .unwrap();
        assert!(untracked.text.contains("+first"));
        assert_eq!(untracked.original.as_deref(), Some(""));
        assert_eq!(untracked.modified.as_deref(), Some("first\n"));
        let staged = repository.stage(vec!["new.rs".into()], false).unwrap();
        assert_ne!(staged.index_version, empty.index_version);
        assert!(
            repository
                .create_commit("Stale".into(), None, empty.index_version)
                .is_err()
        );
        let staged_diff = repository
            .diff(diff_request(DiffScope::Index, "new.rs"))
            .unwrap();
        assert_eq!(staged_diff.modified.as_deref(), Some("first\n"));
        let status = repository.stage(vec!["new.rs".into()], true).unwrap();
        assert!(status.changes[0].untracked);
        assert!(fixture.root.join("new.rs").exists());
        let staged = repository.stage(vec!["new.rs".into()], false).unwrap();
        let committed = repository
            .create_commit("First commit".into(), None, staged.index_version)
            .unwrap();
        assert!(committed.changes.is_empty());
        assert!(committed.head.is_some());
        fixture.write("new.rs", "second\n");
        let staged = repository.stage(vec!["new.rs".into()], false).unwrap();
        fixture.commit("External commit");
        assert!(
            repository
                .create_commit("Stale HEAD".into(), staged.head, staged.index_version)
                .is_err()
        );
    }

    #[test]
    fn rename_history_commit_details_merge_parents_and_pagination_are_real_git_data() {
        let fixture = Fixture::new();
        fixture.write("old name.rs", "one\ntwo\n");
        let initial = fixture.commit("Initial file");
        fixture.git(&["mv", "old name.rs", "new name.rs"]);
        let rename = fixture.commit("Rename file");
        fixture.git(&["checkout", "-qb", "feature"]);
        fixture.write("feature.rs", "feature\n");
        let feature = fixture.commit("Feature work");
        fixture.git(&["checkout", "-q", "main"]);
        fixture.write("main.rs", "main\n");
        fixture.commit("Main work");
        fixture.git(&["merge", "--no-ff", "-qm", "Merge feature", "feature"]);
        let repository = fixture.repository();
        let detail = repository.detail("HEAD").unwrap();
        assert_eq!(detail.commit.parents.len(), 2);
        assert!(detail.commit.parents.contains(&feature));
        assert!(
            detail
                .files
                .iter()
                .any(|file| file.path.ends_with("feature.rs"))
        );
        let root_detail = repository.detail(&initial).unwrap();
        assert_eq!(root_detail.files.len(), 1);
        assert_eq!(root_detail.files[0].additions, Some(2));
        let detail = repository.detail(&rename).unwrap();
        assert!(detail.files[0].status.starts_with('R'));
        assert!(
            detail.files[0]
                .original_path
                .as_deref()
                .unwrap()
                .ends_with("old name.rs")
        );
        let mut request = diff_request(DiffScope::Commit, "new name.rs");
        request.original_path = Some("old name.rs".into());
        request.revision = Some(rename);
        let diff = repository.diff(request).unwrap();
        assert_eq!(diff.original, diff.modified);
        let history = repository
            .history(None, Some("new name.rs"), None, 0, 50)
            .unwrap();
        assert!(history.commits.iter().any(|commit| commit.id == initial));
        fixture.git(&["mv", "new name.rs", "next name.rs"]);
        fixture.write("next name.rs", "one\ntwo changed\n");
        let mut request = diff_request(DiffScope::Worktree, "next name.rs");
        request.original_path = Some("new name.rs".into());
        let diff = repository.diff(request).unwrap();
        assert_eq!(diff.original.as_deref(), Some("one\ntwo\n"));
        assert_eq!(diff.modified.as_deref(), Some("one\ntwo changed\n"));
        let page = repository.history(None, None, None, 0, 2).unwrap();
        assert_eq!(page.commits.len(), 2);
        assert!(page.has_more);
        let next = repository.history(None, None, None, 2, 2).unwrap();
        assert_ne!(page.commits[0].id, next.commits[0].id);
        let search = repository
            .history(None, None, Some("Feature work"), 0, 50)
            .unwrap();
        assert_eq!(search.commits.len(), 1);
        assert!(
            repository
                .refs()
                .unwrap()
                .iter()
                .any(|reference| reference.name == "main" && reference.current)
        );
    }

    #[test]
    fn comparisons_deletions_binary_and_large_files_have_explicit_results() {
        let fixture = Fixture::new();
        fixture.write("file.rs", "before\n");
        let base = fixture.commit("Base");
        fixture.write("file.rs", "after\n");
        fixture.write("added.rs", "added\n");
        let head = fixture.commit("Head");
        let repository = fixture.repository();
        let comparison = repository.compare(&base, &head).unwrap();
        assert_eq!((comparison.ahead, comparison.behind), (1, 0));
        assert_eq!(comparison.merge_base.as_deref(), Some(base.as_str()));
        assert_eq!(comparison.files.len(), 2);
        let mut request = diff_request(DiffScope::Compare, "file.rs");
        request.base = Some(base);
        request.head = Some(head);
        let diff = repository.diff(request).unwrap();
        assert_eq!(diff.original.as_deref(), Some("before\n"));
        assert_eq!(diff.modified.as_deref(), Some("after\n"));
        fs::remove_file(fixture.root.join("file.rs")).unwrap();
        let deletion = repository
            .diff(diff_request(DiffScope::Worktree, "file.rs"))
            .unwrap();
        assert_eq!(deletion.modified.as_deref(), Some(""));
        assert!(deletion.text.contains("-after"));
        fs::write(fixture.root.join("binary.dat"), [0, 1, 2, 3]).unwrap();
        assert!(
            repository
                .diff(diff_request(DiffScope::Worktree, "binary.dat"))
                .unwrap()
                .binary
        );
        fs::write(fixture.root.join("large.txt"), vec![b'a'; FILE_LIMIT + 1]).unwrap();
        let large = repository
            .diff(diff_request(DiffScope::Worktree, "large.txt"))
            .unwrap();
        assert!(large.truncated);
        assert!(large.modified.is_none());
    }

    #[test]
    fn blame_tracks_unsaved_text_and_bounds_line_ranges() {
        let fixture = Fixture::new();
        fixture.write("file.rs", "first\nsecond\nthird\n");
        let id = fixture.commit("Original lines");
        let repository = fixture.repository();
        let blame = repository
            .blame(
                "file.rs",
                Some(1),
                Some(2),
                Some("first\nunsaved\nthird\n".into()),
            )
            .unwrap();
        assert_eq!(blame.lines.len(), 2);
        assert_eq!(blame.lines[0].commit, id);
        assert!(blame.lines[1].uncommitted);
        assert_eq!(blame.lines[1].line, 2);
        assert!(blame.truncated);
        let final_line = repository
            .blame(
                "file.rs",
                Some(4),
                Some(4),
                Some("first\nsecond\nthird\n".into()),
            )
            .unwrap();
        assert!(final_line.lines.is_empty());
        fixture.write("untracked.rs", "new\n");
        let untracked = repository
            .blame(
                "untracked.rs",
                Some(1),
                Some(1),
                Some("unsaved new\n".into()),
            )
            .unwrap();
        assert_eq!(untracked.lines.len(), 1);
        assert!(untracked.lines[0].uncommitted);
        assert!(repository.blame("file.rs", Some(0), None, None).is_err());
        assert!(
            repository
                .blame("file.rs", Some(1), Some(2_001), None)
                .is_err()
        );
        assert_eq!(
            fs::read_to_string(fixture.root.join("file.rs")).unwrap(),
            "first\nsecond\nthird\n"
        );
    }

    #[test]
    fn nested_workspaces_cannot_modify_or_commit_hidden_staged_files() {
        let fixture = Fixture::new();
        fixture.write("inside/file.rs", "inside\n");
        fixture.write("outside.rs", "outside\n");
        fixture.commit("Initial");
        fixture
            .workspace
            .open_folder(&fixture.root.join("inside"))
            .unwrap();
        let repository = fixture.repository();
        fixture.write("inside/file.rs", "inside changed\n");
        fixture.write("outside.rs", "outside changed\n");
        fixture.git(&["add", "outside.rs"]);
        let status = repository
            .stage(vec!["inside/file.rs".into()], false)
            .unwrap();
        assert_eq!(status.changes.len(), 1);
        assert!(
            repository
                .create_commit("Hidden file".into(), status.head, status.index_version)
                .is_err()
        );
        assert!(repository.stage(vec!["outside.rs".into()], false).is_err());
        assert!(
            repository
                .stage(vec!["inside/../outside.rs".into()], false)
                .is_err()
        );
        let detail = repository.detail("HEAD").unwrap();
        assert_eq!(detail.files.len(), 1);
        assert!(detail.files[0].path.contains("/inside/"));
        assert_eq!(fixture.git(&["log", "--format=%s", "-1"]), "Initial");
    }

    #[test]
    fn paths_are_literal_and_refs_cannot_inject_git_options() {
        let fixture = Fixture::new();
        fixture.write("normal.rs", "normal\n");
        fixture.write(":(glob)*", "literal\n");
        let repository = fixture.repository();
        let status = repository.stage(vec![":(glob)*".into()], false).unwrap();
        assert_eq!(
            status
                .changes
                .iter()
                .filter(|change| change.index_status == "A")
                .count(),
            1
        );
        assert!(
            status
                .changes
                .iter()
                .find(|change| change.relative_path == "normal.rs")
                .unwrap()
                .untracked
        );
        assert!(repository.path("../escape").is_err());
        assert!(repository.path(".git/config").is_err());
        assert!(repository.path("/etc/passwd").is_err());
        for revision in [
            "--all",
            "--output=/tmp/escape",
            "HEAD:file.rs",
            "HEAD\n--all",
        ] {
            assert!(repository.resolve(revision).is_err(), "{revision:?}");
        }
    }

    #[test]
    fn graph_keeps_merge_empty_and_detached_head_commits() {
        let fixture = Fixture::new();
        fixture.write("file.rs", "base\n");
        fixture.commit("Initial");
        fixture.git(&["checkout", "-qb", "feature"]);
        fixture.write("feature.rs", "feature\n");
        fixture.commit("Feature");
        fixture.git(&["checkout", "-q", "main"]);
        fixture.git(&["merge", "--no-ff", "-qm", "Merge feature", "feature"]);
        let merge = fixture.git(&["rev-parse", "HEAD"]);
        fixture.git(&["commit", "--allow-empty", "-qm", "Empty checkpoint"]);
        fixture.git(&["checkout", "--detach", "-q"]);
        fixture.git(&["commit", "--allow-empty", "-qm", "Detached checkpoint"]);
        let detached = fixture.git(&["rev-parse", "HEAD"]);
        let history = fixture
            .repository()
            .history(None, None, None, 0, 50)
            .unwrap();
        assert_eq!(history.commits.len(), 5);
        assert!(
            history
                .commits
                .iter()
                .any(|commit| commit.id == merge && commit.parents.len() == 2)
        );
        assert!(history.commits.iter().any(|commit| commit.id == detached));
        assert!(
            history
                .commits
                .iter()
                .any(|commit| commit.subject == "Empty checkpoint")
        );
    }

    #[test]
    fn truncated_records_do_not_parse_partial_utf8_or_names() {
        assert_eq!(
            complete_records(b"complete\0partial\xc3", true, 0),
            b"complete\0"
        );
        assert_eq!(
            complete_records(b"complete\npartial\xc3", true, b'\n'),
            b"complete\n"
        );
        assert!(complete_records(b"partial", true, 0).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_diffs_use_the_link_target_string_and_external_links_are_rejected() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        fixture.write("target-a.rs", "first target contents\n");
        fixture.write("target-b.rs", "second target contents\n");
        symlink("target-a.rs", fixture.root.join("link.rs")).unwrap();
        fixture.commit("Tracked link");
        fs::remove_file(fixture.root.join("link.rs")).unwrap();
        symlink("target-b.rs", fixture.root.join("link.rs")).unwrap();
        let repository = fixture.repository();
        let diff = repository
            .diff(diff_request(DiffScope::Worktree, "link.rs"))
            .unwrap();
        assert_eq!(diff.original.as_deref(), Some("target-a.rs"));
        assert_eq!(diff.modified.as_deref(), Some("target-b.rs"));
        assert!(diff.text.contains("-target-a.rs"));
        assert!(diff.text.contains("+target-b.rs"));
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret"), "outside").unwrap();
        symlink(
            outside.path().join("secret"),
            fixture.root.join("escape.rs"),
        )
        .unwrap();
        assert!(repository.stage(vec!["escape.rs".into()], false).is_err());
        assert_eq!(
            fs::read_to_string(outside.path().join("secret")).unwrap(),
            "outside"
        );
    }

    #[cfg(unix)]
    #[test]
    fn explicit_commits_honor_hooks_and_replaced_workspace_roots_are_rejected() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        fixture.write("file.rs", "content\n");
        let repository = fixture.repository();
        let staged = repository.stage(vec!["file.rs".into()], false).unwrap();
        let hook = fixture.root.join(".git/hooks/pre-commit");
        fs::write(
            &hook,
            "#!/bin/sh\nprintf 'hook stopped commit' >&2\nexit 1\n",
        )
        .unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
        let error = repository
            .create_commit("Hook".into(), staged.head, staged.index_version)
            .unwrap_err();
        assert!(error.contains("hook stopped commit"));
        assert!(repository.status().unwrap().status.head.is_none());
        let moved = fixture.root.with_extension("moved");
        fs::rename(&fixture.root, &moved).unwrap();
        fs::create_dir(&fixture.root).unwrap();
        assert!(Repository::discover(fixture.workspace.snapshot().unwrap()).is_err());
        fs::remove_dir(&fixture.root).unwrap();
        fs::rename(moved, &fixture.root).unwrap();
    }
}
