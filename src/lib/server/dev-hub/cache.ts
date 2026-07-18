/**
 * Tiny in-memory cache primitive shared by the dev-hub / fleet-drift read
 * modules, mirroring the established `deployment-metadata.ts` pattern:
 * TTL cache + single inflight load (dedupe) + stale-on-error (a failed refresh
 * re-serves the last good value for a short error TTL instead of throwing).
 */

export type CachedLoader<T> = {
	/** Cached value when fresh; otherwise one shared upstream load. */
	get(options?: { fresh?: boolean }): Promise<T>;
	/** Drop the cached value (next get() reloads). */
	invalidate(): void;
	/** Last cached value without triggering a load (tests/diagnostics). */
	peek(): T | null;
};

export function createCachedLoader<T>(input: {
	ttlMs: number;
	/** How long an error-derived value keeps being served (default 15s). */
	errorTtlMs?: number;
	load: () => Promise<T>;
	/**
	 * Turn a load failure into a degraded value (cached for errorTtlMs).
	 * Receives the last good value (stale) when one exists. Without a fallback,
	 * a failure re-serves the stale value, or rethrows when there is none.
	 */
	fallback?: (cause: unknown, stale: T | null) => T;
	now?: () => number;
}): CachedLoader<T> {
	const errorTtlMs = input.errorTtlMs ?? 15_000;
	const now = input.now ?? Date.now;
	let entry: { value: T; expiresAt: number } | null = null;
	let lastGood: T | null = null;
	let inflight: Promise<T> | null = null;

	return {
		async get(options?: { fresh?: boolean }): Promise<T> {
			if (!options?.fresh && entry && entry.expiresAt > now()) {
				return entry.value;
			}
			if (inflight) return inflight;
			inflight = (async () => {
				try {
					const value = await input.load();
					entry = { value, expiresAt: now() + input.ttlMs };
					lastGood = value;
					return value;
				} catch (cause) {
					if (input.fallback) {
						const value = input.fallback(cause, lastGood);
						entry = { value, expiresAt: now() + errorTtlMs };
						return value;
					}
					if (lastGood !== null) {
						// Stale-on-error: keep serving the last good value briefly.
						entry = { value: lastGood, expiresAt: now() + errorTtlMs };
						return lastGood;
					}
					throw cause;
				} finally {
					inflight = null;
				}
			})();
			return inflight;
		},
		invalidate(): void {
			entry = null;
		},
		peek(): T | null {
			return entry?.value ?? null;
		},
	};
}
