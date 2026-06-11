# Interactive CLI Sessions (`interactive-cli` runtime family) — SSOT

> Status: **IMPLEMENTED 2026-06** (v1: `claude-code-cli`). This is the SSOT for
> running agent CLIs (Claude Code now; Codex / Antigravity `agy` later) as
> first-class durable runtimes: the REAL TUI in a per-session Kueue-admitted
> sandbox pod, accessed through a web terminal, with the Dapr workflow wrapping
> the session LIFECYCLE and the transcript/status mirrored into
> `session_events`. Companion docs: `durable-session-runtime-contract.md`
> (registry contract), `workflow-lifecycle-termination.md` (stop SSOT),
> `agent-runtime-comparison.md`.

## What it is (one paragraph)

`services/cli-agent-py` is a host service (FastAPI :8002, image
`cli-agent-py-sandbox`, container `cli-agent-py`) that runs inside a
per-session agent-sandbox pod (workflow-builder ns, execution class
`interactive-cli` → LocalQueue `interactive-agent`). It supervises a headless
**herdr** server (terminal multiplexer with an agent-state socket API; replaces
tmux), launches the **real `claude` TUI** in a herdr pane (cwd `/sandbox`),
registers Dapr workflow `session_workflow` as a LIFECYCLE wrapper, and serves a
WS→PTY endpoint (`/terminal/{id}?target=main|shell`) that the BFF proxies to
the session page's xterm.js. The user types in the genuine TUI; the platform
still gets `session.status_*` + `user.message`/`agent.message`/
`agent.tool_use`/`agent.tool_result`/`agent.llm_usage` in the timeline, OTEL
metrics/logs, Kueue capacity mediation, and Lifecycle-Controller stop.

## The runtime (registry descriptor)

`services/shared/runtime-registry.json` id **`claude-code-cli`**: family
`interactive-cli`, `durabilityGranularity: "per-session"` (new enum value),
`mainContainerName: cli-agent-py`, `appIdConfigKey: CLAUDE_CODE_CLI_APP_ID`,
`imageEnvKey: AGENT_RUNTIME_CLAUDE_CLI_DEFAULT_IMAGE`, `instancePrefix:
durable-claude-cli`, plus two NEW descriptor fields:
- `executionClass: "interactive-cli"` — consulted by
  `agentWorkflowHostExecutionClass` before the env default.
- `cliAuth: {provider, tokenKind: subscription_oauth, envVar:
  CLAUDE_CODE_OAUTH_TOKEN, setupCommand: "claude setup-token"}` — drives the
  Settings page + spawn readiness gate generically.
- capability `interactiveTerminal: true` — gates the terminal-first session UI
  + the cli-terminal proxy.

**Dispatch invariants**: `durable/run` REJECTS family `interactive-cli`
(orchestrator `_resolve_native_agent_runtime` guard) — these sessions are
UI-initiated only. `benchmarkEligible: false`. Swap-safety: family crossings
involving `interactive-cli` are reject-class (`interactionModel` drop, needs
`opts.sourceFamily`).

## Event mirroring (three sources → CMA events)

1. **herdr semantic state** (`events.subscribe`): `working` →
   `session.status_running`; `idle` → `session.status_idle{stop_reason:
   end_turn}`; `blocked` → `session.status_idle{blocked: true, reason:
   permission_prompt|auth|awaiting_input}` (drives the amber "Needs input"
   badge + toast); pane exit / `done` → external event `{type: "cli.exited"}`
   raised onto the workflow, which durably emits `session.status_terminated`.
2. **Claude Code http hooks** (baked into the image at
   `/etc/claude-code/managed-settings.json`, POSTing to
   `127.0.0.1:8002/internal/hooks/claude`): UserPromptSubmit→`user.message`,
   PreToolUse→`agent.tool_use`, PostToolUse(Failure)→`agent.tool_result`,
   Permission*→`hook.decision`, Stop→transcript flush + workflow
   `turn.completed`, SessionEnd→`cli.session_end`.
3. **Transcript JSONL tailing** (`transcript_path` from the SessionStart hook;
   `CLAUDE_CONFIG_DIR=/sandbox/.claude`): assistant text → `agent.message`
   (block-array content), usage → `agent.llm_usage` (Session Pulse works
   unchanged).

## herdr facts (VERIFIED against a live 0.6.8 socket, protocol 13)

NDJSON over Unix socket (`HERDR_SOCKET_PATH=/sandbox/run/herdr.sock`):
- Launch = **`agent.start {name, argv, cwd?, env?}`** (creates its own
  workspace/pane; there is NO `pane.run` socket method). `agent.get {target}`;
  `agent_status ∈ unknown|working|blocked|idle|done` (unknown until herdr
  detects the CLI or `pane.report_agent` is called).
- `events.subscribe {subscriptions: [...]}` is REQUIRED-param; global variants:
  `pane.created/closed/exited`, `pane.agent_detected`; pane-scoped (concrete
  `pane_id`, no wildcard): `pane.agent_status_changed`. Streamed lines are
  `{"event": ..., "data": {...}}` — exits arrive as **`pane_exited`**
  (underscore, no exit code).
- Malformed-request errors echo `"id": ""` (client correlates via a
  singleton-pending fallback); subscription error acks may suffix the id.
- Attach: bare `herdr` attaches to the socket's server; **nested attach is
  refused** when HERDR_* pane markers are inherited — the WS→PTY endpoint
  strips all `HERDR_*` env except `HERDR_SOCKET_PATH`/`HERDR_CONFIG_PATH`.
- Config: `HERDR_CONFIG_PATH=/etc/herdr/config.toml` (baked in `/etc` because
  the pod mounts an emptyDir over the user `.config`, which would shadow it).
- Licensing: AGPL-3.0 — we ship the UNMODIFIED upstream binary (pinned version
  + sha256) with the license notice at `/usr/share/doc/herdr/`. Never patch it
  without the commercial license.

## Auth (personal subscription tokens — NOT cluster API keys)

- User runs `claude setup-token` locally (1-year, inference-only) and pastes it
  at **`/settings/cli-tokens`** → `user_cli_credentials` table (user-scoped —
  vaults are project-scoped and would share a personal token with the
  workspace; AES-256-CBC EncryptedObject, `expiresAt`).
- Spawn resolves the session owner's token (missing/expired → HTTP 412
  `CLI_TOKEN_MISSING|CLI_TOKEN_EXPIRED` + settings deep-link) and passes
  `sessionSecretEnv` to sandbox-execution-api, which creates per-session Secret
  `agent-host-cred-<appId>` (ownerRef → Sandbox CR, auto-GC) injected as a
  `secretKeyRef` env. Never in Dapr `childInput`, the CR YAML, spans (redacted)
  or logs.
- **SYSTEM INVARIANT: `ANTHROPIC_API_KEY`/`CLAUDE_API_KEY` must NEVER reach
  these pods** — env precedence silently outranks `CLAUDE_CODE_OAUTH_TOKEN` and
  flips billing from subscription to API. Enforced structurally
  (`agentHostEnvFrom` class override excludes the shared secret refs;
  `ExternalSecret cli-agent-py-secrets` carries ONLY `INTERNAL_API_TOKEN`), at
  startup (cli-agent-py crash-loops loudly if present), and by a
  sandbox-execution-api manifest unit test.
- Interactive TUI usage stays on subscription limits (the 2026-06-15 Agent SDK
  credit split affects only `-p`/SDK usage).

## Terminal access

Browser → BFF WS route `/api/v1/sessions/[id]/cli-terminal/[terminalId]`
(cookie/JWT + `resolveSessionRuntimeDebugTarget` scope + `interactiveTerminal`
gate via the `cli-terminal/resolve` preflight; registered in BOTH
`server-prod.js` and `vite.config.ts`) → pod `ws://{podIp}:8002/terminal/...`
with `X-Internal-Token` → PTY running `herdr` attach (binary frames = PTY
bytes; `\x01`-prefixed JSON = resize). Disconnect = herdr detach (CLI keeps
running); reconnect re-attaches; multi-tab = multi-client attach. `target=shell`
tabs give plain bash in the same pod. The kube-exec `/shell` route remains as
break-glass. Chat composer is hidden (type in the TUI); `raise-event`
`user.message` still injects text into the pane (goal-loop continuations).

## Kickoff + TUI text injection (readiness-gated)

The kickoff prompt (`initialMessage`) is stamped into `childInput.initialEvents`
by the BFF; `session_workflow` extracts the first `user.message`
(`_extract_seed_user_message`) and passes it to `start_cli`, which **arms** a
readiness-gated injection (`SessionSupervisor.arm_seed`, scheduled onto the app
loop from the activity worker thread). The supervisor types it into the TUI
only once herdr reports the agent **`idle`** (the pane has booted to its
prompt) — injecting during boot loses the keystrokes (the live failure that
motivated the gate). Invariants enforced by the supervisor:
- **idle = ready**, polled authoritatively via `agent.get` (committed
  event-stream state is a fallback only when herdr is unreachable — closes the
  ≈2s-debounce race where a just-sent message left a stale `idle`).
- **never type into a `blocked` dialog** — on gate timeout the send is best-
  effort ONLY when the TUI is not at a permission/auth prompt (Enter there
  would mis-answer it).
- **kickoff lands first** — mid-session injections (`session.user_events`
  batches from `raiseSessionUserEvents`, goal-loop continuations) await seed
  completion before sending.
- **serialized pane writes** — one `asyncio.Lock` across each `send_text`+Enter
  pair so concurrent senders never interleave keystrokes; the seed is
  exactly-once.
The raise-event handler accepts both `user.message` and the BFF's canonical
`session.user_events` `{events:[…]}` batch name. The injection marker is a
zero-width prefix the UserPromptSubmit hook strips, so the kickoff isn't
re-published (the BFF already recorded it in `session_events`).

## Lifecycle

`session_workflow` (lifecycle shape): `seed_session` (MCP `.mcp.json` from
`agentConfig.mcpServers` incl. goal-MCP auto-wire; skills materialized into
`~/.claude/skills`; system prompt via `--append-system-prompt-file`) →
`start_cli` (herdr `agent.start`) → durable loop (`session.lifecycle_events`
external events + idle-probe timer + `continue_as_new` every ~50 iterations) →
`stop_cli` (cooperative `/exit`, bounded wait, `pane.close`) →
`session.status_terminated` + contract return dict. Stop button →
Lifecycle Controller → management-parity endpoints
(`/api/v2/agent-runs/{id}/...`). Idle reap is host-driven (herdr idle >
`CLI_IDLE_TTL_SECONDS` AND no attached terminal clients → graceful exit).
Hard backstops: Sandbox `shutdownTime` (spawn sets `timeoutSeconds`) + the
fixed `workflow-builder-sandbox-gc` (now skips CRs with a future
`spec.shutdownTime` — the fix MUST be deployed before activation) +
`lifecycle-terminal-reaper`.

## Observability

Claude Code native OTEL (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, OTLP →
`otel-collector.observability:4318`): `claude_code.*` metrics (cost/tokens) +
log events, tagged `session.id` + `wfb.session.id` resource attr. Interactive
sessions IGNORE inbound TRACEPARENT → traces are flat in v1 (correlate by
session id). Host activities emit their own spans via the standard sidecar
tracing config.

## Capacity

Execution class `interactive-cli` (requests 500m/1Gi/4Gi-eph, limits
2/3Gi/12Gi-eph, non-root 10001, no OpenShell seed init) rides the
`interactive-agent` ClusterQueue (priority 1000, PSI admission) — ~6 concurrent
CLI sessions at current quota; bump `KueueCapacityProfiles` shares if needed.
The provisioning API reports a `queued` phase so the UI can show "Queued for
capacity" instead of a dead terminal.

## Adding the next CLI (codex / agy)

1. New `CliAdapter` in `services/cli-agent-py/src/cli_adapters/` (argv, seeding
   — e.g. codex `config.toml` `mcp_servers`, OTEL `[otel]`; agy
   `mcp_config.json`) + CLI binary in the image (or a per-CLI image via
   `imageEnvKey`).
2. New registry descriptor (`codex-cli` / `agy-cli`, family `interactive-cli`,
   own `cliAuth`) + `*_APP_ID` in orchestrator `core/config.py` + BFF env.
3. Token card appears automatically on `/settings/cli-tokens`; terminal,
   status mirroring (herdr detects Codex/Antigravity natively), spawn gating
   and lifecycle are CLI-agnostic.

## Deploy/activation checklist (first rollout)

1. stacks: sandbox-gc fix FIRST; then class JSON + ConfigMap + ExternalSecret +
   Role secrets verbs + Tekton trigger (all inert).
2. Merge `cli-agent-py` → outer-loop builds `cli-agent-py-sandbox` → pin
   `AGENT_RUNTIME_CLAUDE_CLI_DEFAULT_IMAGE` + the class `agentHostImage` to the
   `git-<sha>` tag.
3. Activation: BFF + orchestrator env `CLAUDE_CODE_CLI_APP_ID` (already in
   manifests) — registry descriptor ships with the wfb image.
4. Smoke (in-pod, one-time): herdr `agent.start` param echo, managed-settings
   `http` hook fields against the pinned CLI, `--append-system-prompt-file`
   flag presence, `pane.send_keys` Enter shape (CR fallback exists), xterm
   re-attach repaint after browser refresh.
