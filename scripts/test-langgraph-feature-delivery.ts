/**
 * Execute the committed LangGraph Dapr agent smoke workflow and assert the plan
 * and execute phases complete through the Dapr agent runtime.
 *
 * Usage:
 *   DATABASE_URL=... GENERIC_ORCHESTRATOR_URL=http://127.0.0.1:3013 \
 *   pnpm exec tsx scripts/test-langgraph-feature-delivery.ts
 */

import { and, asc, desc, eq } from "drizzle-orm";
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
const WORKFLOW_ID = process.env.WORKFLOW_ID;
const WORKFLOW_NAME = process.env.WORKFLOW_NAME || "LangGraph Dapr Agent Smoke";
const POLL_INTERVAL_MS = Number.parseInt(
	process.env.POLL_INTERVAL_MS || "5000",
	10,
);
const TIMEOUT_MS = Number.parseInt(
	process.env.WORKFLOW_TIMEOUT_MS || `${20 * 60 * 1000}`,
	10,
);
const LANGGRAPH_ENGINE = "langgraph-deepagents";

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
	console.log(`[langgraph-smoke] ${new Date().toISOString()} ${message}`);
}

function readResultValue(
	result: Record<string, unknown> | null,
	path: string[],
): unknown {
	let current: unknown = result;
	for (const key of path) {
		if (!current || typeof current !== "object" || !(key in current)) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function resolveAgentRunEngine(result: Record<string, unknown> | null) {
	return (
		readResultValue(result, ["engine"]) ??
		readResultValue(result, ["runSummary", "engine"]) ??
		readResultValue(result, ["engineMetadata", "engine"]) ??
		readResultValue(result, ["agentProgress", "framework"])
	);
}

async function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function approve(instanceId: string, eventName: string) {
	log(`approving plan with event=${eventName}`);
	await genericOrchestratorClient.raiseEvent(
		ORCHESTRATOR_URL,
		instanceId,
		eventName,
		{
			approved: true,
			reason: "LangGraph smoke auto-approval",
			approvedBy: "codex",
		},
	);
}

async function resolveWorkflow() {
	if (WORKFLOW_ID) {
		const workflow = await db.query.workflows.findFirst({
			where: eq(workflows.id, WORKFLOW_ID),
		});
		if (!workflow) {
			throw new Error(`Workflow ${WORKFLOW_ID} not found`);
		}
		return workflow;
	}

	const workflow = await db.query.workflows.findFirst({
		where: eq(workflows.name, WORKFLOW_NAME),
		orderBy: [desc(workflows.updatedAt)],
	});
	if (!workflow) {
		throw new Error(
			`Workflow "${WORKFLOW_NAME}" not found. Create it with scripts/create-langgraph-agent-workflow.ts first.`,
		);
	}
	return workflow;
}

async function startExecution() {
	const workflow = await resolveWorkflow();
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

	const result = await genericOrchestratorClient.startWorkflow(
		ORCHESTRATOR_URL,
		definition,
		{},
		{},
		execution.id,
		{},
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

	log(
		`started workflow=${workflow.id} execution=${execution.id} instance=${result.instanceId}`,
	);
	return {
		workflowId: workflow.id,
		executionId: execution.id,
		instanceId: result.instanceId,
	};
}

async function pollUntilComplete(instanceId: string) {
	const deadline = Date.now() + TIMEOUT_MS;
	let approvalSent = false;
	while (Date.now() < deadline) {
		const status = await genericOrchestratorClient.getWorkflowStatus(
			ORCHESTRATOR_URL,
			instanceId,
		);
		log(
			`runtime=${status.runtimeStatus} phase=${status.phase} progress=${status.progress}`,
		);
		if (
			status.phase === "awaiting_approval" &&
			status.approvalEventName &&
			!approvalSent
		) {
			await approve(instanceId, status.approvalEventName);
			approvalSent = true;
		}
		if (
			status.runtimeStatus === "COMPLETED" ||
			status.runtimeStatus === "FAILED" ||
			status.runtimeStatus === "TERMINATED"
		) {
			return status;
		}
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error("Timed out waiting for LangGraph smoke workflow completion");
}

async function waitForExecutionRecord(executionId: string) {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		const execution = await db.query.workflowExecutions.findFirst({
			where: eq(workflowExecutions.id, executionId),
		});
		if (execution && execution.status !== "running") {
			return execution;
		}
		await sleep(2_000);
	}
	return db.query.workflowExecutions.findFirst({
		where: eq(workflowExecutions.id, executionId),
	});
}

async function assertArtifacts(workflowId: string, executionId: string) {
	const execution = await waitForExecutionRecord(executionId);
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
	if (agentRuns.length < 2) {
		throw new Error(
			`Expected at least 2 agent runs for execution ${executionId}, found ${agentRuns.length}`,
		);
	}

	for (const agentRun of agentRuns) {
		if (agentRun.status !== "completed") {
			throw new Error(
				`Agent run ${agentRun.id} ended with status ${agentRun.status}`,
			);
		}
		const result =
			agentRun.result && typeof agentRun.result === "object"
				? (agentRun.result as Record<string, unknown>)
				: null;
		const engine = resolveAgentRunEngine(result);
		if (engine !== LANGGRAPH_ENGINE) {
			throw new Error(
				`Agent run ${agentRun.id} used engine ${String(engine)} instead of ${LANGGRAPH_ENGINE} (result.engine=${String(readResultValue(result, ["engine"]))}, runSummary.engine=${String(readResultValue(result, ["runSummary", "engine"]))}, engineMetadata.engine=${String(readResultValue(result, ["engineMetadata", "engine"]))}, agentProgress.framework=${String(readResultValue(result, ["agentProgress", "framework"]))})`,
			);
		}
	}

	const planArtifact = await db.query.workflowPlanArtifacts.findFirst({
		where: and(
			eq(workflowPlanArtifacts.workflowExecutionId, executionId),
			eq(workflowPlanArtifacts.workflowId, workflowId),
		),
		orderBy: [desc(workflowPlanArtifacts.createdAt)],
	});
	if (!planArtifact) {
		throw new Error(`No plan artifact persisted for execution ${executionId}`);
	}
	if (!["approved", "executed"].includes(planArtifact.status)) {
		throw new Error(
			`Plan artifact ${planArtifact.id} has unexpected status ${planArtifact.status}`,
		);
	}

	log(
		`validated execution=${executionId} planArtifact=${planArtifact.id} type=${planArtifact.artifactType} status=${planArtifact.status}`,
	);
}

async function main() {
	try {
		const started = await startExecution();
		const runtime = await pollUntilComplete(started.instanceId);
		if (runtime.runtimeStatus !== "COMPLETED") {
			throw new Error(
				`Runtime finished with ${runtime.runtimeStatus}: ${runtime.error || runtime.message || "unknown error"}`,
			);
		}
		await assertArtifacts(started.workflowId, started.executionId);
		log("LangGraph smoke workflow passed");
	} finally {
		await sql.end({ timeout: 5 });
	}
}

main().catch((error) => {
	console.error("[test-langgraph-feature-delivery] Error:", error);
	process.exit(1);
});
