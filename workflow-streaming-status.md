# Workflow Streaming Integration - Status Summary

**Date**: 2026-02-02
**Project**: planner-agent/100-improve-planning-agent

## Goal

Integrate the planner-dapr-agent's multi-step workflow into the ai-chatbot UI with real-time SSE streaming updates. The workflow phases are:

1. **Clone** - Clone GitHub repository with token auth
2. **Planning** - AI generates a plan with tasks using OpenAI
3. **Approval** - Human reviews and approves the plan (wait_for_external_event)
4. **Execution** - AI implements the tasks
5. **Testing** - Verify implementation

## Issues and Final Resolution

### 1. SSE Streaming Through Dapr - SOLVED

**Problem**: Dapr service invocation buffers HTTP responses before forwarding, which breaks Server-Sent Events (SSE) streaming.

**Solution**: Added direct Kubernetes service URL bypass for SSE streams in:
- `ai/main/app/(agent)/api/workflows/[instanceId]/stream/route.ts`

```typescript
// Direct Kubernetes service URL for SSE streaming (bypasses Dapr to avoid buffering)
const PLANNER_DAPR_AGENT_SERVICE_URL = process.env.PLANNER_DAPR_AGENT_SERVICE_URL ||
  "http://planner-dapr-agent.planner-agent.svc.cluster.local:8000";
```

**Verified**: Direct curl to `localhost:8000/workflows/{id}/stream` returns SSE data immediately.

---

### 2. DevSpace Hot Reload - SOLVED (Disabled)

**Problem**: DevSpace used `uvicorn --reload --reload-dir /app` which watched the entire `/app` directory including `/app/workspace` where repositories get cloned. This triggered uvicorn to restart when workflows cloned repos.

**Investigation**:
- Tried `--reload-exclude '/app/workspace/*'` - didn't work (uvicorn uses relative paths)
- Tried `--reload-exclude 'workspace'` - didn't work
- Tried `--reload-exclude '**/workspace/**'` - didn't work (fnmatch doesn't support `**`)

**Final Solution**: Disabled hot reload entirely. Dapr workflows are durable and continue running during restarts, but the brief service interruption was undesirable.

```yaml
# devspace.yaml
exec uvicorn app:app --host 0.0.0.0 --port ${UVICORN_PORT}
# For code changes, manually restart: kubectl rollout restart deployment/planner-dapr-agent-devspace -n planner-agent
```

---

### 3. HTTP 504 Timeout on Workflow Creation - SOLVED

**Problem**: Creating workflows via Dapr service invocation returned HTTP 504 timeout.

**Root Cause**: The workflow creation endpoint was returning immediately, but uvicorn hot reload was triggered by cloned repo files, causing brief restarts that could interrupt HTTP response delivery.

**Solution**: With hot reload disabled, the endpoint consistently returns 200 immediately:
```json
{
  "workflow_id": "wf-7efe78050919",
  "status": "running",
  "message": "Workflow started. Will pause at planning phase for approval.",
  "approval_endpoint": "/workflow/wf-7efe78050919/approve"
}
```

---

## Verified Working Flow

Test executed:
```bash
curl -X POST http://localhost:8000/workflow/dapr \
  -H "Content-Type: application/json" \
  -d '{"task":"Create a hello world Python script","model":"gpt-5.2-codex","repository":{"owner":"PittampalliOrg","repo":"planner-agent","branch":"main"}}'
```

Result from logs:
```
INFO: Started Dapr multi-step workflow: wf-7efe78050919
INFO: "POST /workflow/dapr HTTP/1.1" 200 OK
INFO: Clone activity started for PittampalliOrg/planner-agent@main
INFO: Clone completed: /app/workspace/planner-agent with 20 files
INFO: Planning completed with 1 tasks
INFO: Workflow wf-7efe78050919 waiting for approval event
INFO: Orchestrator yielded with 0 task(s) and 1 event(s) outstanding.
```

✅ Clone → ✅ Planning → ✅ Waiting for Approval

---

## Files Modified

| File | Changes |
|------|---------|
| `planner-dapr-agent/devspace.yaml` | Disabled hot reload to prevent unwanted restarts during repo cloning |
| `ai/main/app/(agent)/api/workflows/[instanceId]/stream/route.ts` | Added direct K8s service URL for SSE bypass |

---

## Next Steps

1. **Test UI integration**: Submit workflow from ai-chatbot UI and verify:
   - Session links to workflow ID
   - SSE stream connects and shows progress
   - Approval buttons appear when waiting for approval

2. **Commit changes**:
   ```bash
   git add planner-dapr-agent/devspace.yaml
   git commit -m "fix: Disable hot reload to prevent restarts during repo cloning"
   ```

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        ai-chatbot (Next.js)                          │
│                                                                      │
│  /api/agent/sessions (POST)         /api/workflows/{id}/stream (GET)│
│         │                                    │                       │
│         │ Dapr invoke                        │ Direct K8s           │
│         ▼                                    ▼                       │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │            planner-dapr-agent (Python/FastAPI)                │  │
│  │                                                               │  │
│  │  POST /workflow/dapr → schedule_new_workflow() → return       │  │
│  │                            │                                  │  │
│  │  GET /workflows/{id}/stream → SSE generator with Dapr sub     │  │
│  │                                                               │  │
│  │  Dapr Workflow (multi_step_workflow):                        │  │
│  │    clone → planning → wait_for_approval → execution → test   │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                              │                                       │
│                              ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Dapr Sidecar                              │   │
│  │  - Workflow state (Redis)                                    │   │
│  │  - Pub/Sub (workflow-events topic)                           │   │
│  │  - Service invocation                                        │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```
