# End-to-End Hook + Plugin Tests

Three SW 1.0 workflows that exercise the `dapr-agent-py` hooks + plugins
subsystem with real official Anthropic plugins (loaded from
`github.com/anthropics/claude-plugins-official` via the testing
Deployment's init container) and inline `agentConfig.hooks` overlays.

| File | Plugin / Hook Event | What It Tests |
|---|---|---|
| `test-plugin-security-guidance.workflow.json` | [`security-guidance`](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/security-guidance) — PreToolUse on `Edit\|Write\|MultiEdit` | Writing a `.github/workflows/*.yml` file fires the plugin's Python hook, which injects a security reminder |
| `test-plugin-hookify.workflow.json` | [`hookify`](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/hookify) — PreToolUse + PostToolUse + UserPromptSubmit + Stop | All four lifecycle hooks fire on a short tool-using session |
| `test-plugin-block-bash.workflow.json` | Inline `agentConfig.hooks` — PreToolUse blocks `Bash(rm *)` | Per-run inline hook overlay denies a dangerous shell command |

## Prerequisites

1. Deploy the testing Deployment with hooks enabled:
   - `DAPR_AGENT_PY_HOOKS_ENABLED=true`
   - `DAPR_AGENT_PY_PLUGINS_ENABLED=true`
   - initContainer that clones `anthropics/claude-plugins-official` into
     `/etc/dapr-agent-py/plugins/`

2. Verify plugin load on pod start:
   ```bash
   kubectl logs -n workflow-builder deploy/dapr-agent-py-testing | grep '\[plugins\]'
   kubectl logs -n workflow-builder deploy/dapr-agent-py-testing | grep '\[hooks\] registered'
   ```

## Importing + running

From the workflow-builder UI (or via API):

```bash
# Example via API
for wf in tests/e2e/*.workflow.json; do
  curl -X POST http://<host>/api/workflows \
    -H 'Content-Type: application/json' \
    -d @"$wf"
done
```

After running, check the Runs tab — each execution should show:
- `hook.exec` OTEL spans with attributes `event`, `hook_type`, `outcome`
- For `security-guidance`: an `additional_context` injected after `Write`
- For `hookify`: hook progress events for all four lifecycle events
- For `test-plugin-block-bash`: the blocked-tool error message in the
  run transcript

## Forcing cold replay

Each workflow starts a fresh Dapr workflow instance per trigger, so
there's no state carry-over. To inspect the per-hook results end-to-end,
check the OTEL traces in Jaeger or the structured logs on the pod.
