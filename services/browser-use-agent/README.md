# browser-use-agent

Standalone durable browser-automation agent: the [browser-use](https://github.com/browser-use/browser-use)
framework hosted on the dapr-agents `DurableAgent` class, default model
**kimi-k3**. This is the in-repo replacement for the hand-built
`browser-use-agent-sandbox` image whose source was never checked in (see
`docs/browser-use-durable-agent.md` for the full evaluation and phasing).

## Architecture (P1 — executor seam)

- `src/agent.py` — `BrowserUseDurableAgent(DurableAgent)`: registers the
  platform `session_workflow` wrapper (same input shape, `session.status_*`
  vocabulary, and `autoTerminateAfterEndTurn` one-shot semantics as
  dapr-agent-py). The inner loop is NOT a chat/tool loop —
- `src/executor.py` — `BrowserUseExecutor(AgentExecutorBase)`: dapr-agents
  v1.0.4's native executor seam. One `run_executor` activity drives
  `browser_use.Agent` step-by-step via the public `take_step()` API, yielding
  `message` / `tool_call` / `tool_result` / `session` / `complete` events and
  mirroring them to the CMA session-event ingest.
- `src/kimi_llm.py` — resolves `agentConfig.modelSpec` (`kimi/kimi-k3`,
  `llm-kimi-k3`, bare) onto browser-use's OpenAI-compatible `ChatOpenAI`
  pointed at `KIMI_BASE_URL` with `KIMI_API_KEY`.
- The browser is **never in-process**: the agent attaches to the chromium
  sidecar (or a Browserstation lane) over CDP (`BROWSER_USE_CDP_URL`,
  default `http://localhost:9222`). Browser state survives activity retries
  in the remote Chromium.
- `src/event_publisher.py`, `src/session_native.py`, `src/session_config.py`
  are vendored byte-identical from `services/shared/session_events/` and
  `services/dapr-agent-py/src/`.

Durability granularity in P1 is **per-session** (the whole turn is one
retried activity, with same-pod forward-progress resume via saved
`AgentState` and between-step cancellation checks on the
`session-cancel:{instance}` key). The per-step-activity upgrade — matching
the registry's declared `per-activity` — is the P2 phase in the design doc.

## Key environment

| Variable | Default | Purpose |
|---|---|---|
| `KIMI_API_KEY` | — (required) | Kimi authentication |
| `KIMI_BASE_URL` | `https://api.kimi.com/coding/v1` | Kimi-for-Coding endpoint |
| `KIMI_DEFAULT_MODEL` | `kimi-k3` | Model when agentConfig has no modelSpec |
| `BROWSER_USE_CDP_URL` | `http://localhost:9222` | Remote Chromium attach |
| `BROWSER_USE_MAX_STEPS` | `40` | Step budget when agentConfig has no maxTurns |
| `BROWSER_USE_USE_VISION` | `true` | Screenshot vision in LLM prompts |
| `AGENT_STATE_STORE` | `dapr-agent-py-statestore` | Dapr state store (cancel keys, entries) |

## Develop

```bash
uv sync
uv run pytest tests/ -q
uv run uvicorn src.main:app --port 8002   # needs a Dapr sidecar for real runs
```
