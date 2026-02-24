import { getConfigAsync } from "@/lib/dapr/config-provider";

const DEFAULT_APP_URL = "http://localhost:3000";

function trimTrailingSlash(url: string): string {
	return url.endsWith("/") ? url.slice(0, -1) : url;
}

function getRequestOrigin(request: Request): string | null {
	try {
		return new URL(request.url).origin;
	} catch {
		return null;
	}
}

/**
 * Resolve the public app URL for social OAuth redirects.
 *
 * Priority:
 * 1) Dapr configuration key `NEXT_PUBLIC_APP_URL`
 * 2) Process env `NEXT_PUBLIC_APP_URL`
 * 3) Incoming request origin
 * 4) localhost fallback
 */
export async function resolveSocialAppUrl(request: Request): Promise<string> {
	try {
		const configured = await getConfigAsync("NEXT_PUBLIC_APP_URL");
		if (configured) {
			return trimTrailingSlash(configured);
		}
	} catch {
		// If Dapr config is unavailable, continue with env/request fallbacks.
	}

	const envUrl = process.env.NEXT_PUBLIC_APP_URL;
	if (envUrl) {
		return trimTrailingSlash(envUrl);
	}

	const requestOrigin = getRequestOrigin(request);
	if (requestOrigin) {
		return requestOrigin;
	}

	return DEFAULT_APP_URL;
}
