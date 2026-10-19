use ejm_ide_lib::workspace::WorkspaceState;
use std::fs;

#[test]
fn workspace_trust_requires_the_current_root_and_expires_on_every_open() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let first_root = first.path().canonicalize().unwrap();
    let second_root = second.path().canonicalize().unwrap();
    let workspace = WorkspaceState::default();
    assert!(workspace.trusted_root_path().is_err());
    assert!(workspace.trust(&first_root).is_err());

    let opened = workspace.open_folder(&first_root).unwrap();
    assert!(!opened.trusted);
    assert!(workspace.trusted_root_path().is_err());
    let path = first_root.join("editable.rs");
    let document = workspace.create_document(&path, "before").unwrap();
    workspace
        .save_document(&path, "after", &document.version)
        .unwrap();
    assert_eq!(workspace.read_document(&path).unwrap().content, "after");
    assert!(workspace.trust(&second_root).is_err());
    assert!(workspace.trusted_root_path().is_err());

    workspace.trust(&first_root).unwrap();
    assert_eq!(workspace.trusted_root_path().unwrap(), first_root);
    assert!(!workspace.open_folder(&second_root).unwrap().trusted);
    assert!(workspace.trust(&first_root).is_err());
    assert!(workspace.trusted_root_path().is_err());
    workspace.trust(&second_root).unwrap();
    assert!(!workspace.open_folder(&second_root).unwrap().trusted);
    assert!(workspace.trusted_root_path().is_err());
}

#[cfg(unix)]
#[test]
fn workspace_trust_uses_the_selected_canonical_root() {
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().join("project");
    let alias = parent.path().join("alias");
    fs::create_dir(&root).unwrap();
    std::os::unix::fs::symlink(&root, &alias).unwrap();
    let workspace = WorkspaceState::default();
    let opened = workspace.open_folder(&alias).unwrap();
    assert_eq!(opened.root, root.canonicalize().unwrap().to_string_lossy());
    assert!(workspace.trust(&alias).is_err());
    workspace.trust(std::path::Path::new(&opened.root)).unwrap();
    assert_eq!(
        workspace.trusted_root_path().unwrap(),
        root.canonicalize().unwrap()
    );
}

#[test]
fn new_files_publish_complete_text_without_overwriting_existing_files() {
    let folder = tempfile::tempdir().unwrap();
    let root = folder.path().canonicalize().unwrap();
    let workspace = WorkspaceState::default();
    workspace.open_folder(&root).unwrap();
    let path = root.join("created.rs");
    let document = workspace.create_document(&path, "fn main() {}\n").unwrap();
    assert_eq!(
        workspace.read_document(&path).unwrap().version,
        document.version
    );
    assert!(workspace.create_document(&path, "overwrite").is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "fn main() {}\n");
    assert!(
        workspace
            .create_document(&root.join("../escape.rs"), "escape")
            .is_err()
    );
    assert!(
        workspace
            .create_document(&root.join("binary.rs"), "\0")
            .is_err()
    );
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
}

#[test]
fn concurrent_new_file_creation_has_one_winner() {
    use std::sync::{Arc, Barrier};
    let folder = tempfile::tempdir().unwrap();
    let root = folder.path().canonicalize().unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = ["first", "second"]
        .into_iter()
        .map(|content| {
            let root = root.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let workspace = WorkspaceState::default();
                workspace.open_folder(&root).unwrap();
                barrier.wait();
                workspace.create_document(&root.join("shared.rs"), content)
            })
        })
        .collect();
    let results: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    let saved = fs::read_to_string(root.join("shared.rs")).unwrap();
    assert!(saved == "first" || saved == "second");
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
}

#[test]
fn saves_preserve_permissions_and_reject_external_changes() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().canonicalize().unwrap().join("script.py");
    fs::write(&path, "print('before')\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o750)).unwrap();
    }
    let workspace = WorkspaceState::default();
    workspace.open_folder(folder.path()).unwrap();
    let opened = workspace.read_document(&path).unwrap();
    let saved = workspace
        .save_document(&path, "print('after')\n", &opened.version)
        .unwrap();
    assert_ne!(saved.version, opened.version);
    assert_eq!(fs::read_to_string(&path).unwrap(), saved.content);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o750
        );
    }
    fs::write(&path, "print('external edit')\n").unwrap();
    assert!(
        workspace
            .save_document(&path, "print('overwrite')\n", &saved.version)
            .is_err()
    );
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "print('external edit')\n"
    );
    assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 1);
}

#[test]
fn rejects_traversal_oversized_and_binary_files() {
    let folder = tempfile::tempdir().unwrap();
    let workspace = WorkspaceState::default();
    workspace.open_folder(folder.path()).unwrap();
    let folder_path = folder.path().canonicalize().unwrap();
    let oversized = folder_path.join("huge.rs");
    fs::File::create(&oversized)
        .unwrap()
        .set_len(2 * 1024 * 1024 + 1)
        .unwrap();
    assert!(workspace.read_document(&oversized).is_err());
    let binary = folder_path.join("binary.rs");
    fs::write(&binary, [0xff, 0, 1]).unwrap();
    assert!(workspace.read_document(&binary).is_err());
    assert!(workspace.validate_path("relative.rs", false).is_err());
    assert!(
        workspace
            .read_document(&folder_path.join("../escape.rs"))
            .is_err()
    );
    assert!(workspace.validate_path("/etc/passwd", false).is_err());
}

#[cfg(unix)]
#[test]
fn symbolic_links_cannot_read_or_modify_files_outside_the_workspace() {
    use std::os::unix::fs::symlink;
    let base = tempfile::tempdir().unwrap();
    let base_path = base.path().canonicalize().unwrap();
    let root = base_path.join("workspace");
    let outside = base_path.join("outside");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret.rs"), "outside data").unwrap();
    symlink(outside.join("secret.rs"), root.join("link.rs")).unwrap();
    symlink(&outside, root.join("linked-directory")).unwrap();
    let workspace = WorkspaceState::default();
    workspace.open_folder(&root).unwrap();
    assert!(
        workspace
            .create_document(&root.join("link.rs"), "overwrite")
            .is_err()
    );
    assert!(
        workspace
            .create_document(&root.join("linked-directory/created.rs"), "outside")
            .is_err()
    );
    assert!(!outside.join("created.rs").exists());
    assert!(workspace.read_document(&root.join("link.rs")).is_err());
    assert!(
        workspace
            .save_document(&root.join("link.rs"), "overwrite", "any-version")
            .is_err()
    );
    assert!(
        workspace
            .read_document(&root.join("linked-directory/secret.rs"))
            .is_err()
    );
    assert!(
        workspace
            .save_document(
                &root.join("linked-directory/secret.rs"),
                "overwrite",
                "any-version"
            )
            .is_err()
    );
    assert_eq!(
        fs::read_to_string(outside.join("secret.rs")).unwrap(),
        "outside data"
    );
}

#[cfg(unix)]
#[test]
fn replacing_the_workspace_path_does_not_redirect_an_atomic_save() {
    use std::os::unix::fs::symlink;
    let base = tempfile::tempdir().unwrap();
    let base_path = base.path().canonicalize().unwrap();
    let root = base_path.join("workspace");
    let moved = base_path.join("moved-workspace");
    let outside = base_path.join("outside");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(root.join("file.rs"), "original").unwrap();
    fs::write(outside.join("file.rs"), "outside").unwrap();
    let workspace = WorkspaceState::default();
    workspace.open_folder(&root).unwrap();
    let opened = workspace.read_document(&root.join("file.rs")).unwrap();
    fs::rename(&root, &moved).unwrap();
    symlink(&outside, &root).unwrap();
    workspace
        .save_document(&root.join("file.rs"), "saved safely", &opened.version)
        .unwrap();
    assert_eq!(
        fs::read_to_string(moved.join("file.rs")).unwrap(),
        "saved safely"
    );
    assert_eq!(
        fs::read_to_string(outside.join("file.rs")).unwrap(),
        "outside"
    );
}
