/**
 * Auth Resolver
 *
 * Resolves credentials for AP piece actions.
 *
 * Priority:
 * 1. Request-scoped X-Connection-External-Id → call internal decrypt API
 * 2. No auth → return undefined
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
 * The request-scoped connection reference (X-Connection-External-Id), if any.
 * Used by /execute's idempotency gate to stamp the piece_execution audit row.
 */
export function getRequestConnectionExternalId(): string | undefined {
	return (
		requestAuthContext.getStore()?.connectionExternalId?.trim() || undefined
	);
}

/**
 * Resolve auth credentials for piece action execution.
 */
export async function resolveAuth(): Promise<unknown> {
	const contextExternalId = requestAuthContext
		.getStore()
		?.connectionExternalId?.trim();
	if (contextExternalId) {
		const cacheKey = `connection:${contextExternalId}`;
		const cached = cachedValue(cacheKey);
		if (cached !== undefined) return cached;
		return storeCachedValue(
			cacheKey,
			await fetchConnectionCredentials(contextExternalId),
		);
	}

	return undefined;
}

/**
 * Clear the credential cache (useful if credentials are rotated).
 */
export function clearAuthCache(): void {
	cachedCredentials.clear();
}
