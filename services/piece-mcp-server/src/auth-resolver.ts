/**
 * Auth Resolver
 *
 * Resolves credentials for AP piece actions.
 *
 * Priority:
 * 1. CONNECTION_EXTERNAL_ID env → call internal decrypt API
 * 2. CREDENTIALS_JSON env → parse inline JSON
 * 3. No auth → return undefined
 *
 * Caches decrypted credentials for 5 minutes (OAuth2 tokens may refresh).
 */

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cachedCredentials: unknown = undefined;
let cacheTimestamp = 0;

/**
 * Resolve auth credentials for piece action execution.
 */
export async function resolveAuth(): Promise<unknown> {
	// Check cache first
	if (cachedCredentials !== undefined && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
		return cachedCredentials;
	}

	// Priority 1: CONNECTION_EXTERNAL_ID → decrypt via internal API
	const connectionExternalId = process.env.CONNECTION_EXTERNAL_ID;
	if (connectionExternalId) {
		const internalApiUrl = process.env.INTERNAL_API_URL;
		const internalApiToken = process.env.INTERNAL_API_TOKEN;

		if (!internalApiUrl || !internalApiToken) {
			throw new Error(
				"CONNECTION_EXTERNAL_ID is set but INTERNAL_API_URL and INTERNAL_API_TOKEN are required",
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
		cachedCredentials = data.value;
		cacheTimestamp = Date.now();
		return cachedCredentials;
	}

	// Priority 2: CREDENTIALS_JSON → parse inline JSON
	const credentialsJson = process.env.CREDENTIALS_JSON;
	if (credentialsJson) {
		try {
			cachedCredentials = JSON.parse(credentialsJson);
			cacheTimestamp = Date.now();
			return cachedCredentials;
		} catch (e) {
			throw new Error(
				`Failed to parse CREDENTIALS_JSON: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	// Priority 3: No auth
	return undefined;
}

/**
 * Clear the credential cache (useful if credentials are rotated).
 */
export function clearAuthCache(): void {
	cachedCredentials = undefined;
	cacheTimestamp = 0;
}
