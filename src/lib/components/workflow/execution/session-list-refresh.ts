export type SessionListRefreshCoordinator = {
	refresh: () => Promise<void>;
	refreshForSnapshot: (snapshot: object | null) => Promise<void> | null;
};

/**
 * Coalesces the run console's polling and execution-stream refresh signals.
 * Execution events retain the current snapshot object, so only a new object is
 * evidence that an authoritative snapshot was received.
 */
export function createSessionListRefreshCoordinator(
	load: () => Promise<void>
): SessionListRefreshCoordinator {
	let lastSnapshot: object | null = null;
	let inFlight: Promise<void> | null = null;

	function refresh(): Promise<void> {
		if (inFlight) return inFlight;

		inFlight = Promise.resolve()
			.then(load)
			.finally(() => {
				inFlight = null;
			});
		return inFlight;
	}

	function refreshForSnapshot(snapshot: object | null): Promise<void> | null {
		if (!snapshot || snapshot === lastSnapshot) return null;
		lastSnapshot = snapshot;
		return refresh();
	}

	return { refresh, refreshForSnapshot };
}
