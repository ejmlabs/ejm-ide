//! Local tracing collection. Payload capture and retention belong to the IDE.
use super::{ActivityContext, HarnessSpan, Runtime};
use std::sync::{Mutex, Weak};
use tracing::{
    Dispatch, Metadata, Subscriber,
    field::{Field, Visit},
    span::{Attributes, Id, Record},
};
use tracing_subscriber::{
    Layer, Registry,
    layer::{Context, SubscriberExt},
    registry::LookupSpan,
};

const TARGET: &str = "ejm_ide::debug";

#[derive(Clone)]
pub(super) struct Collector {
    dispatch: Dispatch,
}

impl Collector {
    pub(super) fn new(runtime: Weak<Mutex<Runtime>>) -> Self {
        Self {
            dispatch: Dispatch::new(Registry::default().with(LocalLayer { runtime })),
        }
    }

    pub(super) fn begin(
        &self,
        activity_id: u64,
        trace_id: &str,
        operation: &str,
        parent: Option<&ActivityContext>,
    ) -> tracing::Span {
        // Explicit parents and a private dispatcher prevent ambient application
        // logs from becoming Debug records. No request or credential is a field.
        let parent_span = parent.and_then(|parent| parent.span.id());
        let parent_activity_id = parent.map_or(0, |parent| parent.id);
        tracing::dispatcher::with_default(&self.dispatch, || {
            tracing::info_span!(
                target: TARGET,
                parent: parent_span,
                "ide.activity",
                activity_id,
                trace_id,
                parent_activity_id,
                operation,
                status = "running",
                code = tracing::field::Empty,
            )
        })
    }
}

#[derive(Clone)]
struct SpanIdentity {
    activity_id: u64,
    trace_id: String,
    status: String,
    code: Option<String>,
}

#[derive(Default)]
struct SpanFields {
    activity_id: Option<u64>,
    trace_id: Option<String>,
    parent_activity_id: Option<u64>,
    status: Option<String>,
    code: Option<String>,
}

impl Visit for SpanFields {
    fn record_u64(&mut self, field: &Field, value: u64) {
        match field.name() {
            "activity_id" => self.activity_id = Some(value),
            "parent_activity_id" if value != 0 => self.parent_activity_id = Some(value),
            _ => {}
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        match field.name() {
            "trace_id" => self.trace_id = Some(value.to_owned()),
            "status" => self.status = Some(value.to_owned()),
            "code" => self.code = Some(value.to_owned()),
            _ => {}
        }
    }

    fn record_debug(&mut self, _field: &Field, _value: &dyn std::fmt::Debug) {}
}

struct LocalLayer {
    runtime: Weak<Mutex<Runtime>>,
}

impl<S> Layer<S> for LocalLayer
where
    S: Subscriber + for<'lookup> LookupSpan<'lookup>,
{
    fn enabled(&self, metadata: &Metadata<'_>, _context: Context<'_, S>) -> bool {
        metadata.target() == TARGET
    }

    fn on_new_span(&self, attributes: &Attributes<'_>, id: &Id, context: Context<'_, S>) {
        let mut fields = SpanFields::default();
        attributes.record(&mut fields);
        let Some(activity_id) = fields.activity_id else {
            return;
        };
        let Some(span) = context.span(id) else {
            return;
        };
        let parent = span
            .parent()
            .and_then(|parent| parent.extensions().get::<SpanIdentity>().cloned());
        let trace_id = parent
            .as_ref()
            .map(|parent| parent.trace_id.clone())
            .or(fields.trace_id);
        let Some(trace_id) = trace_id else {
            return;
        };
        let parent_id = parent
            .map(|parent| parent.activity_id)
            // A capacity-omitted parent has no Registry span, but its causal
            // identity remains useful as an explicit missing-parent marker.
            .or(fields.parent_activity_id);
        span.extensions_mut().insert(SpanIdentity {
            activity_id,
            trace_id: trace_id.clone(),
            status: fields.status.unwrap_or_else(|| "running".into()),
            code: None,
        });

        let Some(runtime) = self.runtime.upgrade() else {
            return;
        };
        let mut runtime = runtime.lock().unwrap_or_else(|error| error.into_inner());
        let Some(active) = runtime.active.get(&activity_id) else {
            return;
        };
        let projection = HarnessSpan {
            id: activity_id,
            trace_id,
            parent_id,
            connection_id: active.connection_id,
            kind: active.kind,
            name: active.name.clone(),
            started_at: active.started_at,
            ended_at: None,
            duration_ms: 0,
            status: "running",
            code: None,
            detail_version: 0,
            has_content: false,
            started: active.started,
        };
        runtime.spans.insert(activity_id, projection);
    }

    fn on_record(&self, id: &Id, values: &Record<'_>, context: Context<'_, S>) {
        let Some(span) = context.span(id) else {
            return;
        };
        let mut fields = SpanFields::default();
        values.record(&mut fields);
        let mut extensions = span.extensions_mut();
        if let Some(identity) = extensions.get_mut::<SpanIdentity>() {
            if let Some(status) = fields.status {
                identity.status = status;
            }
            if fields.code.is_some() {
                identity.code = fields.code;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::{ACTIVITY_CAPACITY, ActivityKind, HarnessState, Outcome};
    use tracing_subscriber::layer::Layered;

    fn registry_identity(span: &tracing::Span) -> (SpanIdentity, Option<u64>) {
        span.with_subscriber(|(id, dispatch)| {
            let subscriber = dispatch
                .downcast_ref::<Layered<LocalLayer, Registry>>()
                .expect("IDE spans use the local Registry");
            let span = subscriber
                .span(id)
                .expect("span is retained by its context");
            let identity = span
                .extensions()
                .get::<SpanIdentity>()
                .expect("IDE identity is attached to the Registry span")
                .clone();
            let parent = span.parent().map(|parent| {
                parent
                    .extensions()
                    .get::<SpanIdentity>()
                    .expect("causal parent uses the same Registry")
                    .activity_id
            });
            (identity, parent)
        })
        .expect("tracked activities have real tracing spans")
    }

    #[test]
    fn real_registry_ancestry_survives_explicit_completion_and_clear() {
        let state = HarnessState::default();
        let turn = state.begin(1, ActivityKind::Turn, "chat");
        let mut model =
            state.begin_with_parent(1, ActivityKind::Request, "model/complete", &turn.context());
        let context = model.context();
        model.finish(Outcome::Completed);
        assert_eq!(registry_identity(&context.span).0.status, "completed");
        assert_eq!(registry_identity(&context.span).1, Some(turn.id));
        state.clear();
        let tool = state.begin_with_parent(1, ActivityKind::Tool, "read_file", &context);
        let (identity, parent) = registry_identity(&tool.context.span);
        assert_eq!(identity.activity_id, tool.id);
        assert_eq!(identity.trace_id, turn.context.trace_id);
        assert_eq!(parent, Some(model.id));
        let snapshot = state.snapshot(None);
        let spans = snapshot["spans"].as_array().unwrap();
        assert!(!spans.iter().any(|span| span["id"] == model.id));
        assert_eq!(
            spans.iter().find(|span| span["id"] == tool.id).unwrap()["parentId"],
            model.id
        );
    }

    #[test]
    fn private_dispatcher_excludes_other_logs_and_foreign_parent_contexts() {
        let first = HarnessState::default();
        let second = HarnessState::default();
        let parent = first.begin_operation("first runtime");
        let child = second.begin_with_parent(1, ActivityKind::Request, "second", &parent.context());
        let (identity, actual_parent) = registry_identity(&child.context.span);
        assert_eq!(actual_parent, None);
        assert_ne!(identity.trace_id, parent.context.trace_id);
        tracing::dispatcher::with_default(&second.1.dispatch, || {
            let unrelated =
                tracing::info_span!(target: "dependency", "unrelated", content = "body");
            assert!(unrelated.is_disabled());
        });
        let fields = child.context.span.metadata().unwrap().fields();
        assert!(fields.field("status").is_some());
        assert!(fields.field("content").is_none());
        assert!(fields.field("request").is_none());
        assert!(fields.field("response").is_none());
        assert!(fields.field("credential").is_none());
        assert_eq!(second.snapshot(None)["spans"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn capacity_omitted_activities_do_not_allocate_registry_spans() {
        let state = HarnessState::default();
        let running: Vec<_> = (0..ACTIVITY_CAPACITY)
            .map(|_| state.begin_operation("running"))
            .collect();
        let mut omitted = state.begin_operation("omitted");
        assert!(omitted.context.span.is_disabled());
        omitted.finish(Outcome::Failed("expected_failure"));
        let snapshot = state.snapshot(None);
        assert_eq!(snapshot["spans"].as_array().unwrap().len(), running.len());
        assert_eq!(snapshot["activeOmitted"], 0);
        assert_eq!(snapshot["droppedSpans"], 1);
    }

    #[test]
    fn completed_context_keeps_outcome_but_does_not_create_an_ownership_cycle() {
        let state = HarnessState::default();
        let runtime = std::sync::Arc::downgrade(&state.0);
        let mut operation = state.begin_operation("quality.format");
        let context = operation.context();
        operation.finish(Outcome::Failed("formatter_error"));
        drop(operation);
        drop(state);
        let (identity, _) = registry_identity(&context.span);
        assert_eq!(identity.status, "failed");
        assert_eq!(identity.code.as_deref(), Some("formatter_error"));
        assert!(runtime.upgrade().is_some());
        drop(context);
        assert!(runtime.upgrade().is_none());
    }
}
