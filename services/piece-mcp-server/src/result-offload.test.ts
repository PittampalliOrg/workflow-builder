import { afterEach, describe, expect, it } from "vitest";
import {
	buildArtifactRefData,
	decideResultOffload,
	DEFAULT_INLINE_WARN_BYTES,
	DEFAULT_MAX_INLINE_RESULT_BYTES,
	getMaxInlineResultBytes,
	RESULT_PREVIEW_BYTES,
} from "./result-offload.js";

afterEach(() => {
	delete process.env.MAX_INLINE_RESULT_BYTES;
});

describe("decideResultOffload", () => {
	it("keeps small results inline", () => {
		const decision = decideResultOffload(JSON.stringify({ ok: true }), {
			canOffload: true,
		});
		expect(decision.action).toBe("inline");
		if (decision.action === "inline") {
			expect(decision.oversized).toBe(false);
		}
	});

	it("keeps results inline exactly at the threshold (strictly-greater offloads)", () => {
		const serialized = "x".repeat(1024);
		const at = decideResultOffload(serialized, {
			canOffload: true,
			maxInlineBytes: 1024,
		});
		expect(at.action).toBe("inline");
		const over = decideResultOffload(`${serialized}y`, {
			canOffload: true,
			maxInlineBytes: 1024,
		});
		expect(over.action).toBe("offload");
	});

	it("offloads oversized results when a durable row backs them", () => {
		const serialized = "a".repeat(DEFAULT_MAX_INLINE_RESULT_BYTES + 1);
		const decision = decideResultOffload(serialized, { canOffload: true });
		expect(decision.action).toBe("offload");
		if (decision.action === "offload") {
			expect(decision.sizeBytes).toBe(DEFAULT_MAX_INLINE_RESULT_BYTES + 1);
			expect(decision.preview).toHaveLength(RESULT_PREVIEW_BYTES);
			expect(decision.preview).toBe("a".repeat(RESULT_PREVIEW_BYTES));
		}
	});

	it("never offloads when no durable row exists (canOffload=false)", () => {
		const serialized = "a".repeat(DEFAULT_MAX_INLINE_RESULT_BYTES + 1);
		const decision = decideResultOffload(serialized, { canOffload: false });
		expect(decision.action).toBe("inline");
		if (decision.action === "inline") {
			// 4 MiB < 12 MiB: big but below the loud-warning threshold
			expect(decision.oversized).toBe(false);
		}
	});

	it("flags inline payloads past the 12 MiB warn threshold", () => {
		const serialized = "a".repeat(DEFAULT_INLINE_WARN_BYTES + 1);
		const decision = decideResultOffload(serialized, { canOffload: false });
		expect(decision.action).toBe("inline");
		if (decision.action === "inline") {
			expect(decision.oversized).toBe(true);
		}
	});

	it("measures size in bytes, not characters", () => {
		// '€' is 3 bytes in UTF-8 — 400 chars ⇒ 1200 bytes
		const serialized = "€".repeat(400);
		const decision = decideResultOffload(serialized, {
			canOffload: true,
			maxInlineBytes: 1100,
		});
		expect(decision.action).toBe("offload");
		if (decision.action === "offload") {
			expect(decision.sizeBytes).toBe(1200);
		}
	});

	it("respects a custom previewBytes", () => {
		const serialized = "b".repeat(2048);
		const decision = decideResultOffload(serialized, {
			canOffload: true,
			maxInlineBytes: 1024,
			previewBytes: 100,
		});
		expect(decision.action).toBe("offload");
		if (decision.action === "offload") {
			expect(decision.preview).toBe("b".repeat(100));
		}
	});
});

describe("getMaxInlineResultBytes", () => {
	it("defaults to 4 MiB", () => {
		expect(getMaxInlineResultBytes()).toBe(4_194_304);
	});

	it("honors MAX_INLINE_RESULT_BYTES", () => {
		process.env.MAX_INLINE_RESULT_BYTES = "1048576";
		expect(getMaxInlineResultBytes()).toBe(1_048_576);
	});

	it("falls back on garbage values", () => {
		process.env.MAX_INLINE_RESULT_BYTES = "not-a-number";
		expect(getMaxInlineResultBytes()).toBe(DEFAULT_MAX_INLINE_RESULT_BYTES);
		process.env.MAX_INLINE_RESULT_BYTES = "-5";
		expect(getMaxInlineResultBytes()).toBe(DEFAULT_MAX_INLINE_RESULT_BYTES);
	});
});

describe("buildArtifactRefData", () => {
	it("builds the documented artifactRef envelope", () => {
		const data = buildArtifactRefData("wf:exec:task", "preview…");
		expect(data).toEqual({
			artifactRef: { kind: "piece_execution", idempotencyKey: "wf:exec:task" },
			preview: "preview…",
			truncated: true,
		});
	});
});
