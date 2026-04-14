import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { mcpConnections } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

function toolNameFromUnknown(value: unknown): string | null {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		return trimmed || null;
	}
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		for (const key of ['name', 'toolName', 'id', 'title']) {
			const candidate = record[key];
			if (typeof candidate === 'string' && candidate.trim()) {
				return candidate.trim();
			}
		}
	}
	return null;
}

function normalizeToolNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const names = value.map(toolNameFromUnknown).filter((item): item is string => Boolean(item));
	return Array.from(new Set(names));
}

function toolsFromMetadata(metadata: Record<string, unknown> | null): string[] {
	const candidates = [metadata?.toolNames, metadata?.tools, metadata?.allowedTools];
	for (const candidate of candidates) {
		if (Array.isArray(candidate)) {
			return normalizeToolNames(candidate);
		}
	}
	return [];
}

function healthUrl(serverUrl: string): string {
	const url = new URL(serverUrl);
	url.pathname = url.pathname.replace(/\/mcp\/?$/, '/health');
	if (!url.pathname.endsWith('/health')) {
		url.pathname = `${url.pathname.replace(/\/+$/, '')}/health`;
	}
	url.search = '';
	return url.toString();
}

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Unauthorized');
	if (!db) return error(500, 'Database not available');

	const [connection] = await db
		.select()
		.from(mcpConnections)
		.where(eq(mcpConnections.id, params.id))
		.limit(1);

	if (!connection) return error(404, 'MCP connection not found');

	const metadataTools = toolsFromMetadata(connection.metadata as Record<string, unknown> | null);
	if (metadataTools.length > 0) {
		return json({ toolNames: metadataTools, source: 'metadata' });
	}

	if (!connection.serverUrl) {
		return json({ toolNames: [], source: 'none' });
	}

	try {
		const response = await fetch(healthUrl(connection.serverUrl), {
			headers: { Accept: 'application/json' },
			signal: AbortSignal.timeout(5000)
		});
		if (!response.ok) {
			return error(response.status, `MCP server health check failed with HTTP ${response.status}`);
		}
		const payload = (await response.json()) as Record<string, unknown>;
		const toolNames = normalizeToolNames(payload.toolNames ?? payload.tools);
		return json({ toolNames, source: 'health' });
	} catch (err) {
		return error(
			502,
			`Unable to discover MCP tools: ${err instanceof Error ? err.message : 'Unknown error'}`
		);
	}
};
