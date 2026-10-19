//! Native browser and loopback adapters for the shared ChatGPT auth engine.

use crate::{HostAccessState, NativeEvents};
use axum::{
    Router,
    extract::State as AxumState,
    http::{HeaderMap, Method, StatusCode, Uri, header::HOST},
    response::{IntoResponse, Response},
};
use ejm_harness_auth::{
    AuthConfig, AuthEngine, CredentialSource, FileStore, LoginAttempt, LogoutResult,
    RegistrationStatus, RetryRequired, SecretString,
};
use serde::Serialize;
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;
use tokio::{net::TcpListener, sync::OnceCell, sync::mpsc, time::Instant};
use tokio_util::sync::CancellationToken;
use url::Url;

const FLOW_LIFETIME: Duration = Duration::from_secs(10 * 60);
const CALLBACK_LIMIT: usize = 16 * 1024;
const CALLBACK_PATH: &str = "/auth/callback";

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Starting,
    Waiting,
    Completing,
    Retrying,
    Succeeded,
    Cancelled,
    Expired,
    Failed,
}

impl Phase {
    fn terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Cancelled | Self::Expired | Self::Failed
        )
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthFlow {
    flow_id: String,
    phase: Phase,
    /// Unix seconds. The host bounds the full flow, including its one retry.
    expires_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct AuthStatus {
    registrations: Vec<RegistrationStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    flow: Option<AuthFlow>,
}

// This private binding never enters IPC, events, traces, or provider configuration.
struct CallbackBinding {
    redirect: Url,
    host: String,
    state: SecretString,
}

struct LoginFlow {
    view: Mutex<AuthFlow>,
    registration_id: Option<String>,
    attempt_id: Mutex<Option<String>>,
    binding: Mutex<Option<CallbackBinding>>,
    cancel: CancellationToken,
    stop_listener: CancellationToken,
}

impl LoginFlow {
    fn new(registration_id: Option<String>) -> Self {
        Self {
            view: Mutex::new(AuthFlow {
                flow_id: uuid::Uuid::new_v4().to_string(),
                phase: Phase::Starting,
                expires_at: timestamp().saturating_add(FLOW_LIFETIME.as_secs()),
                error: None,
            }),
            registration_id,
            attempt_id: Mutex::new(None),
            binding: Mutex::new(None),
            cancel: CancellationToken::new(),
            stop_listener: CancellationToken::new(),
        }
    }

    fn snapshot(&self) -> AuthFlow {
        self.view
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn update(&self, phase: Phase, error: Option<&str>) -> bool {
        let mut view = self
            .view
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if view.phase.terminal() {
            return false;
        }
        view.phase = phase;
        view.error = error.map(str::to_owned);
        true
    }

    fn install(&self, attempt: &LoginAttempt, redirect: &str) -> Result<(), String> {
        *self
            .attempt_id
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(attempt.id.clone());
        if self.cancel.is_cancelled() || attempt.redirect_uri != redirect {
            return Err("ChatGPT sign-in was cancelled. Start sign-in again.".into());
        }
        let authorization = Url::parse(attempt.authorization_url.expose_secret())
            .map_err(|_| "ChatGPT sign-in could not be prepared.")?;
        let mut states = authorization
            .query_pairs()
            .filter(|(key, _)| key == "state");
        let state = states
            .next()
            .filter(|(_, value)| !value.is_empty())
            .map(|(_, value)| SecretString::new(value.into_owned()))
            .ok_or("ChatGPT sign-in could not be prepared.")?;
        if states.next().is_some() {
            return Err("ChatGPT sign-in could not be prepared.".into());
        }
        let redirect = Url::parse(redirect).map_err(|_| "The sign-in callback is unavailable.")?;
        let host = format!(
            "127.0.0.1:{}",
            redirect
                .port()
                .ok_or("The sign-in callback is unavailable.")?
        );
        *self
            .binding
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(CallbackBinding {
            redirect,
            host,
            state,
        });
        let mut view = self
            .view
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        view.expires_at = view.expires_at.min(attempt.expires_at);
        Ok(())
    }

    fn stop(&self, engine: Option<&AuthEngine>) {
        self.update(Phase::Cancelled, None);
        self.cancel.cancel();
        self.stop_listener.cancel();
        self.binding
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(engine) = engine
            && let Some(id) = self
                .attempt_id
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take()
        {
            let _ = engine.cancel(&id);
        }
    }
}

#[derive(Default)]
pub(crate) struct ProviderAuthState {
    engine: OnceCell<AuthEngine>,
    flow: Mutex<Option<Arc<LoginFlow>>>,
}

impl ProviderAuthState {
    fn claim(&self, flow: Arc<LoginFlow>) -> Result<(), String> {
        let mut current = self
            .flow
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if current
            .as_ref()
            .is_some_and(|current| !current.snapshot().phase.terminal())
        {
            return Err("A ChatGPT sign-in is already in progress.".into());
        }
        *current = Some(flow);
        Ok(())
    }

    fn cancel(&self, flow_id: &str) -> Result<Arc<LoginFlow>, String> {
        let current = self
            .flow
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .filter(|flow| flow.snapshot().flow_id == flow_id)
            .ok_or("This ChatGPT sign-in is no longer current.")?;
        if !current.update(Phase::Cancelled, None) && current.snapshot().phase != Phase::Cancelled {
            return Err("This ChatGPT sign-in has already finished.".into());
        }
        current.stop(self.engine.get());
        Ok(current)
    }
}

fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

async fn engine(app: &AppHandle) -> Result<AuthEngine, String> {
    let state = app.state::<ProviderAuthState>();
    state
        .engine
        .get_or_try_init(|| async {
            let directory = app
                .path()
                .app_data_dir()
                .map_err(|_| "The application data folder is unavailable.")?
                .join("auth/chatgpt");
            let store = tauri::async_runtime::spawn_blocking(move || FileStore::open(directory))
                .await
                .map_err(|_| "ChatGPT account storage is unavailable.")?
                .map_err(|_| "ChatGPT account storage could not be opened.")?;
            AuthEngine::new(
                AuthConfig {
                    agent_name: "ejm-ide".into(),
                },
                Arc::new(store),
            )
            .map_err(|_| "ChatGPT sign-in could not be initialized.".to_owned())
        })
        .await
        .cloned()
}

fn check_registration_id(registration_id: &str) -> Result<(), String> {
    if !super::profiles::valid_id(registration_id) {
        return Err("Choose a valid ChatGPT account registration.".into());
    }
    Ok(())
}

pub(crate) async fn credential_source(
    app: &AppHandle,
    registration_id: &str,
) -> Result<Arc<dyn CredentialSource>, String> {
    check_registration_id(registration_id)?;
    let engine = engine(app).await?;
    let status = engine
        .status(registration_id, CancellationToken::new())
        .await
        .map_err(|_| "This ChatGPT account is unavailable. Sign in again.")?;
    validate_registration(&status, registration_id)?;
    Ok(engine.source(registration_id))
}

fn validate_registration(status: &RegistrationStatus, registration_id: &str) -> Result<(), String> {
    if status.id != registration_id
        || status.issuer != "https://auth.openai.com"
        || status.subject.is_empty()
        || status.client_id.is_empty()
        || !status.signed_in
    {
        return Err("This ChatGPT account is signed out. Sign in again.".into());
    }
    if !status.plan_enabled {
        return Err("This ChatGPT account has not granted subscription model access. Sign in again and allow model access.".into());
    }
    Ok(())
}

async fn status(app: &AppHandle) -> Result<AuthStatus, String> {
    let engine = engine(app).await?;
    let registrations = engine
        .registrations(CancellationToken::new())
        .await
        .map_err(|_| "ChatGPT account status could not be read.")?;
    let flow = app
        .state::<ProviderAuthState>()
        .flow
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .map(|flow| flow.snapshot());
    Ok(AuthStatus {
        registrations,
        flow,
    })
}

async fn publish_status(app: &AppHandle) {
    if let Ok(status) = status(app).await
        && let Ok(value) = serde_json::to_value(status)
    {
        app.state::<NativeEvents>().publish("provider:auth", value);
    }
}

async fn phase(app: &AppHandle, flow: &LoginFlow, phase: Phase, error: Option<&str>) {
    if flow.update(phase, error) {
        publish_status(app).await;
    }
}

// Check routing and state before the engine consumes its one-use attempt.
fn filtered_callback(
    binding: &CallbackBinding,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
) -> Option<SecretString> {
    if method != Method::GET
        || uri.scheme().is_some()
        || uri.authority().is_some()
        || uri.path() != CALLBACK_PATH
        || uri.to_string().len() > CALLBACK_LIMIT
        || headers.get_all(HOST).iter().count() != 1
        || headers.get(HOST)?.to_str().ok()? != binding.host
    {
        return None;
    }
    let mut callback = binding.redirect.clone();
    callback.set_query(Some(uri.query()?));
    if callback.as_str().len() > CALLBACK_LIMIT {
        return None;
    }
    let mut names = HashSet::new();
    let mut state = None;
    for (name, value) in callback.query_pairs() {
        if names.len() >= 16 || !names.insert(name.clone().into_owned()) {
            return None;
        }
        if name == "state" {
            state = Some(value);
        }
    }
    if state.as_deref() != Some(binding.state.expose_secret()) {
        return None;
    }
    Some(SecretString::new(callback.to_string()))
}

#[derive(Clone)]
struct CallbackState {
    flow: Arc<LoginFlow>,
    callbacks: mpsc::Sender<SecretString>,
}

fn callback_response(status: StatusCode, message: &'static str) -> Response {
    (
        status,
        [
            ("cache-control", "no-store"),
            ("referrer-policy", "no-referrer"),
            ("x-content-type-options", "nosniff"),
            (
                "content-security-policy",
                "default-src 'none'; frame-ancestors 'none'",
            ),
        ],
        message,
    )
        .into_response()
}

async fn receive_callback(
    AxumState(state): AxumState<CallbackState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    if state.flow.cancel.is_cancelled() {
        return callback_response(StatusCode::GONE, "This sign-in is no longer active.");
    }
    let mut binding = state
        .flow
        .binding
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(current) = binding.as_ref() else {
        return callback_response(
            StatusCode::CONFLICT,
            "This sign-in callback is not pending.",
        );
    };
    let Some(callback) = filtered_callback(current, &method, &uri, &headers) else {
        return callback_response(
            StatusCode::BAD_REQUEST,
            "This sign-in callback was not accepted.",
        );
    };
    if state.callbacks.try_send(callback).is_err() {
        return callback_response(
            StatusCode::CONFLICT,
            "This sign-in callback was already received.",
        );
    }
    binding.take();
    callback_response(
        StatusCode::OK,
        "Sign-in received. Return to ejm-ide. You can close this tab.",
    )
}

struct FlowCleanup {
    engine: AuthEngine,
    flow: Arc<LoginFlow>,
    server: tauri::async_runtime::JoinHandle<()>,
}

impl Drop for FlowCleanup {
    fn drop(&mut self) {
        self.flow.stop(Some(&self.engine));
        self.server.abort();
    }
}

async fn open_attempt(
    app: &AppHandle,
    flow: &LoginFlow,
    attempt: &LoginAttempt,
    redirect: &str,
) -> Result<(), String> {
    flow.install(attempt, redirect)?;
    let authorization = attempt.authorization_url.clone();
    let browser_app = app.clone();
    let cancel = flow.cancel.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if cancel.is_cancelled() {
            return Err("ChatGPT sign-in was cancelled.");
        }
        browser_app
            .opener()
            .open_url(authorization.expose_secret(), None::<&str>)
            .map_err(|_| "The sign-in browser could not be opened.")
    })
    .await
    .map_err(|_| "The sign-in browser could not be opened.")??;
    phase(app, flow, Phase::Waiting, None).await;
    Ok(())
}

async fn complete_flow(
    app: &AppHandle,
    engine: &AuthEngine,
    flow: &LoginFlow,
    redirect: &str,
    callbacks: &mut mpsc::Receiver<SecretString>,
) -> Result<(), &'static str> {
    let mut retried = false;
    loop {
        let callback = callbacks
            .recv()
            .await
            .ok_or("The sign-in callback listener closed. Start sign-in again.")?;
        phase(app, flow, Phase::Completing, None).await;
        let attempt_id = flow
            .attempt_id
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .ok_or("ChatGPT sign-in is no longer active.")?;
        match engine
            .complete(&attempt_id, callback.expose_secret(), flow.cancel.clone())
            .await
        {
            Ok(_) => return Ok(()),
            Err(error) => {
                let Some(retry) = error.downcast_ref::<RetryRequired>().filter(|_| !retried) else {
                    return Err(
                        "ChatGPT sign-in was declined or could not be verified. Start sign-in again.",
                    );
                };
                retried = true;
                phase(app, flow, Phase::Retrying, None).await;
                let attempt = engine
                    .retry(&retry.attempt_id, redirect, flow.cancel.clone())
                    .await
                    .map_err(|_| "ChatGPT sign-in could not be retried. Start sign-in again.")?;
                open_attempt(app, flow, &attempt, redirect).await.map_err(
                    |_| "ChatGPT sign-in could not reopen the browser. Start sign-in again.",
                )?;
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn provider_auth_status(
    app: AppHandle,
    window: WebviewWindow,
    auth: String,
    host: State<'_, HostAccessState>,
) -> Result<AuthStatus, String> {
    host.check(&window, &auth)?;
    status(&app).await
}

#[tauri::command]
pub(crate) async fn provider_auth_start(
    app: AppHandle,
    window: WebviewWindow,
    auth: String,
    host: State<'_, HostAccessState>,
    registration_id: Option<String>,
) -> Result<AuthFlow, String> {
    host.check(&window, &auth)?;
    let engine = engine(&app).await?;
    if let Some(id) = &registration_id {
        check_registration_id(id)?;
        engine.status(id, CancellationToken::new()).await.map_err(
            |_| "This ChatGPT account is unavailable. Choose an account or start a new sign-in.",
        )?;
    }
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| "The local sign-in callback listener could not be started.")?;
    let address = listener
        .local_addr()
        .map_err(|_| "The local sign-in callback listener is unavailable.")?;
    let redirect = format!("http://127.0.0.1:{}{CALLBACK_PATH}", address.port());
    let flow = Arc::new(LoginFlow::new(registration_id.clone()));
    app.state::<ProviderAuthState>().claim(flow.clone())?;
    let deadline = Instant::now() + FLOW_LIFETIME;
    let (callbacks, mut received) = mpsc::channel(1);
    let callback_state = CallbackState {
        flow: flow.clone(),
        callbacks,
    };
    let stop = flow.stop_listener.clone();
    let server_flow = flow.clone();
    let server_app = app.clone();
    let server = tauri::async_runtime::spawn(async move {
        let router = Router::new()
            .fallback(receive_callback)
            .with_state(callback_state);
        if axum::serve(listener, router)
            .with_graceful_shutdown(stop.cancelled_owned())
            .await
            .is_err()
        {
            server_flow.update(
                Phase::Failed,
                Some("The local sign-in callback listener stopped. Start sign-in again."),
            );
            server_flow.cancel.cancel();
            publish_status(&server_app).await;
        }
    });
    let cleanup = FlowCleanup {
        engine: engine.clone(),
        flow: flow.clone(),
        server,
    };
    publish_status(&app).await;
    let prepared = async {
        let attempt = engine
            .start(&redirect, registration_id.as_deref(), flow.cancel.clone())
            .await
            .map_err(|_| "ChatGPT sign-in could not be started. Try again.")?;
        open_attempt(&app, &flow, &attempt, &redirect).await
    };
    let prepared = tokio::select! {
        biased;
        () = flow.cancel.cancelled() => Err((Phase::Cancelled, "ChatGPT sign-in was cancelled.".to_owned())),
        () = tokio::time::sleep_until(deadline) => Err((Phase::Expired, "ChatGPT sign-in expired. Start sign-in again.".to_owned())),
        result = prepared => result.map_err(|message| (Phase::Failed, message)),
    };
    if let Err((outcome, message)) = prepared {
        flow.update(
            outcome,
            (outcome != Phase::Cancelled).then_some(message.as_str()),
        );
        drop(cleanup);
        publish_status(&app).await;
        return Err(message);
    }
    let response = flow.snapshot();
    tauri::async_runtime::spawn(async move {
        let outcome = tokio::select! {
            biased;
            () = flow.cancel.cancelled() => (Phase::Cancelled, None),
            () = tokio::time::sleep_until(deadline) => (Phase::Expired, Some("ChatGPT sign-in expired. Start sign-in again.")),
            result = complete_flow(&app, &engine, &flow, &redirect, &mut received) => match result {
                Ok(()) => (Phase::Succeeded, None),
                Err(message) => (Phase::Failed, Some(message)),
            },
        };
        flow.update(outcome.0, outcome.1);
        drop(cleanup);
        publish_status(&app).await;
    });
    Ok(response)
}

#[tauri::command]
pub(crate) async fn provider_auth_cancel(
    app: AppHandle,
    window: WebviewWindow,
    auth: String,
    host: State<'_, HostAccessState>,
    flow_id: String,
) -> Result<(), String> {
    host.check(&window, &auth)?;
    app.state::<ProviderAuthState>().cancel(&flow_id)?;
    publish_status(&app).await;
    Ok(())
}

#[tauri::command]
pub(crate) async fn provider_auth_logout(
    app: AppHandle,
    window: WebviewWindow,
    auth: String,
    host: State<'_, HostAccessState>,
    registration_id: String,
) -> Result<LogoutResult, String> {
    host.check(&window, &auth)?;
    check_registration_id(&registration_id)?;
    let engine = engine(&app).await?;
    let active = app
        .state::<ProviderAuthState>()
        .flow
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    if let Some(flow) = active
        && flow.registration_id.as_deref() == Some(registration_id.as_str())
        && flow.update(Phase::Cancelled, None)
    {
        flow.stop(Some(&engine));
    }
    let result = engine
        .logout(&registration_id, CancellationToken::new())
        .await
        .map_err(|_| {
            "ChatGPT sign-out could not be confirmed. Refresh account status and try again."
                .to_owned()
        });
    publish_status(&app).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding() -> CallbackBinding {
        CallbackBinding {
            redirect: Url::parse("http://127.0.0.1:43210/auth/callback").unwrap(),
            host: "127.0.0.1:43210".into(),
            state: SecretString::new("test-state"),
        }
    }

    fn headers() -> HeaderMap {
        HeaderMap::from_iter([(HOST, "127.0.0.1:43210".parse().unwrap())])
    }

    #[test]
    fn callback_filter_requires_exact_method_host_path_and_one_matching_state() {
        let good: Uri = "/auth/callback?state=test-state&code=fixture"
            .parse()
            .unwrap();
        assert!(filtered_callback(&binding(), &Method::GET, &good, &headers()).is_some());
        for method in [Method::POST, Method::HEAD, Method::OPTIONS] {
            assert!(filtered_callback(&binding(), &method, &good, &headers()).is_none());
        }
        for uri in [
            "/wrong?state=test-state&code=fixture",
            "/auth/callback/?state=test-state&code=fixture",
            "/auth/callback?state=wrong&code=fixture",
            "/auth/callback?code=fixture",
            "/auth/callback?state=test-state&state=test-state&code=fixture",
            "/auth/callback?state=test-state&code=first&code=second",
            "http://127.0.0.1:43210/auth/callback?state=test-state&code=fixture",
        ] {
            assert!(
                filtered_callback(&binding(), &Method::GET, &uri.parse().unwrap(), &headers())
                    .is_none(),
                "{uri}"
            );
        }
        for host in ["localhost:43210", "127.0.0.1:43211", "example.test:43210"] {
            let mut headers = headers();
            headers.insert(HOST, host.parse().unwrap());
            assert!(filtered_callback(&binding(), &Method::GET, &good, &headers).is_none());
        }
        let mut duplicate = headers();
        duplicate.append(HOST, "127.0.0.1:43210".parse().unwrap());
        assert!(filtered_callback(&binding(), &Method::GET, &good, &duplicate).is_none());
        let oversized: Uri = format!(
            "/auth/callback?state=test-state&code={}",
            "x".repeat(CALLBACK_LIMIT)
        )
        .parse()
        .unwrap();
        assert!(filtered_callback(&binding(), &Method::GET, &oversized, &headers()).is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn invalid_callbacks_do_not_consume_the_attempt_and_valid_callbacks_are_one_use() {
        let flow = Arc::new(LoginFlow::new(None));
        *flow.binding.lock().unwrap() = Some(binding());
        let (callbacks, mut received) = mpsc::channel(1);
        let state = CallbackState { flow, callbacks };
        let rejected = receive_callback(
            AxumState(state.clone()),
            Method::GET,
            "/auth/callback?state=wrong&code=fixture".parse().unwrap(),
            headers(),
        )
        .await;
        assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
        assert!(state.flow.binding.lock().unwrap().is_some());
        let accepted = receive_callback(
            AxumState(state.clone()),
            Method::GET,
            "/auth/callback?state=test-state&code=fixture"
                .parse()
                .unwrap(),
            headers(),
        )
        .await;
        assert_eq!(accepted.status(), StatusCode::OK);
        assert!(received.try_recv().is_ok());
        let duplicate = receive_callback(
            AxumState(state),
            Method::GET,
            "/auth/callback?state=test-state&code=fixture"
                .parse()
                .unwrap(),
            headers(),
        )
        .await;
        assert_eq!(duplicate.status(), StatusCode::CONFLICT);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancelled_callbacks_are_rejected_without_queuing() {
        let flow = Arc::new(LoginFlow::new(None));
        *flow.binding.lock().unwrap() = Some(binding());
        flow.cancel.cancel();
        let (callbacks, mut received) = mpsc::channel(1);
        let response = receive_callback(
            AxumState(CallbackState { flow, callbacks }),
            Method::GET,
            "/auth/callback?state=test-state&code=fixture"
                .parse()
                .unwrap(),
            headers(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::GONE);
        assert!(received.try_recv().is_err());
    }

    #[test]
    fn credential_binding_requires_the_selected_account_and_subscription_grant() {
        let status = RegistrationStatus {
            id: "registration-id".into(),
            issuer: "https://auth.openai.com".into(),
            subject: "fixture-subject".into(),
            client_id: "fixture-client".into(),
            email: None,
            signed_in: true,
            plan_enabled: true,
            expires_at: None,
        };
        assert!(validate_registration(&status, "registration-id").is_ok());
        assert!(validate_registration(&status, "another-registration").is_err());
        for invalid in [
            RegistrationStatus {
                issuer: "https://other.example.test".into(),
                ..status.clone()
            },
            RegistrationStatus {
                subject: String::new(),
                ..status.clone()
            },
            RegistrationStatus {
                client_id: String::new(),
                ..status.clone()
            },
            RegistrationStatus {
                signed_in: false,
                ..status.clone()
            },
            RegistrationStatus {
                plan_enabled: false,
                ..status.clone()
            },
        ] {
            assert!(validate_registration(&invalid, "registration-id").is_err());
        }
    }

    #[test]
    fn cancellation_stops_only_the_current_flow_and_cannot_overwrite_a_terminal_result() {
        let state = ProviderAuthState::default();
        let first = Arc::new(LoginFlow::new(None));
        state.claim(first.clone()).unwrap();
        assert!(state.cancel("foreign-flow").is_err());
        assert!(!first.cancel.is_cancelled());
        let second = Arc::new(LoginFlow::new(None));
        assert!(state.claim(second.clone()).is_err());
        state.cancel(&first.snapshot().flow_id).unwrap();
        assert!(first.cancel.is_cancelled());
        assert!(first.stop_listener.is_cancelled());
        assert!(!first.update(Phase::Succeeded, None));
        state.claim(second.clone()).unwrap();
        assert!(state.cancel(&first.snapshot().flow_id).is_err());
        assert!(!second.cancel.is_cancelled());
    }

    #[test]
    fn stopping_an_abandoned_flow_releases_its_claim_and_preserves_finished_outcomes() {
        let state = ProviderAuthState::default();
        let abandoned = Arc::new(LoginFlow::new(None));
        *abandoned.binding.lock().unwrap() = Some(binding());
        state.claim(abandoned.clone()).unwrap();
        abandoned.stop(None);
        assert!(matches!(abandoned.snapshot().phase, Phase::Cancelled));
        assert!(abandoned.cancel.is_cancelled());
        assert!(abandoned.stop_listener.is_cancelled());
        assert!(abandoned.binding.lock().unwrap().is_none());
        state.claim(Arc::new(LoginFlow::new(None))).unwrap();

        for outcome in [Phase::Succeeded, Phase::Failed, Phase::Expired] {
            let finished = LoginFlow::new(None);
            finished.update(outcome, Some("fixture outcome"));
            finished.stop(None);
            assert!(finished.snapshot().phase == outcome);
            assert_eq!(
                finished.snapshot().error.as_deref(),
                Some("fixture outcome")
            );
        }
    }

    #[test]
    fn ipc_flow_contains_only_safe_fields_and_clamps_retry_expiration() {
        let flow = LoginFlow::new(None);
        let original_expiry = flow.snapshot().expires_at;
        let attempt = LoginAttempt {
            id: "private-attempt".into(),
            authorization_url: SecretString::new(
                "https://auth.openai.com/authorize?state=test-state&nonce=private-nonce",
            ),
            redirect_uri: "http://127.0.0.1:43210/auth/callback".into(),
            expires_at: original_expiry + 60,
        };
        flow.install(&attempt, &attempt.redirect_uri).unwrap();
        assert_eq!(flow.snapshot().expires_at, original_expiry);
        let value = serde_json::to_value(flow.snapshot()).unwrap();
        assert_eq!(value["phase"], "starting");
        assert_eq!(value.as_object().unwrap().len(), 3);
        let encoded = value.to_string();
        for secret in [
            "private-attempt",
            "private-nonce",
            "test-state",
            "auth.openai.com",
        ] {
            assert!(!encoded.contains(secret));
        }
    }
}
