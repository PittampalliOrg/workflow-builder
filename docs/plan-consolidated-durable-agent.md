# Plan: Consolidated Durable Agent Node

## Context

Three overlapping agent pieces exist: `AGENT_PIECE` (agent/run), `DURABLE_AGENT_PIECE` (durable/run), and `MASTRA_AGENT_PIECE` (mastra/*). All agent runs route to the same durable-agent service. The pieces expose different subsets of parameters, and the `agentId` field is never resolved end-to-end. This plan replaces all three with one optimal implementation and wires up complete agent resolution.

The Dapr-native ReAct loop (async generator with `callLlm` → parallel `runTool` via `whenAll` → `saveToolResults` → loop) is already implemented in `services/durable-agent/` and requires no changes.

---

## Steps

### Step 1: Fix `showWhen` for undefined values

**File:** `components/workflow/config/action-config-renderer.tsx` (line 171)

The `showWhen` check does `config[field.showWhen.field] !== field.showWhen.equals` — when `agentId` is `undefined` (never set), `undefined !== ""` hides inline fields on fresh nodes.

Fix: coerce to string:
```typescript
const dependentValue = String(config[field.showWhen.field] ?? "");
```

### Step 2: Replace all agent pieces with one definitive piece

**File:** `lib/actions/builtin-pieces.ts`

**Delete** `AGENT_PIECE` and the old `DURABLE_AGENT_PIECE`. **Delete** `MASTRA_AGENT_PIECE` (its discrete tool actions like `mastra/clone`, `mastra/read-file` etc. are redundant — the agent itself has these tools). Replace with a single comprehensive `DURABLE_AGENT_PIECE`:

```
configFields:
  agentId        dynamic-select   "Select a saved agent (optional)", defaultValue: ""
  prompt         template-textarea  Required, 6 rows
  ── Inline config (showWhen: { field: "agentId", equals: "" }) ──
  model          model-selector   default "openai/gpt-4o"
  instructions   template-textarea  "Custom system prompt", 6 rows
  tools          dynamic-multi-select  Workspace tool selection
  ── Always visible ──
  maxTurns       number           default 50
  timeoutMinutes number           default 30
  stopCondition  template-textarea  Optional, 4 rows

outputFields:
  text, toolCalls, fileChanges, patch, usage, agentWorkflowId
```

`getBuiltinPieces()` returns only `[MCP_PIECE, DURABLE_AGENT_PIECE]`.

### Step 3: Add dynamic options endpoints

**File:** `app/api/builtin/options/route.ts`

1. **tools for durable/run**: Handler returns workspace tool names. Try fetching live from `DURABLE_AGENT_API_BASE_URL/api/tools`, fallback to hardcoded list (`read_file, write_file, edit_file, list_files, delete_file, mkdir, file_stat, execute_command`).
2. **model for durable/run**: Extend the existing model handler to match `durable/run` action name.
3. **Clean up** any `agent/run` or `mastra/*` specific handlers.

### Step 4: Agent resolution in BFF

**File:** `app/api/orchestrator/workflows/route.ts`

Add `resolveAgentConfigs()` called before `startWorkflow()`:

1. Scan definition nodes for `durable/run` actionType with `agentId` set
2. Batch-fetch agent rows from `agents` table (`inArray` by id, filter by userId)
3. Inject `agentConfig` into node config:
   ```json
   {
     "agentConfig": {
       "name": "My Code Agent",
       "instructions": "You are...",
       "modelSpec": "anthropic/claude-opus-4-6",
       "maxTurns": 30,
       "timeoutMinutes": 30,
       "tools": ["read_file", "write_file", "edit_file"]
     }
   }
   ```
4. Matches existing `AgentConfigPayload` type in `durable-agent/src/service/main.ts:64-71`

New imports: `and, inArray` from drizzle-orm, `agents` from schema.

### Step 5: Forward agentConfig in Python orchestrator

**File:** `services/workflow-orchestrator/workflows/dynamic_workflow.py` (line ~1067)

Add to `activity_input` in `process_agent_child_workflow()`:
```python
"agentConfig": resolved_config.get("agentConfig"),
```

Also forward `instructions` and `tools` for inline config:
```python
"instructions": resolved_config.get("instructions"),
"tools": resolved_config.get("tools"),
```

Clean up the orchestrator routing: replace `agent/*` prefix check with `durable/*` only (since AGENT_PIECE is deleted, the `agent/` prefix is dead code). Update `process_agent_child_workflow` condition at line 304:
```python
if action_type.startswith("durable/") or action_type == "mastra/execute":
```

### Step 6: Handle inline config in durable-agent

**File:** `services/durable-agent/src/service/main.ts`

When no saved agent is selected but the user provides inline `model`/`instructions`/`tools`, construct an `agentConfig` from these. After the existing `agentConfig` check (line 507):

```typescript
if (!activeAgentOverridden && req.body?.model) {
  const inlineConfig: AgentConfigPayload = {
    name: "inline-agent",
    instructions: req.body.instructions || agent!.instructions || "",
    modelSpec: req.body.model,
    tools: parseJsonArray(req.body.tools),
  };
  if (inlineConfig.instructions && inlineConfig.modelSpec) {
    activeAgent = await getOrCreateConfiguredAgent(inlineConfig);
  }
}
```

---

## Files Modified

| File | Change |
|------|--------|
| `components/workflow/config/action-config-renderer.tsx` | Fix `showWhen` undefined coercion |
| `lib/actions/builtin-pieces.ts` | Delete AGENT_PIECE + MASTRA_AGENT_PIECE, replace DURABLE_AGENT_PIECE with comprehensive version |
| `app/api/builtin/options/route.ts` | Add tools handler, extend model handler, clean up legacy handlers |
| `app/api/orchestrator/workflows/route.ts` | Add `resolveAgentConfigs()` for agentId → agentConfig |
| `services/workflow-orchestrator/workflows/dynamic_workflow.py` | Forward agentConfig/instructions/tools, simplify routing to `durable/*` only |
| `services/durable-agent/src/service/main.ts` | Add inline config fallback in `/api/run` |

**No changes needed:**
- `services/durable-agent/src/workflow/agent-workflow.ts` — ReAct loop already Dapr-native
- `services/durable-agent/src/durable-agent.ts` — core agent class unchanged
- `lib/actions/types.ts` — existing `showWhen` type sufficient

## Verification

1. **Type-check**: `npx tsc --noEmit` passes
2. **UI: New node**: Add Durable Agent → all fields visible. Select saved agent → model/instructions/tools hide. Clear → reappear.
3. **Execution with saved agent**: durable/run + agentId → durable-agent logs `Using configured agent: <name>`
4. **Execution with inline config**: durable/run + custom model/instructions → agent uses inline settings
5. **Options endpoints**: Model dropdown and tools multi-select load correctly

## Status

**Implemented**: 2026-02-16 — All 6 steps completed, `tsc --noEmit` passes with exit code 0.
