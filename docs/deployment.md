# Deployment & Infrastructure

This document describes the current deployment model for `workflow-builder`.

## Current Cluster Shape

The active cluster shape is:

- `workflow-builder`
- `workflow-builder-svelte`
- `workflow-orchestrator`
- `function-router`
- `openshell-agent-runtime`
- `dapr-swe`
- `fn-activepieces`
- `postgresql`
- Dapr sidecars and their Redis/pub-sub backing services

## Deployment Truth

There are two different operating modes and they are not equivalent.

### Skaffold inner loop

Use this for fast local iteration:

```bash
bash scripts/skaffold-dev.sh              # default: workflow-builder
bash scripts/skaffold-dev.sh ALL          # all 6 active modules
```

The wrapper pauses ArgoCD reconciliation for the target apps, runs
`skaffold dev` with file-sync into running pods (HMR for Node/SvelteKit,
uvicorn reload for Python), and resumes ArgoCD on Ctrl-C. See
`skaffold/README.md` for the full module map.

It is useful for:

- UI iteration
- API route iteration
- runtime code debugging

It is not the authoritative cluster deployment state.

### GitOps rollout

Use this to change the real cluster:

1. push source changes to the normal GitHub repo when a new image is needed
2. let the hub Tekton outer-loop build and publish `ghcr.io/pittampalliorg/<image>:git-<sha>`
3. update `stacks/main` image pins or manifests
4. let ArgoCD reconcile

On `ryzen`, changing only this repo does not change the real cluster until the corresponding `stacks/main` change is delivered with `idpbuilder stacks sync` or `cluster-update`.

## Build and Promotion Model

The cluster uses a GitOps and hub-build flow:

- app repos contain source
- Tekton builds images in the hub cluster
- GHCR stores promoted built image tags and digests
- `stacks/main` pins the live image refs
- ArgoCD reconciles the runtime from `stacks/main`
- ryzen local manifest iteration uses `idpbuilder stacks sync`, which snapshots `stacks/main` into local Gitea and refreshes only affected ArgoCD apps; current syncs preserve active-development image pins by default, require explicit `--seed-images=true` for bootstrap rewrites, and serialize mutating sync/watch sessions with a per cluster/repo/branch lock

If the live cluster does not match local code, first check whether the image tags and manifests in `stacks/main` were updated.

## Runtime Expectations

The expected live coding path is:

1. `workflow-builder` starts a run
2. `workflow-orchestrator` resolves draft or published execution target
3. `durable/run` action nodes dispatch via `ctx.call_child_workflow` directly to `dapr-agent-py` (native Dapr child workflow, no function-router hop)
4. `workspace/*`, `browser/*`, `openshell/*`, `system/*`, `code/*`, `_default` (AP pieces) dispatch via Dapr service invoke to `function-router`, which decrypts credentials and forwards to the target runtime
5. `dapr-swe/*` actions route only when a workflow explicitly targets that separate runtime
6. the UI reads persisted artifacts back through the BFF

For `durable/run`, the deployed `dapr-agent-py` image is expected to include the
OpenAI adapter. A workflow can select GPT-5.4 by setting:

```json
{
  "agentConfig": {
    "runtime": "dapr-agent-py",
    "modelSpec": "openai/gpt-5.4"
  }
}
```

The deployed pod must set `OPENAI_API_KEY` for OpenAI model calls and
`ANTHROPIC_API_KEY` for Anthropic model calls. Gemini model routing is disabled
until an API-key-backed Gemini adapter is added.
`OPENAI_REASONING_EFFORT=low` is the recommended deployment setting for
tool-heavy GPT-5.4 workflows such as spreadsheet generation because it keeps
tool-call latency bounded.

For XLSX workflows, `openshell-agent-runtime` must use a runtime script or
configuration that maps the sandbox template name to the intended sandbox image
ref through `SANDBOX_TEMPLATE_IMAGES_JSON`, for example:

```text
dapr-agent-xlsx -> <registry>/openshell-sandbox-xlsx:<tag>
```

That sandbox image should contain spreadsheet dependencies in the image. Update
the image mapping in `stacks/main` and deliver it to ryzen with
`idpbuilder stacks sync`; do not rely on runtime package installation inside the
agent workflow.

For hooks + plugins support, the `dapr-agent-py` and
`dapr-agent-py-testing` Deployments set:

```yaml
env:
  - name: DAPR_AGENT_PY_HOOKS_ENABLED
    value: "true"
  - name: DAPR_AGENT_PY_PLUGINS_ENABLED
    value: "true"
  - name: DAPR_AGENT_PY_PLUGIN_PATHS
    value: "/etc/dapr-agent-py/plugins"
```

plus a `fetch-claude-plugins` init container that sparse-clones
`anthropics/claude-plugins-official` into an `emptyDir` volume and
installs the `security-guidance` + `hookify` plugins into
`/etc/dapr-agent-py/plugins`, mounted read-only in the main container.
Rolling the Deployment fetches any upstream plugin updates. Full
reference in `docs/hooks-and-plugins.md`.

## Validation Checklist

After a real rollout, verify:

1. Argo apps are `Synced` and `Healthy`
2. all core pods are `Running` with healthy Dapr sidecars
3. `function-router` (via Dapr invoke from orchestrator) routes `workspace/*`, `browser/*`, `openshell/*`, `code/*`, and `_default` AP pieces to the intended runtimes; `durable/run` is a native child workflow and bypasses function-router
4. a fresh OpenShell-backed workflow run progresses through workspace creation and clone
5. coding runs persist patch, change-set, and snapshot artifacts
6. published workflows appear in runtime introspection and can execute by name/version

Additional checks for GPT-5.4 and XLSX workflows:

1. `dapr-agent-py` logs `Patched DaprChatClient class for OpenAI direct calls`
2. a GPT-5.4 test run emits `run_started.model = llm-openai-gpt5`
3. `dapr-agent-py` logs `[openai-responses] Calling gpt-5.4 ... auth=...`
4. an XLSX sandbox created with `sandboxTemplate: "dapr-agent-xlsx"` reports the `openshell-sandbox-xlsx` image in workspace profile output
5. the child agent package check reports `xlsxwriter: true` and `openpyxl: true`
6. the workflow writes `/sandbox/validation-output/workbook-output.xlsx` and `/sandbox/validation-output/xlsx-local-result.json`
7. parent steps complete metadata validation, OneDrive upload/download, and Excel workbook/worksheet/range readback

Additional checks for hooks + plugins rollout:

1. `dapr-agent-py` pod init container `fetch-claude-plugins` logs `[plugins] installed security-guidance` and `[plugins] installed hookify`
2. main container logs `[plugins] loaded hookify v0.1.0 (4 hook events, 0 mcp servers)` and `[plugins] loaded security-guidance v0.1.0 (1 hook events, 0 mcp servers)`
3. main container logs `[hooks] registered: {'PreToolUse': 2, 'PostToolUse': 1, 'Stop': 1, 'UserPromptSubmit': 1}`
4. the three plugin test workflows (`test-plugin-security-guidance`, `test-plugin-hookify`, `test-plugin-block-bash`) complete with expected hook behavior — see `services/dapr-agent-py/tests/e2e/README.md`

## Operational Notes

### Dapr health matters

If a pod looks healthy at the app container level but the overall pod is not ready, inspect the Dapr sidecar and control plane before assuming the app rollout is broken.

### Parent workflow owns timeouts

Long-running agent execution should be governed by the parent durable workflow timeout, not by ad hoc inter-service HTTP timeouts.

### Multi-app child workflows are not active on ryzen

Native cross-app Dapr child workflows should stay disabled until every participating workflow app shares the same workflow actor state store in the same namespace.

### Review data must be durable

For successful coding runs:

- `/changes` should resolve from persisted artifacts
- `/patch` should return a durable patch
- `/files/snapshot/...` should return durable snapshots

Patch-only fallback is acceptable for historical runs, not for newly persisted OpenShell runs.

## Environment Expectations

Important runtime dependencies include:

- `DATABASE_URL`
- `INTERNAL_API_TOKEN`
- `WORKFLOW_ORCHESTRATOR_URL`
- `DAPR_HOST`
- `DAPR_HTTP_PORT`
- `ANTHROPIC_API_KEY` for Anthropic model runs
- `OPENAI_API_KEY` for GPT-5.4 runs
- `OPENAI_REASONING_EFFORT` for OpenAI Responses API reasoning control
- OpenShell runtime availability
- local Gitea registry reachability from cluster nodes
- healthy `dapr-system`

## Current Validated Workflow

The XLSX workflow validated with GPT-5.4 follows this shape:

1. `workspace/profile` creates a `dapr-agent-xlsx` OpenShell sandbox.
2. `durable/run` runs `dapr-agent-py` with the `xlsx` skill and `modelSpec: "openai/gpt-5.4"`.
3. The agent creates a workbook and JSON metadata under `/sandbox/validation-output`.
4. Parent shell steps validate the workbook zip and metadata.
5. OneDrive upload and download steps verify cloud file access.
6. Microsoft Excel steps list workbooks, list worksheets, and read `Summary!A1:C40`.

The stored workflow may keep an Anthropic default model while individual tests
or executions override `agentConfig.modelSpec` to GPT-5.4. Treat the workflow
definition and live `stacks/main` image/env pins as the source of truth for
whether GPT-5.4 is the default or only an override.

## Related Docs

- [docs/architecture.md](/home/vpittamp/repos/PittampalliOrg/workflow-builder/main/docs/architecture.md)
- [docs/services.md](/home/vpittamp/repos/PittampalliOrg/workflow-builder/main/docs/services.md)
