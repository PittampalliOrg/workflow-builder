import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getGenericOrchestratorUrl } from "@/lib/config-service";
import { genericOrchestratorClient } from "@/lib/dapr-client";
import { db } from "@/lib/db";
import {
	attachMcpRunExecution,
	createMcpRun,
	getOrCreateMcpServer,
} from "@/lib/db/mcp";
import {
	appConnections,
	projects,
	workflowExecutions,
	workflows,
} from "@/lib/db/schema";
import { isValidInternalToken } from "@/lib/internal-api";
import { generateWorkflowDefinition } from "@/lib/workflow-definition";

type RouteParams = {
	params: Promise<{ projectId: string; workflowId: string }>;
};

type Body = {
	toolName?: string;
	input?: Record<string, unknown>;
};

async function extractNodeConnectionMap(
	nodes: unknown,
	ownerId: string,
): Promise<Record<string, string>> {
	if (!Array.isArray(nodes)) {
		return {};
	}
	const map: Record<string, string> = {};
	const pendingIntegrationIdsByNode = new Map<string, string>();
	for (const node of nodes as any[]) {
		const config = (node?.data?.config ?? {}) as Record<string, unknown>;
		const authTemplate = config.auth as string | undefined;
		if (!authTemplate) {
			const integrationId = config.integrationId as string | undefined;
			if (integrationId && node?.id) {
				pendingIntegrationIdsByNode.set(String(node.id), integrationId);
			}
			continue;
		}
		const match = authTemplate.match(/\{\{connections\[['"]([^'"]+)['"]\]\}\}/);
		if (match?.[1] && node?.id) {
			map[node.id] = match[1];
			continue;
		}

		const integrationId = config.integrationId as string | undefined;
		if (integrationId && node?.id) {
			pendingIntegrationIdsByNode.set(String(node.id), integrationId);
		}
	}

	if (pendingIntegrationIdsByNode.size > 0) {
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
			if (map[nodeId]) {
				continue;
			}
			const externalId = externalIdByIntegrationId.get(integrationId);
			if (externalId) {
				map[nodeId] = externalId;
			}
		}
	}
	return map;
}

function getMcpTriggerConfig(nodes: unknown): {
	enabled: boolean;
	returnsResponse: boolean;
	toolName: string;
} | null {
	if (!Array.isArray(nodes)) {
		return null;
	}
	const triggerNode = (nodes as any[]).find((n) => n?.data?.type === "trigger");
	const cfg = (triggerNode?.data?.config ?? {}) as Record<string, unknown>;
	if (cfg.triggerType !== "MCP") {
		return null;
	}

	const enabled =
		typeof cfg.enabled === "string"
			? cfg.enabled.toLowerCase() === "true"
			: cfg.enabled !== false;

	const returnsResponse =
		typeof cfg.returnsResponse === "string"
			? cfg.returnsResponse.toLowerCase() === "true"
			: Boolean(cfg.returnsResponse);

	const toolName = (cfg.toolName as string | undefined) ?? "";
	return { enabled, returnsResponse, toolName };
}

export async function POST(request: Request, { params }: RouteParams) {
	if (!isValidInternalToken(request)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { projectId, workflowId } = await params;
	const body = (await request.json().catch(() => ({}))) as Body;
	const input = body.input ?? {};

	const project = await db.query.projects.findFirst({
		where: eq(projects.id, projectId),
		columns: { id: true, ownerId: true },
	});
	if (!project) {
		return NextResponse.json({ error: "Project not found" }, { status: 404 });
	}

	const workflow = await db.query.workflows.findFirst({
		where: and(
			eq(workflows.id, workflowId),
			or(
				eq(workflows.projectId, projectId),
				and(isNull(workflows.projectId), eq(workflows.userId, project.ownerId)),
			),
		),
	});
	if (!workflow) {
		return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
	}

	const trigger = getMcpTriggerConfig(workflow.nodes);
	if (!trigger?.enabled) {
		return NextResponse.json(
			{ error: "Workflow is not enabled as an MCP tool" },
			{ status: 400 },
		);
	}

	const server = await getOrCreateMcpServer(projectId);
	if (server.status !== "ENABLED") {
		return NextResponse.json(
			{ error: "MCP access is disabled for this project" },
			{ status: 403 },
		);
	}

	const toolName = body.toolName ?? trigger.toolName ?? workflow.name;

	// Create MCP run first (used for gateway polling + Reply action rendezvous).
	const run = await createMcpRun({
		projectId,
		mcpServerId: server.id,
		workflowId: workflow.id,
		toolName,
		input,
	});

	// Create execution record (links to monitor UI).
	const [execution] = await db
		.insert(workflowExecutions)
		.values({
			workflowId: workflow.id,
			userId: workflow.userId,
			status: "running",
			input: {
				__mcp: {
					runId: run.id,
					projectId,
					workflowId: workflow.id,
					toolName,
					returnsResponse: trigger.returnsResponse,
				},
				...input,
			},
		})
		.returning();

	const nodes = workflow.nodes as unknown as any[];
	const edges = workflow.edges as unknown as any[];
	const definition = generateWorkflowDefinition(
		nodes,
		edges,
		workflow.id,
		workflow.name,
		{
			description: workflow.description || undefined,
			author: workflow.userId,
		},
	);

	const nodeConnectionMap = await extractNodeConnectionMap(
		nodes,
		workflow.userId,
	);

	const defaultOrchestratorUrl = await getGenericOrchestratorUrl();
	const orchestratorUrl = (workflow as Record<string, unknown>)
		.daprOrchestratorUrl as string | undefined;

	const result = await genericOrchestratorClient.startWorkflow(
		orchestratorUrl || defaultOrchestratorUrl,
		definition,
		{
			__mcp: {
				runId: run.id,
				projectId,
				workflowId: workflow.id,
				toolName,
				returnsResponse: trigger.returnsResponse,
			},
			...input,
		},
		{},
		execution.id,
		nodeConnectionMap,
	);

	await db
		.update(workflowExecutions)
		.set({
			daprInstanceId: result.instanceId,
			phase: "running",
			progress: 0,
		})
		.where(eq(workflowExecutions.id, execution.id));

	await attachMcpRunExecution({
		runId: run.id,
		workflowExecutionId: execution.id,
		daprInstanceId: result.instanceId,
	});

	return NextResponse.json({
		runId: run.id,
		executionId: execution.id,
		instanceId: result.instanceId,
		returnsResponse: trigger.returnsResponse,
	});
}
