import { error } from '@sveltejs/kit';
import { and, eq, inArray } from 'drizzle-orm';
import { appConnections } from '$lib/server/db/schema';
import { AppConnectionStatus } from '$lib/server/types/app-connection';
import type { db } from '$lib/server/db';
import { connectionBelongsToProject } from '$lib/server/app-connection-scope';

type Database = NonNullable<typeof db>;

export function normalizePieceName(value: string | null | undefined): string {
	return (value || '')
		.trim()
		.toLowerCase()
		.replace(/^@activepieces\/piece-/, '')
		.replace(/[_\s]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

export function pieceCandidates(value: string | null | undefined): string[] {
	const normalized = normalizePieceName(value);
	if (!normalized) return [];
	return [normalized, `@activepieces/piece-${normalized}`];
}

export function pieceMcpRegistryRef(pieceName: string): string {
	return `ap-${normalizePieceName(pieceName)}-service`;
}

function isActivepiecesPieceServiceHost(hostname: string): boolean {
	const serviceName = hostname.split('.')[0] ?? '';
	return /^ap-[a-z0-9]([-a-z0-9]*[a-z0-9])?-service$/.test(serviceName);
}

export function normalizePieceMcpServerUrl(value: string): string {
	const text = value.trim();
	if (!text) return text;
	try {
		const url = new URL(text);
		if (isActivepiecesPieceServiceHost(url.hostname)) {
			if (url.port === '3100') {
				url.port = '';
			}
			if (!url.hostname.includes('.')) {
				url.hostname = `${url.hostname}.workflow-builder.svc.cluster.local`;
			}
		}
		return url.toString();
	} catch {
		return text;
	}
}

export function pieceMcpServerUrl(pieceName: string): string {
	return `http://${pieceMcpRegistryRef(pieceName)}/mcp`;
}

export function humanizePieceName(pieceName: string): string {
	return normalizePieceName(pieceName)
		.split('-')
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

export function requireSessionProjectId(locals: App.Locals): string {
	const projectId = locals.session?.projectId?.trim();
	if (!locals.session?.userId) throw error(401, 'Unauthorized');
	if (!projectId) throw error(400, 'Current session does not include a project');
	return projectId;
}

export async function validateMcpCredentialBinding(
	database: Database,
	projectId: string,
	pieceName: string | null | undefined,
	externalId: unknown
): Promise<string | null> {
	const value = typeof externalId === 'string' ? externalId.trim() : '';
	if (!value) return null;
	const candidates = pieceCandidates(pieceName);
	if (candidates.length === 0) {
		throw error(400, 'connectionExternalId can only be set for a piece MCP connection');
	}
	const [connection] = await database
		.select({ externalId: appConnections.externalId, projectIds: appConnections.projectIds })
		.from(appConnections)
		.where(
			and(
				eq(appConnections.externalId, value),
				eq(appConnections.status, AppConnectionStatus.ACTIVE),
				inArray(appConnections.pieceName, candidates)
			)
		)
		.limit(1);
	if (!connection || !connectionBelongsToProject(connection.projectIds, projectId)) {
		throw error(400, 'connectionExternalId must reference an active app connection for the same piece');
	}
	return value;
}
