/**
 * Owns one pending/active browser-context lease and its MCP child cleanup.
 * Every exit path converges on the same disposal promise so SDK callbacks,
 * DELETE, transport close, and outer request errors cannot double-clean.
 */
export function createMcpSessionLifecycle({
	registry,
	acquisition,
	sessions,
	cleanup,
	getTransportSessionId = () => null,
}) {
	let committed = false;
	let initializedSessionId = null;
	let cleanupPromise = null;
	let disposePromise = null;

	const cleanupOnce = () => (cleanupPromise ??= Promise.resolve().then(() => cleanup()));

	const disposeOnce = () =>
		(disposePromise ??= (async () => {
			const sessionId = getTransportSessionId() || initializedSessionId;
			if (sessionId) sessions.delete(sessionId);
			try {
				if (committed) {
					registry.detach(acquisition);
				} else {
					await registry.abandon(acquisition);
				}
			} finally {
				await cleanupOnce();
			}
		})());

	function initialize(newSessionId, sessionRecord) {
		if (!registry.commit(acquisition)) {
			throw new Error("Browser context closed during MCP initialization");
		}
		committed = true;
		initializedSessionId = newSessionId;
		sessions.set(newSessionId, {
			...sessionRecord,
			sessionId: newSessionId,
			cleanup: cleanupOnce,
			dispose: disposeOnce,
		});
	}

	async function cleanupUncommittedAfterHandle() {
		if (committed) return false;
		await disposeOnce();
		return true;
	}

	return {
		cleanupOnce,
		cleanupUncommittedAfterHandle,
		dispose: disposeOnce,
		initialize,
		isCommitted: () => committed,
	};
}
