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

function browserDeleteRetryableStatus(status) {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Delete one BrowserStation lease with bounded retries. A missing lease is a
 * successful idempotent outcome; permanent client errors fail immediately.
 */
export async function deleteBrowserWithRetry({
	request,
	attempts = 3,
	initialDelayMs = 250,
	sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
}) {
	if (
		typeof request !== "function" ||
		typeof sleep !== "function" ||
		!Number.isInteger(attempts) ||
		attempts < 1 ||
		!Number.isFinite(initialDelayMs) ||
		initialDelayMs < 0
	) {
		throw new Error("invalid browser delete retry policy");
	}

	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			const response = await request(attempt);
			if (response?.status === 404) return false;
			if (response?.ok) return true;

			const status = Number(response?.status);
			lastError = new Error(
				Number.isFinite(status)
					? `browser delete HTTP ${status}`
					: "browser delete returned an invalid response",
			);
			if (!browserDeleteRetryableStatus(status)) throw lastError;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			const statusMatch = /^browser delete HTTP (\d+)$/.exec(lastError.message);
			if (
				statusMatch &&
				!browserDeleteRetryableStatus(Number(statusMatch[1]))
			) {
				throw lastError;
			}
		}

		if (attempt < attempts) {
			await sleep(initialDelayMs * 2 ** (attempt - 1));
		}
	}
	throw lastError ?? new Error("browser delete failed");
}

/** Select an exact farm-bound close child, or no child for an unused lane. */
export async function resolveBrowserCloseChild({
	lane,
	localChild,
	childCdpUrl,
	waitForLaneReady,
	bindLaneChild,
}) {
	if (!lane) return localChild;
	if (
		typeof waitForLaneReady !== "function" ||
		typeof bindLaneChild !== "function"
	) {
		throw new Error("invalid farm browser close policy");
	}
	const ready = await waitForLaneReady(lane.ready);
	if (ready !== true || !lane.cdpUrl) return null;
	if (childCdpUrl === lane.cdpUrl) return localChild;

	const binding = await bindLaneChild(lane.cdpUrl);
	if (!binding?.child || binding.cdpUrl !== lane.cdpUrl) {
		throw new Error("browser close child is not bound to its farm lane");
	}
	return binding.child;
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
	const finalization = Promise.resolve().then(() =>
		finalize(controller.signal),
	);
	let cancellation = Promise.resolve();
	let timer;
	const deadline = new Promise((_, reject) => {
		timer = setTimeout(() => {
			const error = new Error(
				`browser close finalization exceeded ${timeoutMs}ms`,
			);
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
	let nextOperationId = 1;

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
				operations: new Map(),
				operationDrainWaiters: new Set(),
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
		if (!ownsClose(context, claim) || context.closeResponseSettled)
			return false;
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

	function settleOperationDrain(context) {
		if (context.operations.size > 0) return;
		for (const resolve of context.operationDrainWaiters) resolve(true);
		context.operationDrainWaiters.clear();
	}

	function waitForOperationDrain(context, timeoutMs = null) {
		if (context.operations.size === 0) return Promise.resolve(true);
		if (timeoutMs === 0) return Promise.resolve(false);
		return new Promise((resolve) => {
			let timer = null;
			const settle = (drained) => {
				if (timer) clearTimeout(timer);
				context.operationDrainWaiters.delete(onDrain);
				resolve(drained);
			};
			const onDrain = () => settle(true);
			context.operationDrainWaiters.add(onDrain);
			if (timeoutMs !== null) {
				timer = setTimeout(() => settle(false), timeoutMs);
			}
		});
	}

	function acquireOperation(
		context,
		authorizationBinding = context?.authorizationBinding,
	) {
		if (!isCurrent(context, authorizationBinding)) return null;
		const controller = new AbortController();
		const operation = {
			context,
			generation: context.generation,
			id: nextOperationId++,
			state: "active",
			controller,
			signal: controller.signal,
		};
		context.operations.set(operation.id, operation);
		return operation;
	}

	function releaseOperation(operation) {
		const context = operation?.context;
		if (
			!context ||
			operation.state !== "active" ||
			context.operations.get(operation.id) !== operation
		) {
			return false;
		}
		operation.state = "released";
		context.operations.delete(operation.id);
		settleOperationDrain(context);
		return true;
	}

	function waitForOperations(context, claim, timeoutMs = null) {
		if (!ownsClose(context, claim)) return Promise.resolve(false);
		if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
			throw new Error("invalid browser operation drain deadline");
		}
		return waitForOperationDrain(context, timeoutMs);
	}

	function hasOperations(context) {
		return Boolean(context?.operations?.size);
	}

	function abortOperations(
		context,
		claim,
		reason = new Error("browser context is closing"),
	) {
		if (!ownsClose(context, claim)) return false;
		let aborted = 0;
		for (const operation of context.operations.values()) {
			if (operation.signal.aborted) continue;
			operation.controller.abort(reason);
			aborted += 1;
		}
		return aborted;
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
			// Aborted work may ignore its signal. Keep replacement admission fenced
			// until every holder confirms it can no longer touch this generation.
			.then(() => waitForOperationDrain(context))
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
		acquireOperation,
		abandon,
		abortOperations,
		claimClose,
		commit,
		detach,
		fenceRelease,
		hasOperations,
		isCurrent,
		ownsClose,
		release,
		releaseOperation,
		settleCloseResponse,
		waitForCloseResponse,
		waitForOperations,
		current(browserSession) {
			return entries.get(browserSession) ?? null;
		},
	};
}
