/**
 * Auth Resolver
 *
 * Resolves credentials for AP piece actions.
 *
 * Priority:
 * 1. Request-scoped X-Connection-External-Id → call internal decrypt API
 * 2. CONNECTION_EXTERNAL_ID env → call internal decrypt API
 * 3. CREDENTIALS_JSON env → parse inline JSON
 * 4. No auth → return undefined
 *
 * Caches decrypted credentials for 5 minutes (OAuth2 tokens may refresh).
 */

import { AsyncLocalStorage } from "node:async_hooks";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export type RequestAuthContext = {
	connectionExternalId?: string | null;
};

type CachedCredential = {
	value: unknown;
	timestamp: number;
};

const requestAuthContext = new AsyncLocalStorage<RequestAuthContext>();
const cachedCredentials = new Map<string, CachedCredential>();

export function runWithRequestAuthContext<T>(
	context: RequestAuthContext,
	fn: () => T,
): T {
	return requestAuthContext.run(context, fn);
}

function cachedValue(key: string): unknown | undefined {
	const cached = cachedCredentials.get(key);
	if (!cached) return undefined;
	if (Date.now() - cached.timestamp >= CACHE_TTL_MS) {
		cachedCredentials.delete(key);
		return undefined;
	}
	return cached.value;
}

function storeCachedValue(key: string, value: unknown): unknown {
	cachedCredentials.set(key, { value, timestamp: Date.now() });
	return value;
}

async function fetchConnectionCredentials(
	connectionExternalId: string,
): Promise<unknown> {
	const internalApiUrl = process.env.INTERNAL_API_URL;
	const internalApiToken = process.env.INTERNAL_API_TOKEN;

	if (!internalApiUrl || !internalApiToken) {
		throw new Error(
			"connectionExternalId is set but INTERNAL_API_URL and INTERNAL_API_TOKEN are required",
		);
	}

	const url = `${internalApiUrl}/api/internal/connections/${encodeURIComponent(connectionExternalId)}/decrypt`;
	const response = await fetch(url, {
		headers: {
			"X-Internal-Token": internalApiToken,
			"Content-Type": "application/json",
		},
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(
			`Failed to decrypt connection ${connectionExternalId}: ${response.status} ${text}`,
		);
	}

	const data = (await response.json()) as { value: unknown };
	return data.value;
}

/**
 * Resolve auth credentials for piece action execution.
 */
export async function resolveAuth(): Promise<unknown> {
	const contextExternalId = requestAuthContext
		.getStore()
		?.connectionExternalId?.trim();
	const connectionExternalId =
		contextExternalId || process.env.CONNECTION_EXTERNAL_ID?.trim();
	if (connectionExternalId) {
		const cacheKey = `connection:${connectionExternalId}`;
		const cached = cachedValue(cacheKey);
		if (cached !== undefined) return cached;
		return storeCachedValue(
			cacheKey,
			await fetchConnectionCredentials(connectionExternalId),
		);
	}

	const credentialsJson = process.env.CREDENTIALS_JSON;
	if (credentialsJson) {
		const cacheKey = "credentials_json";
		const cached = cachedValue(cacheKey);
		if (cached !== undefined) return cached;
		try {
			return storeCachedValue(cacheKey, JSON.parse(credentialsJson));
		} catch (e) {
			throw new Error(
				`Failed to parse CREDENTIALS_JSON: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	// Priority 4: No auth
	return undefined;
}

/**
 * Clear the credential cache (useful if credentials are rotated).
 */
export function clearAuthCache(): void {
	cachedCredentials.clear();
}
