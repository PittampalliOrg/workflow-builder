import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { workflowConnectionRefs } from '$lib/server/db/schema';

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseConnectionExternalId(value: unknown): string | null {
	if (typeof value !== 'string' || value.trim().length === 0) return null;
	const match = value.match(/connections\['([^']+)'\]/);
	return match?.[1] || (value.trim() ? value.trim() : null);
}

function inferPieceName(nodeData: Record<string, unknown>): string | null {
	const actionDefinition = isRecord(nodeData.actionDefinition) ? nodeData.actionDefinition : null;
	const catalogFunction = isRecord(nodeData.catalogFunction) ? nodeData.catalogFunction : null;
	const actionCatalogDetail = isRecord(nodeData.actionCatalogDetail) ? nodeData.actionCatalogDetail : null;

	const candidates = [
		catalogFunction?.pieceName,
		actionCatalogDetail?.providerId,
		actionCatalogDetail?.pieceName,
		actionDefinition?.providerId,
	];

	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate.trim().length > 0) {
			return candidate.trim();
		}
	}

	return null;
}

export function collectWorkflowConnectionRefs(
	workflowId: string,
	nodes: unknown,
): Array<{ workflowId: string; nodeId: string; connectionExternalId: string; pieceName: string }> {
	if (!Array.isArray(nodes)) return [];

	const refs = new Map<string, { workflowId: string; nodeId: string; connectionExternalId: string; pieceName: string }>();
	for (const node of nodes) {
		if (!isRecord(node)) continue;
		const nodeId = typeof node.id === 'string' ? node.id : '';
		if (!nodeId) continue;
		const data = isRecord(node.data) ? node.data : {};
		const actionBinding = isRecord(data.actionBinding) ? data.actionBinding : null;
		const taskConfig = isRecord(data.taskConfig) ? data.taskConfig : null;
		const withConfig = taskConfig && isRecord(taskConfig.with) ? taskConfig.with : null;
		const body = withConfig && isRecord(withConfig.body) ? withConfig.body : null;
		const input = body && isRecord(body.input) ? body.input : null;

		const connectionExternalId =
			(typeof actionBinding?.connectionExternalId === 'string' && actionBinding.connectionExternalId.trim()) ||
			parseConnectionExternalId(input?.auth) ||
			null;
		const pieceName =
			(typeof actionBinding?.pieceName === 'string' && actionBinding.pieceName.trim()) ||
			inferPieceName(data) ||
			null;

		if (!connectionExternalId || !pieceName) continue;
		refs.set(nodeId, {
			workflowId,
			nodeId,
			connectionExternalId,
			pieceName,
		});
	}

	return Array.from(refs.values());
}

export async function syncWorkflowConnectionRefs(
	workflowId: string,
	nodes: unknown,
): Promise<void> {
	if (!db) return;
	const refs = collectWorkflowConnectionRefs(workflowId, nodes);

	await db.delete(workflowConnectionRefs).where(eq(workflowConnectionRefs.workflowId, workflowId));
	if (refs.length === 0) return;

	await db.insert(workflowConnectionRefs).values(refs);
}
