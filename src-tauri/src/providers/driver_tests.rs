use super::*;
use futures_util::stream;

fn event(kind: &str, value: Value) -> String {
    format!("event: {kind}\ndata: {value}\n\n")
}

fn openai_event(value: Value) -> String {
    format!("data: {value}\n\n")
}

fn openai_delta(delta: Value, finish_reason: Value) -> String {
    openai_event(json!({"choices":[{"index":0,"delta":delta,"finish_reason":finish_reason}]}))
}

fn openai_tool_stream() -> String {
    [
        openai_delta(
            json!({"role":"assistant","reasoning_content":"private reasoning"}),
            Value::Null,
        ),
        openai_delta(json!({"content":"Run λ "}), Value::Null),
        openai_delta(
            json!({"tool_calls":[{"index":0,"id":"call_a","type":"function",
            "function":{"name":"open_file","arguments":"{\"path\":"}}]}),
            Value::Null,
        ),
        openai_delta(
            json!({"tool_calls":[{"index":1,"id":"call_b","type":"function",
            "function":{"name":"search","arguments":"{\"query\":"}}]}),
            Value::Null,
        ),
        openai_delta(
            json!({"tool_calls":[
                {"index":1,"function":{"arguments":"\"needle\"}"}},
                {"index":0,"function":{"arguments":"\"src/lib.rs\"}"}}
            ]}),
            Value::Null,
        ),
        openai_delta(json!({}), json!("tool_calls")),
        openai_event(
            json!({"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":30,
            "prompt_tokens_details":{"cached_tokens":40},
            "completion_tokens_details":{"reasoning_tokens":8}}}),
        ),
        "data: [DONE]\n\n".into(),
    ]
    .concat()
}

fn anthropic_start() -> String {
    event(
        "message_start",
        json!({"type":"message_start","message":{
            "role":"assistant","content":[],"usage":{"input_tokens":12,"cache_read_input_tokens":20,
                "cache_creation_input_tokens":30,"output_tokens":1}
        }}),
    )
}

fn block_start(index: u64, block: Value) -> String {
    event(
        "content_block_start",
        json!({"type":"content_block_start","index":index,"content_block":block}),
    )
}

fn block_delta(index: u64, delta: Value) -> String {
    event(
        "content_block_delta",
        json!({"type":"content_block_delta","index":index,"delta":delta}),
    )
}

fn block_stop(index: u64) -> String {
    event(
        "content_block_stop",
        json!({"type":"content_block_stop","index":index}),
    )
}

fn anthropic_end(reason: &str) -> String {
    [
        event(
            "message_delta",
            json!({"type":"message_delta","delta":{"stop_reason":reason},
            "usage":{"output_tokens":55}}),
        ),
        event("message_stop", json!({"type":"message_stop"})),
    ]
    .concat()
}

fn anthropic_tool_stream() -> String {
    [
        anthropic_start(),
        event("ping", json!({"type":"ping"})),
        block_start(0, json!({"type":"thinking","thinking":"","signature":""})),
        block_delta(
            0,
            json!({"type":"thinking_delta","thinking":"private reasoning"}),
        ),
        block_delta(0, json!({"type":"signature_delta","signature":"signed-"})),
        block_delta(0, json!({"type":"signature_delta","signature":"thinking"})),
        block_stop(0),
        block_start(1, json!({"type":"text","text":""})),
        block_delta(1, json!({"type":"text_delta","text":"Checking λ"})),
        block_stop(1),
        block_start(
            2,
            json!({"type":"tool_use","id":"call_a","name":"open_file","input":{}}),
        ),
        block_delta(
            2,
            json!({"type":"input_json_delta","partial_json":"{\"path\":"}),
        ),
        block_delta(
            2,
            json!({"type":"input_json_delta","partial_json":"\"src/lib.rs\"}"}),
        ),
        block_stop(2),
        block_start(
            3,
            json!({"type":"tool_use","id":"call_b","name":"search","input":{}}),
        ),
        block_delta(
            3,
            json!({"type":"input_json_delta","partial_json":"{\"query\":\"needle\"}"}),
        ),
        block_stop(3),
        anthropic_end("tool_use"),
    ]
    .concat()
}

async fn decode(protocol: Protocol, source: &str, width: usize) -> Result<(Reply, String), String> {
    let chunks: Vec<Result<Vec<u8>, ()>> = source
        .as_bytes()
        .chunks(width)
        .map(|chunk| Ok(chunk.to_vec()))
        .collect();
    let mut deltas = String::new();
    let reply = decode_stream(
        protocol,
        stream::iter(chunks),
        |text| deltas.push_str(text),
        None,
        None,
    )
    .await?;
    Ok((reply, deltas))
}

fn message(role: &str, content: &str) -> Message {
    Message {
        role: role.into(),
        content: content.into(),
        tool_calls: Vec::new(),
        tool_call_id: None,
        is_error: false,
        artifact: None,
        blocks: Vec::new(),
        reasoning_content: None,
        continuation: None,
    }
}

fn call(id: &str, name: &str, arguments: &str) -> ToolCall {
    ToolCall {
        id: id.into(),
        name: name.into(),
        arguments: arguments.into(),
    }
}

fn request<'a>(messages: &'a [Message], tools: &'a [Value]) -> Request<'a> {
    Request {
        model: "test-model",
        effort: None,
        reasoning: ReasoningMode::None,
        messages,
        tools,
        max_output_tokens: 4096,
    }
}

#[tokio::test]
async fn openai_reassembles_interleaved_tools_unicode_reasoning_and_final_usage() {
    let source = openai_tool_stream();
    for width in [1, 7, 16384] {
        let (reply, deltas) = decode(Protocol::OpenaiCompatible, &source, width)
            .await
            .unwrap();
        assert_eq!(deltas, "Run λ ");
        assert_eq!(reply.text, deltas);
        assert_eq!(
            reply.reasoning_content.as_deref(),
            Some("private reasoning")
        );
        assert_eq!(reply.finish_reason.as_deref(), Some("tool_calls"));
        assert_eq!(reply.tool_calls.len(), 2);
        assert_eq!(reply.tool_calls[0].id, "call_a");
        assert_eq!(reply.tool_calls[0].name, "open_file");
        assert_eq!(reply.tool_calls[0].arguments, "{\"path\":\"src/lib.rs\"}");
        assert_eq!(reply.tool_calls[1].id, "call_b");
        assert_eq!(reply.tool_calls[1].arguments, "{\"query\":\"needle\"}");
        let usage = reply.usage.unwrap();
        assert_eq!(usage.input_tokens, 100);
        assert_eq!(usage.cached_input_tokens, Some(40));
        assert_eq!(usage.cache_write_input_tokens, 0);
        assert_eq!(usage.output_tokens, 30);
        assert_eq!(usage.reasoning_output_tokens, Some(8));
        assert_eq!(reply.response_bytes, source.len());
    }
}

#[tokio::test]
async fn openai_requires_done_and_finish_reason_before_exposing_tool_calls() {
    let source = openai_tool_stream();
    let missing_done = source.replace("data: [DONE]\n\n", "");
    assert_eq!(
        decode(Protocol::OpenaiCompatible, &missing_done, 3)
            .await
            .unwrap_err(),
        TRUNCATED_STREAM
    );
    let missing_reason =
        source.replace("\"finish_reason\":\"tool_calls\"", "\"finish_reason\":null");
    assert_eq!(
        decode(Protocol::OpenaiCompatible, &missing_reason, 5)
            .await
            .unwrap_err(),
        TRUNCATED_STREAM
    );
    let unfinished_event = source.replace("data: [DONE]\n\n", "data: [DONE]");
    assert_eq!(
        decode(Protocol::OpenaiCompatible, &unfinished_event, 11)
            .await
            .unwrap_err(),
        TRUNCATED_STREAM
    );
}

#[tokio::test]
async fn openai_rejects_truncated_json_duplicate_ids_and_wrong_tool_finish() {
    let source = openai_tool_stream();
    for bad in [
        source.replace("needle\\\"}", "needle\\\""),
        source.replace("call_b", "call_a"),
        source.replace(
            "\"finish_reason\":\"tool_calls\"",
            "\"finish_reason\":\"stop\"",
        ),
    ] {
        assert!(decode(Protocol::OpenaiCompatible, &bad, 13).await.is_err());
    }
}

#[tokio::test]
async fn openai_rejects_stream_errors_token_limits_and_bytes_after_finish() {
    let source = openai_tool_stream();
    let error =
        openai_event(json!({"error":{"message":"secret-token and https://private.example"}}));
    let result = decode(Protocol::OpenaiCompatible, &error, 1)
        .await
        .unwrap_err();
    assert_eq!(result, "The provider reported an error while streaming.");
    assert!(!result.contains("secret-token"));
    let length = source.replace(
        "\"finish_reason\":\"tool_calls\"",
        "\"finish_reason\":\"length\"",
    );
    assert!(
        decode(Protocol::OpenaiCompatible, &length, 17)
            .await
            .unwrap_err()
            .contains("token limit")
    );
    let after_finish = source.replace(
        "data: [DONE]",
        &format!(
            "{}data: [DONE]",
            openai_delta(json!({"content":"extra"}), Value::Null)
        ),
    );
    assert!(
        decode(Protocol::OpenaiCompatible, &after_finish, 31)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn anthropic_reassembles_signed_thinking_multiple_tools_and_cumulative_usage() {
    let source = anthropic_tool_stream();
    for width in [1, 11, 16384] {
        let (reply, deltas) = decode(Protocol::Anthropic, &source, width).await.unwrap();
        assert_eq!(deltas, "Checking λ");
        assert_eq!(reply.text, deltas);
        assert!(reply.reasoning_content.is_none());
        assert_eq!(
            reply.blocks[0],
            json!({"type":"thinking","thinking":"private reasoning","signature":"signed-thinking"})
        );
        assert_eq!(reply.tool_calls.len(), 2);
        assert_eq!(reply.tool_calls[0].id, "call_a");
        assert_eq!(reply.tool_calls[0].arguments, "{\"path\":\"src/lib.rs\"}");
        assert_eq!(reply.blocks[2]["input"], json!({"path":"src/lib.rs"}));
        assert_eq!(reply.tool_calls[1].name, "search");
        let usage = reply.usage.unwrap();
        assert_eq!(usage.input_tokens, 62);
        assert_eq!(usage.cached_input_tokens, Some(20));
        assert_eq!(usage.cache_write_input_tokens, 30);
        assert_eq!(usage.output_tokens, 55);
        assert_eq!(reply.response_bytes, source.len());
    }
}

#[tokio::test]
async fn anthropic_requires_stopped_blocks_finish_reason_and_message_stop() {
    let source = anthropic_tool_stream();
    let missing_stop = source.replace(&event("message_stop", json!({"type":"message_stop"})), "");
    assert_eq!(
        decode(Protocol::Anthropic, &missing_stop, 7)
            .await
            .unwrap_err(),
        TRUNCATED_STREAM
    );
    let missing_block_stop = source.replace(&block_stop(3), "");
    assert!(
        decode(Protocol::Anthropic, &missing_block_stop, 7)
            .await
            .is_err()
    );
    let missing_finish = source.replace("\"stop_reason\":\"tool_use\"", "\"stop_reason\":null");
    assert_eq!(
        decode(Protocol::Anthropic, &missing_finish, 7)
            .await
            .unwrap_err(),
        TRUNCATED_STREAM
    );
}

#[tokio::test]
async fn anthropic_rejects_missing_signatures_invalid_tool_json_and_wrong_stop_reason() {
    let source = anthropic_tool_stream();
    let unsigned = source
        .replace(
            &block_delta(0, json!({"type":"signature_delta","signature":"signed-"})),
            "",
        )
        .replace(
            &block_delta(0, json!({"type":"signature_delta","signature":"thinking"})),
            "",
        );
    assert!(
        decode(Protocol::Anthropic, &unsigned, 5)
            .await
            .unwrap_err()
            .contains("signature")
    );
    let malformed = source.replace("needle\\\"}", "needle\\\"");
    assert!(decode(Protocol::Anthropic, &malformed, 5).await.is_err());
    let wrong_reason = source.replace(
        "\"stop_reason\":\"tool_use\"",
        "\"stop_reason\":\"end_turn\"",
    );
    assert!(decode(Protocol::Anthropic, &wrong_reason, 5).await.is_err());
}

#[tokio::test]
async fn anthropic_rejects_stream_errors_and_max_tokens_even_for_text() {
    let error = [
        anthropic_start(),
        event(
            "error",
            json!({"type":"error","error":{"message":"private-body"}}),
        ),
    ]
    .concat();
    assert_eq!(
        decode(Protocol::Anthropic, &error, 3).await.unwrap_err(),
        "The provider reported an error while streaming."
    );
    let source = [
        anthropic_start(),
        block_start(0, json!({"type":"text","text":"partial"})),
        block_stop(0),
        anthropic_end("max_tokens"),
    ]
    .concat();
    assert!(
        decode(Protocol::Anthropic, &source, 1)
            .await
            .unwrap_err()
            .contains("token limit")
    );
}

#[tokio::test]
async fn streams_accept_fragmented_bom_and_crlf_and_hide_transport_errors() {
    let source = format!("\u{feff}{}", openai_tool_stream().replace('\n', "\r\n"));
    let (reply, _) = decode(Protocol::OpenaiCompatible, &source, 1)
        .await
        .unwrap();
    assert_eq!(reply.response_bytes, source.len());
    assert_eq!(reply.tool_calls.len(), 2);
    let source = stream::iter([Err::<Vec<u8>, _>("secret key and private endpoint")]);
    let result = decode_stream(Protocol::Anthropic, source, |_| {}, None, None)
        .await
        .unwrap_err();
    assert_eq!(result, "The provider stream was interrupted.");
}

#[tokio::test]
async fn raw_frame_bounds_apply_before_event_parser_buffering() {
    let huge = format!("data: {}", "x".repeat(MAX_FRAME_BYTES));
    assert!(
        decode(Protocol::OpenaiCompatible, &huge, 127)
            .await
            .unwrap_err()
            .contains("size limit")
    );
    let multiline = "data: line\r\n".repeat(MAX_FRAME_BYTES / 8);
    assert!(
        decode(Protocol::OpenaiCompatible, &multiline, 127)
            .await
            .unwrap_err()
            .contains("size limit")
    );
}

#[test]
fn output_bounds_and_total_stream_bounds_reject_before_append() {
    let mut output = OutputBounds(MAX_OUTPUT_BYTES - 1);
    let mut text = "unchanged".to_owned();
    assert_eq!(output.append(&mut text, "xx").unwrap_err(), OUTPUT_LIMIT);
    assert_eq!(text, "unchanged");
    let mut stream = StreamBounds {
        bytes: MAX_STREAM_BYTES,
        ..Default::default()
    };
    assert!(stream.feed(b"x").is_err());
}

#[test]
fn openai_requests_replay_reasoning_and_function_calls_with_current_token_limit() {
    let mut assistant = message("assistant", "");
    assistant.tool_calls = vec![call("call_a", "search", "{\"query\":\"rust\"}")];
    assistant.reasoning_content = Some("native-only reasoning".into());
    let mut tool_result = message("tool", "found");
    tool_result.tool_call_id = Some("call_a".into());
    let messages = [
        message("system", "rules"),
        message("user", "search"),
        assistant,
        tool_result,
    ];
    let tools =
        [json!({"name":"search","description":"Find code","inputSchema":{"type":"object"}})];
    let mut request = request(&messages, &tools);
    request.reasoning = ReasoningMode::Openai;
    request.effort = Some("high");
    let body: Value =
        serde_json::from_slice(&request_body(Protocol::OpenaiCompatible, request).unwrap())
            .unwrap();
    assert_eq!(
        body["messages"][2]["reasoning_content"],
        "native-only reasoning"
    );
    assert_eq!(
        body["messages"][2]["tool_calls"][0]["function"]["arguments"],
        "{\"query\":\"rust\"}"
    );
    assert_eq!(body["messages"][3]["tool_call_id"], "call_a");
    assert_eq!(
        body["tools"][0]["function"]["parameters"],
        json!({"type":"object"})
    );
    assert_eq!(body["reasoning_effort"], "high");
    assert_eq!(body["max_completion_tokens"], 4096);
    assert!(body.get("max_tokens").is_none());
    assert!(body["messages"][2].get("toolCalls").is_none());
}

#[test]
fn tool_failure_and_artifact_metadata_reach_both_provider_request_formats() {
    for (is_error, artifact, expected) in [
        (false, None, "result"),
        (true, None, "[ejm-harness tool error]\nresult"),
        (
            false,
            Some("/workspace/results/trace.json"),
            "result\n[ejm-harness artifact: /workspace/results/trace.json]",
        ),
        (
            true,
            Some("/workspace/results/trace.json"),
            "[ejm-harness tool error]\nresult\n[ejm-harness artifact: /workspace/results/trace.json]",
        ),
    ] {
        let mut assistant = message("assistant", "");
        assistant.tool_calls = vec![call("call", "read", "{}")];
        let mut tool = message("tool", "result");
        tool.tool_call_id = Some("call".into());
        tool.is_error = is_error;
        tool.artifact = artifact.map(Into::into);
        let messages = [message("user", "read"), assistant, tool];
        let openai: Value = serde_json::from_slice(
            &request_body(Protocol::OpenaiCompatible, request(&messages, &[])).unwrap(),
        )
        .unwrap();
        assert_eq!(openai["messages"][2]["content"], expected);
        assert_eq!(openai["messages"][2]["tool_call_id"], "call");
        let anthropic: Value = serde_json::from_slice(
            &request_body(Protocol::Anthropic, request(&messages, &[])).unwrap(),
        )
        .unwrap();
        assert_eq!(anthropic["messages"][2]["content"][0]["content"], expected);
        assert_eq!(anthropic["messages"][2]["content"][0]["is_error"], is_error);
        assert_eq!(
            anthropic["messages"][2]["content"][0]["tool_use_id"],
            "call"
        );
    }
}

#[test]
fn anthropic_requests_replay_exact_signed_blocks_and_group_tool_results() {
    let blocks = vec![
        json!({"type":"thinking","thinking":"native-only reasoning","signature":"opaque-signature"}),
        json!({"type":"redacted_thinking","data":"opaque-data"}),
        json!({"type":"text","text":"Checking"}),
        json!({"type":"tool_use","id":"call_a","name":"search","input":{"query":"rust"}}),
        json!({"type":"tool_use","id":"call_b","name":"search","input":{"query":"go"}}),
    ];
    let mut assistant = message("assistant", "Checking");
    assistant.blocks = blocks.clone();
    assistant.tool_calls = vec![
        call("call_a", "search", "{\"query\":\"rust\"}"),
        call("call_b", "search", "{\"query\":\"go\"}"),
    ];
    let mut first_result = message("tool", "found rust");
    first_result.tool_call_id = Some("call_a".into());
    let mut second_result = message("tool", "found go");
    second_result.tool_call_id = Some("call_b".into());
    let messages = [
        message("system", "rules"),
        message("user", "search"),
        assistant,
        first_result,
        second_result,
    ];
    let tools =
        [json!({"name":"search","description":"Find code","inputSchema":{"type":"object"}})];
    let mut request = request(&messages, &tools);
    request.reasoning = ReasoningMode::Anthropic;
    request.effort = Some("high");
    let body: Value =
        serde_json::from_slice(&request_body(Protocol::Anthropic, request).unwrap()).unwrap();
    assert_eq!(body["system"], "rules");
    assert_eq!(body["messages"].as_array().unwrap().len(), 3);
    assert_eq!(body["messages"][1]["content"], Value::Array(blocks));
    assert_eq!(body["messages"][2]["role"], "user");
    assert_eq!(body["messages"][2]["content"].as_array().unwrap().len(), 2);
    assert_eq!(body["messages"][2]["content"][1]["tool_use_id"], "call_b");
    assert_eq!(body["tools"][0]["input_schema"], json!({"type":"object"}));
    assert_eq!(body["thinking"]["budget_tokens"], 3072);
    assert_eq!(body["max_tokens"], 4096);
}

#[test]
fn anthropic_thinking_budget_never_reaches_output_limit_and_has_a_minimum() {
    let messages = [message("user", "hello")];
    for max_output in [1, 256, 1024, 2047] {
        let mut request = request(&messages, &[]);
        request.reasoning = ReasoningMode::Anthropic;
        request.effort = Some("low");
        request.max_output_tokens = max_output;
        assert!(request_body(Protocol::Anthropic, request).is_err());
    }
    let mut request = request(&messages, &[]);
    request.reasoning = ReasoningMode::Anthropic;
    request.effort = Some("low");
    request.max_output_tokens = 2048;
    let body: Value =
        serde_json::from_slice(&request_body(Protocol::Anthropic, request).unwrap()).unwrap();
    assert_eq!(body["thinking"]["budget_tokens"], 1024);
}

#[test]
fn token_usage_rejects_negative_overflow_and_impossible_subsets() {
    assert!(openai_usage(&json!({"prompt_tokens":-1,"completion_tokens":1})).is_err());
    assert!(openai_usage(&json!({"prompt_tokens":2,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":3}})).is_err());
    assert!(openai_usage(&json!({"prompt_tokens":2,"completion_tokens":1,"completion_tokens_details":{"reasoning_tokens":2}})).is_err());
    let mut decoder = AnthropicDecoder::default();
    assert!(
        decoder
            .merge_usage(&json!({"input_tokens":u64::MAX,"cache_read_input_tokens":1}))
            .is_err()
    );
}

#[test]
fn endpoint_validation_preserves_api_prefixes_and_rejects_unsafe_urls_without_echoing() {
    let client = Client::new(
        Protocol::OpenaiCompatible,
        "https://api.example/v1",
        Some("test-key"),
    )
    .unwrap();
    assert_eq!(
        client.url("chat/completions").unwrap().as_str(),
        "https://api.example/v1/chat/completions"
    );
    for endpoint in [
        "http://localhost:1234/v1",
        "http://127.0.0.2/v1",
        "http://[::1]:1234/v1",
    ] {
        assert!(validate_endpoint(endpoint).is_ok());
    }
    for endpoint in [
        "http://remote.example/v1",
        "https://secret:password@api.example/v1",
        "https://api.example/v1?api_key=secret",
        "https://api.example/#secret",
        "file:///private/secret",
    ] {
        let error = validate_endpoint(endpoint).unwrap_err();
        assert!(!error.contains("secret"));
        assert!(!error.contains("api.example"));
    }
    let error = Client::new(
        Protocol::Anthropic,
        "https://api.example/v1",
        Some("secret\nkey"),
    )
    .err()
    .unwrap();
    assert_eq!(error, "The provider credential is invalid.");
}

#[test]
fn request_serialization_rejects_missing_tool_ids_and_invalid_json_arguments() {
    let messages = [message("tool", "unpaired result")];
    assert!(request_body(Protocol::OpenaiCompatible, request(&messages, &[])).is_err());
    assert!(request_body(Protocol::Anthropic, request(&messages, &[])).is_err());
    let mut assistant = message("assistant", "");
    assistant.tool_calls.push(call("call_a", "search", "[1,2]"));
    assert!(request_body(Protocol::OpenaiCompatible, request(&[assistant], &[])).is_err());
}

fn capture_detail(state: &crate::harness::HarnessState) -> Value {
    serde_json::to_value(state.event_detail(1)).unwrap()
}

#[tokio::test]
async fn diagnostics_capture_raw_sse_with_fragmented_unicode_and_credentials() {
    let state = crate::harness::HarnessState::default();
    let mut trace = state.begin(1, crate::harness::ActivityKind::Request, "model/complete");
    let source = openai_tool_stream().replace("Run λ ", "Run λ credential-example ");
    let chunks = source
        .as_bytes()
        .iter()
        .map(|byte| Ok::<_, ()>(vec![*byte]))
        .collect::<Vec<_>>();
    decode_stream(
        Protocol::OpenaiCompatible,
        stream::iter(chunks),
        |_| {},
        Some(&trace),
        Some("credential-example"),
    )
    .await
    .unwrap();
    trace.finish(crate::harness::Outcome::Completed);
    let detail = capture_detail(&state);
    let response = detail["response"]["text"].as_str().unwrap();
    assert!(response.contains("Run λ "));
    assert!(response.contains("private reasoning"));
    assert!(response.contains("tool_calls"));
    assert!(response.contains("[DONE]"));
    assert!(!response.contains("credential-example"));
    assert!(detail["response"]["redactions"].as_u64().unwrap() > 0);
}

#[test]
fn response_capture_preserves_partial_and_invalid_utf8_as_explicit_bytes() {
    let state = crate::harness::HarnessState::default();
    let mut trace = state.begin(1, crate::harness::ActivityKind::Request, "model/complete");
    {
        let mut capture = ResponseCapture::new(Some(&trace), None, "sse");
        capture.feed(b"data: partial ");
        capture.feed(&[0xff, 0xe2]);
    }
    trace.finish(crate::harness::Outcome::Cancelled);
    let detail = capture_detail(&state);
    let response = detail["response"]["text"].as_str().unwrap();
    assert!(response.contains("data: partial "));
    assert!(response.contains("invalid UTF-8 bytes: [ff]"));
    assert!(response.contains("incomplete UTF-8 bytes: [e2]"));
}

fn local_provider<T: AsRef<[u8]> + Send + 'static>(
    responses: Vec<T>,
) -> (String, std::thread::JoinHandle<()>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        for response in responses {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut received = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let count = socket.read(&mut buffer).unwrap();
                if count == 0 {
                    break;
                }
                received.extend_from_slice(&buffer[..count]);
                if let Some(end) = received.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&received[..end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if received.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            socket.write_all(response.as_ref()).unwrap();
        }
    });
    (format!("http://{address}/v1"), server)
}

fn http_response(status: &str, content_type: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nX-Trace-Id: trace-visible\r\nSet-Cookie: session=test-cookie-secret\r\n\r\n{body}",
        body.len()
    )
}

#[tokio::test]
async fn diagnostics_capture_http_error_body_and_request_without_credentials() {
    let state = crate::harness::HarnessState::default();
    let mut trace = state.begin(1, crate::harness::ActivityKind::Request, "model/complete");
    let (endpoint, server) = local_provider(vec![http_response(
        "401 Unauthorized",
        "application/json",
        r#"{"error":{"message":"Detailed access rejection","token_budget":123}}"#,
    )]);
    let client = Client::new(
        Protocol::OpenaiCompatible,
        &endpoint,
        Some("test-api-secret"),
    )
    .unwrap();
    let messages = vec![message("user", "Full request source and context")];
    let error = client
        .complete(request(&messages, &[]), |_| {}, &trace)
        .await
        .unwrap_err();
    trace.finish(crate::harness::Outcome::error(&error));
    server.join().unwrap();
    let detail = capture_detail(&state);
    let serialized = detail.to_string();
    assert!(serialized.contains("Full request source and context"));
    assert!(serialized.contains("Detailed access rejection"));
    assert!(serialized.contains("token_budget"));
    assert!(serialized.contains("trace-visible"));
    assert!(
        detail["error"]["text"]
            .as_str()
            .unwrap()
            .contains("credential or access permissions")
    );
    assert!(!serialized.contains("test-api-secret"));
    assert!(!serialized.contains("test-cookie-secret"));
}

#[tokio::test]
async fn diagnostics_keep_every_discovery_page_and_partial_failed_stream() {
    let state = crate::harness::HarnessState::default();
    let mut trace = state.begin(1, crate::harness::ActivityKind::Request, "model/list");
    let (endpoint, server) = local_provider(vec![
        http_response(
            "200 OK",
            "application/json",
            r#"{"data":[{"id":"first-model","display_name":"First"}],"has_more":true,"last_id":"first-model"}"#,
        ),
        http_response(
            "200 OK",
            "application/json",
            r#"{"data":[{"id":"second-model","display_name":"Second"}],"has_more":false}"#,
        ),
    ]);
    let client = Client::new(Protocol::Anthropic, &endpoint, None).unwrap();
    assert_eq!(client.discover_models(&trace).await.unwrap().len(), 2);
    trace.finish(crate::harness::Outcome::Completed);
    server.join().unwrap();
    let detail = capture_detail(&state);
    let response = detail["response"]["text"].as_str().unwrap();
    assert!(response.contains("first-model"));
    assert!(response.contains("second-model"));
    assert!(
        detail["request"]["text"]
            .as_str()
            .unwrap()
            .contains("after_id=first-model")
    );

    let state = crate::harness::HarnessState::default();
    let mut trace = state.begin(1, crate::harness::ActivityKind::Request, "model/complete");
    let partial = openai_delta(json!({"content":"Useful partial output"}), Value::Null);
    let (endpoint, server) =
        local_provider(vec![http_response("200 OK", "text/event-stream", &partial)]);
    let client = Client::new(Protocol::OpenaiCompatible, &endpoint, None).unwrap();
    let messages = vec![message("user", "hello")];
    let error = client
        .complete(request(&messages, &[]), |_| {}, &trace)
        .await
        .unwrap_err();
    trace.finish(crate::harness::Outcome::error(&error));
    server.join().unwrap();
    let detail = capture_detail(&state);
    assert!(
        detail["response"]["text"]
            .as_str()
            .unwrap()
            .contains("Useful partial output")
    );
    assert!(
        detail["error"]["text"]
            .as_str()
            .unwrap()
            .contains("before the response was complete")
    );
}

#[tokio::test]
async fn binary_credential_headers_are_redacted_before_hex_rendering() {
    let state = crate::harness::HarnessState::default();
    let mut trace = state.begin(1, crate::harness::ActivityKind::Request, "model/complete");
    let (endpoint, server) = local_provider(vec![b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\nSet-Cookie: session=secret-\xff-value\r\nX-Plain: visible-\xff\r\n\r\n".to_vec()]);
    let client = Client::new(Protocol::OpenaiCompatible, &endpoint, None).unwrap();
    let response = client
        .http
        .get(client.url("models").unwrap())
        .send()
        .await
        .unwrap();
    server.join().unwrap();
    client.capture_headers(&response, &trace, "text");
    trace.finish(crate::harness::Outcome::Completed);
    let detail = capture_detail(&state);
    let response = detail["response"]["text"].as_str().unwrap();
    assert!(response.contains("set-cookie: [REDACTED credential]"));
    assert!(!response.contains("session=secret"));
    assert!(!response.contains("73, 65, 73, 73, 69, 6f, 6e"));
    assert!(response.contains("x-plain: [raw header bytes:"));
    assert_eq!(detail["response"]["redactions"], 1);
}

#[test]
fn only_canonical_openai_uses_native_responses() {
    for endpoint in [
        "https://api.openai.com/v1",
        "https://api.openai.com:443/v1/",
    ] {
        let client = Client::new(Protocol::OpenaiCompatible, endpoint, Some("fixture")).unwrap();
        assert!(client.responses.is_some());
    }
    for endpoint in [
        "http://127.0.0.1/v1",
        "https://api.openai.com:8443/v1",
        "https://api.openai.com/custom/v1",
        "https://api.openai.com.example/v1",
    ] {
        let client = Client::new(Protocol::OpenaiCompatible, endpoint, Some("fixture")).unwrap();
        assert!(client.responses.is_none());
    }
    assert!(
        Client::new(
            Protocol::Anthropic,
            "https://api.openai.com/v1",
            Some("fixture")
        )
        .unwrap()
        .responses
        .is_none()
    );
}

#[test]
fn openai_usage_preserves_missing_details_and_reported_zero() {
    let unknown = openai_usage(&json!({"prompt_tokens":10,"completion_tokens":2})).unwrap();
    assert_eq!(unknown.cached_input_tokens, None);
    assert_eq!(unknown.reasoning_output_tokens, None);
    let reported = openai_usage(&json!({"prompt_tokens":10,"completion_tokens":2,
        "prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":0}})).unwrap();
    assert_eq!(reported.cached_input_tokens, Some(0));
    assert_eq!(reported.reasoning_output_tokens, Some(0));
}
