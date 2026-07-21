# Workflow MCP Server

`workflow-mcp-server` is the MCP authoring and execution surface for Workflow
Builder. External clients authenticate as a workspace principal. A Workflow
Builder session is optional context for goal and explicit session-lineage tools;
it is not the owner or credential for workflow operations or run debugging.

## Connect an MCP client

1. Open **Workspace settings > API keys** at
   `/workspaces/<workspace-slug>/settings/keys`.
2. Create a key and store the displayed `wfb_...` value. It is shown only when
   created. Rotating a workspace-bound key also displays its replacement secret,
   but rotating a legacy webhook key does not upgrade its scope; replace legacy
   keys by creating a new workspace key.
3. Store the key in 1Password at
   `op://hub-eso/WORKFLOW-BUILDER-MCP-API-KEY/password`. The Nix-managed clients
   read it only when the MCP proxy starts. `WFB_API_KEY_OP_REF` may point at a
   different item.

   For a one-off shell launch, `WFB_API_KEY` is an explicit override:

   ```bash
   export WFB_API_KEY='wfb_...'
   ```

4. Connect to the dev Streamable HTTP endpoint:

   ```text
   https://workflow-builder-mcp-dev.tail286401.ts.net/mcp
   ```

   Send the key on every HTTP request:

   ```text
   Authorization: Bearer <WFB_API_KEY>
   ```

The Nix-managed Codex, Claude Code, Kimi Code, and Antigravity configurations
use a shared `mcp-remote` wrapper. The wrapper reads `WFB_API_KEY` or resolves
the configured 1Password reference, sends the bearer header, and supports
`WFB_MCP_URL` as an endpoint override. The key is read at runtime and never
written into the Nix store, generated client configuration, or process
arguments.

For a direct HTTP client, configure the same endpoint and bearer header using
that client's secret/environment interpolation mechanism.

## Verify the selected workspace

Call `get_workflow_context` before authoring, executing, or debugging workflows.
It reports the authenticated workspace, granted scopes and capabilities, and
any attached Workflow Builder session without returning the credential.

`capabilities.workflowDebug` is true when the principal has `workflow:read`.
That capability covers workspace-scoped run discovery, execution inspection,
and trace reads. It does not require an attached Workflow Builder session.

Workflow definition operations use that authenticated workspace:

- `list_workflows`
- `get_workflow`
- `save_workflow_script`
- `validate_workflow_script`
- `run_workflow_script`
- `execute_workflow`

They do not require a session ID. Saved workflows are owned by the workspace
resolved from the bearer credential, and workflow lookups are restricted to
that workspace.

## Debug a workflow run

Use a focused, progressive debugging sequence instead of loading an entire
trace into the client's context:

1. Call `list_workflow_executions` to discover recent runs in the authenticated
   workspace. Filter by workflow or status when possible, then select the exact
   workflow execution ID you intend to inspect. Do not assume the newest run is
   the relevant one when runs may overlap.
2. Call `debug_workflow_execution` with that execution ID. It provides the
   current execution state and a compact debugging view suitable for both
   running and terminal runs.
3. Call `trace_get_digest` first for the deterministic trace summary, including
   phases, timing, usage, critical path, and correlated issues.
4. Drill into only the evidence the digest identifies. Use
   `trace_search_spans` to find failures or services, `trace_get_span` for one
   exact tool/MCP/runtime span, `trace_get_llm_turn` to inspect a selected model
   turn, and `trace_get_logs` for correlated log lines. Browser runs also expose
   execution-bound screenshot references; pass one to
   `trace_get_browser_screenshot` to receive native MCP image content for vision
   analysis.

All eight tools above are authorized by the workspace principal's
`workflow:read` scope. They work on a normal API-key connection with no
`WFB_MCP_SESSION_ID`. An unknown execution and an execution outside the
authenticated workspace are both reported as not found so the tools do not
leak cross-workspace run identifiers.

Trace telemetry is eventually consistent while a run is active. Treat the
execution status as authoritative, honor any partial-data or refresh guidance
returned by the tools, and repeat the compact inspection before requesting more
span or log pages. A lack of matching spans is not by itself proof that a
running workflow is stuck.

## Optional session attachment

Set `WFB_MCP_SESSION_ID` only when intentionally attaching an existing Workflow
Builder agent session:

```bash
export WFB_MCP_SESSION_ID='<workflow-builder-session-id>'
```

The shared wrapper sends it as `X-Wfb-Session-Id`. The server verifies that the
session belongs to the same user and workspace as the API key. API-key session
context is used by goal and explicit session-lineage operations; it does not
grant trace access, team capabilities, or change workflow ownership. Trace
access comes from `workflow:read`. Team capabilities are available only to
platform-spawned agents with a signed team role.

Platform-spawned agents receive a signed, session-bound bootstrap credential
automatically. Users and external MCP clients do not create or supply it. The
BFF rechecks session state, workspace membership, and teammate membership, then
issues a five-minute principal assertion for internal operations. Script
recursion depth and team role are signed claims; caller-provided depth or team
headers do not grant capabilities. The bootstrap credential is bound to the
deployment audience and expires after seven days by default
(`WORKFLOW_MCP_SESSION_TOKEN_TTL_SECONDS` can shorten or extend that window).

The BFF and MCP images must be rolled out in phases: deploy the BFF token issuer
first, drain or restart active pre-token interactive CLI sessions, then enable
the MCP enforcement image. Existing durable or CLI sessions are not rewritten
on a spawn retry because that could overwrite signed recursion capabilities;
start a fresh session after the credential rollout or after its token expires.
Raw session IDs are never accepted by the MCP server as a rollout compatibility
credential. A dev deployment may temporarily set
`WORKFLOW_MCP_LEGACY_RUNTIME_COMPAT_UNTIL` to a future timestamp no more than 48
hours away. That application policy is limited to selected direct BFF runtime
routes, revalidates the stored owner and live session state, and grants only the
minimum resource-specific scope. It is not external MCP authentication and must
remain unset outside the bounded dev cutover.

## Manage preview environments

Workflow MCP manages dev preview environments through the Workflow Builder BFF;
it does not discover namespaces with a Kubernetes service account and does not
proxy MCP calls or credentials into a preview. The BFF resolves the signed
workspace principal, applies the authoritative platform-admin and owner access
policies, and calls the existing preview application ports.

Use this sequence:

1. Call `list_preview_services` to discover the current server-authorized
   app-live service names.
2. Call `list_preview_environments` to inspect fleet capacity, or
   `get_preview_environment` for one exact generation.
3. Call `launch_preview_environment` with a lowercase name. Omit `services` to
   select every service in the current preview-native catalog. Identity,
   platform revision, capabilities, provenance, and cold placement are derived
   by the BFF. An optional `sourceRef` is resolved to a complete commit by the
   server.
4. Call `debug_preview_environment` for a bounded lifecycle, runtime, and trace
   bundle. Use `query_preview_traces` for explicit service, status, text, and
   time-range filters, including the full `7d` preview retention window.
5. Before teardown, read the preview again and pass that same generation's
   `provenance.requestId` and `sourceRevision` to
   `teardown_preview_environment`. Poll the returned signed ticket with
   `get_preview_teardown_status` until every physical absence check completes.

Catalog, status, runtime, trace, and cleanup-status reads require
`workflow:read`. Launch and teardown require `workflow:execute`. Fleet-wide and
mutating operations additionally require the caller to be a Workflow Builder
platform administrator; per-preview diagnostics are restricted to the owner or
a platform administrator. These checks happen in the BFF, not in tool prompts.

Direct Kubernetes discovery, cross-target MCP routing, and source-key
forwarding remain deliberately disabled. A preview-local MCP endpoint is a
separate audience and must not receive the dev workspace key through these
tools.

On that direct preview connection, execution overview and authorization remain
preview-local. Digest, span, LLM-turn, and correlated-log reads use the
tuple-bound physical diagnostics adapter, so the normal trace tools work
without copying ClickHouse credentials into the preview. A physical read must
match the preview owner, dev workspace membership, exact execution proof, and
all five immutable preview identity fields.

## IDs that are not interchangeable

| Identifier                                                                      | Meaning                                                    | Use for workflow ownership? |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------- |
| Workflow definition (`workflows.id`)                                            | Saved workflow selected for authoring or execution         | No; workspace is the owner  |
| Workflow execution (`workflow_executions.id`)                                   | One run used by execution-debugging and trace tools        | No; workspace is the owner  |
| Trace/span IDs                                                                  | Correlated telemetry selected by targeted trace tools      | No                          |
| MCP transport session (`Mcp-Session-Id`)                                        | Protocol state used to resume a Streamable HTTP connection | No                          |
| Workflow Builder session (`sessions.id`)                                        | A running or retained agent session in Workflow Builder    | No; optional context only   |
| AI client thread (`CODEX_THREAD_ID`, `CLAUDE_CODE_SESSION_ID`, and equivalents) | A local conversation owned by the AI client                | No                          |

Do not copy an MCP transport session or AI client thread ID into
`WFB_MCP_SESSION_ID`. The client configurations deliberately do not infer one
identity from another.

## Troubleshooting

- **`WFB_API_KEY is required`**: store the key at the configured 1Password
  reference, or export it in the environment that launches the AI client, then
  restart that client.
- **Authentication failed**: rotate a workspace key in workspace settings and
  update `WFB_API_KEY`. For a legacy webhook key, create a replacement workspace
  key; rotation deliberately preserves its legacy scope.
- **Session context rejected**: unset `WFB_MCP_SESSION_ID`, or attach a session
  owned by the same user and workspace as the key.
- **Wrong workspace**: use a key created from the intended workspace and confirm
  it with `get_workflow_context` before saving.
- **Trace tools are unavailable**: call `get_workflow_context` and confirm that
  `capabilities.workflowDebug` is true. Trace debugging requires
  `workflow:read`, not `WFB_MCP_SESSION_ID`.
- **No trace rows yet**: call `debug_workflow_execution` and
  `trace_get_digest` first. For an active run, follow the returned refresh or
  partial-data guidance before concluding telemetry is missing.
- **Preview tools are denied**: confirm the key has `workflow:read` for
  diagnostics or `workflow:execute` for lifecycle commands. Fleet launch,
  listing, teardown, and teardown-status polling also require platform-admin
  authorization in Workflow Builder.
- **Preview evidence is partial**: honor `refreshAfterMs`, then repeat
  `debug_preview_environment`. A generation-fence warning means the preview
  changed while evidence was collected; refresh status before taking action.
- **Preview trace query timed out**: follow the returned
  `query_preview_traces` next action. It preserves the service, status, text,
  and limit filters while reducing only the time range.
- **Session-only tool has no context**: set an actual Workflow Builder session
  ID explicitly for goal or explicit lineage work. Workflow CRUD, execution
  inspection, script execution, and trace debugging should continue to work
  without one.
