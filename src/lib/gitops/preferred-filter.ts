/**
 * Persisted view preferences for the GitOps pipeline page (Kargo's
 * `preferredFilter`). Stored in localStorage so the active pipeline, view mode,
 * and graph toggles survive reloads.
 */
export type PipelineViewMode = "graph" | "list";

export type PreferredFilter = {
	/** Selected warehouse names (empty = all pipelines). */
	warehouses: string[];
	view: PipelineViewMode;
	showSubscriptions: boolean;
	showMinimap: boolean;
	stepEdges: boolean;
	/** Collapse each service's env stages into one lane card. */
	groupLanes: boolean;
};

export const DEFAULT_PREFERRED_FILTER: PreferredFilter = {
	warehouses: [],
	view: "graph",
	showSubscriptions: false,
	showMinimap: false,
	stepEdges: false,
	groupLanes: false,
};

const STORAGE_KEY = "gitops/pipeline/preferred-filter";

export function loadPreferredFilter(): PreferredFilter {
	if (typeof localStorage === "undefined") return { ...DEFAULT_PREFERRED_FILTER };
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...DEFAULT_PREFERRED_FILTER };
		const parsed = JSON.parse(raw) as Partial<PreferredFilter>;
		return {
			...DEFAULT_PREFERRED_FILTER,
			...parsed,
			warehouses: Array.isArray(parsed.warehouses) ? parsed.warehouses : [],
		};
	} catch {
		return { ...DEFAULT_PREFERRED_FILTER };
	}
}

export function savePreferredFilter(filter: PreferredFilter): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(filter));
	} catch {
		/* ignore quota / privacy-mode errors */
	}
}
