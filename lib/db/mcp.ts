import { and, eq, isNull, or } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { db } from "@/lib/db";
import { buildHostedMcpServerUrl } from "@/lib/mcp-gateway/url";
import {
	type McpRun,
	type McpConnection,
	type McpServer,
	type McpServerStatus,
	mcpRuns,
	mcpServers,
	projects,
	workflowExecutions,
	workflows,
} from "@/lib/db/schema";
import type { McpInputProperty } from "@/lib/mcp/types";
import { decryptString, encryptString } from "@/lib/security/encryption";
import { generateId } from "@/lib/utils/id";
import { upsertHostedWorkflowMcpConnection } from "./mcp-connections";

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

export type PopulatedMcpServer = Omit<McpServer, "tokenEncrypted"> & {
	token: string;
	flows: PopulatedMcpWorkflow[];
};

function parseBoolString(v: unknown, defaultValue: boolean): boolean {
	if (typeof v === "boolean") {
		return v;
	}
	if (typeof v === "string") {
		return v.toLowerCase() === "true";
	}
	return defaultValue;
}

function parseInputSchema(value: unknown): McpInputProperty[] {
	if (!value) {
		return [];
	}
	if (Array.isArray(value)) {
		// Backward/alternate format (if stored as array directly)
		return value as McpInputProperty[];
	}
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value) as unknown;
			if (Array.isArray(parsed)) {
				return parsed as McpInputProperty[];
			}
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
	if (!Array.isArray(nodes)) {
		return null;
	}
	const triggerNode = nodes.find(
		(n) => (n as any)?.data?.type === "trigger",
	) as any;
	const triggerType = triggerNode?.data?.config?.triggerType as
		| string
		| undefined;
	if (triggerType !== "MCP") {
		return null;
	}

	const config = (triggerNode?.data?.config ?? {}) as Record<string, unknown>;
	const enabled = parseBoolString(config.enabled, true);
	const toolNameRaw = (config.toolName as string | undefined) ?? "";
	const toolDescriptionRaw =
		(config.toolDescription as string | undefined) ?? "";

	return {
		enabled,
		toolName: toolNameRaw,
		toolDescription: toolDescriptionRaw,
		inputSchema: parseInputSchema(config.inputSchema),
		returnsResponse: parseBoolString(config.returnsResponse, false),
	};
}

export async function listMcpWorkflowsForProject(
	projectId: string,
): Promise<PopulatedMcpWorkflow[]> {
	const project = await db.query.projects.findFirst({
		where: eq(projects.id, projectId),
		columns: { id: true, ownerId: true },
	});
	if (!project) {
		return [];
	}

	const rows = await db.query.workflows.findMany({
		where: or(
			eq(workflows.projectId, projectId),
			and(isNull(workflows.projectId), eq(workflows.userId, project.ownerId)),
		),
		columns: {
			id: true,
			name: true,
			description: true,
			nodes: true,
		},
		orderBy: (t, { asc }) => [asc(t.createdAt)],
	});

	const populated: PopulatedMcpWorkflow[] = [];
	for (const w of rows) {
		const trigger = getMcpTriggerFromWorkflowNodes(w.nodes);
		if (!trigger) {
			continue;
		}
		populated.push({
			id: w.id,
			name: w.name,
			description: w.description,
			enabled: trigger.enabled,
			trigger: {
				toolName: trigger.toolName || w.name,
				toolDescription: trigger.toolDescription || "",
				inputSchema: trigger.inputSchema,
				returnsResponse: trigger.returnsResponse,
			},
		});
	}
	return populated;
}

export async function getOrCreateMcpServer(
	projectId: string,
): Promise<McpServer> {
	const existing = await db.query.mcpServers.findFirst({
		where: eq(mcpServers.projectId, projectId),
	});
	if (existing) {
		return existing;
	}

	const token = generateMcpToken();
	const [created] = await db
		.insert(mcpServers)
		.values({
			id: generateId(),
			projectId,
			status: "DISABLED",
			tokenEncrypted: encryptString(token),
		})
		.returning();
	return created;
}

export async function getPopulatedMcpServerByProjectId(
	projectId: string,
): Promise<PopulatedMcpServer> {
	const server = await getOrCreateMcpServer(projectId);
	const flows = await listMcpWorkflowsForProject(projectId);
	return {
		...server,
		token: decryptString(server.tokenEncrypted),
		flows,
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

export async function syncHostedWorkflowMcpConnection(params: {
	projectId: string;
	status: McpServerStatus;
	actorUserId?: string | null;
	request?: Request;
}): Promise<McpConnection> {
	const serverUrl = buildHostedMcpServerUrl(params.projectId, {
		request: params.request,
	});

	return upsertHostedWorkflowMcpConnection({
		projectId: params.projectId,
		status: params.status,
		serverUrl,
		registryRef: "mcp-gateway",
		metadata: {
			provider: "workflow-builder",
			serviceName: "mcp-gateway",
			endpointPath: "/api/v1/projects/:projectId/mcp-server/http",
		},
		actorUserId: params.actorUserId ?? null,
		lastError: null,
	});
}

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
			status: "STARTED",
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
			updatedAt: new Date(),
		})
		.where(eq(mcpRuns.id, params.runId));
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
			status: "RESPONDED",
			updatedAt: new Date(),
		})
		.where(eq(mcpRuns.id, params.runId))
		.returning();
	return updated ?? null;
}

export async function getMcpRun(runId: string): Promise<McpRun | null> {
	const run = await db.query.mcpRuns.findFirst({
		where: eq(mcpRuns.id, runId),
	});
	return run ?? null;
}

export async function markMcpRunTimedOut(runId: string): Promise<void> {
	await db
		.update(mcpRuns)
		.set({
			status: "TIMED_OUT",
			updatedAt: new Date(),
		})
		.where(eq(mcpRuns.id, runId));
}

export async function failMcpRun(runId: string, error: string): Promise<void> {
	await db
		.update(mcpRuns)
		.set({
			status: "FAILED",
			response: { error },
			updatedAt: new Date(),
		})
		.where(eq(mcpRuns.id, runId));
}

export async function getWorkflowExecutionForRun(
	runId: string,
): Promise<{ id: string; daprInstanceId: string | null } | null> {
	const run = await db.query.mcpRuns.findFirst({
		where: eq(mcpRuns.id, runId),
		columns: { workflowExecutionId: true },
	});
	if (!run?.workflowExecutionId) {
		return null;
	}
	const exec = await db.query.workflowExecutions.findFirst({
		where: eq(workflowExecutions.id, run.workflowExecutionId),
		columns: { id: true, daprInstanceId: true },
	});
	return exec ?? null;
}

function generateMcpToken(length = 72): string {
	const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", length);
	return nanoid();
}
