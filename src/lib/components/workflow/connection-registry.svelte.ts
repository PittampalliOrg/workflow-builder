/**
 * Lazily-fetched, shared registry of app-connection external ids for canvas
 * node validation — AP call nodes show a warning dot when their
 * `{{connections['…']}}` ref no longer resolves to an existing connection
 * (mirrors what the server-side `collectWorkflowConnectionRefs` extracts).
 *
 * One fetch per TTL window shared by every node instance; refreshes when the
 * tab regains visibility so a connection created on the Integrations page is
 * picked up on return. Deliberately NOT a validation framework — just a Set
 * of known external ids plus a `loaded` flag.
 */
import { browser } from '$app/environment';

const TTL_MS = 60_000;

let ids = $state<Set<string>>(new Set());
let loaded = $state(false);
let fetchedAt = 0;
let inflight: Promise<void> | null = null;
let visibilityHooked = false;

async function refresh(): Promise<void> {
	try {
		const response = await fetch('/api/app-connections');
		const payload = (await response.json().catch(() => null)) as
			| Array<{ externalId?: unknown }>
			| null;
		if (!response.ok || !Array.isArray(payload)) return;
		ids = new Set(
			payload
				.map((row) => (typeof row.externalId === 'string' ? row.externalId : ''))
				.filter(Boolean),
		);
		loaded = true;
		fetchedAt = Date.now();
	} catch {
		// Advisory only — keep whatever we had.
	} finally {
		inflight = null;
	}
}

function ensureFresh(): void {
	if (!browser) return;
	if (!visibilityHooked) {
		visibilityHooked = true;
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'visible') {
				fetchedAt = 0;
				ensureFresh();
			}
		});
	}
	if (inflight || Date.now() - fetchedAt < TTL_MS) return;
	inflight = refresh();
}

/** Reactive view over the shared registry; call once per component init. */
export function useConnectionRegistry(): {
	readonly ids: Set<string>;
	readonly loaded: boolean;
} {
	ensureFresh();
	return {
		get ids() {
			return ids;
		},
		get loaded() {
			return loaded;
		},
	};
}

/**
 * Extract the connection external id a task references, if any:
 * `with.connectionExternalId` or `with.body.input.auth`'s
 * `{{connections['…']}}` template.
 */
export function extractTaskConnectionRef(
	taskConfig: Record<string, unknown> | null | undefined,
): string | null {
	if (!taskConfig || typeof taskConfig !== 'object') return null;
	const withConfig =
		taskConfig.with && typeof taskConfig.with === 'object' && !Array.isArray(taskConfig.with)
			? (taskConfig.with as Record<string, unknown>)
			: null;
	if (!withConfig) return null;

	const direct = withConfig.connectionExternalId;
	if (typeof direct === 'string' && direct.trim()) return direct.trim();

	const body =
		withConfig.body && typeof withConfig.body === 'object' && !Array.isArray(withConfig.body)
			? (withConfig.body as Record<string, unknown>)
			: null;
	const input =
		body?.input && typeof body.input === 'object' && !Array.isArray(body.input)
			? (body.input as Record<string, unknown>)
			: null;
	const auth = input?.auth;
	if (typeof auth !== 'string') return null;
	const match = auth.match(/connections\['([^']+)'\]/);
	return match?.[1] ?? null;
}
