# Interactive CLI Sessions (`interactive-cli` runtime family) — SSOT

> Status: **IMPLEMENTED 2026-06** — `claude-code-cli`, **`codex-cli`**, and
> **`agy-cli`** (Antigravity). This is the SSOT for running agent CLIs as
> first-class durable runtimes: the REAL TUI in a per-session Kueue-admitted
> sandbox pod, accessed through a web terminal, with the Dapr workflow wrapping
> the session LIFECYCLE and the transcript/status mirrored into
> `session_events`. **ONE image (`cli-agent-py-sandbox`) hosts all three CLIs**;
> the BFF stamps `agentConfig.cliAdapter` (claude-code | codex | antigravity) so
> the host launches the right TUI, and they share the ONE `interactive-cli`
> execution class. Companion docs: `durable-session-runtime-contract.md`
> (registry contract), `workflow-lifecycle-termination.md` (stop SSOT),
> `agent-runtime-comparison.md`, `cli-conversation-durability.md` (making the
> CLI transcript durable + resumable — DB-backed FUSE vs statestore snapshot;
> prototype GO).

## What it is (one paragraph)

`services/cli-agent-py` is a host service (FastAPI :8002, image
`cli-agent-py-sandbox`, container `cli-agent-py`) that runs inside a
per-session agent-sandbox pod (workflow-builder ns, execution class
`interactive-cli` -> LocalQueue `interactive-agent`). It supervises a headless
**herdr** server (terminal multiplexer with an agent-state socket API; replaces
tmux), launches the real CLI TUI selected by `agentConfig.cliAdapter` in a herdr
pane (cwd `/sandbox`), registers Dapr workflow `session_workflow` as a lifecycle
wrapper, and serves a WS->PTY endpoint (`/terminal/{id}?target=main|shell`) that
the BFF proxies to the session page's xterm.js. In direct sessions, the user
types in the genuine TUI; in SW 1.0 `durable/run`, the workflow injects one
kickoff prompt and the hook completion signal ends the CLI turn. The platform
still gets `session.status_*` + `user.message`/`agent.message`/
`agent.tool_use`/`agent.tool_result`/`agent.llm_usage` when the adapter can emit
them, OTEL metrics/logs, Kueue capacity mediation, and Lifecycle-Controller stop.

## The runtime (registry descriptor)

`services/shared/runtime-registry.json` has one descriptor per CLI runtime
(`claude-code-cli`, `codex-cli`, `agy-cli`): family `interactive-cli`,
`durabilityGranularity: "per-session"` (new enum value), `mainContainerName:
cli-agent-py`, runtime-specific `appIdConfigKey` / `imageEnvKey` /
`instancePrefix`, plus two descriptor fields:
- `executionClass: "interactive-cli"` — consulted by
  `agentWorkflowHostExecutionClass` before the env default.
- `cliAuth: {provider, tokenKind: subscription_oauth, envVar:
  <RUNTIME_SECRET>, credentialKind: ...}` — drives the Settings page, spawn
  readiness gate, and workflow bridge credential injection generically.
- capability `interactiveTerminal: true` — gates the terminal-first session UI
  and the cli-terminal proxy.
- capability `workflowDispatch: "auto-turn"` — allows SW 1.0 `durable/run` to
  dispatch the runtime for a single prompt/turn and terminate on the hook signal.

**Dispatch invariants**: `durable/run` accepts only runtimes whose descriptor
declares `capabilities.workflowDispatch == "auto-turn"`; `browser-use-agent`
stays excluded. `benchmarkEligible: false` for the CLI runtimes. Swap-safety:
family crossings involving `interactive-cli` are reject-class for long-lived UI
sessions unless the caller explicitly requests the workflow auto-turn path.

## Event mirroring (adapter sources -> CMA events)

1. **herdr semantic state** (`events.subscribe`): `working` →
   `session.status_running`; `idle` → `session.status_idle{stop_reason:
   end_turn}`; `blocked` → `session.status_idle{blocked: true, reason:
   permission_prompt|auth|awaiting_input}` (drives the amber "Needs input"
   badge + toast); `done` → coerced to `session.status_idle` (herdr's `done` is
   a false positive after every turn — the TUI is back at its idle prompt, not
   exited — so the session stays alive between turns like the durable agents,
   wfb #133). A **real** exit arrives as a `pane_exited` event → external event
   `{type: "cli.exited"}` raised onto the workflow, which durably emits
   `session.status_terminated`. Other terminal paths: `cli.session_end` (claude
   SessionEnd hook), explicit stop, idle-TTL reaper.
2. **CLI hooks**: Claude Code uses the baked managed settings at
   `/etc/claude-code/managed-settings.json`, POSTing to
   `127.0.0.1:8002/internal/hooks/claude`. Codex and Antigravity write a
   per-session hook config during `seed()` and execute a small relay script that
   posts stdin JSON to `127.0.0.1:8002/internal/hooks/cli/{adapter}`. Claude
   maps UserPromptSubmit->`user.message`, PreToolUse->`agent.tool_use`,
   PostToolUse(Failure)->`agent.tool_result`, Permission*->`hook.decision`,
   Stop->transcript flush + workflow `turn.completed`, and
   SessionEnd->`cli.session_end`. Codex/Antigravity use their stop/end hook as
   the durable workflow completion signal; richer tool/usage events are emitted
   when the hook payload exposes enough structure.
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

## Auth (personal OAuth — NOT cluster API keys)

Each runtime's `cliAuth.credentialKind` picks ONE of three delivery models. All
OAuth; all keep usage on the USER's personal subscription, never a cluster key.

| Runtime | provider | `credentialKind` | What the user does | Delivery |
|---|---|---|---|---|
| `claude-code-cli` | anthropic | `env_token` | `claude setup-token` → paste `sk-ant-oat…` | secret env `CLAUDE_CODE_OAUTH_TOKEN`, read directly by claude |
| `codex-cli` | openai | `file` | `codex login` (browser ChatGPT OAuth) → paste `~/.codex/auth.json` | secret env `CODEX_AUTH_JSON` (the blob); the adapter `seed()` writes `$CODEX_HOME/auth.json` (0600) and STRIPS the env from the pane |
| `agy-cli` | google | `file_bundle` | direct session: authenticate in terminal once; workflow: use captured `~/.gemini` bundle | secret env `AGY_AUTH_JSON` when available/required; adapter restores the login bundle |

- **Storage**: `env_token`/`file` credentials live in `user_cli_credentials`
  (user-scoped — vaults are project-scoped and would share a personal credential
  with the workspace; AES-256-CBC EncryptedObject, `expiresAt`). The `value`
  column holds the opaque token (claude) OR the whole auth.json blob (codex).
  Validation is per-`credentialKind` (`assertPlausibleCliCredential`): claude
  rejects `sk-ant-api…`; codex must parse as JSON with a `tokens` block (an
  api-key auth.json is rejected); file bundles must be base64 gzip archives.
- **Spawn** (`spawn.ts`): for `env_token`/`file` it resolves the owner's
  credential (missing/expired → HTTP 412 `CLI_TOKEN_MISSING|CLI_TOKEN_EXPIRED` +
  settings deep-link) and passes `sessionSecretEnv: {[envVar]: value}` to
  sandbox-execution-api → per-session Secret `agent-host-cred-<appId>`
  (ownerRef → Sandbox CR, auto-GC) → `secretKeyRef` env. For direct UI sessions,
  `file_bundle` is optional so agy can still fall back to terminal device-code
  login and capture the bundle afterward; for SW 1.0 workflow dispatch the
  bridge requires the bundle up front because there is no operator to complete
  an interactive login. Never in Dapr `childInput`, the CR YAML, spans
  (redacted) or logs. `spawn.ts` also stamps `agentConfig.cliAdapter` from the
  descriptor so the host selects claude/codex/antigravity.
- **SYSTEM INVARIANT: provider API keys must NEVER reach these pods** — they
  silently outrank OAuth and flip billing to the metered API. Each adapter's
  `pane_env` strips them: claude (`ANTHROPIC_API_KEY`/`CLAUDE_API_KEY`), codex
  (`OPENAI_API_KEY`/`CODEX_API_KEY` + the `CODEX_AUTH_JSON` blob, since codex
  prefers an env credential over the file), agy
  (`ANTIGRAVITY_API_KEY`/`GEMINI_API_KEY`/`GOOGLE_API_KEY`/`GOOGLE_APPLICATION_CREDENTIALS`).
  Codex additionally sets `forced_login_method = "chatgpt"` in config.toml.
  Enforced structurally (`agentHostEnvFrom` class override excludes the shared
  agent secrets; `ExternalSecret cli-agent-py-secrets` carries ONLY
  `INTERNAL_API_TOKEN`) + each adapter's pane_env strip + a startup guard.
- **Credential paths in-pod** (writable sandbox emptyDir so auto-refresh
  persists for the session): codex `$CODEX_HOME=/sandbox/.codex`; agy
  `$HOME=/sandbox` -> `~/.gemini`.

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

`session_workflow` (lifecycle shape): `seed_session` (adapter-owned MCP config,
skills/system-prompt files, auth files, and hook config) →
`start_cli` (herdr `agent.start`) → durable loop (`session.lifecycle_events`
external events + idle-probe timer + `continue_as_new` every ~50 iterations) →
`stop_cli` (cooperative `/exit`, bounded wait, `pane.close`) →
`session.status_terminated` + contract return dict. Stop button →
Lifecycle Controller → management-parity endpoints
(`/api/v2/agent-runs/{id}/...`). Idle reap is host-driven (herdr idle >
`CLI_IDLE_TTL_SECONDS` AND no attached terminal clients → graceful exit).
Hard backstops: Sandbox `shutdownTime` (spawn sets `timeoutSeconds`) + the
fixed `workflow-builder-sandbox-gc` (now skips CRs with a future
`spec.shutdownTime` — the fix MUST be deployed before activation).

### SW 1.0 workflow auto-turn mode

When a Serverless Workflow v1.0 `durable/run` step selects a CLI runtime, the
BFF workflow bridge resolves the runtime descriptor, provisions the same
interactive sandbox host, injects the user's CLI credential as a session Secret,
and passes `autoTerminateAfterEndTurn: true` into `session_workflow`. The host
then starts the real CLI, injects the kickoff prompt, waits for a hook-derived
`turn.completed` event, captures the last assistant text it can recover from
the adapter/transcript, stops the CLI, and returns the normal durable/run result
contract with `agentRuntime` set to the selected CLI runtime.

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

## codex-cli + agy-cli (IMPLEMENTED 2026-06)

Both ride the SAME image + execution class as claude-code-cli; only the adapter,
descriptor, and credential model differ.

**`codex-cli`** (`CodexAdapter`, `cliAdapter: "codex"`): launches
`codex --dangerously-bypass-hook-trust --cd /sandbox --model <m> --sandbox
danger-full-access --ask-for-approval on-request` (the K8s pod is the real
isolation boundary, so codex's own landlock sandbox is off; approvals surface to
the live user; `permissionMode: bypass` →
`--dangerously-bypass-approvals-and-sandbox`). `seed()` writes
`$CODEX_HOME/config.toml` (`forced_login_method`, `[mcp_servers.<n>]` with
stdio command/args/env OR streamable-http `url` + `http_headers` +
`experimental_use_rmcp_client`), `$CODEX_HOME/hooks.json` with a Stop hook relay,
the system prompt → `AGENTS.md`, and the OAuth `auth.json` from the
`CODEX_AUTH_JSON` blob (0600). Codex auto-refreshes the token in-session. herdr
detects Codex state natively.

**`agy-cli`** (`AntigravityAdapter`, `cliAdapter: "antigravity"`): launches bare
`agy` (+ `--model` for a `gemini*` model; `--dangerously-skip-permissions` only
for bypass). `seed()` writes `$HOME/.gemini/config/mcp_config.json`
(`mcpServers` with remote `serverUrl` — NOT `url`), `$HOME/.gemini/config/hooks.json`
with a Stop hook relay, the system prompt → `GEMINI.md`, and a `settings.json`
pre-trusting `/sandbox`. Direct sessions may start without a credential bundle:
agy prints a Google OAuth URL+code on first launch and the user pastes the code
in the web terminal; the bundle can then be captured for future launches.
Workflow dispatch requires the captured `AGY_AUTH_JSON` bundle up front. herdr
detects agy by screen pattern (no native socket integration), so its mirror is
herdr-state-based; agy has no OTEL export. The pinned binary is a sha512-verified
GCS release tarball at `/usr/local/bin/agy` (root-owned read-only → defeats its
background self-update). The hook config is implemented from Antigravity's
Gemini-compatible hook layout and still needs an in-pod smoke against the pinned
binary before broad rollout.

To add another CLI: new `CliAdapter` + register in `cli_adapters/__init__.py`;
new registry descriptor (family `interactive-cli`, `cliAdapter`, `cliAuth` with
a `credentialKind`) + `*_APP_ID` in orchestrator `core/config.py` + BFF/orch
Deployment env; add the binary to `Dockerfile.sandbox`. Settings/terminal/spawn
are CLI-agnostic (driven off the descriptor).

## Deploy/activation checklist (first rollout)

1. stacks: sandbox-gc fix FIRST; then class JSON + ConfigMap + ExternalSecret +
   Role secrets verbs + Tekton trigger (all inert).
2. Merge `cli-agent-py` → outer-loop builds `cli-agent-py-sandbox` → pin the
   CLI runtime image env vars + the class `agentHostImage` to the `git-<sha>`
   tag.
3. Activation: BFF + orchestrator env for each CLI app-id
   (`CLAUDE_CODE_CLI_APP_ID`, `CODEX_CLI_APP_ID`, `AGY_CLI_APP_ID`) — registry
   descriptor ships with the wfb image.
4. Smoke (in-pod, one-time): herdr `agent.start` param echo, hook fields against
   each pinned CLI, `--append-system-prompt-file` flag presence for Claude,
   Codex Stop hook relay with `--dangerously-bypass-hook-trust`, Antigravity Stop
   hook relay against the pinned `agy`, `pane.send_keys` Enter shape (CR fallback
   exists), xterm re-attach repaint after browser refresh, and one SW 1.0
   `durable/run` auto-turn for each CLI runtime.
