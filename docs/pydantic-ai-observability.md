# pydantic-ai-agent-py Observability (SSOT)

First-class observability for the pydantic-ai runtime that connects Dapr
workflow traces with agent-level LLM/tool telemetry. **Deliberately NOT a port
of dapr-agent-py's hand-rolled telemetry stack** — the strategy is
*pydantic-ai-native first, thin platform contract on top*.

## Strategy

Three layers, smallest possible surface:

1. **Native pydantic-ai instrumentation carries LLM fidelity.** The model used
   inside the `call_llm` durable activity is wrapped in pydantic-ai's own
   `InstrumentedModel` (`src/telemetry/__init__.py::instrument_model`). That
   emits the OTel **GenAI semantic conventions** (`chat kimi-k3` CLIENT span:
   `gen_ai.request.*`, `gen_ai.response.*`, `gen_ai.usage.*`,
   `gen_ai.input.messages` / `gen_ai.output.messages` v5 format, tool
   definitions, `operation.cost`) plus native metrics
   (`gen_ai.client.token.usage`, `gen_ai.client.operation.time_to_first_chunk`).
   It binds to the **global OTel providers** — plain OTLP to the cluster
   collector; **no Logfire account / vendor coupling** (`logfire-api` stays the
   inert shim).
2. **Activity spans join the Dapr workflow trace.** Each durable activity
   (`call_llm`, `execute_tool <tool>`) opens a span via
   `telemetry.activity_span()`, parented on the inbound
   `WORKFLOW_BUILDER_TRACEPARENT` (sandbox-execution-api stamps it onto every
   agent-host pod via downward-API from pod annotations; it carries the
   BFF/orchestrator trace that the daprd sidecar workflow spans also join). Net
   effect: one distributed trace — BFF → orchestrator → daprd workflow/activity
   spans → agent activity spans → native `chat` span.
3. **Platform contract attrs live on the activity spans.** The BFF ClickHouse
   reader (`src/lib/server/otel/clickhouse.ts`) filters `otel.otel_traces` by
   `session.id` / `workflow.execution.id`; the curated views gate on
   `openinference.span.kind ∈ {LLM, TOOL}` and read `llm.token_count.*`,
   `llm.{input,output}_messages`, `tool.{name,arguments,result}`
   (`obs.llm_spans_mv` / `obs.tool_spans_mv`, stacks
   `observability-clickhouse-dev` initdb — the hub server dev forwards to).
   `call_llm` / `execute_tool` stamp exactly those keys after the fact (they
   hold response/usage/messages in hand). The nested native `chat` span has no
   `openinference.span.kind`, so curated views never double-count.

No collector or ClickHouse changes were needed: dev's forwarder collector
(OTLP → hub ClickHouse) and the Dapr sidecar tracing Config
(`openshell-sandbox-dapr`, sampling 1.0) are runtime-agnostic.

## Code map (services/pydantic-ai-agent-py)

| File | Role |
|---|---|
| `src/telemetry/__init__.py` | `init_telemetry()` (traces+metrics+logs OTLP, gated on `OTEL_EXPORTER_OTLP_ENDPOINT`), `activity_span()` (inbound-traceparent parenting), `instrument_model()`, `set_content_attr()` (60 KB cap + `.truncated` flag), `flush_telemetry()` (called per activity — per-session pods are reaped at session end) |
| `src/telemetry/session_tracing.py` | `get_current_trace_context()` — the vendored `event_publisher` lazily imports it to stamp `traceId`/`spanId` onto every session event (UI deep-links events → trace view) |
| `src/compaction/tokens.py` | `context_usage_fields()` (Kimi-K3 window math, same field contract as dapr-agent-py) — the publisher stamps `context_*` onto `agent.llm_usage`; Session Pulse Context % reads them |
| `src/workflow.py` | span open + OpenInference stamping in `call_llm` / `execute_tool`; `_span_base_attrs()` = `session.id`, `workflow.execution.id`, `dapr.workflow.instance_id`, `workflow_builder.turn_id`, `agent.turn`, `iteration` |
| `src/main.py` | `init_telemetry()` at import, before the workflow runtime starts |

The two lazy-import seams (`src.telemetry.session_tracing`,
`src.compaction.tokens`) intentionally match the module paths the vendored
`event_publisher.py` probes — creating them activated trace-link + context
stamping with zero publisher changes.

## Environment

| Var | Effect |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | master switch; unset → every helper no-ops (local dev, unit tests). Inherited from `dapr-agent-py-config` (`http://otel-collector.observability:4318`) |
| `OTEL_SERVICE_NAME` | **must be overridden to `pydantic-ai-agent-py`** — the pod also envFroms `dapr-agent-py-config`, whose value would mislabel spans. Stacks `pydantic-ai-agent-py-config` (appended after the dapr CM, k8s later-source-wins) carries the override |
| `OTEL_LOG_USER_PROMPTS` | content capture (prompts/completions/tool args+results on spans + `include_content` for native instrumentation); default true |
| `WORKFLOW_BUILDER_TRACEPARENT/TRACESTATE/BAGGAGE` | inbound trace context (SEA downward-API) |
| `OTEL_BSP_SCHEDULE_DELAY` / `OTEL_METRIC_EXPORT_INTERVAL` | batch cadence (2 s / 60 s defaults here) |
| `KIMI_CONTEXT_WINDOW` | context-window override for `context_*` stamps (default 1,048,576) |

## What each surface shows for pydantic runs

- **Run/session trace view + service graph**: full trace via `session.id`
  filter (activity spans + native chat spans), joined with daprd spans.
- **obs.llm_spans / agent conversation view**: model, prompt/completion/total
  tokens, cache reads, flattened `{role, content}` messages
  (`messages_io.openinference_messages`; the native `gen_ai.input.messages`
  on the chat span keeps full fidelity).
- **obs.tool_spans**: tool name/args/result, ERROR status on failure.
- **Session events**: every event stamped `traceId`/`spanId`; `agent.llm_usage`
  additionally carries `context_*` window occupancy (Pulse Context % now
  provider-truth for this runtime).
- **Metrics**: native `gen_ai.client.token.usage` (+ TTFT) via the collector
  metrics pipeline.
- **Logs**: stdlib logging shipped via OTLP LoggerProvider → `otel_logs`.

## Explicitly rejected

- **Porting dapr-agent-py's `claude_code.*` span tree / DaprAgentsInstrumentor
  stack** — ~9 modules of bespoke telemetry whose fidelity pydantic-ai now
  provides natively; only the platform *contract* (attr keys) was kept.
- **Logfire SaaS** — pydantic's own backend; we keep OTLP → collector →
  ClickHouse. The instrumentation classes work against any global provider.
- **Collector-side GenAI→OpenInference remapping** — config churn in stacks and
  it can't synthesize the flattened message arrays; app-side stamping is ~40
  lines where the data already is.
- **Spans from workflow code** (`agent_workflow` / `session_workflow`) — replay
  would duplicate them; daprd's sidecar spans already cover orchestration
  timing. Activities only.
