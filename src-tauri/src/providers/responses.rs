//! Thin IDE projection over the shared native OpenAI transport.

use super::{Activity, Message, Reply, Request, ToolCall, Usage, validate_tool_calls};
use ejm_harness as ejm;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const TRACE_QUEUE: usize = 16;

#[derive(Clone)]
pub(super) struct Adapter(ejm::ResponsesProvider);

impl Adapter {
    pub(super) fn new(
        credentials: Arc<dyn ejm_harness_auth::CredentialSource>,
    ) -> Result<Self, String> {
        ejm::ResponsesProvider::new(
            ejm::ResponsesConfig {
                model: "catalog".into(),
                reasoning_effort: None,
            },
            credentials,
        )
        .map(Self)
        .map_err(|error| error.to_string())
    }

    pub(super) async fn models(&self, trace: &Activity) -> Result<Vec<(String, String)>, String> {
        let cancel = CancellationToken::new();
        let _guard = cancel.clone().drop_guard();
        trace.record_request(
            &json!({"method":"GET", "url":"https://api.openai.com/v1/models",
            "capture":"Shared model catalog projection; raw catalog HTTP capture is unavailable."}),
        );
        let models = self
            .0
            .models(cancel)
            .await
            .map_err(|error| error.to_string())?;
        trace.record_response(&json!({"models":models, "capture":"Validated catalog entries"}));
        Ok(models
            .into_iter()
            .map(|model| (model.slug, model.display_name))
            .collect())
    }

    pub(super) async fn complete(
        &self,
        request: Request<'_>,
        mut on_delta: impl FnMut(&str),
        trace: &Activity,
        secrets: &[&str],
    ) -> Result<Reply, String> {
        let config = ejm::ResponsesConfig {
            model: request.model.into(),
            reasoning_effort: request.effort.map(str::to_string),
        };
        let request = canonical_request(request)?;
        let (delta_tx, mut delta_rx) = mpsc::channel(32);
        let (trace_tx, trace_rx) = mpsc::channel(TRACE_QUEUE);
        let dropped = Arc::new(AtomicUsize::new(0));
        let provider = self.0.clone().with_observer(Arc::new(Observer {
            sender: trace_tx,
            dropped: dropped.clone(),
        }));
        let cancel = CancellationToken::new();
        // Dropping a prediction or turn future must also cancel credential refresh/transport.
        let _guard = cancel.clone().drop_guard();
        let future = provider.stream_with_config(&config, request, cancel, delta_tx);
        tokio::pin!(future);
        let mut capture = Capture {
            receiver: trace_rx,
            trace,
            secrets,
            dropped,
            bytes: CaptureBytes::default(),
            finished: false,
        };
        let result = loop {
            tokio::select! {
                result = &mut future => break result,
                Some(ejm::ModelDelta::Text(text)) = delta_rx.recv() => on_delta(&text),
                Some(record) = capture.receiver.recv() => capture.bytes.record(trace, &record, secrets),
            }
        };
        while let Ok(ejm::ModelDelta::Text(text)) = delta_rx.try_recv() {
            on_delta(&text);
        }
        capture.finish();
        let response = result.map_err(|error| {
            let mut message = format!("{error:#}");
            for secret in secrets.iter().filter(|secret| !secret.is_empty()) {
                message = message.replace(secret, "[REDACTED credential]");
            }
            trace.record_error(&message);
            message
        })?;
        let calls = response
            .tool_calls
            .into_iter()
            .map(|call| ToolCall {
                id: call.id,
                name: call.name,
                arguments: call.arguments.to_string(),
            })
            .collect::<Vec<_>>();
        validate_tool_calls(&calls)?;
        Ok(Reply {
            text: response.content,
            finish_reason: Some(
                if calls.is_empty() {
                    "stop"
                } else {
                    "tool_calls"
                }
                .into(),
            ),
            tool_calls: calls,
            usage: Some(Usage {
                input_tokens: response.usage.input_tokens,
                output_tokens: response.usage.output_tokens,
                cached_input_tokens: response.usage.cached_input_tokens,
                reasoning_output_tokens: response.usage.reasoning_output_tokens,
                cache_write_input_tokens: 0,
            }),
            continuation: response.continuation,
            blocks: vec![],
            reasoning_content: None,
            request_bytes: capture.bytes.request,
            response_bytes: capture.bytes.response,
        })
    }
}

struct Observer {
    sender: mpsc::Sender<ejm::HttpTraceRecord>,
    dropped: Arc<AtomicUsize>,
}
impl ejm::HttpObserver for Observer {
    fn observe(&self, record: &ejm::HttpTraceRecord) {
        // The shared transport calls observers inline. Storage and UI work stay on the consumer.
        if self.sender.try_send(record.clone()).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

// A dropped turn must retain queued records and label any unobserved tail.
struct Capture<'a> {
    receiver: mpsc::Receiver<ejm::HttpTraceRecord>,
    trace: &'a Activity,
    secrets: &'a [&'a str],
    dropped: Arc<AtomicUsize>,
    bytes: CaptureBytes,
    finished: bool,
}

impl Capture<'_> {
    fn drain(&mut self) {
        while let Ok(record) = self.receiver.try_recv() {
            self.bytes.record(self.trace, &record, self.secrets);
        }
        let dropped = self.dropped.swap(0, Ordering::Relaxed);
        if dropped > 0 {
            self.trace.append_response_text(
                &format!("\n[Shared HTTP capture queue dropped {dropped} records; byte counts are partial.]\n"),
                "text", self.secrets,
            );
        }
    }

    fn finish(&mut self) {
        self.drain();
        self.finished = true;
    }
}

impl Drop for Capture<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.drain();
            self.trace.append_response_text(
                "\n[Shared HTTP capture interrupted; response content and byte counts are partial.]\n",
                "text", self.secrets,
            );
        }
    }
}

#[derive(Default)]
struct CaptureBytes {
    request: usize,
    response: usize,
}
impl CaptureBytes {
    fn record(&mut self, trace: &Activity, record: &ejm::HttpTraceRecord, secrets: &[&str]) {
        let text = serde_json::to_string(record)
            .unwrap_or_else(|_| "[HTTP record serialization failed]".into());
        match record.phase {
            ejm::HttpTracePhase::RequestBody => {
                self.request = self.request.saturating_add(record.payload_bytes);
                trace.record_request_text(&text, "json", secrets);
            }
            ejm::HttpTracePhase::SsePayload | ejm::HttpTracePhase::HttpErrorBody => {
                self.response = self.response.saturating_add(record.payload_bytes);
                trace.append_response_text(&format!("{text}\n"), "jsonl", secrets);
            }
            _ => trace.append_response_text(&format!("{text}\n"), "jsonl", secrets),
        }
    }
}

fn canonical_request(request: Request<'_>) -> Result<ejm::ModelRequest, String> {
    let mut system = Vec::new();
    let mut messages = Vec::new();
    for message in request.messages {
        if message.role == "system" {
            system.push(message.content.clone());
        } else {
            messages.push(canonical_message(message)?);
        }
    }
    let tools = request
        .tools
        .iter()
        .map(|tool| {
            Ok(ejm::ToolDefinition {
                name: tool["name"].as_str().ok_or("The tool has no name.")?.into(),
                description: tool["description"].as_str().unwrap_or_default().into(),
                input_schema: tool
                    .get("inputSchema")
                    .or_else(|| tool.get("parameters"))
                    .filter(|value| value.is_object())
                    .ok_or("The tool has no input schema.")?
                    .clone(),
                // Only a transport projection. Execution policy stays in the canonical harness registry.
                effect: ejm::Effect::Read,
                version: "1".into(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(ejm::ModelRequest {
        system: system.join("\n\n"),
        messages,
        tools,
        max_output_tokens: request.max_output_tokens,
    })
}

fn canonical_message(message: &Message) -> Result<ejm::Message, String> {
    let role = match message.role.as_str() {
        "user" => ejm::Role::User,
        "assistant" => ejm::Role::Assistant,
        "tool" => ejm::Role::Tool,
        _ => return Err("The provider message role is invalid.".into()),
    };
    let tool_calls = message
        .tool_calls
        .iter()
        .map(|call| {
            let arguments: Value = serde_json::from_str(&call.arguments)
                .map_err(|_| "The tool arguments are invalid.")?;
            if !arguments.is_object() {
                return Err("The tool arguments must be an object.");
            }
            Ok(ejm::ToolCall {
                id: call.id.clone(),
                name: call.name.clone(),
                arguments,
            })
        })
        .collect::<Result<Vec<_>, &str>>()
        .map_err(str::to_string)?;
    Ok(ejm::Message {
        role,
        content: message.content.clone(),
        tool_calls,
        tool_call_id: message.tool_call_id.clone(),
        continuation: message.continuation.clone(),
        is_error: message.is_error,
        artifact: message.artifact.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ejm::HttpObserver;

    #[test]
    fn observer_is_bounded_and_exposes_dropped_records() {
        let (sender, mut receiver) = mpsc::channel(1);
        let dropped = Arc::new(AtomicUsize::new(0));
        let observer = Observer {
            sender,
            dropped: dropped.clone(),
        };
        let record = ejm::HttpTraceRecord {
            request_id: "call".into(),
            phase: ejm::HttpTracePhase::SsePayload,
            payload: "{}".into(),
            status: Some(200),
            redactions: 0,
            truncated: false,
            payload_bytes: 2,
            method: None,
            url: None,
            headers: vec![],
        };
        observer.observe(&record);
        observer.observe(&record);
        assert_eq!(dropped.load(Ordering::Relaxed), 1);
        assert_eq!(receiver.try_recv().unwrap().payload, "{}");
    }

    #[test]
    fn interrupted_capture_drains_queued_records_and_exposes_omissions() {
        let state = crate::harness::HarnessState::default();
        let trace = state.begin(1, crate::harness::ActivityKind::Request, "model/complete");
        let (sender, receiver) = mpsc::channel(1);
        let dropped = Arc::new(AtomicUsize::new(0));
        let observer = Observer {
            sender,
            dropped: dropped.clone(),
        };
        let record = ejm::HttpTraceRecord {
            request_id: "call".into(),
            phase: ejm::HttpTracePhase::SsePayload,
            payload: "queued response".into(),
            status: Some(200),
            redactions: 0,
            truncated: false,
            payload_bytes: 15,
            method: None,
            url: None,
            headers: vec![],
        };
        let capture = Capture {
            receiver,
            trace: &trace,
            secrets: &[],
            dropped,
            bytes: CaptureBytes::default(),
            finished: false,
        };
        observer.observe(&record);
        observer.observe(&record);
        drop(capture);
        let detail = serde_json::to_value(state.event_detail(1))
            .unwrap()
            .to_string();
        assert!(detail.contains("queued response"));
        assert!(detail.contains("dropped 1 records"));
        assert!(detail.contains("capture interrupted"));
        assert!(detail.contains("byte counts are partial"));
    }

    #[test]
    fn projection_preserves_tool_identity_and_opaque_continuation() {
        let message = Message {
            role: "assistant".into(),
            content: String::new(),
            tool_calls: vec![ToolCall {
                id: "call".into(),
                name: "read".into(),
                arguments: "{}".into(),
            }],
            tool_call_id: None,
            blocks: vec![],
            reasoning_content: None,
            is_error: false,
            artifact: None,
            continuation: Some(ejm::ProviderContinuation::OpenAiResponses {
                reasoning: vec![json!({"type":"reasoning", "encrypted_content":"opaque"})],
            }),
        };
        let projected = canonical_message(&message).unwrap();
        assert_eq!(projected.tool_calls[0].id, "call");
        assert!(projected.continuation.is_some());
        let bad = Message {
            tool_calls: vec![ToolCall {
                id: "call".into(),
                name: "read".into(),
                arguments: "[]".into(),
            }],
            ..message
        };
        assert!(canonical_message(&bad).is_err());
    }

    #[tokio::test]
    async fn native_transport_preserves_effort_tools_continuation_and_visible_capture() {
        use axum::{
            Router,
            extract::Request as HttpRequest,
            http::{StatusCode, header},
            routing::post,
        };
        use std::collections::VecDeque;
        let (requests, mut received) = mpsc::channel::<Value>(2);
        let output = Arc::new(std::sync::Mutex::new(VecDeque::from([
            json!({"status":"completed", "output":[
                {"type":"reasoning","id":"reasoning-1","summary":[],"encrypted_content":"opaque-state"},
                {"type":"function_call","call_id":"call-1","name":"read","arguments":"{}"}
            ],"usage":{"input_tokens":10,"output_tokens":3,
                "input_tokens_details":{"cached_tokens":0},"output_tokens_details":{"reasoning_tokens":1}}}),
            json!({"status":"completed", "output":[
                {"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done"}]}
            ],"usage":{"input_tokens":20,"output_tokens":2}}),
        ])));
        let app = Router::new().route(
            "/v1/responses",
            post(move |request: HttpRequest| {
                let requests = requests.clone();
                let output = output.clone();
                async move {
                    assert_eq!(
                        request.headers()[header::AUTHORIZATION],
                        "Bearer fixture-secret"
                    );
                    let bytes = axum::body::to_bytes(request.into_body(), 1024 * 1024)
                        .await
                        .unwrap();
                    let body = serde_json::from_slice::<Value>(&bytes).unwrap();
                    requests.send(body).await.unwrap();
                    let response = output.lock().unwrap().pop_front().unwrap();
                    let mut sse = String::new();
                    if response["output"][0]["type"] == "message" {
                        sse.push_str(&format!(
                            "data: {}\n\n",
                            json!({"type":"response.output_text.delta","delta":"Done"})
                        ));
                    }
                    sse.push_str(&format!(
                        "data: {}\n\n",
                        json!({"type":"response.completed","response":response})
                    ));
                    (
                        StatusCode::OK,
                        [
                            (header::CONTENT_TYPE, "text/event-stream"),
                            (header::SET_COOKIE, "private-cookie"),
                        ],
                        sse,
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let provider = ejm::ResponsesProvider::for_endpoint(
            ejm::ResponsesConfig {
                model: "initial".into(),
                reasoning_effort: None,
            },
            Arc::new(ejm_harness_auth::StaticCredential::new(
                ejm_harness_auth::SecretString::new("fixture-secret"),
            )),
            &format!("http://{address}/v1"),
        )
        .unwrap();
        let adapter = Adapter(provider);
        let state = crate::harness::HarnessState::default();
        let mut trace = state.begin(1, crate::harness::ActivityKind::Request, "model/complete");
        let mut messages = vec![Message {
            role: "user".into(),
            content: "Inspect this source".into(),
            tool_calls: vec![],
            tool_call_id: None,
            blocks: vec![],
            reasoning_content: None,
            is_error: false,
            artifact: None,
            continuation: None,
        }];
        let tools = [
            json!({"name":"read","description":"Read source","inputSchema":{"type":"object","properties":{}}}),
        ];
        let first = adapter
            .complete(
                Request {
                    model: "selected-model",
                    effort: Some("high"),
                    reasoning: super::super::ReasoningMode::Openai,
                    messages: &messages,
                    tools: &tools,
                    max_output_tokens: 1000,
                },
                |_| {},
                &trace,
                &[],
            )
            .await
            .unwrap();
        assert_eq!(first.tool_calls[0].id, "call-1");
        assert!(first.continuation.is_some());
        assert_eq!(first.usage.as_ref().unwrap().cached_input_tokens, Some(0));
        messages.push(Message {
            role: "assistant".into(),
            content: first.text,
            tool_calls: first.tool_calls,
            tool_call_id: None,
            blocks: vec![],
            reasoning_content: None,
            is_error: false,
            artifact: None,
            continuation: first.continuation,
        });
        messages.push(Message {
            role: "tool".into(),
            content: "source result".into(),
            tool_calls: vec![],
            tool_call_id: Some("call-1".into()),
            blocks: vec![],
            reasoning_content: None,
            is_error: false,
            artifact: None,
            continuation: None,
        });
        let mut deltas = String::new();
        let second = adapter
            .complete(
                Request {
                    model: "selected-model",
                    effort: Some("high"),
                    reasoning: super::super::ReasoningMode::Openai,
                    messages: &messages,
                    tools: &tools,
                    max_output_tokens: 1000,
                },
                |text| deltas.push_str(text),
                &trace,
                &[],
            )
            .await
            .unwrap();
        assert_eq!(deltas, "Done");
        assert_eq!(second.text, "Done");
        assert_eq!(second.usage.unwrap().cached_input_tokens, None);
        let first_request = received.recv().await.unwrap();
        let replay = received.recv().await.unwrap();
        assert_eq!(first_request["model"], "selected-model");
        assert_eq!(first_request["reasoning"]["effort"], "high");
        assert_eq!(first_request["store"], false);
        assert_eq!(first_request["tools"][0]["name"], "read");
        let input = replay["input"].as_array().unwrap();
        assert!(
            input
                .iter()
                .any(|item| item["encrypted_content"] == "opaque-state")
        );
        assert!(
            input
                .iter()
                .any(|item| item["type"] == "function_call_output" && item["call_id"] == "call-1")
        );
        trace.finish(crate::harness::Outcome::Completed);
        let detail = serde_json::to_value(state.event_detail(1)).unwrap();
        let captured = detail.to_string();
        assert!(captured.contains("Inspect this source"));
        assert!(captured.contains("response.completed"));
        assert!(!captured.contains("fixture-secret"));
        assert!(!captured.contains("private-cookie"));
        server.abort();
    }
}
