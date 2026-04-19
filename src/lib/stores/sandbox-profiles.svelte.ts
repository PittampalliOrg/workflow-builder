/**
 * Module-level cache of sandbox profiles hydrated once per page load. The env
 * editor reads this via `sandboxProfilesStore()` / `ensureSandboxProfiles()`
 * to build the sandboxTemplate picker without re-fetching on every re-render.
 *
 * Mirrors the pattern in `agent-summary.svelte.ts`: a singleton with a
 * de-duplicated inflight promise + reactive `$state` that components can
 * subscribe to.
 */

import type { SandboxProfile } from "$lib/types/sandbox-profiles";

type ProfilesState = {
	loaded: boolean;
	loading: boolean;
	error: string | null;
	profiles: SandboxProfile[];
	/** Indexed for O(1) lookup by slug from the env editor. */
	bySlug: Map<string, SandboxProfile>;
};

const state = $state<ProfilesState>({
	loaded: false,
	loading: false,
	error: null,
	profiles: [],
	bySlug: new Map(),
});

let inflight: Promise<void> | null = null;

export function sandboxProfilesStore(): ProfilesState {
	return state;
}

/**
 * Idempotent fetch. Returns the existing promise if a load is already in
 * flight, otherwise kicks one off. Silently uses the existing cache once
 * loaded — caller should call `reloadSandboxProfiles()` explicitly to force
 * a refetch after admin-UI edits.
 */
export function ensureSandboxProfiles(): Promise<void> {
	if (state.loaded) return Promise.resolve();
	if (inflight) return inflight;
	state.loading = true;
	state.error = null;
	inflight = fetch("/api/v1/sandbox-profiles?includeArchived=false")
		.then(async (res) => {
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as { profiles: SandboxProfile[] };
			state.profiles = body.profiles ?? [];
			state.bySlug = new Map(state.profiles.map((p) => [p.slug, p]));
			state.loaded = true;
		})
		.catch((e) => {
			state.error = e instanceof Error ? e.message : String(e);
		})
		.finally(() => {
			state.loading = false;
			inflight = null;
		});
	return inflight;
}

export function lookupSandboxProfile(
	slug: string | null | undefined,
): SandboxProfile | undefined {
	if (!slug) return undefined;
	return state.bySlug.get(slug);
}

export function reloadSandboxProfiles(): Promise<void> {
	state.loaded = false;
	return ensureSandboxProfiles();
}
