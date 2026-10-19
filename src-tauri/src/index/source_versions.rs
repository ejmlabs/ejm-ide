use super::*;
use std::path::Component;

impl IndexState {
    fn saved_source_versions(
        &self,
        snapshot: &WorkspaceRoot,
        cache: &Path,
    ) -> Result<HashMap<String, String>, String> {
        let handle = self.handle(&snapshot.path, cache)?;
        let connection = connect(&handle.database, false)?;
        let mut statement = connection
            .prepare("SELECT path,version FROM files ORDER BY path LIMIT ?1")
            .map_err(error)?;
        let rows = statement
            .query_map([(FILE_COUNT_LIMIT + 1) as u32], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(error)?;
        let mut versions = HashMap::new();
        for row in rows {
            let (relative, version) = row.map_err(error)?;
            let relative = Path::new(&relative);
            if relative.as_os_str().is_empty()
                || !relative
                    .components()
                    .all(|part| matches!(part, Component::Normal(_)))
            {
                return Err(error("saved source version has an invalid workspace path"));
            }
            if versions.len() >= FILE_COUNT_LIMIT {
                return Err(error(
                    "saved source versions exceed the 10,000-file index limit",
                ));
            }
            versions.insert(
                path_to_uri(&snapshot.path.join(relative)).map_err(error)?,
                version,
            );
        }
        Ok(versions)
    }
}

#[tauri::command]
pub async fn index_source_versions(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    workspace: State<'_, WorkspaceState>,
    index: State<'_, IndexState>,
    auth: String,
) -> Result<HashMap<String, String>, String> {
    host.check(&window, &auth)?;
    let snapshot = workspace.snapshot()?;
    let root = snapshot.path.clone();
    let cache = cache_dir(&app)?;
    let index = index.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let status = index.status(&snapshot.path, &cache)?;
        let status = if status.state == "idle" || status.stale {
            index.refresh(&snapshot, &cache)?
        } else {
            status
        };
        if status.state != "ready" {
            return Err(status.last_error.unwrap_or_else(|| {
                error("saved source versions are still updating; retry when indexing finishes")
            }));
        }
        index.saved_source_versions(&snapshot, &cache)
    })
    .await
    .map_err(error)??;
    check_workspace(&workspace, &root)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_versions_cover_unopened_internal_files_and_exclude_external_paths() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("workspace");
        fs::create_dir_all(root.join("src/a folder")).unwrap();
        let sources = [
            ("src/lib.rs", "fn root() { helper(); }\n"),
            ("src/a folder/🦀.rs", "fn helper() {}\n"),
            ("README.md", "# Source versions\n"),
        ];
        for (relative, source) in sources {
            fs::write(root.join(relative), source).unwrap();
        }
        fs::write(directory.path().join("external.rs"), "fn external() {}\n").unwrap();
        let workspace = WorkspaceState::default();
        workspace.open_folder(&root).unwrap();
        let snapshot = workspace.snapshot().unwrap();
        let cache = directory.path().join("cache");
        let index = IndexState::default();
        assert_eq!(index.refresh(&snapshot, &cache).unwrap().state, "ready");
        let versions = index.saved_source_versions(&snapshot, &cache).unwrap();
        assert_eq!(versions.len(), sources.len());
        for (relative, _) in sources {
            let path = snapshot.path.join(relative);
            assert_eq!(
                versions.get(&path_to_uri(&path).unwrap()),
                Some(&snapshot.read_document(&path).unwrap().version),
            );
        }
        assert!(
            versions
                .keys()
                .all(|uri| uri_to_path(uri).unwrap().starts_with(&snapshot.path))
        );
        fs::write(snapshot.path.join("src/lib.rs"), "fn root() {}\n").unwrap();
        assert_eq!(
            index.saved_source_versions(&snapshot, &cache).unwrap(),
            versions
        );

        let handle = index.handle(&snapshot.path, &cache).unwrap();
        let connection = connect(&handle.database, true).unwrap();
        connection
            .execute(
                "INSERT INTO files(path,version,bytes) VALUES('../external.rs','untrusted',0)",
                [],
            )
            .unwrap();
        assert!(index.saved_source_versions(&snapshot, &cache).is_err());
    }
}
