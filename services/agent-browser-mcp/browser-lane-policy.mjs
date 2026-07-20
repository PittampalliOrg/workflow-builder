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
	let nextLeaseId = 1;

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
		let context = entries.get(browserSession);
		if (context) {
			if (!isCurrent(context, authorizationBinding)) return null;
		} else {
			context = {
				...createState({ browserSession, authorizationBinding }),
				browserSession,
				authorizationBinding,
				generation: nextGeneration++,
				closing: false,
				released: false,
				releasePromise: null,
				closeClaim: null,
				closePromise: null,
				settleClose: null,
				established: false,
				leases: new Map(),
			};
			entries.set(browserSession, context);
		}
		const lease = {
			context,
			id: nextLeaseId++,
			state: "pending",
		};
		context.leases.set(lease.id, lease);
		return lease;
	}

	function claimClose(context) {
		if (
			!context ||
			entries.get(context.browserSession) !== context ||
			context.released ||
			context.closing
		) {
			return null;
		}
		let settleClose;
		const closePromise = new Promise((resolve) => {
			settleClose = resolve;
		});
		const claim = Object.freeze({
			browserSession: context.browserSession,
			generation: context.generation,
			nonce: Symbol("browser-close-owner"),
		});
		context.closing = true;
		context.closeClaim = claim;
		context.closePromise = closePromise;
		context.settleClose = settleClose;
		return claim;
	}

	function ownsClose(context, claim) {
		return Boolean(context && claim && context.closeClaim === claim);
	}

	function waitForClose(context) {
		return context?.closePromise ?? Promise.resolve(false);
	}

	function commit(lease) {
		const context = lease?.context;
		if (
			!context ||
			lease.state !== "pending" ||
			context.leases.get(lease.id) !== lease ||
			!isCurrent(context, context.authorizationBinding)
		) {
			return false;
		}
		lease.state = "active";
		context.established = true;
		return true;
	}

	function detach(lease) {
		const context = lease?.context;
		if (
			!context ||
			lease.state !== "active" ||
			context.leases.get(lease.id) !== lease
		) {
			return false;
		}
		lease.state = "detached";
		context.leases.delete(lease.id);
		return true;
	}

	function release(context, claim = null) {
		if (!context) return Promise.resolve(false);
		if (context.releasePromise) {
			return ownsClose(context, claim)
				? context.releasePromise
				: Promise.resolve(false);
		}
		if (entries.get(context.browserSession) !== context) {
			return Promise.resolve(false);
		}
		let owner = claim;
		if (!context.closing) owner = claimClose(context);
		if (!ownsClose(context, owner)) return Promise.resolve(false);
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
		pending.then(
			() => context.settleClose?.(true),
			() => context.settleClose?.(false),
		);
		return pending;
	}

	async function abandon(lease) {
		const context = lease?.context;
		if (
			!context ||
			lease.state !== "pending" ||
			context.leases.get(lease.id) !== lease
		) {
			return false;
		}
		lease.state = "abandoned";
		context.leases.delete(lease.id);
		if (context.established || context.leases.size > 0) return true;
		const claim = claimClose(context);
		return claim ? release(context, claim) : waitForClose(context);
	}

	return {
		acquire,
		abandon,
		claimClose,
		commit,
		detach,
		isCurrent,
		ownsClose,
		release,
		waitForClose,
		current(browserSession) {
			return entries.get(browserSession) ?? null;
		},
	};
}
