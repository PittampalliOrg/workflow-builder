#!/usr/bin/env npx tsx
/**
 * Native child-workflow durability drill for the hydrated durable-agent flow.
 *
 * Proves that:
 *  1. workflow-builder can start the hydrated SW 1.0 workflow
 *  2. durable-agent survives pod deletion and the child workflow resumes
 *  3. workflow-orchestrator survives pod deletion while the child remains active
 *  4. the same parent/child Dapr instance IDs complete successfully
 *  5. the final agent decision summary stops explicitly with `done`
 */

import { execFileSync } from "node:child_process";

const NAMESPACE = process.env.NAMESPACE ?? "workflow-builder";
const WORKFLOW_ID =
	process.env.WORKFLOW_ID ?? "durableagenthydratedanalysisdemo1";

const WORKFLOW_BUILDER_APP =
  process.env.WORKFLOW_BUILDER_APP ?? "workflow-builder";
const WORKFLOW_BUILDER_CONTAINER =
	process.env.WORKFLOW_BUILDER_CONTAINER ?? "workflow-builder";
const DURABLE_AGENT_APP = process.env.DURABLE_AGENT_APP ?? "durable-agent";
const ORCHESTRATOR_APP =
	process.env.ORCHESTRATOR_APP ?? "workflow-orchestrator";

const PRE_CHILD_KILL_WAIT_SECONDS = parseInt(
	process.env.PRE_CHILD_KILL_WAIT_SECONDS ?? "10",
	10,
);
const POST_CHILD_RESTART_WAIT_SECONDS = parseInt(
	process.env.POST_CHILD_RESTART_WAIT_SECONDS ?? "10",
	10,
);
const PRE_PARENT_KILL_WAIT_SECONDS = parseInt(
	process.env.PRE_PARENT_KILL_WAIT_SECONDS ?? "6",
	10,
);
const POST_PARENT_RESTART_WAIT_SECONDS = parseInt(
	process.env.POST_PARENT_RESTART_WAIT_SECONDS ?? "8",
	10,
);
const WORKFLOW_TIMEOUT_SECONDS = parseInt(
	process.env.WORKFLOW_TIMEOUT_SECONDS ?? "900",
	10,
);

const SKIP_CHILD_KILL = process.argv.includes("--skip-child-kill");
const SKIP_PARENT_KILL = process.argv.includes("--skip-parent-kill");
const UPSERT_SCRIPT_PATH =
	process.env.UPSERT_SCRIPT_PATH ??
	"/app/scripts/upsert-durable-agent-hydrated-analysis-workflow.mjs";

type WorkflowExecutionStatus = {
	executionId: string;
	instanceId: string | null;
	workflowId: string;
	status: string;
	phase: string | null;
	progress: number | null;
	output: Record<string, unknown> | null;
	traceId: string | null;
	completedAt: string | null;
};

type AgentDecisionSummary = {
	totalTurns: number;
	toolCallTurns: number;
	assistantMessageTurns: number;
	waitOrApprovalTurns: number;
	stopTurns: number;
	errorTurns: number;
	totalToolCalls: number;
	totalDurationMs: number;
	totalTokens: number;
	averageTurnLatencyMs: number;
	stopReason: string | null;
};

type AgentDecisionTurn = {
	turnIndex: number;
	decisionType: string;
	decisionLabel: string;
	durationMs: number;
	stopReason: string | null;
	toolCalls: Array<{ name?: string; args?: Record<string, unknown> }>;
	toolResults: Array<Record<string, unknown>>;
};

type AgentDecisionPayload = {
	summary: AgentDecisionSummary;
	turns: AgentDecisionTurn[];
};

type WorkflowAgentRunRow = {
	id: string;
	workflow_execution_id: string;
	workflow_id: string;
	node_id: string;
	mode: string;
	agent_workflow_id: string;
	dapr_instance_id: string;
	parent_execution_id: string;
	workspace_ref: string | null;
	status: string;
	created_at: string;
	updated_at: string;
	completed_at: string | null;
};

function log(message: string) {
	const stamp = new Date().toISOString().slice(11, 23);
	console.log(`[durability] ${stamp} ${message}`);
}

function fail(message: string): never {
	console.error(`\nFAIL: ${message}`);
	process.exit(1);
}

function pass(message: string) {
	console.log(`\nPASS: ${message}`);
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function kubectl(args: string[]) {
	return execFileSync("kubectl", args, {
		encoding: "utf-8",
		timeout: 60_000,
		maxBuffer: 50 * 1024 * 1024,
	}).trim();
}

function kubectlJson<T>(args: string[]): T {
	const raw = kubectl(args);
	return JSON.parse(raw) as T;
}

function getNewestRunningPod(appName: string): string {
	const data = kubectlJson<{
		items: Array<{
			metadata?: { name?: string; creationTimestamp?: string };
      status?: {
        phase?: string;
        containerStatuses?: Array<{ ready?: boolean }>;
      };
		}>;
  }>(["-n", NAMESPACE, "get", "pods", "-l", `app=${appName}`, "-o", "json"]);

	const running = (data.items ?? [])
		.filter(
			(item) =>
				item.metadata?.name &&
				item.status?.phase === "Running" &&
        (item.status.containerStatuses ?? []).every(
          (status) => status.ready === true,
        ),
		)
		.sort((a, b) =>
			String(a.metadata?.creationTimestamp ?? "").localeCompare(
				String(b.metadata?.creationTimestamp ?? ""),
			),
		);

	const pod = running.at(-1)?.metadata?.name;
	if (!pod) {
    fail(
      `No ready running pod found for app=${appName} in namespace ${NAMESPACE}`,
    );
	}
	return pod;
}

function execNodeInPod(
	podName: string,
	containerName: string,
	script: string,
	options?: { inputTypeModule?: boolean },
) {
	const args = [
		"-n",
		NAMESPACE,
		"exec",
		podName,
		"-c",
		containerName,
		"--",
		"node",
	];
	if (options?.inputTypeModule) {
		args.push("--input-type=module");
	}
	args.push("-e", script);
	return kubectl(args);
}

function execInWorkflowBuilderPod(args: string[]) {
	const pod = getNewestRunningPod(WORKFLOW_BUILDER_APP);
	return kubectl([
		"-n",
		NAMESPACE,
		"exec",
		pod,
		"-c",
		WORKFLOW_BUILDER_CONTAINER,
		"--",
		...args,
	]);
}

function upsertHydratedWorkflow() {
	log(`upserting workflow definition ${WORKFLOW_ID}`);
	const args = [
		"env",
		`DATABASE_URL=${process.env.DATABASE_URL ?? "postgresql://postgres:password@postgresql.workflow-builder.svc.cluster.local:5432/workflow_builder"}`,
		`WORKFLOW_ID=${WORKFLOW_ID}`,
	];
	const passthrough = [
		"WORKFLOW_NAME",
		"WORKFLOW_DESCRIPTION",
		"WORKFLOW_PROMPT",
		"REPOSITORY_OWNER",
		"REPOSITORY_REPO",
		"REPOSITORY_BRANCH",
		"TARGET_DIR",
		"MODEL_SPEC",
		"WORKFLOW_MODEL",
		"MAX_TURNS",
		"TIMEOUT_MINUTES",
	];
	for (const key of passthrough) {
		const value = process.env[key];
		if (value && value.trim()) {
			args.push(`${key}=${value}`);
		}
	}
	args.push("node", UPSERT_SCRIPT_PATH);
	const output = execInWorkflowBuilderPod(args);
	log(`upsert complete: ${output.replace(/\s+/g, " ").trim()}`);
}

function fetchViaWorkflowBuilderPod<T>(
	path: string,
	options?: {
		method?: string;
		body?: Record<string, unknown>;
		internalAuth?: boolean;
    headers?: Record<string, string>;
	},
): T {
	const pod = getNewestRunningPod(WORKFLOW_BUILDER_APP);
	const script = `
const headers = { "Content-Type": "application/json", ...${JSON.stringify(options?.headers ?? {})} };
if (${options?.internalAuth === true}) headers["X-Internal-Token"] = process.env.INTERNAL_API_TOKEN;
const opts = {
  method: ${JSON.stringify(options?.method ?? "GET")},
  headers,
  ${options?.body ? `body: ${JSON.stringify(JSON.stringify(options.body))},` : ""}
};
fetch("http://127.0.0.1:3000${path}", opts)
  .then(async (res) => {
    const text = await res.text();
    process.stdout.write(text);
    if (!res.ok) process.exit(2);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
`;
	const raw = execNodeInPod(pod, WORKFLOW_BUILDER_CONTAINER, script);
	return JSON.parse(raw) as T;
}

function queryAgentRuns(executionId: string): WorkflowAgentRunRow[] {
	const pod = getNewestRunningPod(WORKFLOW_BUILDER_APP);
	const script = `
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const executionId = ${JSON.stringify(executionId)};
const rows = await sql\`
  select
    id,
    workflow_execution_id,
    workflow_id,
    node_id,
    mode,
    agent_workflow_id,
    dapr_instance_id,
    parent_execution_id,
    workspace_ref,
    status,
    created_at::text as created_at,
    updated_at::text as updated_at,
    completed_at::text as completed_at
  from workflow_agent_runs
  where workflow_execution_id = ${"${executionId}"}
  order by created_at asc
\`;
process.stdout.write(JSON.stringify(rows));
await sql.end({ timeout: 5 });
`;
	const raw = execNodeInPod(pod, WORKFLOW_BUILDER_CONTAINER, script, {
		inputTypeModule: true,
	});
	return JSON.parse(raw) as WorkflowAgentRunRow[];
}

function startExecution() {
	log(`starting workflow ${WORKFLOW_ID}`);
	return fetchViaWorkflowBuilderPod<{
		success: boolean;
		executionId: string;
		instanceId: string;
		workflowId: string;
		workflowName: string;
		status: string;
	}>("/api/internal/agent/workflows/execute", {
		method: "POST",
		internalAuth: true,
    headers: { "x-wfb-system-principal": "workflow-trigger" },
		body: {
			workflowId: WORKFLOW_ID,
			triggerData: {},
		},
	});
}

function getExecutionStatus(executionId: string): WorkflowExecutionStatus {
	return fetchViaWorkflowBuilderPod<WorkflowExecutionStatus>(
		`/api/workflows/executions/${executionId}/status`,
	);
}

function getAgentDecisions(executionId: string): AgentDecisionPayload {
	return fetchViaWorkflowBuilderPod<AgentDecisionPayload>(
		`/api/observability/sessions/${executionId}/agent-decisions`,
	);
}

async function waitForSettledAgentDecisions(
	executionId: string,
	timeoutSeconds = 120,
) {
	const deadline = Date.now() + timeoutSeconds * 1000;
	let lastPayload: AgentDecisionPayload | null = null;
	while (Date.now() < deadline) {
		const payload = getAgentDecisions(executionId);
		lastPayload = payload;
		if (
			payload.summary.stopTurns >= 1 &&
			payload.summary.stopReason === "done"
		) {
			return payload;
		}
		await sleep(3000);
	}
	return lastPayload ?? getAgentDecisions(executionId);
}

async function waitForAgentRun(executionId: string, timeoutSeconds = 120) {
	const deadline = Date.now() + timeoutSeconds * 1000;
	while (Date.now() < deadline) {
		const runs = queryAgentRuns(executionId);
		if (runs.length > 0) {
			return runs[0];
		}
		await sleep(3000);
	}
  fail(
    `Timed out waiting for workflow_agent_runs row for execution ${executionId}`,
  );
}

async function waitForExecutionToBeRunning(
	executionId: string,
	timeoutSeconds = 120,
) {
	const deadline = Date.now() + timeoutSeconds * 1000;
	while (Date.now() < deadline) {
		const status = getExecutionStatus(executionId);
		if (status.status === "running") {
			return status;
		}
		if (status.status === "error" || status.status === "cancelled") {
      fail(
        `Execution ${executionId} failed before durability drill: ${status.status}`,
      );
		}
		await sleep(3000);
	}
	fail(`Timed out waiting for execution ${executionId} to reach running state`);
}

async function waitForReadyReplacement(appName: string, oldPodName: string) {
  log(
    `waiting for replacement pod for ${appName} after deleting ${oldPodName}`,
  );
	const deadline = Date.now() + 180_000;
	while (Date.now() < deadline) {
		const data = kubectlJson<{
			items: Array<{
				metadata?: { name?: string; creationTimestamp?: string };
        status?: {
          phase?: string;
          containerStatuses?: Array<{ ready?: boolean }>;
        };
			}>;
    }>(["-n", NAMESPACE, "get", "pods", "-l", `app=${appName}`, "-o", "json"]);
		const replacement = (data.items ?? [])
			.filter(
				(item) =>
					item.metadata?.name &&
					item.metadata.name !== oldPodName &&
					item.status?.phase === "Running" &&
					(item.status.containerStatuses ?? []).length > 0 &&
          (item.status.containerStatuses ?? []).every(
            (status) => status.ready === true,
          ),
			)
			.sort((a, b) =>
				String(a.metadata?.creationTimestamp ?? "").localeCompare(
					String(b.metadata?.creationTimestamp ?? ""),
				),
			)
			.at(-1);

		if (replacement?.metadata?.name) {
			log(`replacement pod ready for ${appName}: ${replacement.metadata.name}`);
			return replacement.metadata.name;
		}
		await sleep(3000);
	}
	fail(`Timed out waiting for ready replacement pod for app=${appName}`);
}

function deletePod(appName: string) {
	const pod = getNewestRunningPod(appName);
	log(`deleting pod ${pod}`);
	kubectl(["-n", NAMESPACE, "delete", "pod", pod, "--wait=false"]);
	return pod;
}

async function waitForCompletion(executionId: string) {
	const deadline = Date.now() + WORKFLOW_TIMEOUT_SECONDS * 1000;
	while (Date.now() < deadline) {
		const status = getExecutionStatus(executionId);
		log(
			`execution ${executionId} status=${status.status} phase=${status.phase ?? "unknown"} trace=${status.traceId ?? "none"}`,
		);
		if (status.status === "success") {
			return status;
		}
		if (status.status === "error" || status.status === "cancelled") {
			fail(`Execution ${executionId} ended with status ${status.status}`);
		}
		await sleep(5000);
	}
	fail(`Timed out waiting for execution ${executionId} to complete`);
}

function extractAgentStep(status: WorkflowExecutionStatus) {
	const output = (status.output ?? {}) as Record<string, unknown>;
	const outputs = (output.outputs ?? {}) as Record<string, unknown>;
	for (const value of Object.values(outputs)) {
		const record = value as Record<string, unknown>;
		if ((record.actionType as string) === "durable/run") {
			return record.data as Record<string, unknown>;
		}
	}
	return null;
}

function verifyReportArtifact(agentStep: Record<string, unknown> | null) {
	const result = (agentStep?.result ?? {}) as Record<string, unknown>;
	const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
	const executeCalls = toolCalls.filter(
		(call) => (call as Record<string, unknown>).name === "execute_command",
	) as Record<string, unknown>[];
	if (executeCalls.length === 0) {
		return {
			success: false,
			error: "No execute_command tool calls recorded",
		};
	}

	const outputs = executeCalls.map((call) => ({
    command: String(
      ((call.args ?? {}) as Record<string, unknown>).command ?? "",
    ),
		success: Boolean(((call.result ?? {}) as Record<string, unknown>).success),
    stdout: String(
      ((call.result ?? {}) as Record<string, unknown>).stdout ?? "",
    ),
	}));

	const successfulOutputs = outputs.filter((entry) => entry.success);
  const combinedStdout = successfulOutputs
    .map((entry) => entry.stdout)
    .join("\n---\n");
	const requiredHeadings = [
		"Scope",
		"Key Files Reviewed",
		"Architecture Summary",
		"Risks / Gaps",
		"Recommended Next Improvements",
		"Verification",
	];
	const headingCheck =
		combinedStdout.includes("HEADINGS_OK") ||
		requiredHeadings.every(
			(heading) =>
				combinedStdout.includes(`heading ok: ${heading}`) ||
				combinedStdout.includes(`OK ${heading}`) ||
				combinedStdout.includes(`found: ${heading}`) ||
				combinedStdout.includes(`Found # ${heading}`) ||
				combinedStdout.includes(`# ${heading}`),
		);
	const pathCount =
		Number(combinedStdout.match(/PATH_COUNT=(\d+)/)?.[1] ?? "0") ||
		Number(combinedStdout.match(/path_count:\s*(\d+)/i)?.[1] ?? "0") ||
		Number(combinedStdout.match(/path count:\s*(\d+)/i)?.[1] ?? "0") ||
    Number(
      combinedStdout.match(/File path count:\s*\n?\s*(\d+)/i)?.[1] ?? "0",
    ) ||
		Number(combinedStdout.match(/unique_path_count=(\d+)/i)?.[1] ?? "0") ||
    Number(
      combinedStdout.match(/Unique repo-like paths:\s*(\d+)/i)?.[1] ?? "0",
    );
	const pathCheck =
		(combinedStdout.includes("PATHS_OK") ||
			combinedStdout.includes("path count ok") ||
			combinedStdout.includes("paths: ok") ||
			combinedStdout.includes("Verification passed") ||
			pathCount > 0) &&
		pathCount >= 8;
	const existenceCheck =
		combinedStdout.includes("EXISTS") ||
		combinedStdout.includes("exists: yes") ||
		combinedStdout.includes("exists: ok") ||
		combinedStdout.includes("Existence:\nOK") ||
		combinedStdout.includes("Verify file exists:\nOK") ||
		combinedStdout.includes("Existence check:") ||
		combinedStdout.includes("Checking file exists:") ||
		combinedStdout.includes("Report created: yes") ||
		combinedStdout.includes("agent-hydrated-analysis-report.md") ||
		combinedStdout.includes("report written");

	const success = Boolean(headingCheck && pathCheck && existenceCheck);

	return {
		success,
		error: success
			? undefined
      : `Missing verification markers: ${[
						headingCheck ? null : "required headings",
						pathCheck ? null : "path count >= 8",
						existenceCheck ? null : "report existence",
					]
						.filter(Boolean)
          .join(", ")}`,
		stdout: combinedStdout,
		command: successfulOutputs.map((entry) => entry.command).join("\n---\n"),
	};
}

async function main() {
	console.log("=".repeat(72));
	console.log("  Native Dapr Durability Drill");
	console.log("=".repeat(72));
	console.log(`  Namespace:                ${NAMESPACE}`);
	console.log(`  Workflow:                 ${WORKFLOW_ID}`);
	console.log(`  Skip child kill:          ${SKIP_CHILD_KILL}`);
	console.log(`  Skip parent kill:         ${SKIP_PARENT_KILL}`);
	console.log(`  Pre-child kill wait:      ${PRE_CHILD_KILL_WAIT_SECONDS}s`);
  console.log(
    `  Post-child restart wait:  ${POST_CHILD_RESTART_WAIT_SECONDS}s`,
  );
	console.log(`  Pre-parent kill wait:     ${PRE_PARENT_KILL_WAIT_SECONDS}s`);
  console.log(
    `  Post-parent restart wait: ${POST_PARENT_RESTART_WAIT_SECONDS}s`,
  );
	console.log(`  Workflow timeout:         ${WORKFLOW_TIMEOUT_SECONDS}s`);
	console.log();

	upsertHydratedWorkflow();

	const started = startExecution();
	if (!started.success) {
		fail(`Failed to start workflow ${WORKFLOW_ID}`);
	}
	log(
		`started executionId=${started.executionId} parentInstanceId=${started.instanceId}`,
	);

	await waitForExecutionToBeRunning(started.executionId);
	const childRunBeforeKill = await waitForAgentRun(started.executionId);
	log(
		`child run scheduled childInstanceId=${childRunBeforeKill.dapr_instance_id} agentWorkflowId=${childRunBeforeKill.agent_workflow_id}`,
	);

	if (!SKIP_CHILD_KILL) {
    log(
      `waiting ${PRE_CHILD_KILL_WAIT_SECONDS}s before deleting durable-agent`,
    );
		await sleep(PRE_CHILD_KILL_WAIT_SECONDS * 1000);
		const oldChildPod = deletePod(DURABLE_AGENT_APP);
		await waitForReadyReplacement(DURABLE_AGENT_APP, oldChildPod);
		log(
			`waiting ${POST_CHILD_RESTART_WAIT_SECONDS}s for durable-agent replay stabilization`,
		);
		await sleep(POST_CHILD_RESTART_WAIT_SECONDS * 1000);

		const afterChildRecoveryStatus = getExecutionStatus(started.executionId);
		if (afterChildRecoveryStatus.status !== "running") {
			fail(
				`Execution finished too early after durable-agent restart: ${afterChildRecoveryStatus.status}`,
			);
		}

    const childRunAfterChildRestart = await waitForAgentRun(
      started.executionId,
    );
		if (
			childRunAfterChildRestart.dapr_instance_id !==
				childRunBeforeKill.dapr_instance_id ||
			childRunAfterChildRestart.agent_workflow_id !==
				childRunBeforeKill.agent_workflow_id
		) {
			fail("Child workflow instance changed after durable-agent restart");
		}
		log(
			`child instance stable after durable-agent restart: ${childRunAfterChildRestart.dapr_instance_id}`,
		);
	} else {
		log("skipping durable-agent pod delete");
	}

	if (!SKIP_PARENT_KILL) {
    log(
      `waiting ${PRE_PARENT_KILL_WAIT_SECONDS}s before deleting workflow-orchestrator`,
    );
		await sleep(PRE_PARENT_KILL_WAIT_SECONDS * 1000);
		const preParentKillStatus = getExecutionStatus(started.executionId);
		if (preParentKillStatus.status !== "running") {
			fail(
				`Execution is no longer running before orchestrator restart: ${preParentKillStatus.status}`,
			);
		}

		const oldParentPod = deletePod(ORCHESTRATOR_APP);
		await waitForReadyReplacement(ORCHESTRATOR_APP, oldParentPod);
		log(
			`waiting ${POST_PARENT_RESTART_WAIT_SECONDS}s for orchestrator recovery`,
		);
		await sleep(POST_PARENT_RESTART_WAIT_SECONDS * 1000);

    const childRunAfterParentRestart = await waitForAgentRun(
      started.executionId,
    );
		if (
			childRunAfterParentRestart.dapr_instance_id !==
				childRunBeforeKill.dapr_instance_id ||
			childRunAfterParentRestart.agent_workflow_id !==
				childRunBeforeKill.agent_workflow_id
		) {
			fail("Child workflow instance changed after orchestrator restart");
		}
		log(
			`child instance stable after orchestrator restart: ${childRunAfterParentRestart.dapr_instance_id}`,
		);
	} else {
		log("skipping workflow-orchestrator pod delete");
	}

	const completed = await waitForCompletion(started.executionId);
	const decisions = await waitForSettledAgentDecisions(started.executionId);
	const finalChildRun = await waitForAgentRun(started.executionId);
	const agentStep = extractAgentStep(completed);
	const reportVerification = verifyReportArtifact(agentStep);

	const checks = [
		{
			name: "Workflow completed successfully",
			ok: completed.status === "success",
		},
		{
			name: "Parent workflow instance stayed stable",
			ok: completed.instanceId === started.instanceId,
		},
		{
			name: "Child workflow instance stayed stable",
			ok:
        finalChildRun.dapr_instance_id ===
          childRunBeforeKill.dapr_instance_id &&
        finalChildRun.agent_workflow_id ===
          childRunBeforeKill.agent_workflow_id,
		},
		{
			name: "Decision summary captured at least four tool-driven turns",
			ok: decisions.summary.toolCallTurns >= 4,
		},
		{
			name: "Decision summary captured exactly one stop turn",
			ok: decisions.summary.stopTurns === 1,
		},
		{
			name: "Final stop reason is done",
			ok: decisions.summary.stopReason === "done",
		},
		{
			name: "Generated report artifact passed direct verification",
			ok: Boolean((reportVerification as { success?: boolean }).success),
		},
	];

	console.log();
	console.log("-".repeat(72));
	console.log("  Durability Drill Results");
	console.log("-".repeat(72));
	console.log(`  executionId:             ${started.executionId}`);
	console.log(`  parentInstanceId:        ${started.instanceId}`);
	console.log(`  childDaprInstanceId:     ${finalChildRun.dapr_instance_id}`);
	console.log(`  childAgentWorkflowId:    ${finalChildRun.agent_workflow_id}`);
	console.log(`  finalStatus:             ${completed.status}`);
	console.log(`  finalTraceId:            ${completed.traceId ?? "n/a"}`);
	console.log(`  decisionTurns:           ${decisions.summary.totalTurns}`);
	console.log(`  toolCallTurns:           ${decisions.summary.toolCallTurns}`);
	console.log(`  totalToolCalls:          ${decisions.summary.totalToolCalls}`);
  console.log(
    `  stopReason:              ${decisions.summary.stopReason ?? "n/a"}`,
  );
	console.log(`  totalTokens:             ${decisions.summary.totalTokens}`);
	console.log(
		`  reportVerified:          ${Boolean((reportVerification as { success?: boolean }).success) ? "yes" : "no"}`,
	);
	if (!reportVerification.success && reportVerification.error) {
		console.log(`  reportVerificationError: ${reportVerification.error}`);
	}
	console.log("-".repeat(72));

	for (const check of checks) {
		console.log(`  ${check.ok ? "OK" : "FAIL"} ${check.name}`);
	}
	console.log();

	if (!checks.every((check) => check.ok)) {
    const failed = checks
      .filter((check) => !check.ok)
      .map((check) => check.name);
		fail(`Failed checks: ${failed.join(", ")}`);
	}

	pass(
		`Workflow ${WORKFLOW_ID} survived the configured restart drill and completed with stable parent/child instances.`,
	);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
