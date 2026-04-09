import { env } from '$env/dynamic/private';
import { getDecryptedAppConnection, normalizePieceName } from '$lib/server/app-connections';

export type ScmProvider = 'github' | 'gitea';

export interface ScmResolvedConnection {
	externalId: string;
	displayName: string;
	provider: ScmProvider;
	baseUrl: string;
	headers: Record<string, string>;
}

function readString(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNestedString(value: Record<string, unknown>, key: string): string | null {
	const direct = readString(value[key]);
	if (direct) return direct;

	const nested = value.data;
	if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
		return readString((nested as Record<string, unknown>)[key]);
	}

	return null;
}

function parseSecretText(secretText: string | null): Record<string, unknown> | null {
	if (!secretText) return null;
	try {
		const parsed = JSON.parse(secretText);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function extractToken(value: Record<string, unknown>): string | null {
	const secretText = readString(value.secret_text);
	const parsedSecret = parseSecretText(secretText);

	return (
		readNestedString(value, 'access_token') ||
		readNestedString(value, 'token') ||
		readNestedString(value, 'api_key') ||
		readNestedString(value, 'personal_access_token') ||
		readNestedString(value, 'pat') ||
		readString(parsedSecret?.access_token) ||
		readString(parsedSecret?.token) ||
		readString(parsedSecret?.api_key) ||
		secretText
	);
}

function normalizeGiteaBaseUrl(rawUrl: string | null): string {
	const fallback = env.GITEA_API_URL || 'http://gitea-http.gitea.svc.cluster.local:3000/api/v1';
	if (!rawUrl) return fallback;
	const trimmed = rawUrl.replace(/\/+$/, '');
	if (trimmed.endsWith('/api/v1')) return trimmed;
	if (trimmed.includes('/api/')) return trimmed;
	return `${trimmed}/api/v1`;
}

function resolveBaseUrl(provider: ScmProvider, value: Record<string, unknown>): string {
	if (provider === 'github') return 'https://api.github.com';

	return normalizeGiteaBaseUrl(
		readString(value.base_url) ||
			readString(value.server_url) ||
			readString(value.instance_url) ||
			readString(value.url) ||
			readString(value.host)
	);
}

export async function getScmConnection(
	connectionExternalId: string
): Promise<ScmResolvedConnection | null> {
	const connection = await getDecryptedAppConnection(connectionExternalId);
	if (!connection) return null;

	const providerName = normalizePieceName(connection.pieceName);
	const provider =
		providerName === 'github' ? 'github' : providerName === 'gitea' ? 'gitea' : null;
	if (!provider) return null;

	const value = connection.value as Record<string, unknown>;
	const token = extractToken(value);
	if (!token) return null;

	const headers: Record<string, string> =
		provider === 'github'
			? {
					Accept: 'application/vnd.github+json',
					'X-GitHub-Api-Version': '2022-11-28',
					Authorization: `Bearer ${token}`
				}
			: {
					Accept: 'application/json',
					Authorization: `token ${token}`
				};

	return {
		externalId: connection.externalId,
		displayName: connection.displayName,
		provider,
		baseUrl: resolveBaseUrl(provider, value),
		headers
	};
}

export async function scmFetchJson<T>(
	connection: ScmResolvedConnection,
	path: string
): Promise<T | null> {
	const response = await fetch(`${connection.baseUrl}${path}`, {
		headers: connection.headers,
		signal: AbortSignal.timeout(20000)
	});

	if (!response.ok) return null;
	return (await response.json()) as T;
}
