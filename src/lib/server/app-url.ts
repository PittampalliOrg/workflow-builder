import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { daprFetch, getDaprSidecarUrl } from '$lib/server/dapr-client';

let cachedAppUrl = '';

/**
 * Resolve the public-facing app URL for OAuth redirect URIs.
 *
 * Priority:
 * 1. Dapr configuration store (azureappconfig) — cached after first fetch
 * 2. APP_PUBLIC_URL (private env)
 * 3. PUBLIC_APP_URL (SvelteKit public env)
 * 4. ORIGIN env var
 * 5. X-Forwarded-Proto + Host headers from the request
 * 6. url.origin with forced https (last resort)
 */
export async function getAppUrl(url?: URL, request?: Request): Promise<string> {
	// Return cached value if available
	if (cachedAppUrl) return cachedAppUrl;

	// 1. Try Dapr configuration store
	try {
		const configStore = env.DAPR_CONFIG_STORE || 'azureappconfig-workflow-builder';
		const res = await daprFetch(
			`${getDaprSidecarUrl()}/v1.0/configuration/${configStore}?key=PUBLIC_APP_URL`,
			{ signal: AbortSignal.timeout(2000), maxRetries: 0 }
		);
		if (res.ok) {
			const data = await res.json();
			const value = data?.['PUBLIC_APP_URL']?.value;
			if (value) {
				cachedAppUrl = value.replace(/\/$/, '');
				return cachedAppUrl;
			}
		}
	} catch {
		// Dapr not available — continue with env fallbacks
	}

	// 2-4. Environment variables
	const envUrl = env.APP_PUBLIC_URL || publicEnv.PUBLIC_APP_URL || env.ORIGIN;
	if (envUrl) {
		cachedAppUrl = envUrl.replace(/\/$/, '');
		return cachedAppUrl;
	}

	// 5. Reconstruct from forwarded headers
	if (request) {
		const proto = request.headers.get('x-forwarded-proto') || 'https';
		const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
		if (host) {
			return `${proto}://${host}`;
		}
	}

	// 6. Fallback — force https on url.origin
	if (url) {
		return url.origin.replace(/^http:\/\//, 'https://');
	}

	return 'https://localhost:3000';
}
