import { error } from '@sveltejs/kit';

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
