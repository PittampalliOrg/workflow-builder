export type StrictCheckpointPromotionProgress =
	| 'submitting'
	| 'confirming'
	| 'complete';

export type StrictCheckpointPromotionReceipt = Readonly<{
	artifactId: string;
	receiptId: string;
	prUrl: string;
	repository: string;
	pullRequestNumber: number;
	branch: string;
}>;

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Sleeper = (milliseconds: number) => Promise<void>;

export type StrictCheckpointPromotionOptions = Readonly<{
	fetcher?: Fetcher;
	sleep?: Sleeper;
	now?: () => number;
	timeoutMs?: number;
	pollIntervalMs?: number;
	replayAfterMs?: number;
	onProgress?: (progress: StrictCheckpointPromotionProgress) => void;
}>;

type SubmitOutcome =
	| Readonly<{ kind: 'confirmed'; receipt: StrictCheckpointPromotionReceipt }>
	| Readonly<{ kind: 'ambiguous' }>
	| Readonly<{ kind: 'failed'; error: Error }>;

type ObserveOutcome =
	| Readonly<{ kind: 'confirmed'; receipt: StrictCheckpointPromotionReceipt }>
	| Readonly<{ kind: 'absent' }>
	| Readonly<{ kind: 'failed'; error: Error }>;

type HttpOutcome =
	| Readonly<{ kind: 'response'; response: Response; body: unknown }>
	| Readonly<{ kind: 'transport' }>;

const DEFAULT_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_REPLAY_AFTER_MS = 5_000;
const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);

async function wait(milliseconds: number): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function report(
	callback: StrictCheckpointPromotionOptions['onProgress'],
	progress: StrictCheckpointPromotionProgress
): void {
	try {
		callback?.(progress);
	} catch {
		// UI observers cannot change the promotion outcome.
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function message(value: unknown, fallback: string): string {
	const body = asRecord(value);
	for (const key of ['error', 'message', 'prError', 'skipped']) {
		if (typeof body?.[key] === 'string' && body[key].trim()) return body[key].trim();
	}
	return fallback;
}

function pullRequestIdentity(value: unknown): Readonly<{
	prUrl: string;
	repository: string;
	number: number;
}> | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	try {
		const url = new URL(value);
		const segments = url.pathname.split('/').filter(Boolean);
		if (
			url.protocol !== 'https:' ||
			url.hostname !== 'github.com' ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			segments.length !== 4 ||
			segments[2] !== 'pull' ||
			!/^[A-Za-z0-9_.-]+$/.test(segments[0]) ||
			!/^[A-Za-z0-9_.-]+$/.test(segments[1]) ||
			!/^[1-9][0-9]*$/.test(segments[3])
		) {
			return null;
		}
		const number = Number(segments[3]);
		if (!Number.isSafeInteger(number)) return null;
		const repository = `${segments[0]}/${segments[1]}`;
		return {
			prUrl: `https://github.com/${repository}/pull/${number}`,
			repository,
			number
		};
	} catch {
		return null;
	}
}

function validReceiptId(value: unknown): value is string {
	return typeof value === 'string' && RECEIPT_ID.test(value);
}

function validBranch(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		BRANCH.test(value) &&
		!value.includes('..') &&
		!value.includes('@{') &&
		!value.endsWith('.') &&
		!value.endsWith('.lock')
	);
}

function immediateReceipt(
	value: unknown,
	artifactId: string
): StrictCheckpointPromotionReceipt | null {
	const body = asRecord(value);
	const pullRequest = asRecord(body?.pullRequest);
	const identity = pullRequestIdentity(body?.prUrl);
	if (
		body?.action !== 'promote' ||
		body.ok !== true ||
		body.draft !== true ||
		body.artifactId !== artifactId ||
		!validReceiptId(body.receiptId) ||
		!validBranch(body.branch) ||
		!identity ||
		pullRequest?.repository !== identity.repository ||
		pullRequest.number !== identity.number
	) {
		return null;
	}
	return {
		artifactId,
		receiptId: body.receiptId,
		prUrl: identity.prUrl,
		repository: identity.repository,
		pullRequestNumber: identity.number,
		branch: body.branch
	};
}

export function strictCheckpointPromotionReceiptFromVersion(
	value: unknown,
	artifactId: string
): StrictCheckpointPromotionReceipt | null {
	const version = asRecord(value);
	const payload = asRecord(version?.payload);
	const promotion = asRecord(version?.promotion);
	const identity = pullRequestIdentity(promotion?.prUrl);
	if (
		version?.artifactId !== artifactId ||
		payload?.tier !== 'tar-overlay-set' ||
		(payload.captureProtocol !== 'atomic-generation-v2' &&
			payload.acceptanceEligible !== true) ||
		!validReceiptId(promotion?.receiptId) ||
		!validBranch(promotion?.branch) ||
		!identity ||
		promotion.repository !== identity.repository ||
		promotion.pullRequestNumber !== identity.number ||
		typeof promotion.baseSha !== 'string' ||
		!FULL_SHA.test(promotion.baseSha) ||
		typeof promotion.headSha !== 'string' ||
		!FULL_SHA.test(promotion.headSha) ||
		promotion.baseSha === promotion.headSha ||
		promotion.commitSha !== promotion.headSha
	) {
		return null;
	}
	return {
		artifactId,
		receiptId: promotion.receiptId,
		prUrl: identity.prUrl,
		repository: identity.repository,
		pullRequestNumber: identity.number,
		branch: promotion.branch
	};
}

async function responseJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

async function requestJson(
	fetcher: Fetcher,
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	timeoutMs: number
): Promise<HttpOutcome> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
	try {
		const response = await fetcher(input, { ...init, signal: controller.signal });
		return { kind: 'response', response, body: await responseJson(response) };
	} catch {
		return { kind: 'transport' };
	} finally {
		clearTimeout(timeout);
	}
}

async function submit(
	fetcher: Fetcher,
	executionId: string,
	artifactId: string,
	title: string | null,
	timeoutMs: number
): Promise<SubmitOutcome> {
	const request = await requestJson(
		fetcher,
		`/api/dev-environments/${encodeURIComponent(executionId)}/preview-continuation`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'promote',
				artifactId,
				...(title ? { title } : {}),
				draft: true
			})
		},
		timeoutMs
	);
	if (request.kind === 'transport') return { kind: 'ambiguous' };
	const { response, body } = request;
	if (response.ok) {
		const receipt = immediateReceipt(body, artifactId);
		return receipt ? { kind: 'confirmed', receipt } : { kind: 'ambiguous' };
	}
	if (RETRYABLE_STATUS.has(response.status)) return { kind: 'ambiguous' };
	return {
		kind: 'failed',
		error: new Error(message(body, `Promotion failed (${response.status})`))
	};
}

async function observe(
	fetcher: Fetcher,
	executionId: string,
	artifactId: string,
	timeoutMs: number
): Promise<ObserveOutcome> {
	const request = await requestJson(
		fetcher,
		`/api/workflows/executions/${encodeURIComponent(executionId)}/versions`,
		undefined,
		timeoutMs
	);
	if (request.kind === 'transport') return { kind: 'absent' };
	const { response, body } = request;
	if (!response.ok) {
		if (RETRYABLE_STATUS.has(response.status)) return { kind: 'absent' };
		return {
			kind: 'failed',
			error: new Error(message(body, `Checkpoint history request failed (${response.status})`))
		};
	}
	const record = asRecord(body);
	if (!Array.isArray(record?.versions)) return { kind: 'absent' };
	const version = record.versions.find(
		(item) => asRecord(item)?.artifactId === artifactId
	);
	const receipt = strictCheckpointPromotionReceiptFromVersion(version, artifactId);
	return receipt ? { kind: 'confirmed', receipt } : { kind: 'absent' };
}

function timeoutError(): Error {
	return new Error(
		'GitHub handoff could not yet be confirmed. Refresh checkpoint history or retry; this promotion is safe to repeat.'
	);
}

/**
 * Submits a strict preview checkpoint and reconciles an ambiguous HTTP outcome
 * against the artifact-specific durable read model. One exact replay repairs the
 * narrow window between the physical receipt and its preview-local projection.
 */
export async function promoteStrictCheckpointUntilConfirmed(
	executionId: string,
	artifactId: string,
	title: string | null,
	options: StrictCheckpointPromotionOptions = {}
): Promise<StrictCheckpointPromotionReceipt> {
	const fetcher = options.fetcher ?? fetch;
	const sleep = options.sleep ?? wait;
	const now = options.now ?? Date.now;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const replayAfterMs = options.replayAfterMs ?? DEFAULT_REPLAY_AFTER_MS;
	if (!executionId.trim() || !artifactId.trim()) throw new Error('Promotion identity is required');
	for (const [name, value] of [
		['timeout', timeoutMs],
		['poll interval', pollIntervalMs],
		['replay delay', replayAfterMs]
	] as const) {
		if (!Number.isFinite(value) || value <= 0) {
			throw new Error(`Promotion ${name} must be greater than zero`);
		}
	}

	const startedAt = now();
	const deadline = startedAt + timeoutMs;
	report(options.onProgress, 'submitting');
	const initial = await submit(
		fetcher,
		executionId,
		artifactId,
		title?.trim() || null,
		deadline - now()
	);
	if (initial.kind === 'confirmed') {
		report(options.onProgress, 'complete');
		return initial.receipt;
	}
	if (initial.kind === 'failed') throw initial.error;

	report(options.onProgress, 'confirming');
	let replayed = false;
	while (now() < deadline) {
		const observed = await observe(fetcher, executionId, artifactId, deadline - now());
		if (observed.kind === 'confirmed') {
			report(options.onProgress, 'complete');
			return observed.receipt;
		}
		if (observed.kind === 'failed') throw observed.error;

		if (!replayed && now() - startedAt >= replayAfterMs) {
			replayed = true;
			const replay = await submit(
				fetcher,
				executionId,
				artifactId,
				title?.trim() || null,
				deadline - now()
			);
			if (replay.kind === 'confirmed') {
				report(options.onProgress, 'complete');
				return replay.receipt;
			}
			if (replay.kind === 'failed') throw replay.error;
		}

		const waitMs = Math.min(pollIntervalMs, deadline - now());
		if (waitMs <= 0) break;
		await sleep(waitMs);
	}
	throw timeoutError();
}
