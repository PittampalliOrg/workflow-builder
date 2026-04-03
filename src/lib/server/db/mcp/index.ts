import { and, eq, isNull, or } from 'drizzle-orm';
import { customAlphabet } from 'nanoid';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { encryptString, decryptString } from '$lib/server/security/encryption';
import { generateId } from '$lib/server/utils/id';
import {
	type McpServer,
	type McpServerStatus,
	type McpRun,
	type McpConnection,
	type McpConnectionStatus,
	mcpServers,
	mcpRuns,
	mcpConnections,
	projects,
	workflows
} from '$lib/server/db/schema';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type McpInputProperty = {
	name: string;
	type: string;
	description?: string;
	required?: boolean;
};

export type PopulatedMcpWorkflow = {
	id: string;
	name: string;
	description: string | null;
	enabled: boolean;
	trigger: {
		toolName: string;
		toolDescription: string;
		inputSchema: McpInputProperty[];
		returnsResponse: boolean;
	};
};

export type PopulatedMcpServer = Omit<McpServer, 'tokenEncrypted'> & {
	token: string;
	flows: PopulatedMcpWorkflow[];
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function generateMcpToken(length = 72): string {
	const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', length);
	return nanoid();
}

function parseBoolString(v: unknown, defaultValue: boolean): boolean {
	if (typeof v === 'boolean') return v;
	if (typeof v === 'string') return v.toLowerCase() === 'true';
	return defaultValue;
}

function parseInputSchema(value: unknown): McpInputProperty[] {
	if (!value) return [];
	if (Array.isArray(value)) return value as McpInputProperty[];
	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value) as unknown;
			if (Array.isArray(parsed)) return parsed as McpInputProperty[];
		} catch {
			return [];
		}
	}
	return [];
}

function getMcpTriggerFromWorkflowNodes(nodes: unknown): {
	enabled: boolean;
	toolName: string;
	toolDescription: string;
	inputSchema: McpInputProperty[];
	returnsResponse: boolean;
} | null {
	if (!Array.isArray(nodes)) return null;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const triggerNode = nodes.find((n: any) => n?.data?.type === 'trigger') as any;
	const triggerType = triggerNode?.data?.config?.triggerType as string | undefined;
	if (triggerType !== 'MCP') return null;

	const config = (triggerNode?.data?.config ?? {}) as Record<string, unknown>;
	return {
		enabled: parseBoolString(config.enabled, true),
		toolName: (config.toolName as string | undefined) ?? '',
		toolDescription: (config.toolDescription as string | undefined) ?? '',
		inputSchema: parseInputSchema(config.inputSchema),
		returnsResponse: parseBoolString(config.returnsResponse, false)
	};
}

// ---------------------------------------------------------------------------
// MCP Gateway URL builder
// ---------------------------------------------------------------------------

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, '');
}

function normalizeBaseUrl(value: string | null | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	return trimmed ? trimTrailingSlash(trimmed) : null;
}

function resolvePublicMcpGatewayBaseUrl(request?: Request): string | null {
	const explicit =
		normalizeBaseUrl(env.MCP_GATEWAY_BASE_URL) ?? normalizeBaseUrl(env.APP_URL);
	if (explicit) return explicit;
	return request ? new URL(request.url).origin : null;
}

function buildHostedMcpServerUrl(
	projectId: string,
	request?: Request
): string | null {
	const baseUrl = resolvePublicMcpGatewayBaseUrl(request);
	if (!baseUrl) return null;
	return `${baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/mcp-server/http`;
}

// ---------------------------------------------------------------------------
// Core DB operations
// ---------------------------------------------------------------------------

export async function getOrCreateMcpServer(projectId: string): Promise<McpServer> {
	const existing = await db
		.select()
		.from(mcpServers)
		.where(eq(mcpServers.projectId, projectId))
		.limit(1);

	if (existing.length > 0) return existing[0];

	const token = generateMcpToken();
	const [created] = await db
		.insert(mcpServers)
		.values({
			id: generateId(),
			projectId,
			status: 'DISABLED',
			tokenEncrypted: encryptString(token)
		})
		.returning();
	return created;
}

export async function listMcpWorkflowsForProject(
	projectId: string
): Promise<PopulatedMcpWorkflow[]> {
	const project = await db
		.select({ id: projects.id, ownerId: projects.ownerId })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);

	if (project.length === 0) return [];

	const rows = await db
		.select({
			id: workflows.id,
			name: workflows.name,
			description: workflows.description,
			nodes: workflows.nodes
		})
		.from(workflows)
		.where(
			or(
				eq(workflows.projectId, projectId),
				and(isNull(workflows.projectId), eq(workflows.userId, project[0].ownerId))
			)
		);

	const populated: PopulatedMcpWorkflow[] = [];
	for (const w of rows) {
		const trigger = getMcpTriggerFromWorkflowNodes(w.nodes);
		if (!trigger) continue;
		populated.push({
			id: w.id,
			name: w.name,
			description: w.description,
			enabled: trigger.enabled,
			trigger: {
				toolName: trigger.toolName || w.name,
				toolDescription: trigger.toolDescription || '',
				inputSchema: trigger.inputSchema,
				returnsResponse: trigger.returnsResponse
			}
		});
	}
	return populated;
}

export async function getPopulatedMcpServerByProjectId(
	projectId: string
): Promise<PopulatedMcpServer> {
	const server = await getOrCreateMcpServer(projectId);
	const flows = await listMcpWorkflowsForProject(projectId);
	const { tokenEncrypted, ...rest } = server;
	return {
		...rest,
		token: decryptString(tokenEncrypted),
		flows
	};
}

export async function updateMcpServerStatus(params: {
	projectId: string;
	status: McpServerStatus;
}): Promise<PopulatedMcpServer> {
	const server = await getOrCreateMcpServer(params.projectId);
	await db
		.update(mcpServers)
		.set({ status: params.status, updatedAt: new Date() })
		.where(eq(mcpServers.id, server.id));
	return getPopulatedMcpServerByProjectId(params.projectId);
}

export async function rotateMcpServerToken(params: {
	projectId: string;
}): Promise<PopulatedMcpServer> {
	const server = await getOrCreateMcpServer(params.projectId);
	const newToken = generateMcpToken();
	await db
		.update(mcpServers)
		.set({ tokenEncrypted: encryptString(newToken), updatedAt: new Date() })
		.where(eq(mcpServers.id, server.id));
	return getPopulatedMcpServerByProjectId(params.projectId);
}

// ---------------------------------------------------------------------------
// Hosted workflow MCP connection sync
// ---------------------------------------------------------------------------

export async function syncHostedWorkflowMcpConnection(params: {
	projectId: string;
	status: McpServerStatus;
	actorUserId?: string | null;
	request?: Request;
}): Promise<McpConnection> {
	const serverUrl = buildHostedMcpServerUrl(params.projectId, params.request);
	return upsertHostedWorkflowMcpConnection({
		projectId: params.projectId,
		status: params.status,
		serverUrl,
		registryRef: 'mcp-gateway',
		metadata: {
			provider: 'workflow-builder',
			serviceName: 'mcp-gateway',
			endpointPath: '/api/v1/projects/:projectId/mcp-server/http'
		},
		actorUserId: params.actorUserId ?? null,
		lastError: null
	});
}

async function upsertHostedWorkflowMcpConnection(params: {
	projectId: string;
	displayName?: string;
	serverUrl?: string | null;
	registryRef?: string | null;
	status: McpConnectionStatus;
	metadata?: Record<string, unknown> | null;
	lastError?: string | null;
	actorUserId?: string | null;
}): Promise<McpConnection> {
	const now = new Date();
	const displayName = params.displayName?.trim() || 'Workflow Builder Hosted MCP';

	const existing = await db
		.select()
		.from(mcpConnections)
		.where(
			and(
				eq(mcpConnections.projectId, params.projectId),
				eq(mcpConnections.sourceType, 'hosted_workflow')
			)
		)
		.limit(1);

	if (existing.length > 0) {
		const row = existing[0];
		const existingMeta = (row.metadata as Record<string, unknown>) ?? {};
		const mergedMeta = params.metadata ? { ...existingMeta, ...params.metadata } : existingMeta;

		const [updated] = await db
			.update(mcpConnections)
			.set({
				displayName,
				serverUrl: params.serverUrl ?? row.serverUrl,
				registryRef: params.registryRef ?? row.registryRef,
				status: params.status,
				lastSyncAt: now,
				lastError: params.lastError ?? null,
				metadata: Object.keys(mergedMeta).length > 0 ? mergedMeta : null,
				updatedBy: params.actorUserId ?? null,
				updatedAt: now
			})
			.where(eq(mcpConnections.id, row.id))
			.returning();
		return updated;
	}

	const [created] = await db
		.insert(mcpConnections)
		.values({
			id: generateId(),
			projectId: params.projectId,
			sourceType: 'hosted_workflow',
			pieceName: null,
			serverKey: null,
			displayName,
			registryRef: params.registryRef ?? 'mcp-gateway',
			serverUrl: params.serverUrl ?? null,
			status: params.status,
			lastSyncAt: now,
			lastError: params.lastError ?? null,
			metadata: params.metadata ?? null,
			createdBy: params.actorUserId ?? null,
			updatedBy: params.actorUserId ?? null
		})
		.returning();
	return created;
}

// ---------------------------------------------------------------------------
// MCP Run CRUD (used by internal gateway routes)
// ---------------------------------------------------------------------------

export async function createMcpRun(params: {
	projectId: string;
	mcpServerId: string;
	workflowId: string;
	toolName: string;
	input: Record<string, unknown>;
}): Promise<McpRun> {
	const [run] = await db
		.insert(mcpRuns)
		.values({
			id: generateId(),
			projectId: params.projectId,
			mcpServerId: params.mcpServerId,
			workflowId: params.workflowId,
			toolName: params.toolName,
			input: params.input,
			status: 'STARTED'
		})
		.returning();
	return run;
}

export async function attachMcpRunExecution(params: {
	runId: string;
	workflowExecutionId: string;
	daprInstanceId: string | null;
}): Promise<void> {
	await db
		.update(mcpRuns)
		.set({
			workflowExecutionId: params.workflowExecutionId,
			daprInstanceId: params.daprInstanceId ?? null,
			updatedAt: new Date()
		})
		.where(eq(mcpRuns.id, params.runId));
}

export async function getMcpRun(runId: string): Promise<McpRun | null> {
	const rows = await db.select().from(mcpRuns).where(eq(mcpRuns.id, runId)).limit(1);
	return rows[0] ?? null;
}

export async function respondToMcpRun(params: {
	runId: string;
	response: unknown;
}): Promise<McpRun | null> {
	const [updated] = await db
		.update(mcpRuns)
		.set({
			response: params.response,
			respondedAt: new Date(),
			status: 'RESPONDED',
			updatedAt: new Date()
		})
		.where(eq(mcpRuns.id, params.runId))
		.returning();
	return updated ?? null;
}
