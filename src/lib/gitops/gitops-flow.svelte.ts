/**
 * A decaying "flowing" set powering the live event-flow motion (Argo Workflows
 * `markFlowing` pattern). When the SSE batch flush resolves which pipeline
 * targets a burst of events touched, it calls `markFlowing(keys)`; nodes/edges
 * read `isFlowing(key)` to play a short CSS pulse that auto-clears.
 *
 * Keys are warehouse names (`"<warehouse>"`) and stage names
 * (`"<warehouse>::<env>"`) — see `activityTargetKeys`. This is pure
 * presentation state: it NEVER feeds the model or the graph layout, so it
 * cannot reintroduce the hover / clock-tick flicker.
 */
const FLOW_MS = 2500;
const SWEEP_MS = 400;

let flows = $state<Record<string, number>>({});
let sweep: ReturnType<typeof setTimeout> | null = null;

function scheduleSweep(): void {
	if (sweep) return;
	sweep = setTimeout(() => {
		sweep = null;
		const now = Date.now();
		const next: Record<string, number> = {};
		let changed = false;
		for (const key in flows) {
			if (flows[key] > now) next[key] = flows[key];
			else changed = true;
		}
		if (changed) flows = next;
		if (Object.keys(next).length > 0) scheduleSweep();
	}, SWEEP_MS);
}

/** Mark one or more keys as currently flowing (resets their ~2.5s decay). */
export function markFlowing(keys: string[]): void {
	if (keys.length === 0) return;
	const expiry = Date.now() + FLOW_MS;
	const next = { ...flows };
	for (const key of keys) next[key] = expiry;
	flows = next;
	scheduleSweep();
}

/** Whether a key is currently flowing. Read in a reactive context to subscribe. */
export function isFlowing(key: string): boolean {
	const expiry = flows[key];
	return expiry !== undefined && expiry > Date.now();
}

/** Clear all flow marks (e.g. on unmount). */
export function clearFlowing(): void {
	if (sweep) {
		clearTimeout(sweep);
		sweep = null;
	}
	if (Object.keys(flows).length > 0) flows = {};
}
