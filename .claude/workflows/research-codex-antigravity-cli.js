export const meta = {
  name: 'research-codex-antigravity-cli',
  description: 'Research Codex CLI + Antigravity CLI OAuth/TUI/MCP surfaces and the claude-code-cli contract to mirror',
  phases: [{ title: 'Research' }],
}

const FIND = {
  type: 'object',
  required: ['summary', 'findings'],
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['topic', 'detail'],
        properties: {
          topic: { type: 'string' },
          detail: { type: 'string', description: 'Concrete: exact commands, flags, file paths, env vars, config keys, JSON shapes, doc URLs' },
          refs: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}

const REPO = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const RO = 'READ-ONLY: do not edit/write/run state-changing commands. Today is 2026-06-11. '

phase('Research')
const [codex, antigravity, contract] = await parallel([
  () => agent(`${RO}Web research (WebSearch + WebFetch on official docs: github.com/openai/codex, developers.openai.com/codex, and current mid-2026 sources). We run agent CLIs as the REAL interactive TUI inside Kubernetes sandbox pods, driven through a web terminal, with a Python host (FastAPI) supervising a headless 'herdr' terminal multiplexer + the CLI in a herdr pane. We already do this for Claude Code; now we add CODEX CLI the same way, authenticated via OAuth (NOT an API key).

Research and report CONCRETELY:
1. **OAuth / ChatGPT login**: exact mechanism for 'codex login' (ChatGPT account OAuth). Where are the resulting credentials stored on disk (path, e.g. ~/.codex/auth.json) and what's the file shape (access token, refresh token, account id, expiry)? Do the OAuth tokens auto-refresh (is a refresh token persisted)? Can a credential obtained by 'codex login' on machine A be copied to machine B (a pod) and reused? Any device-code / headless login flow (no browser on the box)? How does codex pick OAuth creds vs OPENAI_API_KEY (precedence), and how to FORCE the ChatGPT/OAuth path (so an injected OPENAI_API_KEY doesn't override)?
2. **Interactive TUI**: how to launch the interactive TUI (just 'codex'? a subcommand?). Working dir / project handling. Does it use the terminal alternate screen + heavy redraws (xterm.js perf implications)? Any flags for non-interactive vs interactive. config.toml location (~/.codex/config.toml?) + keys for: mcp_servers, model/provider, sandbox mode, approval policy, OTEL [otel].
3. **MCP**: how Codex consumes MCP servers (config.toml [mcp_servers]? shape — command/args/env for stdio, url/headers for http/sse?). 
4. **Telemetry/OTEL**: codex [otel] config — what it emits, how to point it at an OTLP collector.
5. **Install**: how to install the codex CLI in a Linux container (npm @openai/codex? a binary? version pinning). 
6. **herdr Codex integration**: herdr (herdr.dev) claims an official Codex integration for agent-state detection (working/idle/blocked/done) — how does it detect Codex state; any setup needed.
7. **app-server / exec**: note 'codex app-server' (JSON-RPC ws) + 'codex exec --json' but we want the INTERACTIVE TUI; just confirm they exist and that the plain interactive TUI is the right surface for a web-terminal session.
Return structured findings with doc URLs in refs.`, { label: 'research:codex', phase: 'Research', schema: FIND }),

  () => agent(`${RO}Web research (WebSearch + WebFetch on official docs: antigravity.google/docs, github.com/google-antigravity/antigravity-cli, developers.googleblog.com, and current mid-2026 sources). We run agent CLIs as the REAL interactive TUI inside Kubernetes sandbox pods via a web terminal + a headless 'herdr' multiplexer. We already do this for Claude Code; now add the ANTIGRAVITY CLI ('agy', Google's Gemini-based agent CLI that replaced Gemini CLI), authenticated via Google OAuth (NOT an API key).

Research and report CONCRETELY:
1. **OAuth / Google login**: exact 'agy login' (or equivalent) Google OAuth mechanism. The earlier note says 'Google OAuth (URL+code flow over SSH) or ANTIGRAVITY_API_KEY' — detail the URL+code (device-code) flow: does it print a URL + code the user visits to authorize, then the CLI captures tokens? Where are credentials stored on disk (path + shape: access/refresh token, expiry)? Do they auto-refresh? Can creds from 'agy login' on machine A be copied into a pod and reused? How to FORCE the OAuth path over ANTIGRAVITY_API_KEY. CRITICAL: the consumer Google OAuth for Gemini CLI/Code Assist sunsets 2026-06-18 — does the Antigravity CLI OAuth use that same sunsetting consumer path, or a different (surviving) Antigravity OAuth? Which tier/account is needed?
2. **Interactive TUI**: how to launch the interactive TUI ('agy'? a subcommand?). Alternate-screen/heavy-redraw (xterm.js perf). Headless flags ('agy -p/--print'). Maturity caveats (no --output-format json, no per-conversation id in --print — confirm current state).
3. **MCP**: how agy consumes MCP servers — mcp_config.json (path + shape: serverUrl for remote, stdio command/args)? settings.json mcpServers?
4. **Skills/Hooks/Subagents/Extensions(plugins)**: confirm agy supports these (carried over from Gemini CLI) + on-disk locations.
5. **Telemetry/OTEL**: does agy have OTEL? (Gemini CLI had full OTEL; agy reportedly lacks it as of late May 2026 — confirm current state + any OTLP config).
6. **Install**: how to install agy in a Linux container (curl install.sh? a Go binary 'agy'? GitHub release naming; version pinning; arch).
7. **herdr Antigravity integration**: herdr claims an official Antigravity CLI integration for state detection — how it works.
8. **Gemini CLI fallback**: if agy's OAuth/headless is too immature for a pod, can Gemini CLI ('gemini', --acp, settings.json mcpServers, full OTEL) be used with an OAuth flow instead? Note Gemini CLI consumer OAuth sunsets 2026-06-18 — is there a surviving OAuth path for it? Briefly assess agy-vs-gemini-CLI for an OAuth interactive-TUI-in-a-pod.
Return structured findings with doc URLs in refs.`, { label: 'research:antigravity', phase: 'Research', schema: FIND }),

  () => agent(`${RO}Explore ${REPO} (very thorough). We built an interactive-cli runtime family: 'claude-code-cli' via services/cli-agent-py runs the real Claude Code TUI in a herdr pane in a Kueue sandbox pod, web-terminal-accessed, with per-user subscription-token auth. We now need to ADD codex-cli + agy-cli runtimes mirroring it. Map the EXACT contract + every seam I must extend, with file:line and concrete shapes.

Report concretely:
1. **CliAdapter contract**: services/cli-agent-py/src/cli_adapters/{base,claude_code}.py — the full adapter interface (build_argv, seed, pane_env, hook/transcript mapping, map_hook_event). What a NEW adapter (codex/agy) must implement. How get_adapter() selects the adapter (adapter_name_for in seed.py). How the workflow/cli_lifecycle picks the adapter per runtime.
2. **Registry descriptor**: services/shared/runtime-registry.json claude-code-cli entry — every field incl. cliAuth {provider, tokenKind, envVar, setupCommand}, executionClass, imageEnvKey, appIdConfigKey, instancePrefix, mainContainerName, capabilities.interactiveTerminal. What a codex-cli / agy-cli descriptor needs. The orchestrator core/config.py *_APP_ID additions + the durable/run reject + sw_workflow guard. The TS reader (runtime-registry.ts) family/cliAuth types.
3. **Auth/credential model — THE KEY SEAM**: how the per-user credential flows today. src/lib/server/db/schema.ts user_cli_credentials (columns); src/lib/server/users/cli-credentials.ts (get/upsert/decrypt). src/lib/server/security/encryption.ts (encryptString/decryptString, AES-256-CBC, AP_ENCRYPTION_KEY). spawn.ts: how cliAuth.envVar + the token become sessionSecretEnv. agent-workflow-host.ts: sessionSecretEnv → sandbox-execution-api. The settings page src/routes/settings/cli-tokens/+page.{svelte,server.ts} + /api/v1/users/me/cli-tokens/[provider]. CRITICAL QUESTION: today the credential is a single TOKEN delivered as ONE env var (CLAUDE_CODE_OAUTH_TOKEN). For Codex/Antigravity the OAuth credential is a FILE/BLOB (auth.json / google creds) that must land at a path in the pod (e.g. ~/.codex/auth.json). What's the cleanest way to generalize: store the blob in user_cli_credentials.value (already an EncryptedObject), and have the host write it to a path at seed time? Identify where the host would write a credential file (the seed.py / pane_env / start_cli flow) and whether sessionSecretEnv (env-only) suffices or we need a file-materialization step (mirror skills/system-prompt materialization).
4. **Image + stacks**: services/cli-agent-py/Dockerfile.sandbox (how claude is installed + herdr + managed-settings + non-root); the interactive-cli execution class; the per-CLI image story (imageEnvKey → one image per CLI, or one image with all CLIs?). The render-workflow-builder-release-overlays.sh class JSON (in stacks) + ryzen base manifests. How a new runtime gets an execution class / image env / Tekton trigger.
5. **UI surfaces that key off cliAuth**: settings/cli-tokens renders one card per descriptor with cliAuth; sessions/new readiness chip; the terminal-first session page (interactiveTerminal). Confirm these are CLI-agnostic so codex/agy appear automatically once descriptors land.
6. **Web terminal perf**: src/lib/components/sandbox/sandbox-terminal.svelte (xterm-svelte + addons). Is the WebGL/canvas renderer addon used? Any flow-control? For 'render well with high performance' across heavy-redraw TUIs (codex/gemini), what perf addons/options exist and whether they're enabled.
Return structured findings with file:line refs.`, { label: 'explore:contract', phase: 'Research', agentType: 'Explore', schema: FIND }),
])

return { codex, antigravity, contract }