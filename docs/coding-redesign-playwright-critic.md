# Coding redesign workflow + Playwright-MCP design critic

A coding generator/critic workflow that clones a repo, redesigns it across a
plan → generate → critic loop, and opens a pull request — where the **critic
drives a real browser (Playwright MCP) to inspect the rendered UI**, following
Anthropic's [long-running-app harness pattern](https://www.anthropic.com/engineering/harness-design-long-running-apps).

- **Workflow**: `coding-redesign-cli-showcase` (fixture
  `scripts/fixtures/generator-critic/coding-redesign-cli-showcase.json`).
- **Demo repo**: `PittampalliOrg/sveltekit-landing-demo` (private; a deliberately
  plain SvelteKit landing page to redesign).
- **Pipeline**: `plan` (clone + write `SPEC.md`) → `approve_goal_spec` (native
  listen gate) → `refine` loop `[generate → build-gate → critic → read_verdict]`
  (for 0..5, early-exit on critic pass) → `pr` (branch/commit/push + open PR) →
  `summary`.

## The critic
A dedicated per-runtime critic agent (`<runtime>-playwright-critic-agent`) carries
the official Microsoft **`@playwright/mcp`** server (stdio, in-pod). The critic
starts the built app, then `browser_navigate` / `browser_snapshot` (accessibility
tree) / `browser_take_screenshot` across viewports in real Chromium, judges the
redesign against a 4-dimension rubric (design_quality, originality, craft,
functionality), and writes a verdict to `/sandbox/work/verdict.json`. A
deterministic `read_verdict` step normalizes the verdict (`meets_criteria` //
`overall_verdict ~ pass` // `score ≥ 80`) so the loop early-exits on a real pass.

Plan/generate use a lean agent (no browser); only the critic phase gets Playwright.
Per-phase agents are selectable via the `planAgent` / `generatorAgent` /
`criticAgent` trigger inputs.

## Per-runtime status (dev-verified 2026-06-20)

| Runtime | Status | Evidence |
| --- | --- | --- |
| **claude-code-cli** | ✅ Works end-to-end | PR #1; `terminalState: satisfied`; critic 18 browser calls, multi-viewport |
| **codex-cli** | ✅ Works end-to-end | PR #2; `success`; critic 12 browser calls (desktop+mobile), verdict pass/92 |
| **agy-cli** | 🔁 Runtime replaced | Antigravity blocker retired; slot now launches legacy Gemini CLI — rerun pending |
| **dapr-agent-py** | ⏸ Not started | different backend (openshell + `:3100` sidecar); native `meets_criteria` |

## Key implementation notes / gotchas
- **CLI MCP attach path**: MCP must live on the **agent's DB config** —
  `resolveSpecAgentRefs` rebuilds `with.agentConfig` from the registry-resolved
  agent + overrides, discarding node-inline `mcpServers`. The orchestrator MCP
  resolver passes stdio/command servers through; `emit_claude_code_cli_servers`
  wires them per-CLI (claude `.mcp.json` / codex `config.toml` / Gemini-backed
  agy `settings.json`).
- **Browser-sidecar carve-out** (`mcp-sidecar.ts`): interactive-cli pods ship
  Chromium in-image and run `@playwright/mcp` over stdio, so the playwright entry
  is NOT rewritten to the dapr-agent-py-only `localhost:3100` sidecar.
- **Pin the browser** (`--executable-path /opt/pw-browsers/chromium-1228/...`):
  `@playwright/mcp`'s bundled playwright-core wants a Chromium revision the image
  doesn't ship, so without pinning it downloads at runtime and stalls.
- **Verdict size**: the critic's `verdict.json` (~9 KB) is truncated through the
  CLI workspace stdout, so `read_verdict` normalizes it **on disk** and emits a
  tiny JSON.
- **Instruction delivery**: claude reads `agentConfig.instructions` via
  `--append-system-prompt-file`; codex/agy write them to `AGENTS.md` /
  `GEMINI.md` which they may not consult consistently — so the repo URL + clone
  command live in the **`body.prompt`** (delivered to every CLI).
- **cliWorkspace helper pod**: when no live CLI pod exists for a `cliWorkspace`
  step, the BFF provisions a short-lived helper pod (shared JuiceFS workspace +
  `GITHUB_TOKEN`). Defensive; the CLIs tested keep their per-turn pods alive.

## retired Antigravity blocker
The original Antigravity-backed `agy-cli` cloned the repo (the `body.prompt` URL
fix applies to all CLIs) but its **generate** turn failed for two runtime
reasons, both independent of the critic:
1. **Stalls after a `run_command`.** agy's native terminal executor needs Linux
   user-namespaces. On the failed dev run, the sandbox baseline exposed
   `user.max_user_namespaces=0`, so the antigravity adapter fell back to the
   legacy `run_command` PreToolUse shim: deny the native call, run the command via
   bash, and inject the result. agy received the injected result and then went
   silent until the 1800s child-workflow timeout — it does not reliably continue
   after a tool **deny** (and it backgrounds long commands via `WaitMsBeforeAsync`,
   expecting to poll completion the shim doesn't serve).
2. **Did not attempt edits.** In the whole turn agy only did `view_file` +
   `run_command` (builds), zero `write_to_file`/`replace_file_content` — it never
   started the redesign (weakest model at multi-step coding).

We retired this path by keeping the external `agy-cli` / `cliAdapter:
"antigravity"` compatibility slot but launching legacy Gemini CLI instead:
`gemini --approval-mode=yolo --sandbox=false --skip-trust
--include-directories /sandbox`. The adapter now writes Gemini's top-level
`~/.gemini/settings.json`, maps `BeforeTool`/`AfterTool`/`AfterAgent`, and uses
Gemini's native `run_shell_command` in normal operation. The old shim remains as
a fallback for constrained clusters, but it now understands Gemini hook/tool
names.

## dapr-agent-py (follow-on)
dapr-agent-py uses the `openshell-shared` workspace backend (not the cli-family
`/sandbox/work` JuiceFS mount) and the `localhost:3100` browser sidecar (not the
in-pod stdio `@playwright/mcp`). Its critic exposes `meets_criteria` natively
(`.loop.last.evaluate.meets_criteria`, RetroForge-style), so no file-based verdict
is needed. It requires an openshell-backed variant of the workflow (the
`workspaceBackend` guard rejects mixing cli + dapr on a shared workspace).
