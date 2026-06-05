/**
 * One shared clock for the whole GitOps pipeline view (Argo Workflows UI
 * `Ticker` pattern). A SINGLE interval drives every relative-time label and
 * event-freshness derivation, so the model never has to re-derive just because
 * the wall clock advanced — leaf components read `nowTick()` in their own
 * reactive context and only their timestamp text / tone restyles on a tick.
 *
 * Period is coarse (~15s): the active→neutral freshness boundary is 30 min, so
 * 15s keeps "x mins ago" labels honest without churn.
 */
let current = $state(Date.now());
let interval: ReturnType<typeof setInterval> | null = null;
let refs = 0;

/** Current shared clock in ms. Call inside a `$derived`/template to subscribe. */
export function nowTick(): number {
	return current;
}

/**
 * Start the shared clock (idempotent, ref-counted). Call from a page `onMount`
 * and invoke the returned disposer in `onDestroy`.
 */
export function startClock(periodMs = 15_000): () => void {
	refs += 1;
	if (!interval) {
		current = Date.now();
		interval = setInterval(() => {
			current = Date.now();
		}, periodMs);
	}
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		refs -= 1;
		if (refs <= 0 && interval) {
			clearInterval(interval);
			interval = null;
			refs = 0;
		}
	};
}
