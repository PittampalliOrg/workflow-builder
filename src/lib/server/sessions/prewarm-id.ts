/**
 * Pure reconstruction of the orchestrator's deterministic child session id.
 *
 * Isolated (zero heavy imports) so a unit test can pin the format against the
 * Python orchestrator WITHOUT pulling in the server runtime. This is the
 * load-bearing seam for identity-bound prewarm: if the format drifts from the
 * orchestrator, prewarm creates a pod under a NON-matching id → no adoption →
 * wasted (reaped) pod + zero benefit (never a crash). The test fixture below the
 * source of truth lives in `prewarm-id.test.ts`.
 *
 * Mirrors EXACTLY:
 *   - services/workflow-orchestrator/app.py:3294
 *       safe_name = re.sub(r'[^a-z0-9-]','-', name.lower()).strip('-')[:40]
 *       instance_id = f"sw-{safe_name}-exec-{db_execution_id}"
 *   - services/workflow-orchestrator/workflows/sw_workflow.py:1575,1577
 *       safe_task_name = re.sub(r"[^A-Za-z0-9_.-]","-", task_name)
 *       child = f"{instance_id}__{instance_prefix}__{safe_task_name}__run__{index}"
 */
/**
 * The orchestrator's workflow INSTANCE id (`sw-<safeName>-exec-<execId>`).
 *
 * NOTE: this is `tc.execution_id` in the orchestrator — which is ALSO what the
 * jq runtime context exposes as `${ .runtime.executionId }` (sw_workflow.py:741).
 * It is DISTINCT from `tc.db_execution_id` (the bare BFF execution.id). A node
 * `workspaceRef: "${ .runtime.executionId }"` therefore resolves to THIS instance
 * id, not the bare id — load-bearing for shared-workspace subPath replication.
 */
export function reconstructOrchestratorInstanceId(params: {
	workflowName: string;
	executionId: string;
}): string {
	const safeName = params.workflowName
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/^-+/, "")
		.replace(/-+$/, "")
		.slice(0, 40);
	return `sw-${safeName}-exec-${params.executionId}`;
}

export function reconstructChildSessionId(params: {
	workflowName: string;
	executionId: string;
	instancePrefix: string;
	taskName: string;
	runIndex?: number;
}): string {
	const instanceId = reconstructOrchestratorInstanceId(params);
	const safeTaskName = params.taskName.replace(/[^A-Za-z0-9_.-]/g, "-");
	const index = params.runIndex ?? 0;
	return `${instanceId}__${params.instancePrefix}__${safeTaskName}__run__${index}`;
}
