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

/**
 * Runs the one close owner's work under a response deadline. A timed-out caller
 * and its followers settle immediately, but the old generation remains the
 * admission fence until both finalization and cancellation have drained.
 */
export async function finalizeBrowserClose({
	registry,
	context,
	claim,
	finalize,
	timeoutMs,
	cancel = async () => {},
}) {
	if (
		!registry?.ownsClose(context, claim) ||
		typeof registry.fenceRelease !== "function" ||
		typeof registry.settleCloseResponse !== "function" ||
		typeof finalize !== "function" ||
		typeof cancel !== "function" ||
		!Number.isFinite(timeoutMs) ||
		timeoutMs <= 0
	) {
		throw new Error("invalid browser close ownership or deadline");
	}
	const controller = new AbortController();
	const finalization = Promise.resolve().then(() => finalize(controller.signal));
	let cancellation = Promise.resolve();
	let timer;
	const deadline = new Promise((_, reject) => {
		timer = setTimeout(() => {
			const error = new Error(`browser close finalization exceeded ${timeoutMs}ms`);
			cancellation = Promise.resolve().then(() => cancel(error));
			reject(error);
			controller.abort(error);
		}, timeoutMs);
	});
	let responseSucceeded = false;
	try {
		const result = await Promise.race([finalization, deadline]);
		responseSucceeded = true;
		return result;
	} finally {
		clearTimeout(timer);
		registry.settleCloseResponse(context, claim, responseSucceeded);
		registry
			.fenceRelease(context, claim, [finalization, cancellation])
			.catch(() => {});
	}
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
				admissionFence: null,
				closeClaim: null,
				closeResponsePromise: null,
				closeResponseSettled: false,
				resolveCloseResponse: null,
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
		let resolveCloseResponse;
		const closeResponsePromise = new Promise((resolve) => {
			resolveCloseResponse = resolve;
		});
		const claim = Object.freeze({
			browserSession: context.browserSession,
			generation: context.generation,
			nonce: Symbol("browser-close-owner"),
		});
		context.closing = true;
		context.closeClaim = claim;
		context.closeResponsePromise = closeResponsePromise;
		context.resolveCloseResponse = resolveCloseResponse;
		return claim;
	}

	function ownsClose(context, claim) {
		return Boolean(context && claim && context.closeClaim === claim);
	}

	function settleCloseResponse(context, claim, result) {
		if (!ownsClose(context, claim) || context.closeResponseSettled) return false;
		context.closeResponseSettled = true;
		context.resolveCloseResponse?.(Boolean(result));
		return true;
	}

	function waitForCloseResponse(context) {
		return context?.closeResponsePromise ?? Promise.resolve(false);
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

	function releaseNow(context, claim = null) {
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
		// Publish the pending fence before removing the entry. This makes the
		// replacement-admission invariant explicit even within this sync turn.
		pendingReleases.set(context.browserSession, pending);
		entries.delete(context.browserSession);
		pending.then(
			() => settleCloseResponse(context, owner, true),
			() => settleCloseResponse(context, owner, false),
		);
		return pending;
	}

	function release(context, claim = null) {
		if (context?.admissionFence) {
			return ownsClose(context, claim)
				? context.admissionFence
				: Promise.resolve(false);
		}
		return releaseNow(context, claim);
	}

	function fenceRelease(context, claim, prerequisites) {
		if (!ownsClose(context, claim) || !Array.isArray(prerequisites)) {
			return Promise.resolve(false);
		}
		if (context.admissionFence) return context.admissionFence;
		context.admissionFence = Promise.allSettled(prerequisites).then(() =>
			releaseNow(context, claim),
		);
		return context.admissionFence;
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
		return claim ? release(context, claim) : waitForCloseResponse(context);
	}

	return {
		acquire,
		abandon,
		claimClose,
		commit,
		detach,
		fenceRelease,
		isCurrent,
		ownsClose,
		release,
		settleCloseResponse,
		waitForCloseResponse,
		current(browserSession) {
			return entries.get(browserSession) ?? null;
		},
	};
}
