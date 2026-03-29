import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { getGenericOrchestratorUrl } from "@/lib/config-service";
import { genericOrchestratorClient } from "@/lib/dapr-client";
import { getLatestWorkflowPlanArtifactForExecution } from "@/lib/db/workflow-plan-artifacts";
import { db } from "@/lib/db";
import {
	appConnections,
	workflowAgentRuns,
	workflowExecutionLogs,
	workflowExecutions,
	workflowExternalEvents,
	workflows,
} from "@/lib/db/schema";
import {
	buildAgentNodeProgress,
	buildDurableTimeline,
	buildExecutionConsistency,
	mapRuntimeStatusToLocalStatus,
	reconcileAgentRunWithLivePayload,
	toDurableAgentRunSummary,
	toDurableExternalEventSummary,
	toDurablePlanArtifactSummary,
	toDurableRuntimeSnapshot,
} from "@/lib/transforms/durable-timeline";
import {
	buildWorkflowExecutionIR,
	WORKFLOW_EXECUTION_IR_VERSION,
} from "@/lib/workflow-contract";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";

const OPENSHELL_AGENT_RUNTIME_API_BASE_URL =
	process.env.OPENSHELL_AGENT_RUNTIME_API_BASE_URL ||
	"http://openshell-agent-runtime.openshell.svc.cluster.local:8083";
const OPENSHELL_LANGGRAPH_OBSERVABLE_API_BASE_URL =
	process.env.OPENSHELL_LANGGRAPH_OBSERVABLE_API_BASE_URL ||
	"http://openshell-langgraph-observable.workflow-builder.svc.cluster.local";

function getAgentRuntimeTarget(
	actionType: string | undefined,
): { baseUrl: string; path: string } | null {
	if (actionType === "openshell-langgraph/run") {
		return {
			baseUrl: OPENSHELL_LANGGRAPH_OBSERVABLE_API_BASE_URL,
			path: "/api/run",
		};
	}
	if (actionType === "openshell-langgraph-observable/run") {
		return {
			baseUrl: OPENSHELL_LANGGRAPH_OBSERVABLE_API_BASE_URL,
			path: "/api/run",
		};
	}
	if (actionType === "openshell/run") {
		return {
			baseUrl: OPENSHELL_AGENT_RUNTIME_API_BASE_URL,
			path: "/api/v1/agent-runs",
		};
	}
	if (actionType === "openshell/session-start") {
		return {
			baseUrl: OPENSHELL_AGENT_RUNTIME_API_BASE_URL,
			path: "/api/v1/agent-runs",
		};
	}
	return null;
}

type WorkflowRecord = typeof workflows.$inferSelect;

function getNodeActionTypeMap(nodes: unknown): Map<string, string> {
	const result = new Map<string, string>();
	if (!Array.isArray(nodes)) {
		return result;
	}
	for (const node of nodes) {
		if (!node || typeof node !== "object") {
			continue;
		}
		const record = node as Record<string, unknown>;
		const nodeId = typeof record.id === "string" ? record.id : null;
		const data =
			record.data && typeof record.data === "object"
				? (record.data as Record<string, unknown>)
				: null;
		const config =
			data?.config && typeof data.config === "object"
				? (data.config as Record<string, unknown>)
				: null;
		const actionType =
			config && typeof config.actionType === "string"
				? config.actionType
				: null;
		if (nodeId && actionType) {
			result.set(nodeId, actionType);
		}
	}
	return result;
}

async function fetchAgentLivePayload(
	actionType: string | undefined,
	instanceId: string,
): Promise<Record<string, unknown> | null> {
	const target = getAgentRuntimeTarget(actionType);
	if (!target) {
		return null;
	}
	try {
		const response = await fetch(
			`${target.baseUrl.replace(/\/+$/, "")}${target.path}/${encodeURIComponent(instanceId)}`,
			{
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(4000),
				cache: "no-store",
			},
		);
		if (!response.ok) {
			return null;
		}
		const payload = await response.json();
		return payload && typeof payload === "object"
			? (payload as Record<string, unknown>)
			: null;
	} catch (error) {
		console.warn("[internal-workflows] Failed to fetch live agent payload", {
			actionType,
			instanceId,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

function shouldFetchLiveAgentPayload(
	actionType: string | undefined,
	status: string,
): boolean {
	if (!actionType || !status) {
		return false;
	}
	if (
		![
			"openshell/run",
			"openshell/session-start",
			"openshell-langgraph/run",
			"openshell-langgraph-observable/run",
		].includes(actionType)
	) {
		return false;
	}
	return !["completed", "failed", "error", "terminated", "cancelled"].includes(
		status,
	);
}

async function extractNodeConnectionMap(
	nodes: WorkflowNode[],
	ownerId: string,
): Promise<Record<string, string>> {
	const nodeConnectionMap: Record<string, string> = {};
	const pendingIntegrationIdsByNode = new Map<string, string>();

	for (const node of nodes) {
		const config =
			((node.data as Record<string, unknown>)?.config as Record<
				string,
				unknown
			>) || {};
		const authTemplate = config.auth as string | undefined;
		if (authTemplate) {
			const match = authTemplate.match(
				/\{\{connections\[['"]([^'"]+)['"]\]\}\}/,
			);
			if (match?.[1]) {
				nodeConnectionMap[node.id] = match[1];
				continue;
			}
		}

		const integrationId = config.integrationId as string | undefined;
		if (integrationId && integrationId.trim().length > 0) {
			pendingIntegrationIdsByNode.set(node.id, integrationId.trim());
		}
	}

	if (pendingIntegrationIdsByNode.size === 0) {
		return nodeConnectionMap;
	}

	const integrationIds = Array.from(
		new Set(Array.from(pendingIntegrationIdsByNode.values())),
	);
	const rows = await db
		.select({
			id: appConnections.id,
			externalId: appConnections.externalId,
		})
		.from(appConnections)
		.where(
			and(
				eq(appConnections.ownerId, ownerId),
				inArray(appConnections.id, integrationIds),
			),
		);
	const externalIdByIntegrationId = new Map(
		rows.map((row) => [row.id, row.externalId]),
	);

	for (const [nodeId, integrationId] of pendingIntegrationIdsByNode) {
		if (nodeConnectionMap[nodeId]) {
			continue;
		}
		const externalId = externalIdByIntegrationId.get(integrationId);
		if (externalId) {
			nodeConnectionMap[nodeId] = externalId;
		}
	}

	return nodeConnectionMap;
}

function pickWorkflowByName(
	workflowsByName: WorkflowRecord[],
): WorkflowRecord | null {
	if (workflowsByName.length === 0) {
		return null;
	}
	return (
		workflowsByName.find((workflow) => workflow.visibility === "public") ??
		workflowsByName[0] ??
		null
	);
}

async function loadInternalWorkflowExecution(executionId: string) {
	return db.query.workflowExecutions.findFirst({
		where: eq(workflowExecutions.id, executionId),
		with: {
			workflow: true,
		},
	});
}

function isMissingRuntimeStateError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	return error.message.includes("Dapr orchestrator error (404):");
}

async function loadInternalWorkflowExecutionRuntime(
	execution: NonNullable<
		Awaited<ReturnType<typeof loadInternalWorkflowExecution>>
	>,
	options: { includeHistory?: boolean } = {},
) {
	const includeHistory = options.includeHistory ?? false;
	let runtimeStatus: Awaited<
		ReturnType<typeof genericOrchestratorClient.getWorkflowStatus>
	> | null = null;
	let runtimeHistory: Awaited<
		ReturnType<typeof genericOrchestratorClient.getWorkflowHistory>
	> | null = null;

	if (execution.daprInstanceId) {
		try {
			const orchestratorUrl =
				execution.workflow.daprOrchestratorUrl ||
				(await getGenericOrchestratorUrl());
			runtimeStatus = await genericOrchestratorClient
				.getWorkflowStatus(orchestratorUrl, execution.daprInstanceId)
				.catch((error) => {
					if (isMissingRuntimeStateError(error)) {
						return null;
					}
					throw error;
				});
			runtimeHistory = includeHistory
				? await genericOrchestratorClient
						.getWorkflowHistory(orchestratorUrl, execution.daprInstanceId)
						.catch((error) => {
							if (isMissingRuntimeStateError(error)) {
								return null;
							}
							throw error;
						})
				: null;
		} catch (error) {
			console.warn(
				`[internal-workflows] Failed to load runtime for ${execution.id}:`,
				error,
			);
		}
	}

	const runtime = toDurableRuntimeSnapshot(runtimeStatus);
	const consistency = buildExecutionConsistency({
		dbStatus: execution.status,
		dbPhase: execution.phase,
		runtime,
	});

	if (runtime) {
		const mapped = mapRuntimeStatusToLocalStatus({
			runtimeStatus: runtime.runtimeStatus,
			phase: runtime.phase,
			message: runtime.message,
			outputs: runtime.outputs,
			error: runtime.error,
			fallbackStatus: execution.status,
		});
		const shouldComplete =
			mapped.status === "success" ||
			mapped.status === "error" ||
			mapped.status === "cancelled";

		if (
			mapped.status !== execution.status ||
			runtime.phase !== execution.phase ||
			runtime.progress !== execution.progress ||
			runtime.error !== execution.error
		) {
			await db
				.update(workflowExecutions)
				.set({
					status: mapped.status,
					phase: runtime.phase,
					progress: runtime.progress,
					output:
						(runtime.outputs as Record<string, unknown> | undefined) ??
						execution.output,
					error: mapped.error,
					...(shouldComplete ? { completedAt: new Date() } : {}),
				})
				.where(eq(workflowExecutions.id, execution.id));
		}

		return {
			runtime,
			runtimeHistory,
			consistency,
			mapped,
		};
	}

	return {
		runtime,
		runtimeHistory,
		consistency,
		mapped: {
			status: execution.status as
				| "pending"
				| "running"
				| "success"
				| "error"
				| "cancelled",
			error: execution.error,
		},
	};
}

function summarizeInternalExecution(
	execution: NonNullable<
		Awaited<ReturnType<typeof loadInternalWorkflowExecution>>
	>,
) {
	const { workflow, ...rest } = execution;
	return {
		...rest,
		workflow: {
			id: workflow.id,
			name: workflow.name,
			daprOrchestratorUrl: workflow.daprOrchestratorUrl,
			engineType: workflow.engineType,
		},
	};
}

export async function resolveInternalWorkflow(input: {
	workflowId?: string;
	workflowName?: string;
}): Promise<WorkflowRecord | null> {
	const workflowId = input.workflowId?.trim();
	if (workflowId) {
		return (
			(await db.query.workflows.findFirst({
				where: eq(workflows.id, workflowId),
			})) ?? null
		);
	}

	const workflowName = input.workflowName?.trim();
	if (!workflowName) {
		return null;
	}

	const candidates = await db.query.workflows.findMany({
		where: eq(workflows.name, workflowName),
		orderBy: [desc(workflows.updatedAt)],
		limit: 20,
	});
	return pickWorkflowByName(candidates);
}

export async function startInternalWorkflowExecution(input: {
	workflow: WorkflowRecord;
	triggerData: Record<string, unknown>;
}): Promise<{
	executionId: string;
	instanceId: string;
	workflowId: string;
	workflowName: string;
	status: string;
}> {
	const workflow = input.workflow;
	const nodes = workflow.nodes as WorkflowNode[];
	const edges = workflow.edges as WorkflowEdge[];
	const executionIr = buildWorkflowExecutionIR({
		workflowId: workflow.id,
		name: workflow.name,
		description: workflow.description || undefined,
		author: workflow.userId,
		nodes,
		edges,
		spec: (workflow as Record<string, unknown>).spec,
		specVersion:
			((workflow as Record<string, unknown>).specVersion as
				| string
				| null
				| undefined) ?? null,
	});
	const nodeConnectionMap = await extractNodeConnectionMap(
		nodes,
		workflow.userId,
	);
	const orchestratorUrl =
		workflow.daprOrchestratorUrl || (await getGenericOrchestratorUrl());

	const [execution] = await db
		.insert(workflowExecutions)
		.values({
			workflowId: workflow.id,
			userId: workflow.userId,
			status: "running",
			phase: "running",
			progress: 0,
			input: input.triggerData,
			executionIrVersion: WORKFLOW_EXECUTION_IR_VERSION,
			executionIr,
		})
		.returning();

	let result: Awaited<
		ReturnType<typeof genericOrchestratorClient.startWorkflow>
	>;
	try {
		result = await genericOrchestratorClient.startWorkflow(
			orchestratorUrl,
			executionIr.definition,
			input.triggerData,
			{},
			execution.id,
			nodeConnectionMap,
		);
	} catch (error) {
		await db
			.update(workflowExecutions)
			.set({
				status: "error",
				phase: "failed",
				error:
					error instanceof Error
						? error.message
						: "Failed to start workflow execution",
				completedAt: new Date(),
			})
			.where(eq(workflowExecutions.id, execution.id));
		throw error;
	}

	await db
		.update(workflowExecutions)
		.set({
			daprInstanceId: result.instanceId,
			phase: "running",
			progress: 0,
			executionIrVersion: WORKFLOW_EXECUTION_IR_VERSION,
			executionIr,
		})
		.where(eq(workflowExecutions.id, execution.id));

	return {
		executionId: execution.id,
		instanceId: result.instanceId,
		workflowId: workflow.id,
		workflowName: workflow.name,
		status: result.status,
	};
}

export async function getInternalWorkflowExecutionDetail(executionId: string) {
	const execution = await loadInternalWorkflowExecution(executionId);

	if (!execution) {
		return null;
	}

	const [logsAsc, externalEvents, agentRunRows] = await Promise.all([
		db.query.workflowExecutionLogs.findMany({
			where: eq(workflowExecutionLogs.executionId, executionId),
			orderBy: [asc(workflowExecutionLogs.timestamp)],
		}),
		db
			.select()
			.from(workflowExternalEvents)
			.where(eq(workflowExternalEvents.executionId, executionId))
			.orderBy(desc(workflowExternalEvents.createdAt)),
		db
			.select()
			.from(workflowAgentRuns)
			.where(eq(workflowAgentRuns.workflowExecutionId, executionId))
			.orderBy(desc(workflowAgentRuns.createdAt)),
	]);

	const { runtime, runtimeHistory, consistency } =
		await loadInternalWorkflowExecutionRuntime(execution, {
			includeHistory: true,
		});

	const effectiveAgentRuns = toDurableAgentRunSummary(agentRunRows);
	const nodeActionTypeMap = getNodeActionTypeMap(execution.workflow.nodes);
	const agentProgressEntries = await Promise.all(
		effectiveAgentRuns.map(async (run) => {
			const actionType = nodeActionTypeMap.get(run.nodeId);
			const framework =
				actionType === "openshell/run" ||
				actionType === "openshell/session-start" ||
				actionType === "openshell-langgraph/run" ||
				actionType === "openshell-langgraph-observable/run"
					? "openshell"
					: null;
			if (!framework) {
				return null;
			}
			let livePayload: Record<string, unknown> | null = null;
			if (shouldFetchLiveAgentPayload(actionType, run.status)) {
				try {
					livePayload = await fetchAgentLivePayload(
						actionType,
						run.daprInstanceId,
					);
				} catch (error) {
					console.warn(
						`[internal-workflows] Failed to fetch live payload for run ${run.id}:`,
						error,
					);
				}
			}
			const effectiveRun = reconcileAgentRunWithLivePayload(run, livePayload);
			return [
				run.nodeId,
				buildAgentNodeProgress(effectiveRun, framework, livePayload),
			] as const;
		}),
	);
	const agentProgressByNode = Object.fromEntries(
		agentProgressEntries.filter(
			(
				entry,
			): entry is readonly [
				string,
				ReturnType<typeof buildAgentNodeProgress>,
			] => entry !== null,
		),
	);

	const planArtifact = await getLatestWorkflowPlanArtifactForExecution({
		workflowExecutionId: executionId,
	});
	const timelinePlanArtifacts = planArtifact
		? [
				{
					...planArtifact,
					artifactVersion: 1,
					workspaceRef:
						typeof planArtifact.metadata?.workspaceRef === "string"
							? planArtifact.metadata.workspaceRef
							: null,
					clonePath:
						typeof planArtifact.metadata?.clonePath === "string"
							? planArtifact.metadata.clonePath
							: null,
				},
			]
		: [];

	const timeline = buildDurableTimeline({
		execution,
		orchestratorHistory: runtimeHistory?.events ?? [],
		logs: logsAsc,
		externalEvents,
		planArtifacts: timelinePlanArtifacts,
		agentRuns: effectiveAgentRuns,
	});

	return {
		execution,
		runtime,
		consistency,
		timeline,
		logs: logsAsc,
		agentRuns: effectiveAgentRuns,
		agentProgressByNode,
		externalEvents: toDurableExternalEventSummary(externalEvents),
		planArtifact,
		planArtifacts: toDurablePlanArtifactSummary(timelinePlanArtifacts),
	};
}

export async function getInternalWorkflowExecutionStatus(executionId: string) {
	const execution = await loadInternalWorkflowExecution(executionId);

	if (!execution) {
		return null;
	}

	const { runtime, consistency, mapped } =
		await loadInternalWorkflowExecutionRuntime(execution);

	return {
		execution: summarizeInternalExecution(execution),
		runtime,
		consistency,
		status: mapped.status,
		error: mapped.error,
	};
}

export async function listInternalWorkflows(input: {
	workflowId?: string;
	workflowName?: string;
	userId?: string;
	projectId?: string;
	visibility?: "private" | "public";
	limit?: number;
}) {
	const filters = [];

	if (input.workflowId?.trim()) {
		filters.push(eq(workflows.id, input.workflowId.trim()));
	}

	if (input.workflowName?.trim()) {
		filters.push(eq(workflows.name, input.workflowName.trim()));
	}

	if (input.userId?.trim()) {
		filters.push(eq(workflows.userId, input.userId.trim()));
	}

	if (input.projectId?.trim()) {
		filters.push(eq(workflows.projectId, input.projectId.trim()));
	}

	if (input.visibility) {
		filters.push(eq(workflows.visibility, input.visibility));
	}

	const rows = await db
		.select({
			id: workflows.id,
			name: workflows.name,
			description: workflows.description,
			userId: workflows.userId,
			projectId: workflows.projectId,
			visibility: workflows.visibility,
			engineType: workflows.engineType,
			daprWorkflowName: workflows.daprWorkflowName,
			daprOrchestratorUrl: workflows.daprOrchestratorUrl,
			createdAt: workflows.createdAt,
			updatedAt: workflows.updatedAt,
		})
		.from(workflows)
		.where(filters.length > 0 ? and(...filters) : undefined)
		.orderBy(desc(workflows.updatedAt))
		.limit(Math.max(1, Math.min(input.limit ?? 100, 500)));

	return rows;
}

export async function listInternalWorkflowExecutions(input: {
	workflowId?: string;
	workflowName?: string;
	status?: string;
	limit?: number;
	offset?: number;
}) {
	const filters = [];

	if (input.workflowId?.trim()) {
		filters.push(eq(workflowExecutions.workflowId, input.workflowId.trim()));
	}

	if (input.workflowName?.trim()) {
		filters.push(eq(workflows.name, input.workflowName.trim()));
	}

	if (input.status?.trim()) {
		filters.push(eq(workflowExecutions.status, input.status.trim() as never));
	}

	const whereClause = filters.length > 0 ? and(...filters) : undefined;
	const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
	const offset = Math.max(0, input.offset ?? 0);

	const [rows, totalRows] = await Promise.all([
		db
			.select({
				id: workflowExecutions.id,
				workflowId: workflowExecutions.workflowId,
				status: workflowExecutions.status,
				phase: workflowExecutions.phase,
				progress: workflowExecutions.progress,
				error: workflowExecutions.error,
				startedAt: workflowExecutions.startedAt,
				completedAt: workflowExecutions.completedAt,
				workflow: {
					id: workflows.id,
					name: workflows.name,
					description: workflows.description,
				},
			})
			.from(workflowExecutions)
			.innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
			.where(whereClause)
			.orderBy(desc(workflowExecutions.startedAt))
			.limit(limit)
			.offset(offset),
		db
			.select({ value: count() })
			.from(workflowExecutions)
			.innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
			.where(whereClause),
	]);

	return {
		executions: rows,
		total: totalRows[0]?.value ?? 0,
	};
}

export async function approveInternalWorkflowExecution(input: {
	executionId: string;
	approved: boolean;
	reason?: string;
	eventName?: string;
	approvedBy?: string;
}) {
	const detail = await getInternalWorkflowExecutionStatus(input.executionId);
	if (!detail) {
		return null;
	}

	const { execution, runtime } = detail;
	if (!execution.daprInstanceId) {
		throw new Error("Execution has no Dapr instance");
	}

	const eventName =
		input.eventName?.trim() || runtime?.approvalEventName || "plan-approval";
	const orchestratorUrl =
		execution.workflow.daprOrchestratorUrl ||
		(await getGenericOrchestratorUrl());
	const result = await genericOrchestratorClient.raiseEvent(
		orchestratorUrl,
		execution.daprInstanceId,
		eventName,
		{
			approved: input.approved,
			reason: input.reason,
			approvedBy: input.approvedBy?.trim() || "system:internal-workflow",
			respondedBy: input.approvedBy?.trim() || "system:internal-workflow",
		},
	);

	return {
		execution,
		eventName,
		result,
	};
}
