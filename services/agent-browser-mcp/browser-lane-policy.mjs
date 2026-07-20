export function shouldProvisionFarmBrowser({
	executionId,
	farmConfigured,
	laneExists,
}) {
	return Boolean(executionId && farmConfigured && !laneExists);
}

export function shouldCloseBrowserAfterCapture(reason) {
	return reason !== "close";
}

/** Entry-aware lifecycle for a reusable run browser and its authorization state. */
export function createBrowserContextRegistry({
	releaseResources = async () => {},
	createState = () => ({}),
} = {}) {
	const entries = new Map();
	const pendingReleases = new Map();
	let nextGeneration = 1;

	function isCurrent(
		context,
		authorizationBinding = context?.authorizationBinding,
	) {
		return Boolean(
			context &&
			entries.get(context.browserSession) === context &&
			!context.closing &&
			!context.released &&
			context.authorizationBinding === authorizationBinding,
		);
	}

	function acquire(browserSession, authorizationBinding) {
		if (
			!browserSession ||
			!authorizationBinding ||
			pendingReleases.has(browserSession)
		) {
			return null;
		}
		const existing = entries.get(browserSession);
		if (existing) {
			return isCurrent(existing, authorizationBinding) ? existing : null;
		}
		const context = {
			...createState({ browserSession, authorizationBinding }),
			browserSession,
			authorizationBinding,
			generation: nextGeneration++,
			closing: false,
			released: false,
			releasePromise: null,
		};
		entries.set(browserSession, context);
		return context;
	}

	function beginClose(context) {
		if (
			!context ||
			entries.get(context.browserSession) !== context ||
			context.released
		) {
			return false;
		}
		if (context.closing) return true;
		context.closing = true;
		return true;
	}

	function release(context) {
		if (!context) return Promise.resolve(false);
		if (context.releasePromise) return context.releasePromise;
		if (entries.get(context.browserSession) !== context) {
			return Promise.resolve(false);
		}
		context.closing = true;
		context.released = true;
		entries.delete(context.browserSession);
		let pending;
		pending = Promise.resolve()
			.then(() => releaseResources(context))
			.then(() => true)
			.finally(() => {
				if (pendingReleases.get(context.browserSession) === pending) {
					pendingReleases.delete(context.browserSession);
				}
			});
		context.releasePromise = pending;
		pendingReleases.set(context.browserSession, pending);
		return pending;
	}

	return {
		acquire,
		beginClose,
		isCurrent,
		release,
		current(browserSession) {
			return entries.get(browserSession) ?? null;
		},
	};
}
