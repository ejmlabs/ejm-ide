mod agent;
mod agent_store;
mod agent_tools;
mod extensions;
mod git;
mod harness;
mod index;
pub mod language;
pub mod lsp;
mod providers;
mod quality;
mod terminal;
pub mod workspace;

use std::sync::Mutex;
use tauri::{AppHandle, Manager, RunEvent, State, WebviewWindow, WindowEvent, ipc::Channel};
use tauri_plugin_opener::OpenerExt;

const QUIT_MENU_ID: &str = "workbench.quit";

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum CloseKind {
    Window,
    App,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CloseRequest {
    kind: CloseKind,
    request_id: String,
}

#[derive(Default)]
struct CloseState {
    pending: Option<CloseRequest>,
    confirmed: bool,
}

impl CloseState {
    fn request(&mut self, kind: CloseKind) -> Option<CloseRequest> {
        if self.confirmed {
            return None;
        }
        let request = CloseRequest {
            kind,
            request_id: uuid::Uuid::new_v4().to_string(),
        };
        self.pending = Some(request.clone());
        Some(request)
    }

    fn confirm(&mut self, request_id: &str) -> Result<CloseKind, String> {
        let request = self
            .pending
            .as_ref()
            .filter(|request| request.request_id == request_id)
            .ok_or("This close request is no longer pending.")?;
        let kind = request.kind;
        self.pending = None;
        self.confirmed = true;
        Ok(kind)
    }

    fn cancel(&mut self, request_id: &str) -> Result<(), String> {
        if self
            .pending
            .as_ref()
            .is_none_or(|request| request.request_id != request_id)
        {
            return Err("This close request is no longer pending.".into());
        }
        self.pending = None;
        Ok(())
    }
}

#[derive(Default)]
struct CloseGuard(Mutex<CloseState>);

fn close_confirmed(app: &AppHandle) -> bool {
    app.state::<CloseGuard>()
        .0
        .lock()
        .is_ok_and(|state| state.confirmed)
}

fn request_close(app: &AppHandle, kind: CloseKind) {
    let request = app
        .state::<CloseGuard>()
        .0
        .lock()
        .ok()
        .and_then(|mut state| state.request(kind));
    if let Some(request) = request {
        app.state::<NativeEvents>().publish(
            "workbench:close-requested",
            serde_json::to_value(request).expect("close request serialization"),
        );
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
}

fn guarded_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let menu = tauri::menu::Menu::default(app)?;
    #[cfg(target_os = "macos")]
    {
        let items = menu.items()?;
        let app_menu = items
            .first()
            .and_then(|item| item.as_submenu())
            .ok_or_else(|| std::io::Error::other("The application menu is unavailable."))?;
        let items = app_menu.items()?;
        let quit = items
            .last()
            .and_then(|item| item.as_predefined_menuitem())
            .ok_or_else(|| std::io::Error::other("The default Quit item is unavailable."))?;
        let text = quit.text()?;
        if !text.replace('&', "").starts_with("Quit") {
            return Err(std::io::Error::other("The default Quit item changed.").into());
        }
        // The predefined macOS Quit calls terminate: without an ExitRequested event.
        app_menu.remove(quit)?;
        app_menu.append(&tauri::menu::MenuItem::with_id(
            app,
            QUIT_MENU_ID,
            text,
            true,
            Some("CmdOrCtrl+Q"),
        )?)?;
    }
    Ok(menu)
}

#[derive(Clone, serde::Serialize)]
pub struct NativeEvent {
    event: String,
    payload: serde_json::Value,
}

#[derive(Default)]
pub struct NativeEvents(Mutex<Option<Channel<NativeEvent>>>);

impl NativeEvents {
    pub fn publish(&self, event: &str, payload: serde_json::Value) {
        if let Ok(channel) = self.0.lock()
            && let Some(channel) = channel.as_ref()
        {
            let _ = channel.send(NativeEvent {
                event: event.into(),
                payload,
            });
        }
    }
}

#[tauri::command]
fn host_subscribe(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    events: State<'_, NativeEvents>,
    auth: String,
    channel: Channel<NativeEvent>,
) -> Result<(), String> {
    host.check(&window, &auth)?;
    *events
        .0
        .lock()
        .map_err(|_| "Desktop events are unavailable")? = Some(channel);
    Ok(())
}

#[tauri::command]
fn host_confirm_close(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    close: State<'_, CloseGuard>,
    auth: String,
    request_id: String,
) -> Result<(), String> {
    host.check(&window, &auth)?;
    let kind = close
        .0
        .lock()
        .map_err(|_| "Close protection is unavailable.")?
        .confirm(&request_id)?;
    match kind {
        CloseKind::Window => {
            if let Err(error) = window.close() {
                if let Ok(mut state) = close.0.lock() {
                    state.confirmed = false;
                }
                return Err(format!("Cannot close the window: {error}"));
            }
        }
        CloseKind::App => app.exit(0),
    }
    Ok(())
}

#[tauri::command]
fn host_cancel_close(
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    close: State<'_, CloseGuard>,
    auth: String,
    request_id: String,
) -> Result<(), String> {
    host.check(&window, &auth)?;
    close
        .0
        .lock()
        .map_err(|_| "Close protection is unavailable.")?
        .cancel(&request_id)
}

fn external_url(value: &str) -> Result<url::Url, String> {
    if value.len() > 8192 || value.chars().any(char::is_control) {
        return Err("This external link is invalid or too long.".into());
    }
    let parsed = url::Url::parse(value).map_err(|_| "This external link is invalid.")?;
    match parsed.scheme() {
        "http" | "https" if parsed.host_str().is_some() => Ok(parsed),
        "mailto" if !parsed.path().is_empty() => Ok(parsed),
        _ => Err("External links must use http, https, or mailto.".into()),
    }
}

#[tauri::command]
async fn host_open_external(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, HostAccessState>,
    auth: String,
    url: String,
) -> Result<(), String> {
    host.check(&window, &auth)?;
    let url = external_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        app.opener()
            .open_url(url.as_str(), None::<&str>)
            .map_err(|error| format!("Cannot open this external link: {error}"))
    })
    .await
    .map_err(|error| format!("Cannot open this external link: {error}"))?
}

pub struct HostAccessState(String);

impl HostAccessState {
    pub fn check(&self, window: &WebviewWindow, auth: &str) -> Result<(), String> {
        if window.label() != "main" || auth != self.0 {
            return Err(
                "This desktop operation is only available to the main ejm-ide interface.".into(),
            );
        }
        Ok(())
    }
}

pub fn run() {
    let token = uuid::Uuid::new_v4().to_string();
    let script = format!(
        "if (window.top === window) {{ const token = {}; Object.defineProperty(window, '__WORKBENCH_INVOKE__', {{ value: (command, args = {{}}) => window.__TAURI_INTERNALS__.invoke(command, {{...args, auth: token}}), writable: false, configurable: false }}); }}",
        serde_json::to_string(&token).unwrap()
    );
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .register_uri_scheme_protocol("workbench-extension", |context, request| {
            extensions::serve_panel(context.app_handle(), request)
        })
        .manage(HostAccessState(token))
        .manage(NativeEvents::default())
        .manage(CloseGuard::default())
        .manage(workspace::WorkspaceState::default())
        .manage(git::GitState::default())
        .manage(language::LanguageState::default())
        .manage(quality::QualityState::default())
        .manage(index::IndexState::default())
        .manage(harness::HarnessState::default())
        .manage(providers::ProviderState::default())
        .manage(providers::auth::ProviderAuthState::default())
        .manage(agent::AgentState::default())
        .manage(agent_tools::AgentToolState::default())
        .manage(extensions::ExtensionState::default())
        .menu(guarded_menu)
        .on_menu_event(|app, event| {
            if event.id() == QUIT_MENU_ID {
                request_close(app, CloseKind::App);
            }
        })
        .setup(move |app| {
            let config = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .expect("main window config");
            tauri::WebviewWindowBuilder::from_config(app, &config)?
                .initialization_script(&script)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            host_subscribe,
            host_confirm_close,
            host_cancel_close,
            host_open_external,
            workspace::workspace_open,
            workspace::workspace_current,
            workspace::workspace_entries,
            workspace::workspace_read,
            workspace::workspace_save,
            workspace::workspace_create,
            workspace::workspace_search,
            workspace::workspace_changes,
            workspace::workspace_diff,
            git::git_status,
            git::git_refs,
            git::git_history,
            git::git_commit_detail,
            git::git_diff,
            git::git_compare,
            git::git_blame,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            terminal::terminal_run,
            language::language_open,
            language::language_change,
            language::language_save,
            language::language_request,
            language::language_cancel,
            language::language_close,
            quality::quality_format,
            quality::quality_lint,
            index::index_status,
            index::index_refresh,
            index::index_search,
            index::index_neighbors,
            index::traversal::index_traverse,
            index::traversal::index_symbol_at,
            index::source_versions::index_source_versions,
            index::index_record_graph,
            harness::harness_snapshot,
            harness::harness_clear,
            harness::harness_event_detail,
            harness::harness_diagnostics,
            providers::profiles::provider_list,
            providers::profiles::provider_save,
            providers::profiles::provider_remove,
            providers::auth::provider_auth_status,
            providers::auth::provider_auth_start,
            providers::auth::provider_auth_cancel,
            providers::auth::provider_auth_logout,
            agent::agent_connect,
            agent::agent_send,
            agent::agent_cancel,
            agent::agent_ide_ack,
            agent::agent_new_chat,
            agent::agent_list_chats,
            agent::agent_open_chat,
            agent::agent_chat_turns,
            agent::agent_rename_chat,
            agent::agent_archive_chat,
            agent::agent_complete,
            agent::agent_complete_cancel,
            extensions::extensions_list,
            extensions::extensions_scaffold,
            extensions::extensions_build,
            extensions::extensions_panel,
            extensions::extensions_activate,
            extensions::extensions_disable,
            extensions::extensions_revert,
            extensions::extensions_mount,
            extensions::extensions_unmount,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build ejm-ide")
        .run(|app, event| match event {
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } if label == "main" && !close_confirmed(app) => {
                api.prevent_close();
                request_close(app, CloseKind::Window);
            }
            RunEvent::ExitRequested { api, .. } if !close_confirmed(app) => {
                api.prevent_exit();
                request_close(app, CloseKind::App);
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_links_accept_web_and_mail_schemes_without_commands_or_controls() {
        for value in [
            "https://example.test/path?q=hello#section",
            "http://localhost:3000/docs",
            "mailto:team@example.test?subject=ejm-ide",
        ] {
            assert!(external_url(value).is_ok(), "{value}");
        }
        for value in [
            "javascript:alert(1)",
            "data:text/html,content",
            "file:///etc/passwd",
            "ftp://example.test/file",
            "relative.md",
            "https://",
            "mailto:",
            "https://example.test/\nopen",
            "https://example.test/\0",
        ] {
            assert!(external_url(value).is_err(), "{value:?}");
        }
        assert!(external_url(&format!("https://example.test/{}", "x".repeat(8192))).is_err());
    }

    #[test]
    fn close_confirmation_requires_the_current_request_and_cannot_be_replayed() {
        let mut state = CloseState::default();
        assert!(state.confirm("unsolicited").is_err());
        assert!(!state.confirmed);

        let window = state.request(CloseKind::Window).unwrap();
        let app = state.request(CloseKind::App).unwrap();
        assert_ne!(window.request_id, app.request_id);
        assert!(state.confirm(&window.request_id).is_err());
        assert!(!state.confirmed);
        assert_eq!(state.confirm(&app.request_id).unwrap(), CloseKind::App);
        assert!(state.confirmed);
        assert!(state.confirm(&app.request_id).is_err());
        assert!(state.request(CloseKind::Window).is_none());
    }

    #[test]
    fn declining_a_window_close_keeps_protection_and_the_next_request_has_a_new_token() {
        let mut state = CloseState::default();
        let declined = state.request(CloseKind::Window).unwrap();
        state.cancel(&declined.request_id).unwrap();
        assert!(!state.confirmed);
        assert!(state.confirm(&declined.request_id).is_err());
        let next = state.request(CloseKind::Window).unwrap();
        assert!(state.cancel(&declined.request_id).is_err());
        assert!(state.confirm(&declined.request_id).is_err());
        assert_eq!(state.confirm(&next.request_id).unwrap(), CloseKind::Window);
        assert_eq!(
            serde_json::to_value(&next).unwrap(),
            serde_json::json!({"kind": "window", "requestId": next.request_id}),
        );
    }
}
