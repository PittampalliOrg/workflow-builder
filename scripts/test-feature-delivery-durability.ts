/**
 * Live durability drill for the OpenShell feature delivery workflow.
 *
 * Usage:
 *   DATABASE_URL=... GENERIC_ORCHESTRATOR_URL=http://127.0.0.1:3013 \
 *   pnpm exec tsx scripts/test-feature-delivery-durability.ts
 */
import { execSync } from "node:child_process";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { genericOrchestratorClient } from "../lib/dapr-client";
import {
	workflows,
	workflowExecutions,
	workflowAgentRuns,
	workflowPlanArtifacts,
} from "../lib/db/schema";
import { generateWorkflowDefinition } from "../lib/workflow-definition";
import type { WorkflowEdge, WorkflowNode } from "../lib/workflow-store";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
	throw new Error("DATABASE_URL is required");
}

const ORCHESTRATOR_URL =
	process.env.GENERIC_ORCHESTRATOR_URL || "http://127.0.0.1:3013";
const WORKFLOW_ID = process.env.WORKFLOW_ID || "agentsysdemo001";
const NAMESPACE = process.env.NAMESPACE || "workflow-builder";
const OPENSHELL_LANGGRAPH_DEPLOYMENT =
	process.env.OPENSHELL_LANGGRAPH_DEPLOYMENT ||
	"openshell-langgraph-observable";
const ORCHESTRATOR_DEPLOYMENT =
	process.env.ORCHESTRATOR_DEPLOYMENT || "workflow-orchestrator";
const POLL_INTERVAL_MS = Number.parseInt(
	process.env.POLL_INTERVAL_MS || "5000",
	10,
);
const TIMEOUT_MS = Number.parseInt(
	process.env.WORKFLOW_TIMEOUT_MS || `${30 * 60 * 1000}`,
	10,
);

const sql = postgres(DATABASE_URL, { max: 1 });
const db = drizzle(sql, {
	schema: {
		workflows,
		workflowExecutions,
		workflowAgentRuns,
		workflowPlanArtifacts,
	},
});

function log(message: string) {
	const stamp = new Date().toISOString();
	console.log(`[durability] ${stamp} ${message}`);
}

function kubectl(args: string) {
	return execSync(`kubectl ${args}`, {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

async function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientNetworkError(error: unknown) {
	if (!(error instanceof Error)) {
		return false;
	}
	if (error.message.includes("fetch failed")) {
		return true;
	}
	if (
		error.message.includes("workflow_runtime_unavailable") ||
		error.message.includes("Dapr workflow runtime is not ready")
	) {
		return true;
	}
	const cause = (error as Error & { cause?: { code?: string } }).cause;
	return cause?.code === "UND_ERR_SOCKET" || cause?.code === "ECONNREFUSED";
}

async function withTransientRetries<T>(
	label: string,
	operation: () => Promise<T>,
	maxAttempts = 18,
) {
	let attempt = 0;
	while (true) {
		attempt += 1;
		try {
			return await operation();
		} catch (error) {
			if (!isTransientNetworkError(error) || attempt >= maxAttempts) {
				throw error;
			}
			log(`${label}: transient network error during rollout, retrying`);
			await sleep(POLL_INTERVAL_MS);
		}
	}
}

async function loadWorkflow() {
	const workflow = await db.query.workflows.findFirst({
		where: eq(workflows.id, WORKFLOW_ID),
	});
	if (!workflow) {
		throw new Error(`Workflow ${WORKFLOW_ID} not found`);
	}
	return workflow;
}

async function startExecution() {
	const workflow = await loadWorkflow();
	const definition = generateWorkflowDefinition(
		workflow.nodes as WorkflowNode[],
		workflow.edges as WorkflowEdge[],
		workflow.id,
		workflow.name,
		{ author: workflow.userId },
	);
	const [execution] = await db
		.insert(workflowExecutions)
		.values({
			workflowId: workflow.id,
			userId: workflow.userId,
			status: "running",
			input: {},
		})
		.returning();

	const result = await withTransientRetries("start workflow", () =>
		genericOrchestratorClient.startWorkflow(
			ORCHESTRATOR_URL,
			definition,
			{},
			{},
			execution.id,
			{},
		),
	);

	await db
		.update(workflowExecutions)
		.set({
			daprInstanceId: result.instanceId,
			status: "running",
			phase: "running",
			progress: 0,
		})
		.where(eq(workflowExecutions.id, execution.id));

	log(`started execution=${execution.id} instance=${result.instanceId}`);
	return { executionId: execution.id, instanceId: result.instanceId };
}

async function pollStatus(
	instanceId: string,
	predicate: (
		status: Awaited<
			ReturnType<typeof genericOrchestratorClient.getWorkflowStatus>
		>,
	) => boolean,
	label: string,
) {
	const deadline = Date.now() + TIMEOUT_MS;
	while (Date.now() < deadline) {
		const status = await withTransientRetries(label, () =>
			genericOrchestratorClient.getWorkflowStatus(ORCHESTRATOR_URL, instanceId),
		);
		log(
			`${label}: runtime=${status.runtimeStatus} phase=${status.phase} progress=${status.progress}`,
		);
		if (predicate(status)) {
			return status;
		}
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function pollAgentRun(executionId: string, mode: "plan" | "run") {
	const deadline = Date.now() + TIMEOUT_MS;
	while (Date.now() < deadline) {
		const rows = await db
			.select()
			.from(workflowAgentRuns)
			.where(eq(workflowAgentRuns.workflowExecutionId, executionId))
			.orderBy(asc(workflowAgentRuns.createdAt));
		const match = rows.find((row) =>
			row.agentWorkflowId.includes(`__${mode}__`),
		);
		if (match) {
			return match;
		}
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error(`Timed out waiting for ${mode} child row`);
}

function restartDeployment(name: string) {
	log(`restarting deployment/${name}`);
	kubectl(`-n ${NAMESPACE} rollout restart deployment/${name}`);
	kubectl(`-n ${NAMESPACE} rollout status deployment/${name} --timeout=180s`);
}

async function approve(instanceId: string, eventName: string) {
	log(`approving with event ${eventName}`);
	await withTransientRetries("approval event", () =>
		genericOrchestratorClient.raiseEvent(
			ORCHESTRATOR_URL,
			instanceId,
			eventName,
			{
				approved: true,
				reason: "durability drill approval",
				approvedBy: "codex",
			},
		),
	);
}

async function assertExecutionArtifacts(executionId: string) {
	const [execution] = await db
		.select()
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, executionId))
		.limit(1);
	if (!execution) {
		throw new Error(`Execution ${executionId} not found`);
	}
	if (execution.status !== "success") {
		throw new Error(
			`Execution ${executionId} finished with status ${execution.status}`,
		);
	}
	const agentRuns = await db
		.select()
		.from(workflowAgentRuns)
		.where(eq(workflowAgentRuns.workflowExecutionId, executionId))
		.orderBy(asc(workflowAgentRuns.createdAt));
	const planArtifact = await db.query.workflowPlanArtifacts.findFirst({
		where: and(
			eq(workflowPlanArtifacts.workflowExecutionId, executionId),
			eq(workflowPlanArtifacts.workflowId, WORKFLOW_ID),
		),
	});
	if (!planArtifact) {
		throw new Error("Plan artifact missing");
	}
	if (planArtifact.status !== "executed") {
		throw new Error(`Plan artifact status is ${planArtifact.status}`);
	}
	const incompleteRuns = agentRuns.filter((row) => row.status !== "completed");
	if (incompleteRuns.length > 0) {
		throw new Error(
			`Child runs not terminal: ${incompleteRuns.map((row) => `${row.id}:${row.status}`).join(", ")}`,
		);
	}
	const output = execution.output as Record<string, unknown> | null;
	const nestedOutputs =
		output?.outputs && typeof output.outputs === "object"
			? (output.outputs as Record<string, unknown>)
			: null;
	const daprNodeOutput =
		nestedOutputs?.da_agent_system_demo &&
		typeof nestedOutputs.da_agent_system_demo === "object"
			? (nestedOutputs.da_agent_system_demo as Record<string, unknown>)
			: null;
	const patchSources = [output?.patch, daprNodeOutput?.patch];
	const patch = patchSources.find(
		(value): value is string =>
			typeof value === "string" && value.trim().length > 0,
	);
	const fileChanges =
		Array.isArray(output?.fileChanges) && output.fileChanges.length > 0
			? output.fileChanges
			: Array.isArray(daprNodeOutput?.fileChanges)
				? daprNodeOutput.fileChanges
				: [];
	const snapshotRefs =
		Array.isArray(output?.snapshotRefs) && output.snapshotRefs.length > 0
			? output.snapshotRefs
			: Array.isArray(daprNodeOutput?.snapshotRefs)
				? daprNodeOutput.snapshotRefs
				: [];
	log(
		`verified execution=${executionId} planArtifact=${planArtifact.id} childRuns=${agentRuns.length}`,
	);
	if (!patch) {
		throw new Error("Final execution patch missing from persisted output");
	}
	if (fileChanges.length === 0) {
		throw new Error("Final execution fileChanges are empty");
	}
	if (snapshotRefs.length === 0) {
		throw new Error("Final execution snapshotRefs are empty");
	}
}

async function main() {
	const { executionId, instanceId } = await startExecution();

	await pollAgentRun(executionId, "plan");
	restartDeployment(OPENSHELL_LANGGRAPH_DEPLOYMENT);

	const awaitingApproval = await pollStatus(
		instanceId,
		(status) =>
			status.phase === "awaiting_approval" && Boolean(status.approvalEventName),
		"awaiting approval",
	);

	restartDeployment(ORCHESTRATOR_DEPLOYMENT);

	const recoveredApproval = await pollStatus(
		instanceId,
		(status) =>
			status.phase === "awaiting_approval" &&
			status.approvalEventName === awaitingApproval.approvalEventName,
		"approval recovery",
	);

	if (!recoveredApproval.approvalEventName) {
		throw new Error("Approval event name missing after orchestrator restart");
	}

	await approve(instanceId, recoveredApproval.approvalEventName);
	await pollAgentRun(executionId, "run");

	await pollStatus(
		instanceId,
		(status) =>
			status.phase === "executing" ||
			status.phase === "running" ||
			status.progress >= 55,
		"execution start",
	);

	restartDeployment(OPENSHELL_LANGGRAPH_DEPLOYMENT);

	await pollStatus(
		instanceId,
		(status) =>
			status.phase === "completed" || status.runtimeStatus === "COMPLETED",
		"workflow completion",
	);

	await assertExecutionArtifacts(executionId);
	log("durability drill passed");
}

main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(async () => {
		await sql.end();
	});
