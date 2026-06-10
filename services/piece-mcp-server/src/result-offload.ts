/**
 * Result offload for the deterministic /execute path.
 *
 * The orchestrator↔function-router legs ride Dapr service invoke with a
 * 16 MiB body ceiling. When a piece action's serialized result exceeds
 * MAX_INLINE_RESULT_BYTES (default 4 MiB) and the full result has been
 * persisted to the `piece_execution` row, the /execute response replaces
 * `data` with an artifact reference + a small preview. When offload is
 * impossible (no idempotency key / no DB), the data passes through inline
 * and we log loudly past the warn threshold (12 MiB) since the Dapr leg
 * may reject it.
 */

export const DEFAULT_MAX_INLINE_RESULT_BYTES = 4_194_304; // 4 MiB
export const RESULT_PREVIEW_BYTES = 16_384; // 16 KiB preview
export const DEFAULT_INLINE_WARN_BYTES = 12_582_912; // 12 MiB — loud warning

export type OffloadDecision =
	| {
			action: "inline";
			sizeBytes: number;
			/** True when the inline payload exceeds the warn threshold. */
			oversized: boolean;
	  }
	| {
			action: "offload";
			sizeBytes: number;
			/** First RESULT_PREVIEW_BYTES bytes of the serialized JSON. */
			preview: string;
	  };

/** Read MAX_INLINE_RESULT_BYTES from env (falls back to 4 MiB). */
export function getMaxInlineResultBytes(): number {
	const raw = process.env.MAX_INLINE_RESULT_BYTES;
	if (!raw) return DEFAULT_MAX_INLINE_RESULT_BYTES;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0
		? parsed
		: DEFAULT_MAX_INLINE_RESULT_BYTES;
}

/**
 * Decide whether a serialized result should be offloaded.
 *
 * Pure function — env/DB concerns live at the call site.
 */
export function decideResultOffload(
	serialized: string,
	opts: {
		/** True only when the full result is durably stored in piece_execution. */
		canOffload: boolean;
		maxInlineBytes?: number;
		warnBytes?: number;
		previewBytes?: number;
	},
): OffloadDecision {
	const maxInline = opts.maxInlineBytes ?? DEFAULT_MAX_INLINE_RESULT_BYTES;
	const warnAt = opts.warnBytes ?? DEFAULT_INLINE_WARN_BYTES;
	const previewBytes = opts.previewBytes ?? RESULT_PREVIEW_BYTES;
	const sizeBytes = Buffer.byteLength(serialized, "utf8");

	if (sizeBytes > maxInline && opts.canOffload) {
		return {
			action: "offload",
			sizeBytes,
			preview: Buffer.from(serialized, "utf8")
				.subarray(0, previewBytes)
				.toString("utf8"),
		};
	}

	return {
		action: "inline",
		sizeBytes,
		oversized: sizeBytes > warnAt,
	};
}

/** Shape of the `data` replacement returned on offload. */
export function buildArtifactRefData(
	idempotencyKey: string,
	preview: string,
): {
	artifactRef: { kind: "piece_execution"; idempotencyKey: string };
	preview: string;
	truncated: true;
} {
	return {
		artifactRef: { kind: "piece_execution", idempotencyKey },
		preview,
		truncated: true,
	};
}
