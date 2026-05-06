# Dapr Workflow Purge Runbook

This runbook applies to workflow-builder, workflow-orchestrator, agent-runtime, and SWE-bench cleanup paths.

## Normal Rule

Dapr workflow purge is only a metadata cleanup step. Do not use it to stop active work.

Normal terminal cleanup order:

1. Request workflow termination.
2. Poll status until the workflow is terminal or missing.
3. Purge workflow metadata.
4. Finalize application DB rows, sandbox resources, and leases.

Dapr only supports normal purge for terminal workflow states: `COMPLETED`, `FAILED`, or `TERMINATED`. If status still reports `RUNNING`, `PENDING`, or `SUSPENDED`, keep retrying termination/status polling before purge.

## What Not To Do

Do not manually delete workflow state as routine cleanup.

Do not purge child workflow history before the parent workflow has stopped. Parent replay can still need child completion or termination events.

Do not use force-style purge semantics while any related workflow, activity, sandbox, benchmark run, or resource lease is active.

## Break-Glass Recovery

Use this only for a failed or cancelled run that is already operationally dead but Dapr keeps reporting stale non-terminal workflow state.

Before deleting state directly, verify all of the following:

1. No active benchmark runs: no rows in `benchmark_runs` with `queued`, `inferencing`, or `evaluating`.
2. No active benchmark leases: no rows in `benchmark_resource_leases` with `status='active'`.
3. No related OpenShell Sandbox CRs or pods remain.
4. The exact parent and child workflow instance IDs are known.
5. The deletion predicate is scoped to those exact instance IDs only.

After scoped state deletion:

1. Restart only the owning workflow app or sidecar, such as `workflow-orchestrator`, to clear cached actor status.
2. Use the normal application cleanup endpoint again.
3. Confirm benchmark instances are terminal, sandbox cleanup is recorded, and leases remain released.

## References

- Dapr Workflow API: purge only terminal workflows: https://docs.dapr.io/reference/api/workflow_api/
- Dapr Manage Workflows: purge requires a running workflow client to preserve state-machine integrity: https://docs.dapr.io/developing-applications/building-blocks/workflow/howto-manage-workflow/
- Dapr CLI: non-terminal force purge is dangerous and should only be used when no workflow instances are running: https://docs.dapr.io/reference/cli/dapr-workflow/
