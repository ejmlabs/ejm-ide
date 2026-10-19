//! The IDE adapts providers and editor tools to the shared ejm-harness engine.
use super::*;
use async_trait::async_trait;
use ejm::{ContextPolicy, RunStrategy};
use ejm_harness as ejm;
use tokio_util::sync::CancellationToken;

type Binding = Arc<Mutex<Option<Arc<BoundRun>>>>;

#[derive(Clone)]
pub(super) struct Core {
    harness: ejm::Harness,
    binding: Binding,
}

pub(super) struct RunInput {
    pub host: ToolHost,
    pub profile: ProviderProfile,
    pub client: Client,
    pub model: String,
    pub effort: Option<String>,
    pub store: AgentStore,
    pub session_id: String,
    pub turn: StoredTurn,
    pub history: Vec<Message>,
    pub total: Usage,
}

struct BoundRun {
    host: ToolHost,
    profile: ProviderProfile,
    client: Client,
    model: String,
    effort: Option<String>,
    store: AgentStore,
    session_id: String,
    history: Vec<Message>,
    data: Mutex<RunData>,
    calls: AtomicU64,
}

struct RunData {
    turn: StoredTurn,
    total: Usage,
    output_bytes: usize,
    tool_parents: HashMap<String, crate::harness::ActivityContext>,
}

impl BoundRun {
    fn data(&self) -> Result<std::sync::MutexGuard<'_, RunData>, String> {
        self.data
            .lock()
            .map_err(|_| "The chat projection is unavailable.".into())
    }

    async fn persist(&self) -> Result<(), String> {
        let turn = self.data()?.turn.clone();
        persist(&self.store, &self.host.root.path, &turn).await
    }

    fn check(&self) -> anyhow::Result<()> {
        self.host.check_current().map_err(anyhow::Error::msg)
    }
}

fn active(binding: &Binding) -> anyhow::Result<Arc<BoundRun>> {
    binding
        .lock()
        .map_err(|_| anyhow::anyhow!("The agent binding is unavailable."))?
        .clone()
        .ok_or_else(|| anyhow::anyhow!("No IDE turn is bound to the harness."))
}

struct BindingGuard(Binding);
impl Drop for BindingGuard {
    fn drop(&mut self) {
        if let Ok(mut binding) = self.0.lock() {
            binding.take();
        }
    }
}

impl Core {
    pub(super) async fn snapshot(&self) -> ejm::HarnessSnapshot {
        self.harness.status().await
    }

    pub(super) fn initialize(app: &AppHandle) -> Result<Self, String> {
        let binding = Binding::default();
        let tools = crate::agent_tools::specs()
            .into_iter()
            .map(|spec| {
                let name = spec["name"].as_str().unwrap_or_default().to_owned();
                Arc::new(EditorTool {
                    definition: ejm::ToolDefinition {
                        effect: if name == "workbench_write_file" {
                            ejm::Effect::Write
                        } else {
                            ejm::Effect::Read
                        },
                        name,
                        description: spec["description"].as_str().unwrap_or_default().to_owned(),
                        input_schema: spec["inputSchema"].clone(),
                        version: "1".into(),
                    },
                    binding: binding.clone(),
                }) as Arc<dyn ejm::Tool>
            })
            .collect();
        let config = ejm::HarnessConfig {
            state_dir: app
                .path()
                .app_data_dir()
                .map_err(|_| "The app data folder is unavailable.")?
                .join("harness"),
            max_sessions: 1,
            max_model_requests: 1,
            max_steps: MAX_ROUNDS as u32,
            context_max_bytes: 1024 * 1024,
            run_timeout_ms: TURN_TIMEOUT.as_millis() as u64,
            system_prompt: INSTRUCTIONS.into(),
            ..Default::default()
        };
        let harness = ejm::Harness::with_policies(
            config,
            Arc::new(ModelProvider(binding.clone())),
            tools,
            Arc::new(IdeContext(binding.clone())),
            Arc::new(IdeStrategy(binding.clone())),
        )
        .map_err(|error| format!("ejm-harness could not start: {error}"))?;
        Ok(Self { harness, binding })
    }

    pub(super) async fn session(
        &self,
        store: &AgentStore,
        root: &Path,
        thread: &str,
    ) -> Result<String, String> {
        let db = store.clone();
        let path = root.to_owned();
        let chat = thread.to_owned();
        if let Some(id) =
            tauri::async_runtime::spawn_blocking(move || db.harness_session(&path, &chat))
                .await
                .map_err(|_| "The harness session could not load.")??
        {
            return Ok(id);
        }
        let session = self
            .harness
            .create_session(ejm::SessionOptions {
                cwd: root.into(),
                title: "Edi chat".into(),
            })
            .await
            .map_err(|error| format!("The harness session could not start: {error}"))?;
        let id = session.id.clone();
        let db = store.clone();
        let path = root.to_owned();
        let chat = thread.to_owned();
        tauri::async_runtime::spawn_blocking(move || db.bind_harness_session(&path, &chat, &id))
            .await
            .map_err(|_| "The harness session could not be saved.")??;
        Ok(session.id)
    }

    pub(super) async fn run(
        &self,
        input: RunInput,
        cancellation: &Cancellation,
    ) -> (StoredTurn, Usage, Result<(), String>) {
        let prompt = core_prompt(&input.turn.messages[0].content, &input.turn.id);
        let run = Arc::new(BoundRun {
            host: input.host,
            profile: input.profile,
            client: input.client,
            model: input.model,
            effort: input.effort,
            store: input.store,
            session_id: input.session_id,
            history: input.history,
            data: Mutex::new(RunData {
                turn: input.turn,
                total: input.total,
                output_bytes: 0,
                tool_parents: HashMap::new(),
            }),
            calls: AtomicU64::new(0),
        });
        let result = self.drive(run.clone(), prompt, cancellation).await;
        let data = run
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (data.turn.clone(), data.total.clone(), result)
    }

    async fn drive(
        &self,
        run: Arc<BoundRun>,
        prompt: String,
        cancellation: &Cancellation,
    ) -> Result<(), String> {
        cancellation.check()?;
        run.host.check_current()?;
        {
            let mut binding = self
                .binding
                .lock()
                .map_err(|_| "The agent binding is unavailable.")?;
            if binding.is_some() {
                return Err("The shared harness is already running a turn.".into());
            }
            *binding = Some(run.clone());
        }
        let _guard = BindingGuard(self.binding.clone());
        let handle = self
            .harness
            .start(&run.session_id, prompt)
            .await
            .map_err(|error| format!("The harness could not start the turn: {error}"))?;
        let summary = finish_run(handle, cancellation).await?;
        match summary.status {
            ejm::RunStatus::Completed => Ok(()),
            ejm::RunStatus::Cancelled | ejm::RunStatus::Interrupted => {
                Err("The response was cancelled.".into())
            }
            _ => Err(summary
                .error
                .unwrap_or_else(|| "The response reached a harness limit.".into())),
        }
    }
}

async fn finish_run(
    mut handle: ejm::RunHandle,
    cancellation: &Cancellation,
) -> Result<ejm::RunSummary, String> {
    // A dropped handle does not stop the engine. Always cancel and drain before unbinding tools.
    tokio::select! {
        biased;
        _ = cancellation.wait() => {handle.cancel(); handle.wait().await},
        result = handle.wait() => result,
    }
    .map_err(|error| format!("The harness stopped: {error}"))
}

// Long source attachments enter through ContextPolicy; the journal retains a bounded prompt and its IDE turn reference.
fn core_prompt(text: &str, turn_id: &str) -> String {
    const MAX: usize = 16 * 1024;
    if text.len() <= MAX {
        return text.into();
    }
    let suffix = format!("\n[Full context is retained in IDE turn {turn_id}.]");
    let mut end = MAX - suffix.len();
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{suffix}", &text[..end])
}

fn canonical(message: &Message) -> anyhow::Result<ejm::Message> {
    let role = match message.role.as_str() {
        "user" => ejm::Role::User,
        "assistant" => ejm::Role::Assistant,
        "tool" => ejm::Role::Tool,
        _ => anyhow::bail!("Invalid conversation role."),
    };
    Ok(ejm::Message {
        role,
        content: message.content.clone(),
        tool_call_id: message.tool_call_id.clone(),
        is_error: message.is_error,
        artifact: message.artifact.clone(),
        continuation: message.continuation.clone(),
        tool_calls: message
            .tool_calls
            .iter()
            .map(|call| {
                Ok(ejm::ToolCall {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    arguments: serde_json::from_str(&call.arguments)?,
                })
            })
            .collect::<anyhow::Result<_>>()?,
    })
}

fn provider_messages(messages: &[ejm::Message], rich: &[Message]) -> anyhow::Result<Vec<Message>> {
    let mut occurrences: HashMap<Vec<u8>, Vec<usize>> = HashMap::new();
    for (index, candidate) in rich.iter().enumerate() {
        occurrences
            .entry(serde_json::to_vec(&canonical(candidate)?)?)
            .or_default()
            .push(index);
    }
    // Context is a suffix of the same ordered conversation. Consume matches so repeated text keeps its own signed reasoning.
    let mut cursor = rich.len();
    let mut result = Vec::with_capacity(messages.len());
    for message in messages.iter().rev() {
        let encoded = serde_json::to_vec(message)?;
        let index = occurrences.get(&encoded).and_then(|indices| {
            indices
                .partition_point(|index| *index < cursor)
                .checked_sub(1)
                .map(|slot| indices[slot])
        });
        if let Some(index) = index {
            cursor = index;
            result.push(rich[index].clone());
        } else {
            result.push(plain_provider_message(message));
        }
    }
    result.reverse();
    Ok(result)
}

fn plain_provider_message(message: &ejm::Message) -> Message {
    Message {
        role: match message.role {
            ejm::Role::User => "user",
            ejm::Role::Assistant => "assistant",
            ejm::Role::Tool => "tool",
        }
        .into(),
        content: message.content.clone(),
        tool_call_id: message.tool_call_id.clone(),
        is_error: message.is_error,
        artifact: message.artifact.clone(),
        continuation: message.continuation.clone(),
        blocks: vec![],
        reasoning_content: None,
        tool_calls: message
            .tool_calls
            .iter()
            .map(|call| crate::providers::driver::ToolCall {
                id: call.id.clone(),
                name: call.name.clone(),
                arguments: call.arguments.to_string(),
            })
            .collect(),
    }
}

fn context_messages(
    history: &[Message],
    turn: &StoredTurn,
    core: Vec<ejm::Message>,
    budget: usize,
) -> anyhow::Result<Vec<ejm::Message>> {
    let start = core
        .iter()
        .rposition(|message| message.role == ejm::Role::User)
        .ok_or_else(|| anyhow::anyhow!("The current turn is missing its prompt."))?;
    let mut current = core.into_iter().skip(start).collect::<Vec<_>>();
    current[0] = canonical(&turn.messages[0])?;
    for message in current.iter_mut().skip(1) {
        if message.role == ejm::Role::Tool
            && let Some(full) = turn
                .messages
                .iter()
                .rev()
                .find(|rich| rich.role == "tool" && rich.tool_call_id == message.tool_call_id)
        {
            *message = canonical(full)?;
        }
    }
    let mut messages = history
        .iter()
        .map(canonical)
        .collect::<anyhow::Result<Vec<_>>>()?;
    messages.extend(current);
    ejm::RecentContext.prepare(messages, budget)
}

struct IdeContext(Binding);
impl ContextPolicy for IdeContext {
    fn prepare(
        &self,
        messages: Vec<ejm::Message>,
        max_bytes: usize,
    ) -> anyhow::Result<Vec<ejm::Message>> {
        let run = active(&self.0)?;
        run.check()?;
        let data = run.data().map_err(anyhow::Error::msg)?;
        context_messages(&run.history, &data.turn, messages, max_bytes)
    }
}

struct IdeStrategy(Binding);
impl RunStrategy for IdeStrategy {
    fn decide(&self, response: &ejm::ModelResponse) -> anyhow::Result<ejm::StepDecision> {
        let run = active(&self.0)?;
        let count = run
            .calls
            .fetch_add(response.tool_calls.len() as u64, Ordering::Relaxed)
            + response.tool_calls.len() as u64;
        anyhow::ensure!(
            count <= MAX_TOOLS as u64,
            "The response reached its 64 tool-call limit."
        );
        ejm::ToolLoop.decide(response)
    }
}

struct ModelProvider(Binding);
#[async_trait]
impl ejm::Provider for ModelProvider {
    async fn stream(
        &self,
        request: ejm::ModelRequest,
        cancel: CancellationToken,
        _deltas: tokio::sync::mpsc::Sender<ejm::ModelDelta>,
    ) -> anyhow::Result<ejm::ModelResponse> {
        let run = active(&self.0)?;
        run.check()?;
        let mut messages = vec![message("system", request.system)];
        let item_id = uuid::Uuid::new_v4().to_string();
        let (item_index, message_index) = {
            let mut data = run.data().map_err(anyhow::Error::msg)?;
            let mut rich = run.history.clone();
            rich.extend_from_slice(&data.turn.messages);
            messages.extend(provider_messages(&request.messages, &rich)?);
            let item_index = data.turn.items.len();
            let message_index = data.turn.messages.len();
            data.turn
                .items
                .push(json!({"id":item_id,"type":"agentMessage","text":"","status":"inProgress"}));
            data.turn.messages.push(message("assistant", String::new()));
            (item_index, message_index)
        };
        let specs = request.tools.iter().map(|tool|json!({"name":tool.name,"description":tool.description,"inputSchema":tool.input_schema})).collect::<Vec<_>>();
        let diagnostics = run.host.app.state::<HarnessState>().inner().clone();
        let mut trace = diagnostics.begin_with_parent(
            run.host.connection_id,
            ActivityKind::Request,
            "model/complete",
            &run.host.trace_context,
        );
        let complete = run.client.complete(
            Request {
                model: &run.model,
                effort: run.effort.as_deref(),
                reasoning: run.profile.reasoning,
                messages: &messages,
                tools: &specs,
                max_output_tokens: run.profile.max_output_tokens.min(request.max_output_tokens),
            },
            |delta| {
                // Live UI hints are bounded by the driver. The engine journals the canonical response on completion.
                if let Ok(mut data) = run.data() {
                    data.turn.messages[message_index].content.push_str(delta);
                    data.turn.items[item_index]["text"] =
                        json!(data.turn.messages[message_index].content);
                }
                publish(
                    &run.host.app,
                    &run.profile.id,
                    &run.host.root.path,
                    &run.host.thread_id,
                    run.host.connection_id,
                    "item/agentMessage/delta",
                    json!({"itemId":item_id,"turnId":run.host.turn_id,"delta":delta}),
                );
            },
            &trace,
        );
        let result = tokio::select! {biased;_=cancel.cancelled()=>Err("The response was cancelled.".into()),result=complete=>result};
        let reply = match result {
            Ok(reply) => reply,
            Err(error) => {
                trace.record_error(&error);
                trace.finish(Outcome::error(&error));
                return Err(anyhow::Error::msg(error));
            }
        };
        if reply.finish_reason.is_none() {
            let error = "The provider did not finish its response.";
            trace.record_error(error);
            trace.finish(Outcome::Failed("incomplete_response"));
            anyhow::bail!(error);
        }
        if reply.text.is_empty() && reply.tool_calls.is_empty() {
            let error = "The provider returned an empty response. Try another model or send again.";
            trace.record_error(error);
            trace.finish(Outcome::Failed("empty_response"));
            anyhow::bail!(error);
        }
        trace.finish_with_bytes(Outcome::Completed, Some(reply.response_bytes));
        diagnostics.traffic(run.host.connection_id, reply.request_bytes, false, false);
        diagnostics.traffic(run.host.connection_id, reply.response_bytes, true, false);
        run.check()?;
        let calls = reply
            .tool_calls
            .iter()
            .map(|call| {
                Ok(ejm::ToolCall {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    arguments: serde_json::from_str(&call.arguments)?,
                })
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        {
            let mut data = run.data().map_err(anyhow::Error::msg)?;
            data.output_bytes = data
                .output_bytes
                .saturating_add(reply.text.len())
                .saturating_add(
                    reply
                        .tool_calls
                        .iter()
                        .map(|call| call.arguments.len())
                        .sum::<usize>(),
                );
            anyhow::ensure!(
                data.output_bytes <= MAX_TURN_OUTPUT,
                "The response exceeded its output limit."
            );
            anyhow::ensure!(
                data.tool_parents
                    .len()
                    .saturating_add(reply.tool_calls.len())
                    <= MAX_TOOLS,
                "The response exceeded its pending tool-call limit."
            );
            for call in &reply.tool_calls {
                data.tool_parents.insert(call.id.clone(), trace.context());
            }
            data.turn.messages[message_index] = Message {
                role: "assistant".into(),
                content: reply.text.clone(),
                tool_calls: reply.tool_calls,
                tool_call_id: None,
                is_error: false,
                artifact: None,
                blocks: reply.blocks,
                reasoning_content: reply.reasoning_content,
                continuation: reply.continuation.clone(),
            };
            if let Some(usage) = &reply.usage {
                add_usage(&mut data.turn.usage, usage);
                add_usage(&mut data.total, usage);
                data.turn.last_usage = Some(usage.clone());
                publish_usage(&run.host, &data.total, usage);
            }
            if reply.text.is_empty() {
                data.turn.items.remove(item_index);
            } else {
                let item = json!({"id":item_id,"type":"agentMessage","text":reply.text});
                data.turn.items[item_index] = item.clone();
                publish(
                    &run.host.app,
                    &run.profile.id,
                    &run.host.root.path,
                    &run.host.thread_id,
                    run.host.connection_id,
                    "item/completed",
                    json!({"turnId":run.host.turn_id,"item":item}),
                );
            }
        }
        run.persist().await.map_err(anyhow::Error::msg)?;
        let usage = reply.usage.unwrap_or_default();
        Ok(ejm::ModelResponse {
            content: reply.text,
            tool_calls: calls,
            usage: ejm::Usage {
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cached_input_tokens: usage.cached_input_tokens,
                reasoning_output_tokens: usage.reasoning_output_tokens,
            },
            continuation: reply.continuation,
        })
    }
}

struct EditorTool {
    definition: ejm::ToolDefinition,
    binding: Binding,
}
#[async_trait]
impl ejm::Tool for EditorTool {
    fn definition(&self) -> ejm::ToolDefinition {
        self.definition.clone()
    }

    async fn execute(
        &self,
        call: ejm::ToolCall,
        context: ejm::ToolContext,
    ) -> anyhow::Result<ejm::ToolOutput> {
        let run = active(&self.binding)?;
        run.check()?;
        anyhow::ensure!(
            context.session_id == run.session_id
                && context.cwd == run.host.root.path
                && !context.cancel.is_cancelled(),
            "The tool no longer belongs to the active IDE turn."
        );
        let mut item = json!({"id":call.id,"callId":call.id,"type":"dynamicToolCall","tool":call.name,"arguments":call.arguments,"status":"inProgress"});
        let (item_index, mut turn, mut total) = {
            let mut data = run.data().map_err(anyhow::Error::msg)?;
            let index = data.turn.items.len();
            data.turn.items.push(item.clone());
            (index, data.turn.clone(), data.total.clone())
        };
        publish(
            &run.host.app,
            &run.profile.id,
            &run.host.root.path,
            &run.host.thread_id,
            run.host.connection_id,
            "item/started",
            json!({"turnId":run.host.turn_id,"item":item}),
        );
        let diagnostics = run.host.app.state::<HarnessState>().inner().clone();
        let parent = run
            .data()
            .map_err(anyhow::Error::msg)?
            .tool_parents
            .remove(&call.id)
            .unwrap_or_else(|| run.host.trace_context.clone());
        let mut trace = diagnostics.begin_with_parent(
            run.host.connection_id,
            ActivityKind::Tool,
            &call.name,
            &parent,
        );
        let mut tool_host = run.host.clone();
        tool_host.trace_context = trace.context();
        trace.record_request(&call.arguments);
        let result = if call.name == "workbench_write_file" {
            let mut conversation = run.history.clone();
            conversation.extend_from_slice(&turn.messages);
            reviewed_write(
                &tool_host,
                &run.profile,
                &run.client,
                &run.model,
                &conversation,
                call.arguments,
                &mut turn,
                &mut total,
            )
            .await
        } else {
            tool_host.execute(&call.name, call.arguments).await
        };
        let (value, success) = match result {
            Ok(ToolResult { value, changes }) => {
                trace.record_response(&json!({"value": value, "changes": changes}));
                if let Some(changes) = changes {
                    item["changes"] = changes;
                }
                (value, true)
            }
            Err(error) => {
                trace.record_error(&error);
                let value = json!({"error": error});
                trace.record_response(&json!({"value": value, "changes": null}));
                (value, false)
            }
        };
        let content = value.to_string();
        trace.finish_with_bytes(
            if success {
                Outcome::Completed
            } else {
                Outcome::Failed("tool_rejected")
            },
            Some(content.len()),
        );
        item["status"] = json!(if success { "completed" } else { "failed" });
        item["success"] = json!(success);
        item["result"] = value;
        {
            let mut data = run.data().map_err(anyhow::Error::msg)?;
            data.output_bytes = data.output_bytes.saturating_add(content.len());
            anyhow::ensure!(
                data.output_bytes <= MAX_TURN_OUTPUT,
                "The response exceeded its output limit."
            );
            data.turn.usage = turn.usage;
            data.total = total;
            data.turn.items[item_index] = item.clone();
            data.turn.messages.push(Message {
                role: "tool".into(),
                content: content.clone(),
                tool_calls: vec![],
                tool_call_id: Some(call.id),
                is_error: !success,
                artifact: None,
                blocks: vec![],
                reasoning_content: None,
                continuation: None,
            });
        }
        publish(
            &run.host.app,
            &run.profile.id,
            &run.host.root.path,
            &run.host.thread_id,
            run.host.connection_id,
            "item/completed",
            json!({"turnId":run.host.turn_id,"item":item}),
        );
        run.persist().await.map_err(anyhow::Error::msg)?;
        Ok(ejm::ToolOutput {
            content,
            is_error: !success,
            ..Default::default()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn continuation(ciphertext: &str) -> ejm::ProviderContinuation {
        ejm::ProviderContinuation::OpenAiResponses {
            reasoning: vec![json!({
                "type": "reasoning",
                "id": format!("rs_{ciphertext}"),
                "encrypted_content": ciphertext,
            })],
        }
    }

    struct WaitingProvider(Arc<Notify>);
    #[async_trait]
    impl ejm::Provider for WaitingProvider {
        async fn stream(
            &self,
            _request: ejm::ModelRequest,
            cancel: CancellationToken,
            _deltas: tokio::sync::mpsc::Sender<ejm::ModelDelta>,
        ) -> anyhow::Result<ejm::ModelResponse> {
            self.0.notify_one();
            cancel.cancelled().await;
            anyhow::bail!("cancelled")
        }
    }

    #[tokio::test]
    async fn cancellation_drains_the_shared_engine_before_another_run() {
        let directory = tempfile::tempdir().unwrap();
        let entered = Arc::new(Notify::new());
        let harness = ejm::Harness::new(
            ejm::HarnessConfig {
                state_dir: directory.path().join("journal"),
                max_sessions: 1,
                ..Default::default()
            },
            Arc::new(WaitingProvider(entered.clone())),
            vec![],
        )
        .unwrap();
        let session = harness
            .create_session(ejm::SessionOptions {
                cwd: directory.path().into(),
                title: "Cancellation fixture".into(),
            })
            .await
            .unwrap();
        let handle = harness
            .start(&session.id, "Read the code".into())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), entered.notified())
            .await
            .unwrap();
        let cancellation = Cancellation::default();
        cancellation.cancel();
        let summary =
            tokio::time::timeout(Duration::from_secs(2), finish_run(handle, &cancellation))
                .await
                .unwrap()
                .unwrap();
        assert_eq!(summary.status, ejm::RunStatus::Cancelled);
        assert_eq!(harness.status().await.active_agents, 0);
        assert_eq!(harness.status().await.tools.running, 0);
        let handle = harness
            .start(&session.id, "A new message".into())
            .await
            .unwrap();
        let summary = finish_run(handle, &cancellation).await.unwrap();
        assert_eq!(summary.status, ejm::RunStatus::Cancelled);
        harness.shutdown().await.unwrap();
    }

    #[test]
    fn long_context_keeps_a_bounded_utf8_journal_prompt() {
        let text = "λ".repeat(20_000);
        let prompt = core_prompt(&text, "turn");
        assert!(prompt.len() <= 16 * 1024);
        assert!(prompt.contains("IDE turn turn"));
        assert_eq!(core_prompt("small", "turn"), "small");
    }

    #[test]
    fn provider_sidecars_require_an_exact_canonical_match() {
        let mut rich = message("assistant", "hello".into());
        rich.reasoning_content = Some("private".into());
        let mut core = canonical(&rich).unwrap();
        assert_eq!(
            provider_messages(&[core.clone()], &[rich.clone()]).unwrap()[0]
                .reasoning_content
                .as_deref(),
            Some("private")
        );
        core.content = "other".into();
        assert!(
            provider_messages(&[core], &[rich]).unwrap()[0]
                .reasoning_content
                .is_none()
        );
    }

    #[test]
    fn opaque_continuation_survives_canonical_serialization_and_plain_replay() {
        let mut rich = message("assistant", "Calling a tool".into());
        rich.continuation = Some(continuation("opaque-first"));
        rich.tool_calls.push(crate::providers::driver::ToolCall {
            id: "call".into(),
            name: "read".into(),
            arguments: "{\"path\":\"code.rs\"}".into(),
        });
        let canonical = canonical(&rich).unwrap();
        let restored: ejm::Message =
            serde_json::from_slice(&serde_json::to_vec(&canonical).unwrap()).unwrap();
        let replay = provider_messages(&[restored], &[]).unwrap();
        assert_eq!(json!(replay[0].continuation), json!(rich.continuation));
        assert_eq!(replay[0].tool_calls[0].id, "call");
        assert_eq!(
            replay[0].tool_calls[0].arguments,
            rich.tool_calls[0].arguments
        );
    }

    #[test]
    fn changed_continuation_never_restores_another_messages_rich_sidecars() {
        let mut rich = message("assistant", "Same text".into());
        rich.continuation = Some(continuation("first"));
        rich.blocks = vec![json!({"type":"thinking","signature":"first-signature"})];
        rich.reasoning_content = Some("first reasoning".into());
        let mut current = canonical(&rich).unwrap();
        current.continuation = Some(continuation("second"));
        let replay = provider_messages(&[current.clone()], &[rich]).unwrap();
        assert_eq!(json!(replay[0].continuation), json!(current.continuation));
        assert!(replay[0].blocks.is_empty());
        assert!(replay[0].reasoning_content.is_none());
    }

    #[test]
    fn tool_failure_and_artifact_survive_canonical_serialization_and_plain_replay() {
        let original = ejm::Message::tool(
            "failed-call",
            &ejm::ToolOutput {
                content: "Read failed".into(),
                is_error: true,
                artifact: Some("/workspace/results/failure.json".into()),
                ..Default::default()
            },
        );
        let restored: ejm::Message =
            serde_json::from_slice(&serde_json::to_vec(&original).unwrap()).unwrap();
        let replay = provider_messages(&[restored], &[]).unwrap();
        assert!(replay[0].is_error);
        assert_eq!(replay[0].artifact, original.artifact);
        let stored: Message =
            serde_json::from_slice(&serde_json::to_vec(&replay[0]).unwrap()).unwrap();
        assert_eq!(json!(canonical(&stored).unwrap()), json!(original));
    }

    #[test]
    fn changed_tool_metadata_does_not_restore_stale_rich_sidecars() {
        let mut rich = message("tool", "Same output".into());
        rich.tool_call_id = Some("call".into());
        rich.is_error = true;
        rich.artifact = Some("/workspace/results/first.json".into());
        rich.blocks = vec![json!({"type":"text","text":"old sidecar"})];
        rich.reasoning_content = Some("old sidecar".into());
        let mut changed_status = canonical(&rich).unwrap();
        changed_status.is_error = false;
        let mut changed_artifact = canonical(&rich).unwrap();
        changed_artifact.artifact = Some("/workspace/results/second.json".into());
        for current in [changed_status, changed_artifact] {
            let replay =
                provider_messages(std::slice::from_ref(&current), std::slice::from_ref(&rich))
                    .unwrap();
            assert_eq!(replay[0].is_error, current.is_error);
            assert_eq!(replay[0].artifact, current.artifact);
            assert!(replay[0].blocks.is_empty());
            assert!(replay[0].reasoning_content.is_none());
        }
    }

    #[test]
    fn repeated_messages_keep_their_own_reasoning_after_context_trimming() {
        let mut first = message("assistant", "Same answer".into());
        first.reasoning_content = Some("first reasoning".into());
        first.continuation = Some(continuation("first"));
        let mut second = first.clone();
        second.reasoning_content = Some("second reasoning".into());
        second.continuation = Some(continuation("second"));
        let rich = vec![
            message("user", "old".into()),
            first.clone(),
            message("user", "again".into()),
            second.clone(),
        ];
        let core = rich
            .iter()
            .map(canonical)
            .collect::<anyhow::Result<Vec<_>>>()
            .unwrap();
        let replay = provider_messages(&core[1..], &rich).unwrap();
        assert_eq!(replay[0].reasoning_content, first.reasoning_content);
        assert_eq!(replay[2].reasoning_content, second.reasoning_content);
        assert_eq!(json!(replay[0].continuation), json!(first.continuation));
        assert_eq!(json!(replay[2].continuation), json!(second.continuation));
        let replay = provider_messages(&core[3..], &rich).unwrap();
        assert_eq!(replay[0].reasoning_content, second.reasoning_content);
        assert_eq!(json!(replay[0].continuation), json!(second.continuation));
    }

    #[test]
    fn host_context_restores_full_tool_output_and_preserves_pairs() {
        let mut assistant = message("assistant", String::new());
        assistant.continuation = Some(continuation("tool-turn"));
        assistant
            .tool_calls
            .push(crate::providers::driver::ToolCall {
                id: "read".into(),
                name: "workbench_read_file".into(),
                arguments: "{}".into(),
            });
        let mut tool = message("tool", "source".repeat(4000));
        tool.tool_call_id = Some("read".into());
        tool.is_error = true;
        tool.artifact = Some("/workspace/results/diagnostic.json".into());
        let turn = StoredTurn {
            id: "t".into(),
            thread_id: "c".into(),
            provider_id: "p".into(),
            model: "m".into(),
            status: "inProgress".into(),
            error: None,
            items: vec![],
            messages: vec![
                message("user", "full prompt".into()),
                assistant.clone(),
                tool.clone(),
            ],
            usage: Usage::default(),
            last_usage: None,
        };
        let mut truncated = canonical(&tool).unwrap();
        truncated.content.truncate(16);
        truncated.is_error = false;
        truncated.artifact = None;
        let core = vec![
            ejm::Message::user("older turn"),
            ejm::Message::user("bounded prompt"),
            canonical(&assistant).unwrap(),
            truncated,
        ];
        let context =
            context_messages(&[message("user", "history".into())], &turn, core, 100_000).unwrap();
        assert_eq!(context.len(), 4);
        assert_eq!(context[1].content, "full prompt");
        assert_eq!(context[3].content, tool.content);
        assert!(context[3].is_error);
        assert_eq!(context[3].artifact, tool.artifact);
        assert_eq!(
            json!(context[2].continuation),
            json!(assistant.continuation)
        );
        let replay = provider_messages(&context, &turn.messages).unwrap();
        assert_eq!(json!(replay[2].continuation), json!(assistant.continuation));
        assert_eq!(replay[3].tool_call_id, tool.tool_call_id);
        assert!(replay[3].is_error);
        assert_eq!(replay[3].artifact, tool.artifact);
    }
}
