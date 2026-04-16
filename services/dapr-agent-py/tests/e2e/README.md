# End-to-End Hook + Plugin Tests

Four SW 1.0 workflows that exercise the `dapr-agent-py` hooks + plugins
subsystem against real Anthropic plugins and against Dapr durability.

| File | Plugin / path | What it verifies |
|---|---|---|
| `test-plugin-security-guidance.workflow.json` | [`security-guidance`](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/security-guidance) PreToolUse on `Edit\|Write\|MultiEdit` | Writing a `.github/workflows/*.yml` file fires the plugin's Python hook (exit 2 → blocking) and the agent can't complete the Write |
| `test-plugin-hookify.workflow.json` | [`hookify`](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/hookify) all four lifecycle hooks | Pre/PostToolUse + UserPromptSubmit + Stop fire pass-through on a short tool-using session |
| `test-plugin-block-bash.workflow.json` | Inline `agentConfig.hooks` — PreToolUse blocks `if: Bash(rm *)` | Per-run overlay distinguishes `touch` (allowed) from `rm` (blocked) under the same `Bash` matcher |
| `test-durability-replay.workflow.json` | No hooks — paced 4×bash with 30 s sleeps | Gives enough runtime window to kill `dapr-agent-py` or `workflow-orchestrator` pods mid-flight and confirm resume |

## Prerequisites

Testing and production Deployments in stacks already set these, but for
local `dapr run`:

```bash
export DAPR_AGENT_PY_HOOKS_ENABLED=true
export DAPR_AGENT_PY_PLUGINS_ENABLED=true
export DAPR_AGENT_PY_PLUGIN_PATHS=/etc/dapr-agent-py/plugins
# Install the Anthropic official plugins to that path:
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/anthropics/claude-plugins-official.git /tmp/plugins-src
(cd /tmp/plugins-src && git sparse-checkout set plugins/security-guidance plugins/hookify)
mkdir -p /etc/dapr-agent-py/plugins
for p in security-guidance hookify; do
  cp -r /tmp/plugins-src/plugins/$p /etc/dapr-agent-py/plugins/
  cp /etc/dapr-agent-py/plugins/$p/.claude-plugin/plugin.json /etc/dapr-agent-py/plugins/$p/plugin.json
done
```

On the Ryzen cluster this is done by the `fetch-claude-plugins` init
container in `Deployment-dapr-agent-py.yaml` (+ the `-testing` variant).

## Verify plugin load on pod start

```bash
kubectl -n workflow-builder logs deploy/dapr-agent-py -c dapr-agent-py | grep '\[plugins\]\|\[hooks\]'
# Expected output
#   [plugins] loaded hookify v0.1.0 from /etc/dapr-agent-py/plugins/hookify (4 hook events, 0 mcp servers)
#   [plugins] loaded security-guidance v0.1.0 from /etc/dapr-agent-py/plugins/security-guidance (1 hook events, 0 mcp servers)
#   [hooks] registered: {'PreToolUse': 2, 'PostToolUse': 1, 'Stop': 1, 'UserPromptSubmit': 1}
#   [plugins] loaded 2 plugin(s); 2 enabled
```

## Importing to the UI

`scripts/upsert-plugin-test-workflows.mjs` reads every `*.workflow.json`
in this directory and upserts each into the `workflows` table. Run from
inside the workflow-builder pod (where `DATABASE_URL` is set):

```bash
UI=$(kubectl -n workflow-builder get pods -l app=workflow-builder \
     --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')
kubectl -n workflow-builder exec $UI -c workflow-builder -- sh -c \
  'cd /app && node scripts/upsert-plugin-test-workflows.mjs'
```

Each workflow appears in the UI at
`https://workflow-builder-ryzen.tail286401.ts.net/workflows`.

## Verified outcomes (Ryzen, image `git-9f0110b625...`)

### `test-plugin-security-guidance`

- Agent calls `Write` with path `/sandbox/plugin-test-security/.github/workflows/ci.yml`
- Matcher `Edit|Write|MultiEdit` matches `Write`; hook runs `python3 ${CLAUDE_PLUGIN_ROOT}/hooks/security_reminder_hook.py`
- Script detects the GitHub Actions path pattern, exits 2 with stderr reminder
- Pod log: `[hooks] PreToolUse blocked Write: You are editing a GitHub Actions workflow file. Be aware of these security risks:`
- Agent's final narrative: `**Outcome: FAILED — File was never successfully created**`

### `test-plugin-hookify`

- Agent runs `bash_run("echo hi > note.txt")` then `file_read("note.txt")`
- Hookify's four scripts register and execute without blocking on every lifecycle
  event
- Agent returns: `**Tool Usage:** Two tool calls made (bash + file read), triggering PreToolUse/PostToolUse hooks at least twice each as intended`

### `test-plugin-block-bash`

- `touch throwaway.txt` → `if: Bash(rm *)` does not match → command proceeds
- `rm throwaway.txt` → matcher + if both match → hook exits 2 → agent blocked
- Pod log: `[hooks] PreToolUse blocked Bash: rm-style commands are blocked by policy for this workflow`
- Agent's narrative: `🚫 Attempted to delete it with rm throwaway.txt — the PreToolUse hook intercepted the command and blocked it`

### `test-durability-replay`

- Used to verify parent `workflow-orchestrator` survives a hard pod kill
- Procedure: trigger the workflow, wait until `currentNodeName` is
  `durable_run_paced` (~t+20 s), kill the orchestrator pod with
  `kubectl delete pod ... --grace-period=0 --force`, watch it resume
- Verified result: new orchestrator pod replayed the 17-event workflow
  history from `wfstate_state` and reached COMPLETED ~290 s post-kill
- Caveat: the activity retry kicked off a second full `agent_workflow`
  run on `dapr-agent-py` (at-least-once semantics; no dedupe key) — a
  known limitation documented in `docs/hooks-and-plugins.md`

## Forcing a cold replay

Each workflow starts a fresh Dapr workflow instance per trigger, so
there's no state carry-over. To observe per-hook results end-to-end,
watch the pod logs for `[hooks]` lines or inspect the OTEL trace for
`hook.exec` spans once OTEL attributes are wired through.
