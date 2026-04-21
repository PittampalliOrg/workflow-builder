import { json, error } from '@sveltejs/kit';
import { and, asc, eq, or } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { getPopulatedMcpServerByProjectId, syncHostedWorkflowMcpConnection } from '$lib/server/db/mcp';
import { mcpConnections, projects } from '$lib/server/db/schema';
import { validateInternalToken } from '$lib/server/internal-auth';
import { buildProjectMcpCatalogEntry } from '$lib/server/mcp-catalog';

/**
 * GET /api/internal/mcp/projects/[projectId]/catalog
 *
 * Returns the enabled project MCP connections in a shape that MCPJam can merge
 * with its shared catalog. The path parameter accepts either the project id or
 * the project's external id.
 *
 * Security: Validated via X-Internal-Token header.
 */
export const GET: RequestHandler = async ({ request, params }) => {
	if (!validateInternalToken(request)) {
		return error(401, 'Unauthorized');
	}
	if (!db) {
		return error(503, 'Database not configured');
	}

	const projectRef = params.projectId?.trim();
	if (!projectRef) {
		return error(400, 'Project id is required');
	}

	const [project] = await db
		.select({ id: projects.id, externalId: projects.externalId })
		.from(projects)
		.where(or(eq(projects.id, projectRef), eq(projects.externalId, projectRef)))
		.limit(1);

	if (!project) {
		return error(404, 'Project not found');
	}

	const hostedServer = await getPopulatedMcpServerByProjectId(project.id);
	await syncHostedWorkflowMcpConnection({
		projectId: project.id,
		status: hostedServer.status
	});

	const rows = await db
		.select({
			id: mcpConnections.id,
			projectId: mcpConnections.projectId,
			sourceType: mcpConnections.sourceType,
			pieceName: mcpConnections.pieceName,
			serverKey: mcpConnections.serverKey,
			connectionExternalId: mcpConnections.connectionExternalId,
			displayName: mcpConnections.displayName,
			serverUrl: mcpConnections.serverUrl,
			metadata: mcpConnections.metadata
		})
		.from(mcpConnections)
		.where(
			and(
				eq(mcpConnections.projectId, project.id),
				eq(mcpConnections.status, 'ENABLED')
			)
		)
		.orderBy(asc(mcpConnections.displayName), asc(mcpConnections.createdAt));

	const hostedGatewayBaseUrl =
		env.MCP_GATEWAY_INTERNAL_BASE_URL?.trim() ||
		'http://mcp-gateway.workflow-builder.svc.cluster.local:8080';

	const servers = rows
		.map((row) =>
			buildProjectMcpCatalogEntry(row, {
				hostedProjectId: project.id,
				hostedToken: hostedServer.token,
				hostedGatewayBaseUrl
			})
		)
		.filter((entry) => entry !== null);

	return json({
		projectId: project.id,
		projectExternalId: project.externalId,
		servers
	});
};
