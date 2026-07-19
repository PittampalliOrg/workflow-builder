# Event-Driven Workflow Triggers (UI-parameterized, Dapr + Argo-Events native)

**Status:** DESIGN. Goal: let users configure, from the workflow-builder UI, a workflow that
**fires automatically whenever the right external signal arrives** (webhook, schedule, message/topic,
cloud queue, Git/SCM, k8s resource, …) — standardized and parameterizable, backed by the most
Dapr-native and Argo-Events-native mechanisms, GitOps-friendly.

This doc is the SSOT for the trigger model. It builds on `docs/event-driven-invocation-and-unified-hooks.md`
(which added the P1 pub/sub **agent**-trigger) and the dev-verified Argo-Events→workflow path recorded in
the memory note `project_argo_events_workflow_trigger`.

---

## 0. The one fact that shapes everything

**Dapr Workflow cannot be "triggered." A workflow instance is created ONLY by an explicit start call**
(`POST /v1.0/workflows/dapr/<name>/start`, SDK `schedule_new_workflow`). There is no native
"start-on-event" or "start-on-schedule." `wait_for_external_event` only _resumes_ a RUNNING workflow
(our approval-gate / `WEBHOOK` pause already uses it) — it never _starts_ one.

So every "trigger" is the same shape:

```
<event source>  →  Dapr/Argo ingress delivers signal to an app ROUTE  →  route calls workflow-START
                                                                          (deterministic instanceID = idempotency)
```

The design is therefore **not** "make workflows triggerable" — it's "standardize the ingress → one
idempotent start path, and let the UI parameterize which ingress backs each workflow."

---

## 1. Current state (what already exists)

- **One `trigger` start node** with `data.config.triggerType`. Today's values: `Manual`, `Webhook`, `MCP`.
  - `Webhook` → `POST /api/workflows/[id]/webhook` (API-key `wfb_…`, requires `triggerType==='Webhook'`),
    fires the orchestrator async (`src/routes/api/workflows/[workflowId]/webhook/+server.ts`).
  - `MCP` → exposed as an MCP tool (`src/lib/server/db/mcp/index.ts`, `…/mcp/.../execute`).
  - `Manual` → UI "Run" / `POST /api/workflows/[id]/execute` (session auth).
- **Internal start path** `POST /api/internal/agent/workflows/execute` (`X-Internal-Token` plus
  `X-Wfb-System-Principal: workflow-trigger`, body
  `{workflowId|workflowName, triggerData}`) — service-to-service; **this is the seam every trigger backend
  should call.**
- **Pub/sub agent-trigger** (P1/#251): NATS JetStream topic `workflow.agent-trigger` → BFF →
  starts an **agent session** (not a workflow). Proves the additive-pub/sub pattern + idempotency discipline.
- **Argo Events**: controller runs on hub AND dev; the gitops activity stream is the reference
  EventSource→Sensor→HTTP-ingest pattern. (dev-verified: a webhook EventSource+Sensor → the internal
  execute endpoint starts a workflow — `project_argo_events_workflow_trigger`.)

So we are already on the "single trigger node + type" model; what's missing is (a) more parameterized
categories, (b) durable always-on listeners per category, and (c) an **activation/reconcile** model that
provisions/tears-down the listener when a workflow is published.

---

## 2. UI model: ONE trigger node with a category, NOT per-source event nodes

**Recommendation: keep the single `trigger` start node and expand `triggerType` into a _category_ with
per-type parameterized config.** Render a distinct icon/label per category so it still _reads_ like
"pick your event source," but it stays one node.

| | **A. One trigger node + category (recommended)** | **B. A trigger category with N event-source node types (n8n/Activepieces style)** |
| ------------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Fit with SW 1.0 | ✅ one entry point — matches the spec's single start | ⚠️ needs multi-entry / synthetic-start semantics the interpreter doesn't model |
| Already built | ✅ `config.triggerType` exists + is read in 3 places | ✗ new node types + canvas + adapter work |
| Spec/canvas cleanliness | ✅ one node, one config panel | ✗ a node per source; "which one starts the run?" ambiguity |
| Parameterization | ✅ type-specific config schema (registry-driven) | ✅ per-node config |
| Visual "many sources" feel | ✅ via per-category icon + config panel | ✅ native |
| Multiple triggers per workflow | ➖ one active trigger/workflow (can extend to a list later) | ✅ naturally many |
| Migration risk | low (extends existing) | high (new model) |

**Verdict: Option A.** It's the smallest, lowest-risk change, reuses the existing field, and keeps the
"a workflow has one start" mental model. (If we ever need fan-in from multiple sources, model it as
multiple workflows publishing to one internal topic, not multiple start nodes.)

### Trigger categories to expose (UI)

`Manual` · `Webhook` · `Schedule` (cron/at) · `Event/Topic` (pub/sub) · `Cloud queue` (Kafka/SQS/RabbitMQ/…)
· `Git/SCM` (GitHub/GitLab) · `Resource` (k8s object change) · `MCP` (existing).

Each category's config is defined by a **trigger-kind registry** (see §4) so the UI panel + validation +
backing-resource provisioning are all data-driven — exactly how `runtime-registry.json` drives runtimes.

---

## 3. Backing mechanisms — the most native option per category

From the Dapr + Argo-Events research (sources at bottom). Dapr ranks by "native ingress that delivers a
signal to a route":

| Category | Most-native backing | Why / notes |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Schedule / delayed** | **Dapr Jobs API + Scheduler** (1.14+) | Durable (etcd-backed), **replica-deduplicated**, one-shot+delay+recurring+retry, carries a payload. Beats `bindings.cron` (in-memory, per-replica, fires on every replica). |
| **Event / topic** | **Dapr declarative `Subscription` v2alpha1** (CEL `routes.rules` + `deadLetterTopic`) | Hot-reloaded, no code; one topic content-routes to many workflow types. The unifying bus (see §5). |
| **Cloud queue / Kafka / MQTT / Service Bus / Event Hubs / GCP / SQS** | **Dapr input binding** per source, `scopes:[orchestrator]` | Native per-source connector → dedicated `/<binding-name>` route; least glue. |
| **Webhook / HTTP**                                                    | No native Dapr HTTP _input_ binding → **Argo Events webhook EventSource** OR the BFF terminates HTTP and **publishes to the bus** | Dapr has no `bindings.http` input; don't invent one. Use Argo Events (rich) or BFF-publish (simple).                                                                        |
| **Git/SCM, Calendar, k8s Resource, Slack, Stripe, …** | **Argo Events EventSource** (27 source types) | Dapr has no connectors for these; Argo Events does. Hand off to the bus/route (see §6). |

**Key insight:** Dapr covers _queues, schedules, and topics_ natively and richly; **Argo Events covers the
"long tail" of event sources** (GitHub, calendar, k8s resource, Slack, Stripe, …) that Dapr has no binding
for. They are complementary, not competing.

---

## 4. Standardization: a trigger-kind registry + `spec.trigger`

Store the trigger on the workflow spec under `x-workflow-builder.trigger` (and mirror to a
`workflow_triggers` row when active):

```jsonc
// workflow spec
"x-workflow-builder": {
  "trigger": {
    "kind": "schedule",            // category id (registry key)
    "config": { "schedule": "@every 1h", "timezone": "America/New_York" },
    "triggerData": { "source": "nightly" }  // static defaults merged into the run input
  }
}
```

A **`trigger-registry.json`** (mirrors `runtime-registry.json`) declares each kind once:

```jsonc
{
  "schedule": {
    "label": "Schedule", "icon": "clock",
    "backing": "dapr-job",                 // dapr-job | dapr-subscription | dapr-binding | argo-eventsource
    "configSchema": { "schedule": {...}, "timezone": {...} },  // drives the UI panel + validation
    "provisioner": "scheduler"             // which reconciler builds the backing resource
  },
  "webhook":  { "label": "Webhook",  "backing": "argo-eventsource", "sourceType": "webhook", ... },
  "github":   { "label": "GitHub",   "backing": "argo-eventsource", "sourceType": "github",  ... },
  "topic":    { "label": "Event/Topic", "backing": "dapr-subscription", ... },
  "queue":    { "label": "Cloud queue", "backing": "dapr-binding", "bindingTypes": ["kafka","aws.sqs",...] }
}
```

This is the single source of truth the UI (config panel), the validator, and the reconciler all read —
the same drift-guarded generator pattern as the runtime registry.

---

## 5. The unifying spine: one internal topic → CEL-routed start

**Every backing funnels into ONE Dapr pub/sub topic** (`workflow.triggers`) carried on the existing NATS
JetStream, with **one declarative `Subscription`** that CEL-routes to a single start handler:

```yaml
apiVersion: dapr.io/v2alpha1
kind: Subscription
metadata: { name: workflow-triggers }
spec:
  pubsubname: pubsub
  topic: workflow.triggers
  routes:
    default: /api/internal/workflows/triggers/start   # one idempotent start handler
  deadLetterTopic: workflow.triggers-dlq
  scopes: [workflow-builder]
```

The start handler resolves `{workflowId, triggerData, dedupKey}` and calls the existing internal
execute path with a **deterministic instanceID derived from `dedupKey`** (Dapr ignores a duplicate active
instance ID → at-least-once becomes effectively-once). This is the same discipline as the P1 agent-trigger.

Why a single topic + CEL instead of N routes: hot-reloaded, no redeploy to add a workflow, free
dead-letter, and one place to enforce auth/idempotency/observability.

**How each backing reaches the spine:**

- `dapr-subscription` (topic triggers): publisher → `workflow.triggers` directly (or its own topic with a
  rule).
- `dapr-job` (schedule): Scheduler fires the job → job handler publishes to `workflow.triggers`.
- `dapr-binding` (queue): the input-binding route republishes to `workflow.triggers` (or starts directly).
- `argo-eventsource` (webhook/github/calendar/resource): Sensor → **HTTP trigger** to a BFF endpoint that
  publishes to `workflow.triggers` (see §6).

---

## 6. Argo Events ↔ Dapr handoff

Two viable bridges (no native connector exists):

- **(a) Sensor HTTP trigger → BFF internal endpoint (recommended default).** Sensor POSTs the mapped
  payload to `…/internal/workflows/triggers/ingest`; the BFF validates + publishes to `workflow.triggers`
  (or starts directly). Pros: reuses the proven dev-verified path; one place for auth/idempotency/mapping;
  no contention on Argo's JetStream. Cons: BFF must be up (mitigate with Sensor `retryStrategy` + idempotency key).
- **(b) Sensor NATS trigger → separate JetStream subject → Dapr `Subscription`.** Fully decoupled/buffered;
  use only with a **separate subject/stream** (Argo owns `default.*` durable consumers — don't share). Pros:
  bus-native fan-out. Cons: more moving parts; two consumers on one JetStream need careful naming.

**Default to (a)**; graduate specific high-volume sources to (b) if buffering/fan-out is needed. Both are
plain CRDs → GitOps-friendly.

Payload mapping (Argo `src{dependencyName,dataKey,contextKey,value}` → `dest`) carries event fields +
the CloudEvent id into `triggerData` + the dedup key — exactly as dev-verified.

---

## 7. "Publish so it fires on the signal" — the activation/reconcile model

A workflow gains an **Active** toggle (separate from save). Activation is a reconcile loop, not a one-shot:

1. User sets the trigger (kind + config) in the UI and toggles **Active**.
2. BFF writes a `workflow_triggers` row `{workflowId, kind, config, dedupSalt, status: 'activating', backingRef}`.
3. A **trigger reconciler** (BFF service, mirrors the lifecycle controller) provisions the backing resource
   for the kind:
   - `dapr-job` → `POST /v1.0/jobs/<wf-trigger-id>` (Scheduler).
   - `dapr-subscription` / `dapr-binding` / `argo-eventsource` → render the CR/Component and apply via
     **GitOps** (preferred, like the runtime-registry copies) or the kube client for ephemeral/dev.
4. Row → `status:'active'`. Deactivate/delete tears the backing resource down (idempotent).
5. **Single-owner + idempotency:** the instanceID is `derive(workflowId, dedupKey)`; re-delivery is a no-op;
   the reaper/lifecycle controller already handles terminal cleanup.

Production resources go through **stacks GitOps** (model: hub `gitops-activity-events/`); dev may apply
directly for fast iteration (as we did in the verified test). Drift-guard the registry-generated copies.

---

## 8. Recommended architecture (synthesis)

```
                       ┌─────────────── workflow-builder UI ───────────────┐
                       │ trigger node → category + parameterized config     │
                       │ (trigger-registry.json drives panel + validation)  │
                       └───────────────┬───────────────────────────────────┘
                                       │ save + Activate
                       ┌───────────────▼───────────────┐
                       │ Trigger reconciler (BFF)       │  workflow_triggers (status, backingRef, dedup)
                       │ provisions backing per kind →  │
                       └──┬──────────┬──────────┬───────┘
        schedule ─────────┘          │          └──────────── webhook/github/calendar/resource
   Dapr Jobs/Scheduler        topic / queue            Argo Events EventSource → Sensor
        │                Dapr Subscription / input binding        │ (HTTP trigger, default)
        └──────────┬───────────────┬────────────────────────────┘
                   ▼               ▼
          publish → Dapr topic `workflow.triggers`  (NATS JetStream; CEL-routed Subscription; DLQ)
                   │
                   ▼
          /api/internal/workflows/triggers/start   →  StartInstance(deterministic instanceID)
                   │
                   ▼
            Dapr Workflow run (the SW 1.0 workflow)  →  visible in /runs, previewable, etc.
```

**One sentence:** standardize on a **single trigger node + category** in the UI, a **trigger-kind registry**
for parameterization, **Dapr-native ingress per class** (Jobs/Scheduler for time, Subscriptions for topics,
input bindings for queues) plus **Argo Events for the source long-tail**, all funneled through **one
`workflow.triggers` topic → one idempotent start handler**, provisioned by an **activation reconciler**.

---

## 9. Phased plan

- **P1 — Unify the start spine.** Add `POST /api/internal/workflows/triggers/start` (idempotent, deterministic
  instanceID) + a `workflow.triggers` Dapr `Subscription`. Make the existing webhook route publish to it.
  (Generalizes P1 agent-trigger to workflows.)
- **P2 — Trigger-kind registry + UI.** `trigger-registry.json` + generator; trigger-node config panel renders
  per-kind parameterized fields; persist `x-workflow-builder.trigger`. Validation.
- **P3 — Schedule (Dapr Jobs) + Topic (Subscription).** Reconciler provisions a Dapr Job / extra Subscription
  rule on Activate. The cheapest, fully-Dapr-native categories first.
- **P4 — Argo Events categories (Webhook/GitHub/Calendar/Resource).** Reconciler renders EventSource+Sensor
  (HTTP→ingest→publish) via GitOps; the dev-verified pattern, generalized + parameterized.
- **P5 — Cloud-queue input bindings** (Kafka/SQS/…) + the **Active** lifecycle UI (toggle, status, last-fired).

Each phase is independently shippable and dev-testable (the §0–§7 path is already dev-proven end-to-end for
the Argo-webhook case).

## 10. Risks / decisions

- **Idempotency is mandatory** (at-least-once everywhere) — deterministic instanceID from `dedupKey`; never
  trust a single delivery. Already our discipline.
- **Don't share Argo's JetStream stream/subjects** if using the NATS bridge — separate subject/stream.
- **cron binding is per-replica/in-memory** — use Dapr Jobs/Scheduler for schedules (durable, dedup).
- **Auth on inbound HTTP** — internal-token for service callers; per-trigger signing secret for public webhooks
  (don't accept arbitrary `workflowId` from the public internet without a workflow-scoped secret).
- **GitOps vs direct apply** — production backings via stacks GitOps; dev may direct-apply for iteration.
- **No dispatch migration** — this is _additive_ (start the existing workflow), consistent with
  `event-driven-invocation-and-unified-hooks.md`; we do NOT change how nodes dispatch.

## References

- Dapr: [Bindings](https://docs.dapr.io/developing-applications/building-blocks/bindings/bindings-overview/) ·
  [Cron binding](https://docs.dapr.io/reference/components-reference/supported-bindings/cron/) ·
  [Jobs/Scheduler](https://docs.dapr.io/developing-applications/building-blocks/jobs/jobs-overview/) ·
  [Jobs API](https://docs.dapr.io/reference/api/jobs_api/) ·
  [Pub/sub subscription methods](https://docs.dapr.io/developing-applications/building-blocks/pubsub/subscription-methods/) ·
  [Message routing](https://docs.dapr.io/developing-applications/building-blocks/pubsub/howto-route-messages/) ·
  [Dead-letter topics](https://docs.dapr.io/developing-applications/building-blocks/pubsub/pubsub-deadletter/) ·
  [Workflow features](https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-features-concepts/) ·
  [Component scopes](https://docs.dapr.io/operations/components/component-scopes/)
- Argo Events: [EventSource](https://argoproj.github.io/argo-events/concepts/event_source/) ·
  [Sensor](https://argoproj.github.io/argo-events/concepts/sensor/) ·
  [JetStream EventBus](https://argoproj.github.io/argo-events/eventbus/jetstream/) ·
  [NATS trigger](https://argoproj.github.io/argo-events/sensors/triggers/nats-trigger/) ·
  [HTTP trigger](https://argoproj.github.io/argo-events/sensors/triggers/http-trigger/) ·
  [Parameterization](https://argoproj.github.io/argo-events/tutorials/02-parameterization/)
- Internal: `docs/event-driven-invocation-and-unified-hooks.md`, memory `project_argo_events_workflow_trigger`.
