import { getApplicationAdapters } from '$lib/server/application';

export interface AppConnectionSummary {
	id: string;
	externalId: string;
	pieceName: string;
	displayName: string;
	type: string;
	status: string;
	createdAt: Date;
	pieceDisplayName?: string | null;
	pieceLogoUrl?: string | null;
}

export interface DecryptedAppConnection {
	id: string;
	externalId: string;
	pieceName: string;
	displayName: string;
	type: string;
	status: string;
	value: Record<string, unknown>;
}

export function normalizePieceName(value: string | null | undefined): string {
	if (!value) return '';
	const trimmed = value.trim();
	return trimmed.startsWith('@activepieces/piece-')
		? trimmed.slice('@activepieces/piece-'.length)
		: trimmed;
}

export async function listAppConnections(options?: {
	pieceName?: string | null;
	providerId?: string | null;
}): Promise<AppConnectionSummary[]> {
	return getApplicationAdapters().workflowData.listAppConnectionSummaries({
		pieceName: options?.pieceName ?? null,
		providerId: options?.providerId ?? null
	});
}

export async function getDecryptedAppConnection(
	externalId: string
): Promise<DecryptedAppConnection | null> {
	const result = await getApplicationAdapters().workflowData.decryptAppConnectionValue({
		externalId
	});
	return result.ok ? result.connection : null;
}
