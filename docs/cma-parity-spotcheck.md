# CMA Parity Spot-Check — Coding Assistant Baseline

**Test date**: 2026-04-18
**Scope**: Build the CMA quickstart "Coding Assistant" on both platforms, run the same Fibonacci prompt, diff the results.
**Conclusion up front**: Baseline parity is solid. Both systems produced byte-identical output with comparable latency. Workflow-builder has substantially more surface area (hooks, plugins, persona structure, observability, git checkpoints) than CMA exposes today. Main gaps are in the tool taxonomy, model catalog, and UI affordances for editing — not in the core runtime.

## What was built

| | CMA | workflow-builder |
|---|---|---|
| Agent ID | `agent_011CaBXYKjJ8BrUtro4FHNEq` (v2) | `coding-assistant` (v2, internal id `RwxKnIlMhDjvnztKliKNh`) |
| Template | Blank agent → customized | Blank agent config → customized |
| Model | `claude-sonnet-4-6` (Opus 4.7 rejected — see Gap #2) | `anthropic/claude-opus-4-7` |
| System prompt | "You are a helpful coding assistant. Write clean, well-documented code." | identical |
| Tools | `agent_toolset_20260401` (8: bash, read, write, edit, glob, grep, web_fetch, web_search) | 5 workspace tools (execute_command, read_file, write_file, list_files, edit_file) |
| Environment | `deep-researcher-env` (cloud + unrestricted) | "No environment (uses default sandbox)" |
| Session | `sesn_011CaBXoQKJHWPRFuEtaxkHJ` | `dfY6g2k2hC-S3NnluDqrf` |

## Runtime result

Both agents completed the Fibonacci task successfully with identical numeric output:

```
0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597, 2584, 4181
```

| Metric | CMA | workflow-builder |
|---|---|---|
| Duration | 39.6s | 25s |
| Tokens (in/out) | 17.1k / 825 | 0 / 0 (UI didn't populate; actual run clearly burned tokens) |
| Tools called | Write, Bash | Write, Bash |
| Final status | `session.status_idle` | `idle` ("Finished the turn") |
| Output path | `/mnt/session/outputs/fibonacci.txt` | `/sandbox/fibonacci.txt` |
| Output auto-upload | Session output → CMA files (implicit) | `/sandbox/outputs/` only (our run wrote to `/sandbox/` so it didn't trigger — see Gap #7) |

Both got to `status_idle` with a final agent message describing the script. No behavioral gap at the task level.

## Static config mapping (CMA → workflow-builder)

| CMA field (from `POST /v1/agents`) | workflow-builder field | Parity | Notes |
|---|---|---|---|
| `name` (required) | `agents.name` | ✓ | |
| `model.id` / `model.speed` | `AgentConfig.modelSpec` + `agents.runtime` | Partial | Different namespace; see Gap #2. We don't expose a `speed` knob. |
| `system` | `AgentConfig.systemPrompt` | ✓ | Ours *also* layers `role` + `goal` + `instructions[]` + `styleGuidelines[]` on top. |
| `tools: [{type: agent_toolset_20260401}]` | `AgentConfig.builtinTools` (`list_files`, `read_file`, `write_file`, `execute_command`, `edit_file`) | **Partial** | Gap #1: missing `glob`, `grep`, `web_fetch`, `web_search`; names also diverge. |
| `mcp_servers` | `AgentConfig.mcpServers` | ✓ | Shape per `docs/mcp-agent-workflows.md`. |
| `skills` | `AgentConfig.skills` + `agent_skill_registry` | ✓ | We have curated-global + custom-per-workspace. |
| `callable_agents` (research preview) | — | **Gap** | No multi-agent orchestration surface. Would go in `AgentConfig`. |
| `description` | `agents.description` | ✓ | |
| `metadata` (key-value) | `agents.tags` (string[]) | Partial | Arrays-of-strings vs key-value. We should add a `metadata` JSONB column if we want 1:1. |
| `version` (bumped on update) | `agentVersions.version` | ✓+ | We go further: every publish requires a human-entered **changelog** (see Gap #5). |
| `archived_at` (timestamp) | `agents.isArchived` (boolean) | Cosmetic | We lose the archive-time. |

### Ours-only (no CMA equivalent) — additive surface

- `role`, `goal`, `instructions[]`, `styleGuidelines[]` — structured persona
- `temperature` — exposed on the agent, not just per-message
- `toolChoice` — auto / required / none
- `maxTurns`, `timeoutMinutes`, `cwd` — execution governance
- `hooks`, `plugins` — Claude Code hooks + plugins port
- `memory` — backend: dapr_state / conversation_list / none
- `sandboxPolicy` / `environmentId` (pinned Environment row)
- `runtime` (`dapr-agent-py` / `dapr-agent-py-testing`) + `runtimeOverridePolicy`
- `configuration` — hot-reload from dapr state store

All of these land in `src/lib/types/agents.ts:51-81`. Most don't correspond to any CMA API surface.

## Templates — side by side

| Template | CMA | workflow-builder | Match |
|---|---|---|---|
| Blank agent config | ✓ | ✓ (`catalog.ts:37`) | ✓ |
| Deep researcher | ✓ | ✓ | ✓ |
| Structured extractor | ✓ | ✓ | ✓ |
| Field monitor (Notion) | ✓ | ✓ | ✓ |
| Support agent | ✓ | ✓ | ✓ |
| Incident commander | ✓ | ✓ | ✓ |
| Feedback miner | — | ✓ | Ours-only |
| Sprint retro facilitator | — | ✓ | Ours-only |
| Support-to-eng escalator | — | ✓ | Ours-only |
| Data analyst | — | ✓ | Ours-only |

We ship 10 templates vs CMA's 6. The 6 shared templates match by name, icon set, and description.

## Event stream taxonomy

Both emit a session event stream. The taxonomies agree on intent but diverge on names:

| Intent | CMA event | workflow-builder event |
|---|---|---|
| User turn sent | `user.message` | `user` (in transcript); stream-side name is `agent.message` with role=user per our lib |
| LLM call starting | — | `llm_start` (extra) |
| Assistant text | `agent.message` | `agent` (UI-labeled) |
| Thinking block | `agent.thinking` | `thinking` |
| Tool use | `agent.tool_use` | `tool` (+ name chip) |
| Tool result | `agent.tool_result` | `result` |
| Idle / done | `session.status_idle` | status badge `idle` + `Finished the turn` event |
| Terminated | `session.status_terminated` | emitted on `autoTerminateAfterEndTurn` path |

`docs/cma-parity.md` claims the event taxonomy is "locked" against CMA — this run shows names in our transcript UI are shortened and we emit an extra `llm_start` event that CMA doesn't. Wire-format alignment may still be good; UI labeling is not.

## Concrete gaps (prioritized by user impact)

### Gap #1 — Missing built-in tools (high impact)
CMA's `agent_toolset_20260401` expands to 8 tools; our Blank template's `builtinTools` only ships 5.

| CMA tool | Our tool | Status |
|---|---|---|
| `bash` | `execute_command` | ✓ (renamed) |
| `read` | `read_file` | ✓ (renamed) |
| `write` | `write_file` | ✓ (renamed) |
| `edit` (string replacement) | `edit_file` | ✓ (renamed) |
| `glob` | *(absent from Blank)* | **missing** — exists elsewhere as `glob_files` in `deep-researcher` template |
| `grep` | *(absent from Blank)* | **missing** — exists as `grep_search` in `deep-researcher` |
| `web_fetch` | — | **gap** |
| `web_search` | — | **gap** |

For a Fibonacci-style task it doesn't matter; for research/debugging workflows the missing `web_search` and `web_fetch` are user-visible. Also, `list_files` exists in ours but has no CMA equivalent (closest is `glob`). Recommend: expand the Blank template's `builtinTools` to all 5 file/shell tools + add `web_search`/`web_fetch` behind a capability toggle.

### Gap #2 — Model catalog mismatch (medium impact)
- CMA's `default` workspace rejected `claude-opus-4-7` with `"not a supported model ID"` despite the Opus 4.7 quickstart example. The "Blank" template defaults to `claude-sonnet-4-6`.
- Our `Model spec` placeholder hints `anthropic/claude-opus-4-7` (provider-prefixed) and accepted it.
- This is less a "gap" in our system and more a CMA entitlement quirk, but the naming convention (`claude-sonnet-4-6` bare vs `anthropic/claude-sonnet-4-6` prefixed) could bite anyone porting configs between systems. We should normalize by accepting both forms.

### Gap #3 — No `callable_agents` (medium impact)
CMA's multi-agent orchestration primitive has no representation in our `AgentConfig`. For now they run only as a research preview, so this is a future-proofing gap, not an immediate blocker.

### Gap #4 — No `metadata` key/value bag (low impact)
We store `tags: string[]`; CMA stores `metadata: {[k]: string}`. Porting scripts that use `metadata.X` lose their structure. Suggest adding a `metadata` JSONB column on `agents` and mapping `metadata.tags` → existing column for back-compat.

### Gap #5 — Mandatory changelog on publish (cosmetic)
Our publish flow pops a modal asking for a changelog. CMA bumps version silently. This is a workflow-builder *additive* feature (auditability) but it's friction for someone wanting 1:1 behavior. Consider: default the changelog to `""` and only prompt if the user clicks "Add changelog".

### Gap #6 — UI editor UX (medium, bug-class)
CMA's YAML editor (TipTap/ProseMirror) is fragile when pasting multi-line YAML via a synthetic event — it dropped the leading `{` and collapsed list indentation during this run. We had to fall back to direct DOM replacement. **This is a CMA bug**, not ours, but worth noting: our agent editor uses discrete form fields (labeled inputs for Role, Goal, System prompt, etc.) which is more robust. Call out in the report if we ever add a YAML view.

### Gap #7 — Output directory convention (medium impact)
- CMA's agent naturally wrote to `/mnt/session/outputs/fibonacci.py` + `fibonacci.txt`.
- Our agent wrote to `/sandbox/fibonacci.py` + `fibonacci.txt` (not `/sandbox/outputs/`).
- Our "Output artifacts" panel only picks up files in `/sandbox/outputs/`. Because the agent wrote one level up, no file was auto-uploaded.
- Two fixes possible: (a) inject a system-prompt hint that says *"Write output files to /sandbox/outputs/ so they get uploaded"*, or (b) broaden the auto-upload scanner to walk `/sandbox/` as well as `/sandbox/outputs/` and `/mnt/session/outputs/`. `(a)` is cheaper.

### Gap #8 — Environment model divergence (architectural, not fixable)
- CMA's environment is an Anthropic-managed container (`{type: cloud, networking: unrestricted}`).
- Ours is an in-cluster OpenShell sandbox (`ws-achuvui4liur`) with per-session git checkpoints, Phoenix/ClickHouse observability, and optional workspace profile mounts.
- The wire shape (`environments` row with sandbox policy) is parallel, but the execution surface is fundamentally different — we own the container, they don't. Document this as an *intentional* divergence, not a gap.

## Ours-only features that matter (don't lose in porting)

These are advantages not friction — keep them and call them out when selling the system:

1. **Per-turn git checkpoints** — every tool mutation is committed to Gitea under `refs/workflow-builder/checkpoints/<session>/turn-N/<tool_call_id>` with `beforeSha`/`afterSha`/`changedFiles[]`. CMA has no equivalent.
2. **Phoenix + ClickHouse observability** — session detail links straight to trace explorer. Each LLM call and tool call is a span.
3. **Live OpenShell sandbox** — inspectable terminal, browse files, live logs from the session detail page.
4. **Workflow integration** — our `durable/run` spawns a session as a Dapr child workflow; CMA sessions are standalone. This is the core of our product differentiation.
5. **Hooks + plugins** — Claude Code-compatible extension surface on the agent runtime; no CMA analog.
6. **10 templates vs 6** — wider catalog.
7. **Richer persona structure** — role/goal/instructions/styleGuidelines separate from the system prompt.

## Verification (what proved this)

- CMA agent: `https://platform.claude.com/workspaces/default/agents/agent_011CaBXYKjJ8BrUtro4FHNEq`
- CMA session: `https://platform.claude.com/workspaces/default/sessions/sesn_011CaBXoQKJHWPRFuEtaxkHJ`
- Workflow-builder agent: `https://workflow-builder-ryzen.tail286401.ts.net/workspaces/default/agents/RwxKnIlMhDjvnztKliKNh`
- Workflow-builder session: `https://workflow-builder-ryzen.tail286401.ts.net/sessions/dfY6g2k2hC-S3NnluDqrf`

Same prompt, same numeric output, same tool sequence (Write → Bash), both reached `idle` / `status_idle`.

## Recommendation for next tier

Now that baseline parity is confirmed, escalate in this order:

1. **Deep Researcher** template on both sides — stress-tests long-horizon `maxTurns`, tool-taxonomy parity under `web_search` + `web_fetch`, and CMA's citation behavior against ours.
2. **Incident Commander** — stress-tests MCP auth + credential broker parity (Sentry, Linear, Slack, GitHub MCPs). Requires real MCP credentials; will surface vault and `mcp_connection` differences.
3. **Custom skill + hooks/plugins** — the features that exist only on our side. Build something that uses our hooks overlay and verify the CMA agent can't do the equivalent (confirming our differentiator).
