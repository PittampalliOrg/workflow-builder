import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq, isNull, or, inArray } from 'drizzle-orm';
import { validateInternalToken } from '$lib/server/internal-auth';
import { db } from '$lib/server/db';
import {
	appConnections,
	projects,
	workflows,
	workflowExecutions
} from '$lib/server/db/schema';
import {
	createMcpRun,
	getOrCreateMcpServer,
	attachMcpRunExecution
} from '$lib/server/db/mcp';
import { daprFetch, getOrchestratorUrl } from '$lib/server/dapr-client';

type Body = {
	toolName?: string;
	input?: Record<string, unknown>;
};

/**
 * Extract a map of nodeId -> connection externalId from workflow nodes.
 * Used to resolve credentials at execution time.
 */
async function extractNodeConnectionMap(
	nodes: unknown,
	ownerId: string
): Promise<Record<string, string>> {
	if (!Array.isArray(nodes)) return {};

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
		const integrationIds = Array.from(new Set(Array.from(pendingIntegrationIdsByNode.values())));
		const rows = await db
			.select({ id: appConnections.id, externalId: appConnections.externalId })
			.from(appConnections)
			.where(and(eq(appConnections.ownerId, ownerId), inArray(appConnections.id, integrationIds)));

		const externalIdByIntegrationId = new Map(rows.map((row) => [row.id, row.externalId]));

		for (const [nodeId, integrationId] of pendingIntegrationIdsByNode) {
			if (map[nodeId]) continue;
			const externalId = externalIdByIntegrationId.get(integrationId);
			if (externalId) map[nodeId] = externalId;
		}
	}

	return map;
}

/**
 * Extract MCP trigger config from workflow nodes.
 */
function getMcpTriggerConfig(nodes: unknown): {
	enabled: boolean;
	returnsResponse: boolean;
	toolName: string;
} | null {
	if (!Array.isArray(nodes)) return null;

	const triggerNode = (nodes as any[]).find((n) => n?.data?.type === 'trigger');
	const cfg = (triggerNode?.data?.config ?? {}) as Record<string, unknown>;
	if (cfg.triggerType !== 'MCP') return null;

	const enabled =
		typeof cfg.enabled === 'string'
			? cfg.enabled.toLowerCase() === 'true'
			: cfg.enabled !== false;
	const returnsResponse =
		typeof cfg.returnsResponse === 'string'
			? cfg.returnsResponse.toLowerCase() === 'true'
			: Boolean(cfg.returnsResponse);
	const toolName = (cfg.toolName as string | undefined) ?? '';

	return { enabled, returnsResponse, toolName };
}

/**
 * Check that the workflow spec is a valid CNCF Serverless Workflow 1.0 document.
 */
function isSWWorkflow(spec: unknown): boolean {
	if (typeof spec !== 'object' || spec === null) return false;
	const w = spec as Record<string, unknown>;
	if (typeof w.document !== 'object' || w.document === null) return false;
	const doc = w.document as Record<string, unknown>;
	return doc.dsl === '1.0.0' && typeof doc.namespace === 'string' && typeof doc.name === 'string';
}

/**
 * POST /api/internal/mcp/projects/[projectId]/tools/[workflowId]/execute
 *
 * Starts execution of a workflow tool triggered via MCP.
 * Creates an MCP run record, a workflow execution, and dispatches to the orchestrator.
 *
 * Called by mcp-gateway when an external AI client invokes an MCP tool.
 *
 * Security: Validated via X-Internal-Token header.
 */
export const POST: RequestHandler = async ({ request, params }) => {
	if (!validateInternalToken(request)) {
		return error(401, 'Unauthorized');
	}

	if (!db) return error(503, 'Database not configured');

	const { projectId, workflowId } = params;
	const body = (await request.json().catch(() => ({}))) as Body;
	const input = body.input ?? {};

	// Validate project
	const project = await db
		.select({ id: projects.id, ownerId: projects.ownerId })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);

	if (project.length === 0) return error(404, 'Project not found');

	// Fetch workflow (scoped to project or owner fallback)
	const [workflow] = await db
		.select()
		.from(workflows)
		.where(
			and(
				eq(workflows.id, workflowId),
				or(
					eq(workflows.projectId, projectId),
					and(isNull(workflows.projectId), eq(workflows.userId, project[0].ownerId))
				)
			)
		)
		.limit(1);

	if (!workflow) return error(404, 'Workflow not found');

	// Validate MCP trigger is enabled
	const trigger = getMcpTriggerConfig(workflow.nodes);
	if (!trigger?.enabled) {
		return error(400, 'Workflow is not enabled as an MCP tool');
	}

	// Validate MCP server is enabled for this project
	const server = await getOrCreateMcpServer(projectId);
	if (server.status !== 'ENABLED') {
		return error(403, 'MCP access is disabled for this project');
	}

	// Validate workflow has a valid SW 1.0 spec
	const spec = (workflow as Record<string, unknown>).spec as Record<string, unknown> | null;
	if (!spec || !isSWWorkflow(spec)) {
		return error(400, 'Workflow does not have a valid CNCF Serverless Workflow 1.0 spec');
	}

	const toolName = body.toolName ?? trigger.toolName ?? workflow.name;

	// Create MCP run record (used for gateway polling + Reply action rendezvous)
	const run = await createMcpRun({
		projectId,
		mcpServerId: server.id,
		workflowId: workflow.id,
		toolName,
		input
	});

	const triggerData = {
		__mcp: {
			runId: run.id,
			projectId,
			workflowId: workflow.id,
			toolName,
			returnsResponse: trigger.returnsResponse
		},
		...input
	};

	// Create execution record
	const [execution] = await db
		.insert(workflowExecutions)
		.values({
			workflowId: workflow.id,
			userId: workflow.userId,
			status: 'running',
			input: triggerData,
			executionIrVersion: 'sw-1.0',
			executionIr: { spec, triggerData }
		})
		.returning();

	// Dispatch to orchestrator
	const orchestratorUrl = getOrchestratorUrl();

	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	for (const h of ['traceparent', 'tracestate', 'baggage']) {
		const v = request.headers.get(h);
		if (v) headers[h] = v;
	}

	const swResponse = await daprFetch(`${orchestratorUrl}/api/v2/sw-workflows`, {
		method: 'POST',
		headers,
		body: JSON.stringify({
			workflow: spec,
			triggerData,
			dbExecutionId: execution.id
		})
	});

	if (!swResponse.ok) {
		const errorText = await swResponse.text().catch(() => 'Unknown error');
		console.error(`[MCP Execute] Orchestrator ${swResponse.status}: ${errorText}`);
		await db
			.update(workflowExecutions)
			.set({ status: 'error', error: errorText.slice(0, 500) })
			.where(eq(workflowExecutions.id, execution.id));
		return error(502, `SW workflow failed: ${swResponse.status}`);
	}

	const result = await swResponse.json();

	// Update execution with Dapr instance ID
	await db
		.update(workflowExecutions)
		.set({ daprInstanceId: result.instanceId })
		.where(eq(workflowExecutions.id, execution.id));

	// Link MCP run to the execution
	await attachMcpRunExecution({
		runId: run.id,
		workflowExecutionId: execution.id,
		daprInstanceId: result.instanceId
	});

	return json({
		runId: run.id,
		executionId: execution.id,
		instanceId: result.instanceId,
		returnsResponse: trigger.returnsResponse
	});
};
