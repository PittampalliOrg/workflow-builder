import { env } from '$env/dynamic/private';

/**
 * Validate that the request carries the correct internal API token.
 *
 * The token is sourced from the `INTERNAL_API_TOKEN` env var (populated from
 * the Dapr secret store / Azure Key Vault key `INTERNAL-API-TOKEN`).
 *
 * Callers pass the token via:
 *   - `X-Internal-Token` header (preferred), or
 *   - `Authorization: Bearer <token>` header
 */
export function validateInternalToken(request: Request): boolean {
	const expected = env.INTERNAL_API_TOKEN;
	if (!expected) {
		return false;
	}
	const token =
		request.headers.get('x-internal-token') ||
		request.headers.get('authorization')?.replace('Bearer ', '');
	return !!token && token === expected;
}
