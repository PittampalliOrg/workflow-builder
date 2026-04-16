# Hooks and plugins (dapr-agent-py)

Port of Claude Code's hooks + plugins extension surface into the Python
Dapr durable agent. Lets workflow authors, plugin authors, and operators
inject behavior into the agent's tool-use loop via the same JSON
protocol and plugin manifest shape used by the TypeScript CLI.

| Layer | Location |
|---|---|
| Hooks subsystem source | `services/dapr-agent-py/src/hooks/` |
| Plugins subsystem source | `services/dapr-agent-py/src/plugins/` |
| Wiring into the agent | `services/dapr-agent-py/src/main.py` (init, `run_tool`, `agent_workflow`) |
| Notification dispatch | `services/dapr-agent-py/src/event_publisher.py` |
| Unit tests | `services/dapr-agent-py/tests/hooks/` + `services/dapr-agent-py/tests/plugins/` |
| End-to-end workflow fixtures | `services/dapr-agent-py/tests/e2e/` |

## Feature flags

Off by default; with flags unset, behavior is byte-identical to baseline
`dapr-agent-py` (the bootstrap call attaches empty registries but hook
callers short-circuit).

| Env var | Default | Purpose |
|---|---|---|
| `DAPR_AGENT_PY_HOOKS_ENABLED` | `false` | Master enable. When off, all `execute_*_hooks` callers return an empty `AggregatedHookResult` without spawning subprocesses. |
| `DAPR_AGENT_PY_PLUGINS_ENABLED` | `false` | Enable disk plugin discovery at service boot. Settings-level hooks still work with only this off. |
| `DAPR_AGENT_PY_PLUGIN_PATHS` | `/etc/dapr-agent-py/plugins` | Colon-separated list of plugin search roots. Service-owned paths only — `~/.claude/plugins` is NOT shared. |
| `DAPR_AGENT_PY_HOOKS_EVENTS` | unset = all | Optional JSON array of event names (e.g. `'["PreToolUse","PostToolUse"]'`) to restrict which events fire — enables one-event-at-a-time canary. |
| `DAPR_AGENT_PY_EXTRA_SETTINGS_PATHS` | unset | Colon-separated additional `settings.json` overlays treated as managed sources. |
| `DAPR_AGENT_PY_MANAGED_SETTINGS` | `/etc/dapr-agent-py/policy.json` (if exists) | Path to the managed policy file. |

The prod + testing Deployments in stacks (`packages/components/active-development/manifests/dapr-agent-py/`)
already set `HOOKS_ENABLED=true` and `PLUGINS_ENABLED=true`, and include a
`fetch-claude-plugins` init container that clones
[`anthropics/claude-plugins-official`](https://github.com/anthropics/claude-plugins-official)
and installs the `security-guidance` + `hookify` plugins into `/etc/dapr-agent-py/plugins`.

## Events fired in v1

All 26 TS `HOOK_EVENTS` are declared in `src.hooks.events.HookEvent` so
any plugin manifest parses cleanly, but only these eight actually fire:

| Event | Where |
|---|---|
| `PreToolUse` | Inside the existing `run_tool` activity, before tool dispatch. Can return `decision=block`, `hookSpecificOutput.updatedInput`, or `additionalContext`. |
| `PostToolUse` | Inside `run_tool`, after success. Can return `updatedToolOutput` or `additionalContext`. |
| `PostToolUseFailure` | Inside `run_tool` except branch. Advisory only. |
| `UserPromptSubmit` | In `agent_workflow` before `super().agent_workflow(...)`, first execution only. Can `block` or append `additionalContext`. |
| `SessionStart` | In `agent_workflow` before `super()`, first execution only. Can inject `initialUserMessage` or append context. |
| `SessionEnd` | In `agent_workflow` success and error paths (duplicated to avoid the `yield` inside `finally` limitation). Advisory. |
| `Stop` | In `agent_workflow` after `super()` returns. Advisory in v1. |
| `Notification` | From `event_publisher.py` daemon-thread dispatcher when `tool_call_error`, `run_error`, or `ask_user_prompt` fires. |

Events that exist in the enum but don't fire (declared for manifest
round-trip compatibility): `PreCompact`, `PostCompact`, `SubagentStart`,
`SubagentStop`, `StopFailure`, `PermissionRequest`, `PermissionDenied`,
`Setup`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `Elicitation`,
`ElicitationResult`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`,
`InstructionsLoaded`, `CwdChanged`, `FileChanged`.

## Hook types in v1

| Type | Status |
|---|---|
| `command` | Subprocess. JSON on stdin, `SyncHookJSONOutput` on stdout. Exit 0 = ok, exit 2 = blocking, other non-zero = non-blocking error. Timeouts default 600 s, capped at 300 s to stay under Dapr activity RPC deadlines. SessionEnd uses a 1.5 s timeout. |
| `callback` | In-process Python callable by dotted path. Only runnable when registered by a trusted source (managed settings or built-in plugin); plugin-sourced callback hooks are skipped at dispatch. |
| `http`, `prompt`, `agent` | Declared in the schema so TS plugin JSON round-trips, but dispatcher returns `outcome=skipped` with a "not supported in v1" reason. |

## Matcher + `if`-field

`HookMatcher.matcher` supports:

- empty or `*` → always matches
- `/regex/` → regex against the event query (e.g. tool name)
- `A|B|C` → pipe alternation — each side tried independently via glob match
- anything else → fnmatch glob

The `if` field on a HookCommand uses TS permission-rule syntax, evaluated
only for `PreToolUse` / `PostToolUse` / `PostToolUseFailure`:

| Expression | Meaning |
|---|---|
| `Bash` | Matches any Bash invocation |
| `Bash(git *)` | Matches Bash when the command string starts with `git` |
| `Read(*.ts)` | Matches Read when `file_path` glob-matches `*.ts` |
| `!Bash(git push*)` | Negation |
| `Bash(git *) and !Bash(git push*)` | Logical AND |

Evaluated deterministically via an explicit AST (no `eval`). Unparseable
rules default to "match" so hooks aren't silently skipped.

## Settings cascade

`settings_loader.load_cascade()` reads settings in this order, honoring
`disableAllHooks` and `allowManagedHooksOnly` per TS semantics:

1. Managed — `$DAPR_AGENT_PY_MANAGED_SETTINGS` or `/etc/dapr-agent-py/policy.json`
2. Project — `${CLAUDE_PROJECT_DIR}/.claude/settings.json`
3. Local — `${CLAUDE_PROJECT_DIR}/.claude/settings.local.json`
4. User — `~/.claude/settings.json`
5. Extras — each path in `DAPR_AGENT_PY_EXTRA_SETTINGS_PATHS` (treated as managed)

Hooks from all layers are registered in order; plugin hooks and per-run
hooks are layered on top.

## Plugin manifest

Parsed via Pydantic (`src.plugins.manifest.PluginManifest`) from
`plugin.json` or `.claude-plugin/plugin.json`. Unknown top-level fields
are tolerated so TS-authored manifests round-trip. For the v1 port,
these fields drive behavior:

| Field | v1 | Notes |
|---|---|---|
| `name`, `version`, `description`, `author` | Yes | Metadata |
| `dependencies` | Yes | Topological resolution; cycles disable the whole cycle |
| `hooks` | Yes | Inline `HooksSettings` or path to a JSON file. If the file has `{"description": ..., "hooks": {...}}`, the outer `hooks` key is unwrapped automatically (mirrors Anthropic plugins) |
| `mcpServers` | Yes | Merged into the existing agent MCP config path |
| `userConfig` | Partial | Defaults are applied; per-user runtime prompts are not yet wired |
| `skills`, `commands`, `agents`, `outputStyles`, `lsp`, `channels` | Deferred to v2 | Parsed but ignored; rest of plugin still loads |

Plugins also support convention file `hooks/hooks.json` at the plugin
root (Anthropic plugins use this layout) — merged with `manifest.hooks`.

## Plugin discovery paths

Service-owned only. Paths are read at service boot **before**
`runner.serve(...)`, so discovery is not in any workflow's I/O path.

Default: `/etc/dapr-agent-py/plugins/<plugin-id>/`. Override via
`DAPR_AGENT_PY_PLUGIN_PATHS` (colon-separated).

The Ryzen deploy uses an init container that sparse-clones
[`anthropics/claude-plugins-official`](https://github.com/anthropics/claude-plugins-official)
into an `emptyDir` volume and mounts it read-only at
`/etc/dapr-agent-py/plugins` in the main container. Rolling the
Deployment picks up any upstream plugin changes. See
`packages/components/active-development/manifests/dapr-agent-py/Deployment-dapr-agent-py*.yaml`
in the stacks repo.

## Per-run overlay (workflow authoring)

A workflow can override hooks for a single run by putting them in the
trigger message's `agentConfig`. Mirrors how `agentConfig.mcpServers` and
`agentConfig.skills` already work.

```jsonc
{
  "call": "durable/run",
  "with": {
    "prompt": "…",
    "agentConfig": {
      "modelSpec": "claude-sonnet-4-6",
      // Enable additional plugins for this run only (must be on disk already)
      "plugins": ["security-guidance", "hookify"],
      // Inline hooks layered on top of the registry captured at workflow start
      "hooks": {
        "PreToolUse": [
          {
            "matcher": "Bash",
            "hooks": [
              {
                "type": "command",
                "command": "echo 'rm-style blocked' >&2; exit 2",
                "if": "Bash(rm *)",
                "timeout": 5
              }
            ]
          }
        ]
      }
    }
  }
}
```

A per-instance `HooksSnapshot` is captured at the first activity that
touches it and frozen for the life of the workflow instance. Hot reloads
during an in-flight workflow do not retroactively change its hooks.

## Durability model (what Dapr guarantees)

The port respects the Dapr workflow contract:

- The workflow function `agent_workflow` is deterministic. All
  subprocess and network I/O sits inside `call_llm` and `run_tool`
  activities (both already durable).
- PreToolUse / PostToolUse / PostToolUseFailure fire **inside** the
  existing `run_tool` activity — their results are cached by Dapr and
  not re-executed on replay of the same activity.
- SessionStart / SessionEnd / UserPromptSubmit / Stop fire in the
  workflow function gated by `not ctx.is_replaying`. Mutations they
  make to `message["task"]` or the system prompt follow the same
  non-durable pattern as the existing PLAN.md injection at
  `main.py` (PLAN.md is also `is_replaying`-gated). Block decisions
  raise a controlled exception which the existing `except` path turns
  into a failed-workflow result.
- Hook execution inside a dying activity re-runs on retry (at-least-once
  semantics). Hooks should be idempotent.
- A parent workflow retry kicks off a full fresh child `agent_workflow`
  (no dedupe key). Hooks fire again in the new run.

The "Dapr durability test report" comment log from the initial rollout
established: parent orchestrator state survives worker kill (17-event
history replayed on resume), child agent workflow state is persisted in
`wb_dapr_agent_py_state` (50+ instance rows in prod Postgres at the time
of writing), and activities honor at-least-once retry.

## Observability

Every hook execution produces:

- Structured pod log: `[hooks] <event> blocked <tool>: <reason>` for
  blocking decisions; silent success for non-blocking hooks
- Hook-progress events via the existing `event_publisher` daemon-thread
  publisher (fire-and-forget to `workflow.stream`)
- Notification hooks fire in the daemon thread for `tool_call_error`,
  `run_error`, `ask_user_prompt`

## End-to-end test workflows

Three Anthropic-plugin-based fixtures live in
`services/dapr-agent-py/tests/e2e/`. All three have been imported into
the workflow-builder DB and verified green on Ryzen:

| Workflow | Plugin / path | Verified behavior |
|---|---|---|
| `test-plugin-security-guidance` | `security-guidance` PreToolUse on `Edit\|Write\|MultiEdit` | Writing `.github/workflows/ci.yml` triggers a blocking Python hook that injects a command-injection reminder; Agent reports FAILED because Write never completes |
| `test-plugin-hookify` | `hookify` all four lifecycle hooks | Two-tool-call session completes cleanly with all four hook scripts executed pass-through |
| `test-plugin-block-bash` | Inline `agentConfig.hooks` | `touch throwaway.txt` proceeds, `rm throwaway.txt` blocked by the `if: Bash(rm *)` hook; agent acknowledges the block without retry |

See `tests/e2e/README.md` for running instructions.

## Known limitations / v2 roadmap

1. `http` / `prompt` / `agent` hook types parsed but not executed.
2. `asyncRewake` command-hook flag parsed but treated as `async: true`.
3. Plugin `commands`, `agents`, `skills`, `outputStyles`, `lsp` ignored.
4. No plugin signature verification.
5. Session-scoped "function hooks" (ephemeral per-session hooks) not ported.
6. Children aren't dedup'd on parent retry — exactly-once child runs
   would need the orchestrator to pass a stable key.

## References

- Source (TS): `claude-code-src/main/utils/hooks.ts`,
  `claude-code-src/main/schemas/hooks.ts`,
  `claude-code-src/main/utils/plugins/schemas.ts`
- Plan file: `~/.claude/plans/review-claude-code-src-main-for-its-refactored-spark.md`
- Dapr durability primer: `dapr.io/docs/concepts/workflow`
- Anthropic official plugins: https://github.com/anthropics/claude-plugins-official
