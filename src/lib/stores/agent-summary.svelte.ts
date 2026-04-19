/**
 * Agent-summary client cache.
 *
 * Lightweight module-level singleton that fetches every managed agent (incl.
 * workflow-ephemerals) once per page load and exposes a lookup by id. Shared
 * by the canvas node badge and the session detail header so neither has to
 * round-trip to resolve agent-ref → name/avatar/slug.
 */

export interface AgentSummary {
	id: string;
	slug: string;
	name: string;
	avatar?: string | null;
}

type State = {
	map: Map<string, AgentSummary>;
	loading: boolean;
	loaded: boolean;
	error: string | null;
};

const state = $state<State>({
	map: new Map(),
	loading: false,
	loaded: false,
	error: null,
});

let inflight: Promise<void> | null = null;

export function agentSummaryStore() {
	return state;
}

/**
 * Ensure the cache is populated. Safe to call repeatedly — the fetch is
 * de-duplicated and cached for the lifetime of the page. Consumers that need
 * a value synchronously can read `state.map` and fall back to a default when
 * `loaded === false`.
 */
export async function ensureAgentSummaries(): Promise<void> {
	if (state.loaded) return;
	if (inflight) return inflight;
	state.loading = true;
	state.error = null;
	inflight = (async () => {
		try {
			const res = await fetch('/api/agents?includeEphemeral=true');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as { agents?: AgentSummary[] };
			const next = new Map<string, AgentSummary>();
			for (const a of data.agents ?? []) {
				if (!a?.id) continue;
				next.set(a.id, {
					id: a.id,
					slug: a.slug,
					name: a.name,
					avatar: a.avatar ?? null,
				});
			}
			state.map = next;
			state.loaded = true;
		} catch (e) {
			state.error = e instanceof Error ? e.message : String(e);
		} finally {
			state.loading = false;
			inflight = null;
		}
	})();
	return inflight;
}

/**
 * Synchronous lookup. Returns the cached summary if available, otherwise
 * null. Callers should call `ensureAgentSummaries()` first for correctness,
 * and re-render reactively via the `state` (which is a `$state`).
 */
export function lookupAgentSummary(id: string | null | undefined): AgentSummary | null {
	if (!id) return null;
	return state.map.get(id) ?? null;
}
