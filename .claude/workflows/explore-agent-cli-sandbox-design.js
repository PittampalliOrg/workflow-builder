export const meta = {
  name: 'explore-agent-cli-sandbox-design',
  description: 'Explore sandbox/Kueue/session/runtime primitives in workflow-builder + stacks, and research agent CLI programmatic surfaces',
  phases: [
    { title: 'Explore', detail: 'parallel read-only exploration of workflow-builder + stacks repos' },
    { title: 'Research', detail: 'web research: Claude Code, Codex, Gemini CLI headless/ACP/OTEL surfaces' },
  ],
}

const FINDINGS = {
  type: 'object',
  required: ['summary', 'findings'],
  properties: {
    summary: { type: 'string', description: 'High-level summary of what was found' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['topic', 'detail'],
        properties: {
          topic: { type: 'string' },
          detail: { type: 'string', description: 'Concrete detail incl. function/endpoint names, env vars, event names' },
          files: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths (with line refs where useful)' },
        },
      },
    },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}

const WB = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const STACKS = '/home/vpittamp/repos/PittampalliOrg/stacks/main'

const READONLY = 'You are READ-ONLY: do not edit, write, or run any state-changing command. '

const explorePrompts = [
  {
    label: 'explore:runtime-contract',
    prompt: READONLY + `Explore the repo ${WB} (very thorough). Goal: understand EXACTLY what it takes to add a new durable agent runtime, and how the existing claude-agent-py runtime works, because we plan to add agent-CLI runtimes (Claude Code CLI, Codex CLI, Gemini CLI) following its pattern.

Investigate and report concretely (function names, endpoints, payload shapes, env vars, event type strings):
1. services/claude-agent-py/ — full anatomy: entrypoint, how Dapr workflow 'session_workflow' is registered, the whole-loop-in-one-activity pattern, how it invokes the Claude Agent SDK (does the SDK spawn the 'claude' CLI binary under the hood? check deps/Dockerfile), how agentConfig.mcpServers is wired into the SDK, how it emits CMA session events back to the BFF (which HTTP endpoint, which event types like agent.message/agent.tool_use/session.status_idle), how multi-turn interactivity works (does it wait for external events like user.message between turns? autoTerminateAfterEndTurn?), management endpoints (terminate/pause/resume/purge), OTEL/telemetry setup, required env vars + secrets (ANTHROPIC_API_KEY etc.), Dockerfile + image.
2. services/shared/runtime-registry.json — full descriptor schema for all 4 runtimes; scripts/sync-runtime-registry.mjs; src/lib/server/agents/runtime-registry.ts; src/lib/server/agents/swap-safety.ts. What fields would a NEW runtime need.
3. Direct (UI-initiated) session spawn: src/lib/server/sessions/spawn.ts — full flow: how the sandbox pod is requested (which API), what childInput contains, how Dapr StartInstance is called, how user messages reach a RUNNING session workflow (raise external event? which endpoint/event name?), how goal MCP auto-wire works, mcp-sidecar rewrite.
4. Session events plumbing: where is the CMA session-event HTTP ingest endpoint in the BFF (src/routes/api/...), the session_events table schema, the SSE stream endpoint, event type taxonomy.
5. docs/durable-session-runtime-contract.md and docs/agent-runtime-comparison.md — summarize the runtime contract requirements verbatim-ish (the checklist a new runtime must satisfy).
Return structured findings with absolute file paths.`,
  },
  {
    label: 'explore:terminal-openshell-ui',
    prompt: READONLY + `Explore the repo ${WB} (very thorough). Goal: understand the INTERACTIVE ACCESS surfaces we already have, for a design where users interact with agent CLIs (Claude Code/Codex/Gemini) running inside sandboxes.

Investigate and report concretely:
1. Web-based terminal: search the whole repo for xterm, node-pty, ttyd, 'terminal' components (src/lib/components/**, src/routes/**). The user says 'we created a web based terminal as a potential way to access'. Find it: what component, what transport (WebSocket? SSE?), what backend it connects to (OpenShell exec? kubectl exec? gateway?), current status/limitations.
2. OpenShell gateway + sandbox addressing: docs/openshell-capabilities.md (read fully), the seed-openshell-config init container, XDG_CONFIG_HOME/openshell/active_gateway, mTLS certs, how the BFF or agents send commands to sandboxes in the openshell namespace (openshell-agent-runtime routes workspace/*, browser/*, openshell/*), exec/command API shape, the 4KB stdout truncation constraint, streaming support if any, the live-preview proxy (getExecutionSandboxPreviewInfo).
3. services/openshell-sandbox/Dockerfile — what's in the sandbox image (OS, tools, node/python versions, Chromium/Playwright), how feasible it is to add CLI binaries (claude, codex, gemini).
4. Session UI: src/routes/**/sessions/[id]/** — the chat interface, how a user sends a message to a live session (which POST endpoint), the event stream rendering, Session Pulse, fork, stop. Also workspace/repo-attach for sessions (binding session.workspaceSandboxName, /sandbox mount).
5. Skills: agent_skill_registry table + /api/agent-skills — how skills are stored and whether/how they currently reach any runtime or sandbox filesystem.
6. Files API + session output auto-upload (/mnt/session/outputs, /sandbox/outputs).
Return structured findings with absolute file paths.`,
  },
  {
    label: 'explore:stacks-sandbox-kueue',
    prompt: READONLY + `Explore the repo ${STACKS} (very thorough). Goal: understand the Kubernetes config for sandboxes, Kueue capacity management, and the openshell namespace — to design new Kueue-admitted sandbox pods that run agent CLIs (Claude Code/Codex/Gemini).

Investigate and report concretely (manifest paths, CR kinds, label/annotation keys, env var names, JSON blobs):
1. sandbox-execution-api: where deployed, SANDBOX_EXECUTION_CLASSES_JSON content (classes, agentHostImage, pod shapes), how Sandbox CRs are created, owner-run-id annotation, how Kueue queue-name labels get onto Sandbox/pods.
2. Kueue configuration: ClusterQueues, LocalQueues, ResourceFlavors, WorkloadPriorityClasses, cohorts, quotas — list them with their resource limits; how Sandbox CRs/pods are admitted (pod-integration? plain-pod? job?); the benchmark-fast queue; anything elastic.
3. kubernetes-sigs/agent-sandbox controller: how it's deployed, Sandbox CRD + SandboxWarmPool CRD usage (browser-use warm pool manifests), self-reap behavior, sandbox templates.
4. Per-session sandbox pod template: where the pod shape lives (seed-openshell-config init container, main runtime container per descriptor.mainContainerName, daprd injection via openshell-sandbox-dapr-webhook, openshell-sandbox-dapr Configuration, optional chromium+playwright-mcp sidecars), volumes (workspace, /mnt/session), resource requests/limits.
5. openshell namespace: every workload/service there — is there an openshell gateway Deployment? how mTLS certs are issued (cert-manager?), services for remote sandbox access, networking (Tailscale ingress?).
6. workflow-builder namespace supporting infra: OTEL collector config (pipelines: traces/metrics/logs exporters -> Jaeger/MLflow/ClickHouse endpoints), mcp-gateway + workflow-mcp-server Deployments (how they're exposed), activepieces-mcps reconciler CronJob, workflow-builder-sandbox-gc, lifecycle-terminal-reaper, secrets management (ExternalSecrets for ANTHROPIC_API_KEY/OPENAI_API_KEY etc. — which secrets exist that CLI runtimes could reuse).
Return structured findings with absolute file paths.`,
  },
]

const researchPrompts = [
  {
    label: 'research:claude-code-cli',
    prompt: READONLY + `Web research task (use WebSearch + WebFetch on official docs: code.claude.com/docs, docs.anthropic.com, github.com/anthropics). Today is 2026-06-10 — prefer current docs. Research Claude Code CLI's programmatic/embedded operation for running it inside a Kubernetes sandbox pod driven by an external host process:
1. Headless + bidirectional modes: 'claude -p', --output-format stream-json, --input-format stream-json, --session-id/--resume/--continue, --permission-mode, --dangerously-skip-permissions, --allowedTools, --mcp-config / .mcp.json, --append-system-prompt. Exact message JSON schema for stream-json input/output if documented.
2. Relationship between Claude Agent SDK (Python/TS) and the claude CLI binary — does the SDK spawn the CLI? What does the SDK add?
3. Native OpenTelemetry: CLAUDE_CODE_ENABLE_TELEMETRY, OTEL_METRICS_EXPORTER, OTEL_LOGS_EXPORTER, OTEL_EXPORTER_OTLP_ENDPOINT etc. — what signals (metrics? logs/events? traces?) does Claude Code export natively, with which attribute schemas?
4. Hooks: full event list, command-hook JSON stdin/stdout contract, can hooks POST to HTTP endpoints (for mirroring transcript events to an external event store)? SessionStart/SessionEnd/Stop semantics.
5. Skills + plugins: where skills live on disk (~/.claude/skills, .claude/skills), marketplace/plugin dirs, how to preload them in a container image or mounted volume.
6. Remote/interactive options: any official web/remote attach (claude.ai/code cloud sessions, 'teleport' feature?), tmux-friendliness, known patterns for running the full TUI in containers; Agent Client Protocol (ACP) adapter (zed-industries/claude-code-acp) status.
7. Auth in containers: ANTHROPIC_API_KEY vs OAuth token (CLAUDE_CODE_OAUTH_TOKEN), setup-token flow, gotchas for headless containers.
Return structured findings; include doc URLs in 'files'.`,
  },
  {
    label: 'research:codex-gemini-cli',
    prompt: READONLY + `Web research task (use WebSearch + WebFetch on official docs/repos: github.com/openai/codex, developers.openai.com, github.com/google-gemini/gemini-cli, geminicli docs, antigravity docs). Today is 2026-06-10 — prefer current info. Research programmatic/embedded operation of (A) OpenAI Codex CLI and (B) Gemini CLI / Google Antigravity, for running them inside Kubernetes sandbox pods driven by an external host process:
A) Codex CLI: 'codex exec' non-interactive mode + --json output; 'codex app-server' JSON-RPC protocol (methods, threads/turns, approvals, streaming events); 'codex mcp' / MCP-server mode; config.toml (mcp_servers, model providers, sandbox modes, approval policies); session resume ('codex resume', session files); OpenTelemetry support ([otel] config — what events/spans it emits); auth options in containers (OPENAI_API_KEY vs ChatGPT login, headless login gotchas); ACP adapter availability.
B) Gemini CLI: headless mode (-p/--prompt, --output-format json/stream-json?), --experimental-acp (Agent Client Protocol) status; settings.json mcpServers config; telemetry (--telemetry flags, OTLP export — what signals + where configurable); checkpointing + session resume; extensions; GEMINI_API_KEY / Vertex auth in containers. Also: what exactly is the Antigravity CLI relative to Gemini CLI (Google Antigravity IDE's agent — does it have a standalone CLI? how does it relate, as of mid-2026)?
C) Agent Client Protocol (ACP, agentclientprotocol.com): one-paragraph overview, which agent CLIs have first-party/adapter support (claude-code-acp, gemini --experimental-acp, codex-acp?), whether any web-based ACP clients exist that could be embedded in a web app.
Return structured findings; include doc URLs in 'files'.`,
  },
  {
    label: 'research:web-terminal-patterns',
    prompt: READONLY + `Web research task (use WebSearch + WebFetch). Today is 2026-06-10. Research patterns for exposing an INTERACTIVE terminal/TUI running in a Kubernetes pod to a web app, and prior art for hosting agent CLIs:
1. Web terminal tech: ttyd, xterm.js + WebSocket + node-pty, kubectl exec WebSocket protocol, wetty/gotty — pros/cons, auth story, resize/binary handling, multiplexing. tmux-based detach/attach for session persistence across reconnects.
2. Prior art products that host coding-agent CLIs in cloud sandboxes with web access: e.g. OpenHands, Coder (coder.com) workspaces + agent integrations, Devin-style products, Anthropic's own Claude Code on the web / cloud sandboxes, Google Antigravity/Jules, sandbox vendors (E2B, Modal, Daytona) agent offerings — specifically HOW each exposes interactivity (chat UI vs web terminal vs both) and whether they wrap CLI agents headlessly.\n3. Any open-source web UIs that speak Agent Client Protocol (ACP) or wrap 'claude -p --input-format stream-json' style loops (e.g. happy-coder, claude-code-webui, omnara, vibe-kanban etc.) — what UX they offer (chat + terminal hybrid?), maturity.
Keep it focused: this informs choosing between (a) chat-bridge via headless CLI, (b) full web terminal PTY, (c) hybrid. Return structured findings; include URLs in 'files'.`,
  },
]

phase('Explore')
const all = await parallel([
  ...explorePrompts.map(p => () => agent(p.prompt, { label: p.label, phase: 'Explore', agentType: 'Explore', schema: FINDINGS })),
  ...researchPrompts.map(p => () => agent(p.prompt, { label: p.label, phase: 'Research', schema: FINDINGS })),
])

const [runtime, terminalUi, stacks, claudeCli, codexGemini, webTerm] = all
return { runtime, terminalUi, stacks, claudeCli, codexGemini, webTerm }