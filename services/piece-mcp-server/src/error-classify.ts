/**
 * Error classification for the deterministic /execute path.
 *
 * The SW 1.0 orchestrator only retries failures the piece-runtime marks
 * `errorClass: "retryable"` (its AP_RETRY_POLICY raises on retryable and
 * returns failure for permanent). Classification contract
 * (docs/activepieces-integration-architecture.md §2.4):
 *
 *   - HTTP errors carrying a response status (@activepieces/pieces-common
 *     HttpError exposes `get response(): { status, body }`; axios errors
 *     expose `response.status`) → 429 / >=500 retryable, other 4xx permanent.
 *   - Network/transport errors (ECONNREFUSED, ETIMEDOUT, ENOTFOUND, aborts,
 *     undici `fetch failed`, …) → retryable.
 *   - Validation / missing-auth / anything unclassifiable → permanent
 *     (conservative: never retry an unknown side effect).
 */

export type ErrorClass = "retryable" | "permanent";

const NETWORK_ERROR_CODES = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ETIMEDOUT",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EPIPE",
	"ECONNABORTED",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_SOCKET",
]);

const NETWORK_MESSAGE_RE =
	/\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|aborted|abort(ed)? signal|network ?error)\b/i;

/**
 * Extract an HTTP status from HttpError / axios / fetch-Response-like
 * error shapes. Returns undefined when no numeric status is present.
 */
export function extractHttpStatus(error: unknown): number | undefined {
	if (!error || typeof error !== "object") return undefined;
	const e = error as Record<string, unknown>;

	// @activepieces/pieces-common HttpError (getter) and axios AxiosError both
	// expose `response.status`.
	const response = e.response;
	if (response && typeof response === "object") {
		const status = (response as Record<string, unknown>).status;
		if (typeof status === "number" && Number.isFinite(status)) return status;
	}

	for (const key of ["status", "statusCode"] as const) {
		const value = e[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}

	return undefined;
}

/** True for fetch/socket/DNS/timeout/abort transport failures. */
export function isNetworkError(error: unknown, depth = 0): boolean {
	if (!error || typeof error !== "object" || depth > 4) return false;
	const e = error as {
		name?: unknown;
		message?: unknown;
		code?: unknown;
		cause?: unknown;
	};

	if (typeof e.code === "string" && NETWORK_ERROR_CODES.has(e.code)) {
		return true;
	}
	if (e.name === "AbortError" || e.name === "TimeoutError") return true;
	if (typeof e.message === "string" && NETWORK_MESSAGE_RE.test(e.message)) {
		return true;
	}
	// undici wraps the real cause (`TypeError: fetch failed` → cause.code).
	if (e.cause) return isNetworkError(e.cause, depth + 1);
	return false;
}

/**
 * Classify a piece-action execution error.
 *
 * Pure function — safe to unit test without a DB or network.
 */
export function classifyExecutionError(error: unknown): ErrorClass {
	const status = extractHttpStatus(error);
	if (status !== undefined) {
		return status === 429 || status >= 500 ? "retryable" : "permanent";
	}
	if (isNetworkError(error)) return "retryable";
	// Unknown/unclassifiable (validation errors, piece bugs, missing auth):
	// conservative — the orchestrator must not replay an unknown side effect.
	return "permanent";
}
