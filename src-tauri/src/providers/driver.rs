//! Provider transport and streaming. Tools are returned only after a complete reply.

use crate::harness::Activity;
use eventsource_stream::{EventStreamError, Eventsource};
use futures_util::{Stream, StreamExt, pin_mut};
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};
use std::{sync::Arc, time::Duration};
use url::{Host, Url};

#[path = "responses.rs"]
mod responses;

#[cfg(test)]
#[path = "driver_tests.rs"]
mod tests;

const MAX_BODY_BYTES: usize = 24 * 1024 * 1024;
const MAX_STREAM_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_EVENTS: usize = 100_000;
const MAX_TOOL_CALLS: usize = 64;
const MAX_BLOCKS: usize = 256;
const MAX_MODELS: usize = 10_000;
const MAX_MODEL_PAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_MODEL_LIST_BYTES: usize = 16 * 1024 * 1024;
const PARSER_CHUNK_BYTES: usize = 16 * 1024;
const INVALID_REPLY: &str = "The provider returned an invalid response.";
const TRUNCATED_STREAM: &str = "The provider stream ended before the response was complete.";
const OUTPUT_LIMIT: &str = "The provider response exceeded the output limit.";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Protocol {
    OpenaiCompatible,
    Anthropic,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReasoningMode {
    #[default]
    None,
    Openai,
    Anthropic,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub is_error: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact: Option<std::path::PathBuf>,
    #[serde(default)]
    pub blocks: Vec<Value>,
    pub reasoning_content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuation: Option<ejm_harness::ProviderContinuation>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// Includes uncached, cache-read, and cache-write input tokens.
    pub input_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_input_tokens: Option<u64>,
    #[serde(default)]
    pub cache_write_input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_output_tokens: Option<u64>,
}

#[derive(Debug)]
pub struct Reply {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub usage: Option<Usage>,
    pub blocks: Vec<Value>,
    pub reasoning_content: Option<String>,
    pub continuation: Option<ejm_harness::ProviderContinuation>,
    pub finish_reason: Option<String>,
    pub request_bytes: usize,
    pub response_bytes: usize,
}

pub struct Request<'a> {
    pub model: &'a str,
    pub effort: Option<&'a str>,
    pub reasoning: ReasoningMode,
    pub messages: &'a [Message],
    pub tools: &'a [Value],
    pub max_output_tokens: u32,
}

#[derive(Clone)]
pub struct Client {
    protocol: Protocol,
    endpoint: Url,
    http: reqwest::Client,
    credential: Option<Arc<str>>,
    responses: Option<responses::Adapter>,
}

impl Client {
    pub fn new(protocol: Protocol, endpoint: &str, key: Option<&str>) -> Result<Self, String> {
        let mut endpoint = validate_endpoint(endpoint)?;
        if !endpoint.path().ends_with('/') {
            endpoint.set_path(&format!("{}/", endpoint.path()));
        }
        let mut headers = HeaderMap::new();
        if let Some(key) = key.filter(|key| !key.is_empty()) {
            let mut value = match protocol {
                Protocol::OpenaiCompatible => HeaderValue::from_str(&format!("Bearer {key}")),
                Protocol::Anthropic => HeaderValue::from_str(key),
            }
            .map_err(|_| "The provider credential is invalid.".to_string())?;
            value.set_sensitive(true);
            headers.insert(
                match protocol {
                    Protocol::OpenaiCompatible => AUTHORIZATION,
                    Protocol::Anthropic => reqwest::header::HeaderName::from_static("x-api-key"),
                },
                value,
            );
        }
        if protocol == Protocol::Anthropic {
            headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        }
        let http = reqwest::Client::builder()
            .default_headers(headers)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(120))
            .timeout(Duration::from_secs(15 * 60))
            .pool_idle_timeout(Duration::from_secs(90))
            .build()
            .map_err(|_| "The provider transport could not be initialized.".to_string())?;
        let responses = if protocol == Protocol::OpenaiCompatible && is_native_openai(&endpoint) {
            Some(responses::Adapter::new(Arc::new(
                ejm_harness_auth::StaticCredential::new(ejm_harness_auth::SecretString::new(
                    key.unwrap_or_default(),
                )),
            ))?)
        } else {
            None
        };
        Ok(Self {
            protocol,
            endpoint,
            http,
            credential: key.filter(|key| !key.is_empty()).map(Arc::from),
            responses,
        })
    }

    pub(crate) async fn for_profile(
        app: &tauri::AppHandle,
        profile: &super::profiles::ProviderProfile,
        key: Option<&str>,
    ) -> Result<Self, String> {
        let mut client = Self::new(profile.protocol, &profile.endpoint, key)?;
        if let Some(registration) = profile.chatgpt_registration_id.as_deref() {
            if profile.protocol != Protocol::OpenaiCompatible || !is_native_openai(&client.endpoint)
            {
                return Err("ChatGPT sign-in requires the native OpenAI endpoint.".into());
            }
            let source = super::auth::credential_source(app, registration).await?;
            client.responses = Some(responses::Adapter::new(source)?);
        }
        Ok(client)
    }

    pub async fn discover_models(&self, trace: &Activity) -> Result<Vec<(String, String)>, String> {
        if let Some(provider) = &self.responses {
            return provider.models(trace).await;
        }
        let result: Result<Vec<(String, String)>, String> = async {
            let mut models = Vec::new();
            let mut seen = HashSet::new();
            let mut cursors = HashSet::new();
            let mut cursor: Option<String> = None;
            let mut requests = Vec::new();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
            let mut received_bytes = 0usize;
            for _ in 0..100 {
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                if remaining.is_zero() {
                    return Err("Provider model discovery timed out.".into());
                }
                let mut url = self.url("models")?;
                if self.protocol == Protocol::Anthropic {
                    let mut query = url.query_pairs_mut();
                    query.append_pair("limit", "100");
                    if let Some(cursor) = &cursor {
                        query.append_pair("after_id", cursor);
                    }
                }
                requests.push(self.request_description("GET", &url, "application/json", None));
                trace.record_request_text(
                    &json!({"pages":requests}).to_string(),
                    "json",
                    &self.secrets(),
                );
                let response = self
                    .http
                    .get(url)
                    .header(ACCEPT, "application/json")
                    .timeout(remaining.min(Duration::from_secs(30)))
                    .send()
                    .await
                    .map_err(|error| traced_transport_error(error, trace))?;
                self.capture_headers(&response, trace, "text");
                let status = ensure_status(response.status());
                let bytes = bounded_body(
                    response,
                    MAX_MODEL_PAGE_BYTES.min(MAX_MODEL_LIST_BYTES.saturating_sub(received_bytes)),
                    trace,
                    self.credential.as_deref(),
                    "text",
                )
                .await?;
                received_bytes += bytes.len();
                status?;
                let page: Value = serde_json::from_slice(&bytes).map_err(|_| INVALID_REPLY)?;
                let items = page["data"].as_array().ok_or(INVALID_REPLY)?;
                for item in items {
                    let id = bounded_identifier(&item["id"], 1024)?;
                    let name = match item.get("display_name") {
                        Some(Value::String(name)) if !name.is_empty() && name.len() <= 1024 => name,
                        Some(Value::Null) | None => id,
                        _ => return Err(INVALID_REPLY.into()),
                    };
                    if seen.insert(id.to_owned()) {
                        models.push((id.to_owned(), name.to_owned()));
                        if models.len() > MAX_MODELS {
                            return Err("The provider returned too many models.".into());
                        }
                    }
                }
                if self.protocol != Protocol::Anthropic || page["has_more"] != true {
                    return Ok(models);
                }
                let next = bounded_identifier(&page["last_id"], 1024)?.to_owned();
                if !cursors.insert(next.clone()) {
                    return Err("The provider repeated a model-list page.".into());
                }
                cursor = Some(next);
            }
            Err("The provider model list exceeded the page limit.".into())
        }
        .await;
        if let Err(error) = &result {
            trace.record_error(error);
        }
        result
    }

    pub async fn complete(
        &self,
        request: Request<'_>,
        on_delta: impl FnMut(&str),
        trace: &Activity,
    ) -> Result<Reply, String> {
        if let Some(provider) = &self.responses {
            return provider
                .complete(request, on_delta, trace, &self.secrets())
                .await;
        }
        let result: Result<Reply, String> = async {
            let body = request_body(self.protocol, request)?;
            let request_bytes = body.len();
            let url = self.url(match self.protocol {
                Protocol::OpenaiCompatible => "chat/completions",
                Protocol::Anthropic => "messages",
            })?;
            trace.record_request_text(
                &self
                    .request_description("POST", &url, "text/event-stream", Some(&body))
                    .to_string(),
                "json",
                &self.secrets(),
            );
            let response = self
                .http
                .post(url)
                .header(ACCEPT, "text/event-stream")
                .header(CONTENT_TYPE, "application/json")
                .body(body)
                .send()
                .await
                .map_err(|error| traced_transport_error(error, trace))?;
            self.capture_headers(&response, trace, "sse");
            let status = ensure_status(response.status());
            let is_sse = response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.split(';').next())
                .is_some_and(|value| value.trim().eq_ignore_ascii_case("text/event-stream"));
            if status.is_err() || !is_sse {
                let captured = bounded_body(
                    response,
                    MAX_MODEL_PAGE_BYTES,
                    trace,
                    self.credential.as_deref(),
                    "text",
                )
                .await;
                if let Err(error) = captured {
                    trace.record_error(&error);
                }
                status?;
                return Err("The provider did not return a streaming response.".into());
            }
            let stream = response.bytes_stream().map(|chunk| {
                chunk.map_err(|error| {
                    trace.record_error(&format!("{error:?}"));
                    error
                })
            });
            let mut reply = decode_stream(
                self.protocol,
                stream,
                on_delta,
                Some(trace),
                self.credential.as_deref(),
            )
            .await?;
            reply.request_bytes = request_bytes;
            Ok(reply)
        }
        .await;
        if let Err(error) = &result {
            trace.record_error(error);
        }
        result
    }

    fn secrets(&self) -> Vec<&str> {
        self.credential.as_deref().into_iter().collect()
    }

    fn request_description(
        &self,
        method: &str,
        url: &Url,
        accept: &str,
        body: Option<&[u8]>,
    ) -> Value {
        let mut headers = serde_json::Map::new();
        headers.insert("accept".into(), json!(accept));
        if let Some(key) = &self.credential {
            match self.protocol {
                Protocol::OpenaiCompatible => {
                    headers.insert("authorization".into(), json!(format!("Bearer {key}")));
                }
                Protocol::Anthropic => {
                    headers.insert("x-api-key".into(), json!(key.as_ref()));
                }
            }
        }
        if self.protocol == Protocol::Anthropic {
            headers.insert("anthropic-version".into(), json!("2023-06-01"));
        }
        if let Some(body) = body {
            headers.insert("content-type".into(), json!("application/json"));
            headers.insert("content-length".into(), json!(body.len()));
        }
        json!({"method":method,"url":url.as_str(),"headers":headers,
            "body":body.map(|body|serde_json::from_slice::<Value>(body).unwrap_or_else(|_|json!(String::from_utf8_lossy(body))))})
    }

    fn capture_headers(&self, response: &reqwest::Response, trace: &Activity, format: &str) {
        let mut secrets = self
            .secrets()
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let mut text = format!("HTTP {}\n", response.status());
        for (name, value) in response.headers() {
            let sensitive = matches!(
                name.as_str(),
                "set-cookie" | "authorization" | "proxy-authorization" | "x-api-key"
            );
            let captured = if sensitive {
                // Redact the whole value before considering a printable or hex representation.
                String::from_utf8_lossy(value.as_bytes()).into_owned()
            } else if let Ok(value) = value.to_str() {
                value.to_owned()
            } else {
                format!("[raw header bytes: {:02x?}]", value.as_bytes())
            };
            if sensitive {
                secrets.push(captured.clone());
            }
            text.push_str(&format!("{name}: {captured}\n"));
        }
        text.push('\n');
        trace.append_response_text(
            &text,
            format,
            &secrets.iter().map(String::as_str).collect::<Vec<_>>(),
        );
    }

    fn url(&self, path: &str) -> Result<Url, String> {
        self.endpoint
            .join(path)
            .map_err(|_| "The provider endpoint is invalid.".into())
    }
}

pub(crate) fn validate_endpoint(endpoint: &str) -> Result<Url, String> {
    let invalid = || "Use an HTTPS provider endpoint or an HTTP endpoint on localhost.".to_string();
    if endpoint.len() > 2048 {
        return Err(invalid());
    }
    let url = Url::parse(endpoint).map_err(|_| invalid())?;
    let loopback = match url.host() {
        Some(Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };
    if url.host().is_none()
        || !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    Ok(url)
}

/// Only the canonical public OpenAI base uses native Responses and subscription credentials.
pub(crate) fn is_native_openai(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("api.openai.com")
        && url.port_or_known_default() == Some(443)
        && matches!(url.path(), "/v1" | "/v1/")
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

fn transport_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "The provider request timed out.".into()
    } else {
        "The provider connection failed.".into()
    }
}

fn ensure_status(status: reqwest::StatusCode) -> Result<(), String> {
    if status.is_success() {
        return Ok(());
    }
    Err(match status.as_u16() {
        401 | 403 => "The provider rejected the credential or access permissions.".into(),
        429 => "The provider rate limit was reached. Try again later.".into(),
        500..=599 => "The provider is temporarily unavailable.".into(),
        code => format!("The provider request failed (HTTP {code})."),
    })
}

fn traced_transport_error(error: reqwest::Error, trace: &Activity) -> String {
    trace.record_error(&format!("{error:?}"));
    transport_error(error)
}

async fn bounded_body(
    response: reqwest::Response,
    limit: usize,
    trace: &Activity,
    secret: Option<&str>,
    format: &str,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut capture = ResponseCapture::new(Some(trace), secret, format);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| traced_transport_error(error, trace))?;
        let remaining = limit.saturating_sub(bytes.len());
        capture.feed(&chunk[..chunk.len().min(remaining)]);
        if chunk.len() > remaining {
            trace.record_error("Response capture stopped at the provider transport size limit; the remaining body was not read.");
            return Err("The provider response exceeded the size limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

// Keep only an incomplete UTF-8 character between network chunks. The activity
// handles credential boundaries and bounded retention separately.
struct ResponseCapture<'a> {
    trace: Option<&'a Activity>,
    secret: Option<&'a str>,
    format: &'a str,
    pending: Vec<u8>,
}

impl<'a> ResponseCapture<'a> {
    fn new(trace: Option<&'a Activity>, secret: Option<&'a str>, format: &'a str) -> Self {
        Self {
            trace,
            secret,
            format,
            pending: Vec::new(),
        }
    }

    fn feed(&mut self, bytes: &[u8]) {
        let Some(trace) = self.trace else {
            return;
        };
        self.pending.extend_from_slice(bytes);
        let secrets: Vec<_> = self.secret.into_iter().collect();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    trace.append_response_text(text, self.format, &secrets);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    if valid > 0 {
                        let text = std::str::from_utf8(&self.pending[..valid])
                            .expect("validated UTF-8 prefix");
                        trace.append_response_text(text, self.format, &secrets);
                    }
                    let Some(invalid) = error.error_len() else {
                        self.pending.drain(..valid);
                        break;
                    };
                    trace.append_response_text(
                        &format!(
                            "[invalid UTF-8 bytes: {:02x?}]",
                            &self.pending[valid..valid + invalid]
                        ),
                        self.format,
                        &secrets,
                    );
                    self.pending.drain(..valid + invalid);
                }
            }
        }
    }
}

impl Drop for ResponseCapture<'_> {
    fn drop(&mut self) {
        if !self.pending.is_empty()
            && let Some(trace) = self.trace
        {
            trace.append_response_text(
                &format!("[incomplete UTF-8 bytes: {:02x?}]", self.pending),
                self.format,
                &self.secret.into_iter().collect::<Vec<_>>(),
            );
        }
    }
}

fn request_body(protocol: Protocol, request: Request<'_>) -> Result<Vec<u8>, String> {
    if request.model.is_empty()
        || request.model.len() > 1024
        || request.model.chars().any(char::is_control)
        || request.messages.is_empty()
        || request.messages.len() > 10_000
        || request.tools.len() > 256
        || request.max_output_tokens == 0
    {
        return Err("The provider request is invalid.".into());
    }
    let tools: Vec<Value> = request
        .tools
        .iter()
        .map(|tool| {
            let name = bounded_identifier(&tool["name"], 64)?;
            let description = tool["description"].as_str().ok_or(INVALID_REPLY)?;
            let schema = &tool["inputSchema"];
            if !schema.is_object()
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            {
                return Err("The provider tool definition is invalid.".to_string());
            }
            Ok(match protocol {
                Protocol::OpenaiCompatible => json!({"type":"function","function":{
                    "name":name,"description":description,"parameters":schema
                }}),
                Protocol::Anthropic => json!({
                    "name":name,"description":description,"input_schema":schema
                }),
            })
        })
        .collect::<Result<_, String>>()?;
    let mut body = match protocol {
        Protocol::OpenaiCompatible => {
            let messages = openai_messages(request.messages)?;
            let mut body = json!({"model":request.model,"messages":messages,"stream":true,
                "stream_options":{"include_usage":true}});
            let limit_key = if request.reasoning == ReasoningMode::Openai {
                "max_completion_tokens"
            } else {
                "max_tokens"
            };
            body[limit_key] = json!(request.max_output_tokens);
            body
        }
        Protocol::Anthropic => {
            let (system, messages) = anthropic_messages(request.messages)?;
            let mut body = json!({"model":request.model,"messages":messages,
                "stream":true,"max_tokens":request.max_output_tokens});
            if !system.is_empty() {
                body["system"] = Value::String(system);
            }
            body
        }
    };
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools);
    }
    if let Some(effort) = request
        .effort
        .filter(|effort| !effort.is_empty() && *effort != "none")
    {
        if effort.len() > 32 || !effort.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') {
            return Err("The reasoning effort is invalid.".into());
        }
        match (protocol, request.reasoning) {
            (Protocol::OpenaiCompatible, ReasoningMode::Openai) => {
                body["reasoning_effort"] = Value::String(effort.to_owned());
            }
            (Protocol::Anthropic, ReasoningMode::Anthropic) => {
                let budget = match effort {
                    "minimal" | "low" => 1024,
                    "medium" => 4096,
                    "high" => 8192,
                    _ => 16_384,
                };
                let available = request.max_output_tokens.saturating_sub(1024);
                if available < 1024 {
                    return Err("Anthropic thinking requires at least 2048 output tokens.".into());
                }
                body["thinking"] = json!({"type":"enabled","budget_tokens":budget.min(available)});
            }
            _ => {}
        }
    }
    let bytes =
        serde_json::to_vec(&body).map_err(|_| "The provider request is invalid.".to_string())?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err("The provider request exceeded the context size limit.".into());
    }
    Ok(bytes)
}

fn message_content(message: &Message) -> String {
    if message.role != "tool" {
        return message.content.clone();
    }
    let status = if message.is_error {
        "[ejm-harness tool error]\n"
    } else {
        ""
    };
    match &message.artifact {
        Some(path) => format!(
            "{status}{}\n[ejm-harness artifact: {}]",
            message.content,
            path.display()
        ),
        None => format!("{status}{}", message.content),
    }
}

fn openai_messages(messages: &[Message]) -> Result<Vec<Value>, String> {
    messages
        .iter()
        .map(|message| {
            if !matches!(
                message.role.as_str(),
                "system" | "user" | "assistant" | "tool"
            ) {
                return Err("The provider message role is invalid.".into());
            }
            let mut result = json!({"role":message.role,"content":message_content(message)});
            if message.role == "tool" {
                let id = message
                    .tool_call_id
                    .as_deref()
                    .filter(|id| !id.is_empty())
                    .ok_or("The tool result is missing its call ID.")?;
                result["tool_call_id"] = Value::String(id.to_owned());
            }
            if message.role == "assistant" {
                if let Some(reasoning) = &message.reasoning_content {
                    result["reasoning_content"] = Value::String(reasoning.clone());
                }
                if !message.tool_calls.is_empty() {
                    validate_tool_calls(&message.tool_calls)?;
                    result["tool_calls"] = Value::Array(
                        message
                            .tool_calls
                            .iter()
                            .map(|call| {
                                json!({
                                    "id":call.id,"type":"function","function":{
                                        "name":call.name,"arguments":call.arguments
                                    }
                                })
                            })
                            .collect(),
                    );
                }
            }
            Ok(result)
        })
        .collect()
}

fn anthropic_messages(messages: &[Message]) -> Result<(String, Vec<Value>), String> {
    let mut system = Vec::new();
    let mut result: Vec<Value> = Vec::new();
    for message in messages {
        if message.role == "system" {
            system.push(message.content.as_str());
            continue;
        }
        let (role, mut blocks) = match message.role.as_str() {
            "tool" => {
                let id = message
                    .tool_call_id
                    .as_deref()
                    .filter(|id| !id.is_empty())
                    .ok_or("The tool result is missing its call ID.")?;
                (
                    "user",
                    vec![
                        json!({"type":"tool_result","tool_use_id":id,"content":message_content(message),"is_error":message.is_error}),
                    ],
                )
            }
            "user" => ("user", vec![json!({"type":"text","text":message.content})]),
            "assistant" if !message.blocks.is_empty() => ("assistant", message.blocks.clone()),
            "assistant" => {
                let mut blocks = Vec::new();
                if !message.content.is_empty() {
                    blocks.push(json!({"type":"text","text":message.content}));
                }
                validate_tool_calls(&message.tool_calls)?;
                for call in &message.tool_calls {
                    let input: Value =
                        serde_json::from_str(&call.arguments).map_err(|_| INVALID_REPLY)?;
                    blocks.push(
                        json!({"type":"tool_use","id":call.id,"name":call.name,"input":input}),
                    );
                }
                ("assistant", blocks)
            }
            _ => return Err("The provider message role is invalid.".into()),
        };
        if blocks.is_empty() {
            return Err("The provider message has no content.".into());
        }
        if let Some(last) = result.last_mut().filter(|last| last["role"] == role) {
            last["content"]
                .as_array_mut()
                .ok_or(INVALID_REPLY)?
                .append(&mut blocks);
        } else {
            result.push(json!({"role":role,"content":blocks}));
        }
    }
    if result.is_empty() {
        return Err("The provider request has no conversation messages.".into());
    }
    Ok((system.join("\n\n"), result))
}

#[derive(Default)]
struct StreamBounds {
    bytes: usize,
    frame_bytes: usize,
    line_bytes: usize,
    after_cr: bool,
}

impl StreamBounds {
    fn feed(&mut self, chunk: &[u8]) -> Result<(), String> {
        if chunk.len() > MAX_STREAM_BYTES.saturating_sub(self.bytes) {
            return Err("The provider stream exceeded the size limit.".into());
        }
        self.bytes += chunk.len();
        for &byte in chunk {
            self.frame_bytes += 1;
            if self.frame_bytes > MAX_FRAME_BYTES {
                return Err("A provider stream event exceeded the size limit.".into());
            }
            if byte == b'\n' && self.after_cr {
                self.after_cr = false;
                continue;
            }
            self.after_cr = byte == b'\r';
            if byte == b'\n' || byte == b'\r' {
                if self.line_bytes == 0 {
                    self.frame_bytes = 0;
                }
                self.line_bytes = 0;
            } else {
                self.line_bytes += 1;
            }
        }
        Ok(())
    }
}

// Shield eventsource-stream 0.2.3 from its leading-BOM bug and repeated scans of
// incomplete lines. The library still owns SSE field and event parsing.
#[derive(Default)]
struct StreamPrefix {
    checked: bool,
    bytes: Vec<u8>,
    line: Vec<u8>,
}

impl StreamPrefix {
    fn prepare(&mut self, chunk: &[u8]) -> Vec<u8> {
        if self.checked {
            return self.complete_lines(chunk);
        }
        let mut bytes = std::mem::take(&mut self.bytes);
        bytes.extend_from_slice(chunk);
        let length = bytes.len().min(3);
        let bom = b"\xef\xbb\xbf";
        if bytes[..length] == bom[..length] && bytes.len() < 3 {
            self.bytes = bytes;
            return Vec::new();
        }
        self.checked = true;
        if bytes.starts_with(bom) {
            bytes.drain(..3);
        }
        self.complete_lines(&bytes)
    }

    fn complete_lines(&mut self, chunk: &[u8]) -> Vec<u8> {
        let Some(end) = chunk.iter().rposition(|byte| matches!(byte, b'\n' | b'\r')) else {
            self.line.extend_from_slice(chunk);
            return Vec::new();
        };
        self.line.extend_from_slice(&chunk[..=end]);
        let output = std::mem::take(&mut self.line);
        self.line.extend_from_slice(&chunk[end + 1..]);
        output
    }
}

async fn decode_stream<S, B, E>(
    protocol: Protocol,
    stream: S,
    mut on_delta: impl FnMut(&str),
    trace: Option<&Activity>,
    secret: Option<&str>,
) -> Result<Reply, String>
where
    S: Stream<Item = Result<B, E>>,
    B: AsRef<[u8]>,
{
    let mut bounds = StreamBounds::default();
    let mut capture = ResponseCapture::new(trace, secret, "sse");
    let mut prefix = StreamPrefix::default();
    let stream = stream
        .map(|chunk| {
            let chunk = chunk.map_err(|_| "The provider stream was interrupted.".to_string())?;
            capture.feed(chunk.as_ref());
            bounds.feed(chunk.as_ref())?;
            Ok::<_, String>(chunk)
        })
        .flat_map(|chunk| {
            let chunks: Vec<Result<Vec<u8>, String>> = match chunk {
                Ok(chunk) => chunk
                    .as_ref()
                    .chunks(PARSER_CHUNK_BYTES)
                    .map(|chunk| Ok(chunk.to_vec()))
                    .collect(),
                Err(error) => vec![Err(error)],
            };
            futures_util::stream::iter(chunks)
        })
        .map(|chunk| chunk.map(|chunk| prefix.prepare(&chunk)))
        .eventsource();
    let mut reply = {
        pin_mut!(stream);
        let mut decoder = Decoder::new(protocol);
        let mut events = 0;
        loop {
            let Some(event) = stream.next().await else {
                return Err(TRUNCATED_STREAM.into());
            };
            let event = event.map_err(|error| match error {
                EventStreamError::Transport(message) => message,
                _ => "The provider sent an invalid event stream.".to_string(),
            })?;
            events += 1;
            if events > MAX_EVENTS {
                return Err("The provider stream exceeded the event limit.".into());
            }
            if decoder.push(&event.event, &event.data, &mut on_delta)? {
                break decoder.finish()?;
            }
        }
    };
    reply.response_bytes = bounds.bytes;
    Ok(reply)
}

enum Decoder {
    Openai(OpenaiDecoder),
    Anthropic(AnthropicDecoder),
}

impl Decoder {
    fn new(protocol: Protocol) -> Self {
        match protocol {
            Protocol::OpenaiCompatible => Self::Openai(OpenaiDecoder::default()),
            Protocol::Anthropic => Self::Anthropic(AnthropicDecoder::default()),
        }
    }

    fn push(
        &mut self,
        event: &str,
        data: &str,
        on_delta: &mut impl FnMut(&str),
    ) -> Result<bool, String> {
        match self {
            Self::Openai(decoder) => decoder.push(data, on_delta),
            Self::Anthropic(decoder) => decoder.push(event, data, on_delta),
        }
    }

    fn finish(self) -> Result<Reply, String> {
        match self {
            Self::Openai(decoder) => decoder.finish(),
            Self::Anthropic(decoder) => decoder.finish(),
        }
    }
}

#[derive(Default)]
struct OutputBounds(usize);

impl OutputBounds {
    fn add(&mut self, bytes: usize) -> Result<(), String> {
        if bytes > MAX_OUTPUT_BYTES.saturating_sub(self.0) {
            return Err(OUTPUT_LIMIT.into());
        }
        self.0 += bytes;
        Ok(())
    }

    fn append(&mut self, output: &mut String, fragment: &str) -> Result<(), String> {
        self.add(fragment.len())?;
        output.push_str(fragment);
        Ok(())
    }
}

#[derive(Default)]
struct OpenaiDecoder {
    text: String,
    reasoning: Option<String>,
    calls: BTreeMap<u64, ToolCall>,
    usage: Option<Usage>,
    finish_reason: Option<String>,
    bounds: OutputBounds,
}

impl OpenaiDecoder {
    fn push(&mut self, data: &str, on_delta: &mut impl FnMut(&str)) -> Result<bool, String> {
        if data.trim() == "[DONE]" {
            return Ok(true);
        }
        let value: Value = serde_json::from_str(data).map_err(|_| INVALID_REPLY)?;
        if value.get("error").is_some() {
            return Err("The provider reported an error while streaming.".into());
        }
        if let Some(usage) = value.get("usage").filter(|usage| !usage.is_null()) {
            self.usage = Some(openai_usage(usage)?);
        }
        let choices = value["choices"].as_array().ok_or(INVALID_REPLY)?;
        for choice in choices {
            if choice["index"].as_u64() != Some(0) || self.finish_reason.is_some() {
                return Err(INVALID_REPLY.into());
            }
            let delta = choice["delta"].as_object().ok_or(INVALID_REPLY)?;
            if let Some(text) = optional_text(delta.get("content"))? {
                self.bounds.append(&mut self.text, text)?;
                on_delta(text);
            }
            if let Some(reasoning) = optional_text(delta.get("reasoning_content"))? {
                self.bounds
                    .append(self.reasoning.get_or_insert_default(), reasoning)?;
            }
            if let Some(calls) = delta.get("tool_calls").filter(|calls| !calls.is_null()) {
                for fragment in calls.as_array().ok_or(INVALID_REPLY)? {
                    let index = fragment["index"]
                        .as_u64()
                        .filter(|index| *index < MAX_TOOL_CALLS as u64)
                        .ok_or(INVALID_REPLY)?;
                    if fragment.get("type").is_some_and(|kind| kind != "function") {
                        return Err(INVALID_REPLY.into());
                    }
                    let call = self.calls.entry(index).or_insert_with(|| ToolCall {
                        id: String::new(),
                        name: String::new(),
                        arguments: String::new(),
                    });
                    if let Some(id) = optional_text(fragment.get("id"))?
                        && call.id != id
                    {
                        self.bounds.append(&mut call.id, id)?;
                    }
                    if let Some(function) = fragment.get("function") {
                        let function = function.as_object().ok_or(INVALID_REPLY)?;
                        if let Some(name) = optional_text(function.get("name"))? {
                            self.bounds.append(&mut call.name, name)?;
                        }
                        if let Some(arguments) = optional_text(function.get("arguments"))? {
                            self.bounds.append(&mut call.arguments, arguments)?;
                        }
                    }
                }
            }
            if let Some(reason) = optional_text(choice.get("finish_reason"))? {
                validate_finish_reason(reason, Protocol::OpenaiCompatible)?;
                self.finish_reason = Some(reason.to_owned());
            }
        }
        Ok(false)
    }

    fn finish(self) -> Result<Reply, String> {
        let reason = self.finish_reason.as_deref().ok_or(TRUNCATED_STREAM)?;
        for (expected, actual) in self.calls.keys().enumerate() {
            if expected as u64 != *actual {
                return Err(INVALID_REPLY.into());
            }
        }
        let calls: Vec<ToolCall> = self.calls.into_values().collect();
        validate_tool_calls(&calls)?;
        if (reason == "tool_calls") != !calls.is_empty() {
            return Err(INVALID_REPLY.into());
        }
        Ok(Reply {
            text: self.text,
            tool_calls: calls,
            usage: self.usage,
            blocks: Vec::new(),
            reasoning_content: self.reasoning,
            continuation: None,
            finish_reason: self.finish_reason,
            request_bytes: 0,
            response_bytes: 0,
        })
    }
}

fn optional_text(value: Option<&Value>) -> Result<Option<&str>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text)),
        _ => Err(INVALID_REPLY.into()),
    }
}

fn bounded_identifier(value: &Value, limit: usize) -> Result<&str, String> {
    value
        .as_str()
        .filter(|text| {
            !text.is_empty() && text.len() <= limit && !text.chars().any(char::is_control)
        })
        .ok_or_else(|| INVALID_REPLY.into())
}

fn validate_tool_calls(calls: &[ToolCall]) -> Result<(), String> {
    let mut ids = HashSet::new();
    if calls.len() > MAX_TOOL_CALLS {
        return Err(INVALID_REPLY.into());
    }
    for call in calls {
        if call.id.is_empty()
            || call.id.len() > 512
            || call.id.chars().any(char::is_control)
            || call.name.is_empty()
            || call.name.len() > 64
            || !call
                .name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            || !ids.insert(&call.id)
            || !serde_json::from_str::<Value>(&call.arguments).is_ok_and(|value| value.is_object())
        {
            return Err("The provider returned an incomplete or invalid tool call.".into());
        }
    }
    Ok(())
}

fn validate_finish_reason(reason: &str, protocol: Protocol) -> Result<(), String> {
    match (protocol, reason) {
        (Protocol::OpenaiCompatible, "stop" | "tool_calls")
        | (Protocol::Anthropic, "end_turn" | "tool_use" | "stop_sequence" | "refusal") => Ok(()),
        (_, "length" | "max_tokens" | "model_context_window_exceeded") => {
            Err("The provider reached its token limit before completing the response.".into())
        }
        (_, "content_filter") => {
            Err("The provider stopped the response because of its content policy.".into())
        }
        _ => Err("The provider stopped without a complete response.".into()),
    }
}

fn token_count(value: &Value, name: &str) -> Result<Option<u64>, String> {
    match value.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_u64().map(Some).ok_or_else(|| INVALID_REPLY.into()),
    }
}

fn openai_usage(value: &Value) -> Result<Usage, String> {
    let input_tokens = token_count(value, "prompt_tokens")?.ok_or(INVALID_REPLY)?;
    let output_tokens = token_count(value, "completion_tokens")?.ok_or(INVALID_REPLY)?;
    let cached_input_tokens = token_count(&value["prompt_tokens_details"], "cached_tokens")?;
    let reasoning_output_tokens =
        token_count(&value["completion_tokens_details"], "reasoning_tokens")?;
    if cached_input_tokens.is_some_and(|tokens| tokens > input_tokens)
        || reasoning_output_tokens.is_some_and(|tokens| tokens > output_tokens)
    {
        return Err(INVALID_REPLY.into());
    }
    Ok(Usage {
        input_tokens,
        cached_input_tokens,
        cache_write_input_tokens: 0,
        output_tokens,
        reasoning_output_tokens,
    })
}

struct AnthropicBlock {
    value: Value,
    input_json: Option<String>,
    stopped: bool,
}

#[derive(Default)]
struct AnthropicDecoder {
    started: bool,
    blocks: BTreeMap<u64, AnthropicBlock>,
    text: String,
    usage: Option<Usage>,
    uncached_input: u64,
    finish_reason: Option<String>,
    bounds: OutputBounds,
}

impl AnthropicDecoder {
    fn push(
        &mut self,
        event: &str,
        data: &str,
        on_delta: &mut impl FnMut(&str),
    ) -> Result<bool, String> {
        let value: Value = serde_json::from_str(data).map_err(|_| INVALID_REPLY)?;
        let kind = value["type"].as_str().ok_or(INVALID_REPLY)?;
        if !event.is_empty() && event != "message" && event != kind {
            return Err(INVALID_REPLY.into());
        }
        match kind {
            "error" => return Err("The provider reported an error while streaming.".into()),
            "ping" => {}
            "message_start" => {
                if self.started
                    || value["message"]["role"] != "assistant"
                    || value["message"]["content"]
                        .as_array()
                        .is_none_or(|blocks| !blocks.is_empty())
                {
                    return Err(INVALID_REPLY.into());
                }
                self.started = true;
                if let Some(usage) = value["message"].get("usage") {
                    self.merge_usage(usage)?;
                }
            }
            "content_block_start" => self.start_block(&value, on_delta)?,
            "content_block_delta" => self.delta_block(&value, on_delta)?,
            "content_block_stop" => {
                if !self.started || self.finish_reason.is_some() {
                    return Err(INVALID_REPLY.into());
                }
                let index = value["index"].as_u64().ok_or(INVALID_REPLY)?;
                let block = self
                    .blocks
                    .get_mut(&index)
                    .filter(|block| !block.stopped)
                    .ok_or(INVALID_REPLY)?;
                if block.value["type"] == "tool_use" {
                    if let Some(input) = block.input_json.take() {
                        let input: Value =
                            serde_json::from_str(&input).map_err(|_| INVALID_REPLY)?;
                        if !input.is_object() {
                            return Err(INVALID_REPLY.into());
                        }
                        block.value["input"] = input;
                    }
                    if !block.value["input"].is_object() {
                        return Err(INVALID_REPLY.into());
                    }
                }
                if block.value["type"] == "thinking"
                    && block.value["signature"].as_str().is_none_or(str::is_empty)
                {
                    return Err("The provider omitted a thinking signature.".into());
                }
                block.stopped = true;
            }
            "message_delta" => {
                if !self.started || self.blocks.values().any(|block| !block.stopped) {
                    return Err(INVALID_REPLY.into());
                }
                if let Some(reason) = optional_text(value["delta"].get("stop_reason"))? {
                    if self.finish_reason.is_some() {
                        return Err(INVALID_REPLY.into());
                    }
                    validate_finish_reason(reason, Protocol::Anthropic)?;
                    self.finish_reason = Some(reason.to_owned());
                }
                if let Some(usage) = value.get("usage") {
                    self.merge_usage(usage)?;
                }
            }
            "message_stop" => {
                if !self.started
                    || self.finish_reason.is_none()
                    || self.blocks.values().any(|block| !block.stopped)
                {
                    return Err(TRUNCATED_STREAM.into());
                }
                return Ok(true);
            }
            _ => {} // Providers may add non-content events without changing this contract.
        }
        Ok(false)
    }

    fn start_block(
        &mut self,
        value: &Value,
        on_delta: &mut impl FnMut(&str),
    ) -> Result<(), String> {
        if !self.started || self.finish_reason.is_some() {
            return Err(INVALID_REPLY.into());
        }
        let index = value["index"]
            .as_u64()
            .filter(|index| *index < MAX_BLOCKS as u64)
            .ok_or(INVALID_REPLY)?;
        let block = &value["content_block"];
        if self.blocks.contains_key(&index) || !block.is_object() || !block["type"].is_string() {
            return Err(INVALID_REPLY.into());
        }
        self.bounds
            .add(serde_json::to_vec(block).map_err(|_| INVALID_REPLY)?.len())?;
        if block["type"] == "text" {
            let text = block["text"].as_str().ok_or(INVALID_REPLY)?;
            self.text.push_str(text);
            on_delta(text);
        }
        self.blocks.insert(
            index,
            AnthropicBlock {
                value: block.clone(),
                input_json: None,
                stopped: false,
            },
        );
        Ok(())
    }

    fn delta_block(
        &mut self,
        value: &Value,
        on_delta: &mut impl FnMut(&str),
    ) -> Result<(), String> {
        if !self.started || self.finish_reason.is_some() {
            return Err(INVALID_REPLY.into());
        }
        let index = value["index"].as_u64().ok_or(INVALID_REPLY)?;
        let block = self
            .blocks
            .get_mut(&index)
            .filter(|block| !block.stopped)
            .ok_or(INVALID_REPLY)?;
        let delta = &value["delta"];
        let (block_type, key, fragment_key) = match delta["type"].as_str().ok_or(INVALID_REPLY)? {
            "text_delta" => ("text", "text", "text"),
            "thinking_delta" => ("thinking", "thinking", "thinking"),
            "signature_delta" => ("thinking", "signature", "signature"),
            "input_json_delta" => {
                if block.value["type"] != "tool_use" {
                    return Err(INVALID_REPLY.into());
                }
                if block.input_json.is_none()
                    && block.value["input"]
                        .as_object()
                        .is_none_or(|input| !input.is_empty())
                {
                    return Err(INVALID_REPLY.into());
                }
                let fragment = delta["partial_json"].as_str().ok_or(INVALID_REPLY)?;
                self.bounds
                    .append(block.input_json.get_or_insert_default(), fragment)?;
                return Ok(());
            }
            "citations_delta" => {
                if block.value["type"] != "text" || !delta["citation"].is_object() {
                    return Err(INVALID_REPLY.into());
                }
                self.bounds.add(
                    serde_json::to_vec(&delta["citation"])
                        .map_err(|_| INVALID_REPLY)?
                        .len(),
                )?;
                let citation = delta["citation"].clone();
                if block.value.get("citations").is_none() {
                    block.value["citations"] = json!([]);
                }
                block.value["citations"]
                    .as_array_mut()
                    .ok_or(INVALID_REPLY)?
                    .push(citation);
                return Ok(());
            }
            _ => return Ok(()),
        };
        if block.value["type"] != block_type {
            return Err(INVALID_REPLY.into());
        }
        let fragment = delta[fragment_key].as_str().ok_or(INVALID_REPLY)?;
        self.bounds.add(fragment.len())?;
        let Value::String(output) = &mut block.value[key] else {
            return Err(INVALID_REPLY.into());
        };
        output.push_str(fragment);
        if block_type == "text" {
            self.text.push_str(fragment);
            on_delta(fragment);
        }
        Ok(())
    }

    fn merge_usage(&mut self, value: &Value) -> Result<(), String> {
        if !value.is_object() {
            return Err(INVALID_REPLY.into());
        }
        let usage = self.usage.get_or_insert_default();
        if let Some(tokens) = token_count(value, "input_tokens")? {
            self.uncached_input = tokens;
        }
        if let Some(tokens) = token_count(value, "cache_read_input_tokens")? {
            usage.cached_input_tokens = Some(tokens);
        }
        if let Some(tokens) = token_count(value, "cache_creation_input_tokens")? {
            usage.cache_write_input_tokens = tokens;
        }
        if let Some(tokens) = token_count(value, "output_tokens")? {
            usage.output_tokens = tokens;
        }
        usage.input_tokens = self
            .uncached_input
            .checked_add(usage.cached_input_tokens.unwrap_or(0))
            .and_then(|tokens| tokens.checked_add(usage.cache_write_input_tokens))
            .ok_or(INVALID_REPLY)?;
        Ok(())
    }

    fn finish(self) -> Result<Reply, String> {
        let reason = self.finish_reason.as_deref().ok_or(TRUNCATED_STREAM)?;
        let mut calls = Vec::new();
        let mut blocks = Vec::new();
        for (expected, (index, block)) in self.blocks.into_iter().enumerate() {
            if expected as u64 != index || !block.stopped {
                return Err(INVALID_REPLY.into());
            }
            if block.value["type"] == "tool_use" {
                calls.push(ToolCall {
                    id: bounded_identifier(&block.value["id"], 512)?.to_owned(),
                    name: bounded_identifier(&block.value["name"], 64)?.to_owned(),
                    arguments: serde_json::to_string(&block.value["input"])
                        .map_err(|_| INVALID_REPLY)?,
                });
            }
            blocks.push(block.value);
        }
        validate_tool_calls(&calls)?;
        if (reason == "tool_use") != !calls.is_empty() {
            return Err(INVALID_REPLY.into());
        }
        Ok(Reply {
            text: self.text,
            tool_calls: calls,
            usage: self.usage,
            blocks,
            reasoning_content: None,
            continuation: None,
            finish_reason: self.finish_reason,
            request_bytes: 0,
            response_bytes: 0,
        })
    }
}
