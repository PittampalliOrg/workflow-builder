import { describe, expect, it } from "vitest";
import {
	effectivePreviewStatus,
	expiresIn,
	phaseTone,
	relativeTime,
	sleepDisabledReason,
} from "$lib/components/dev/preview-lifecycle";

const NOW = Date.parse("2026-07-05T12:00:00Z");

describe("relativeTime", () => {
	it("buckets a past timestamp", () => {
		expect(relativeTime("2026-07-05T11:59:30Z", NOW)).toBe("just now");
		expect(relativeTime("2026-07-05T11:30:00Z", NOW)).toBe("30m ago");
		expect(relativeTime("2026-07-05T09:00:00Z", NOW)).toBe("3h ago");
		expect(relativeTime(null, NOW)).toBeNull();
		expect(relativeTime("not-a-date", NOW)).toBeNull();
	});
});

describe("expiresIn", () => {
	it("is urgent under an hour and flags expiry", () => {
		expect(expiresIn("2026-07-05T12:45:00Z", NOW)).toEqual({
			label: "expires in 45m",
			urgent: true,
			expired: false,
		});
		expect(expiresIn("2026-07-05T15:00:00Z", NOW)).toEqual({
			label: "expires in 3h",
			urgent: false,
			expired: false,
		});
		expect(expiresIn("2026-07-07T12:00:00Z", NOW)).toEqual({
			label: "expires in 2d",
			urgent: false,
			expired: false,
		});
		expect(expiresIn("2026-07-05T11:00:00Z", NOW)).toEqual({
			label: "expired",
			urgent: true,
			expired: true,
		});
		expect(expiresIn(null, NOW)).toBeNull();
	});
});

describe("effectivePreviewStatus / phaseTone", () => {
	it("slept overrides a ready phase", () => {
		expect(effectivePreviewStatus({ phase: "ready", state: "slept" })).toBe("slept");
		expect(effectivePreviewStatus({ phase: "ready", state: "hot" })).toBe("ready");
		expect(phaseTone({ phase: "ready", state: "slept" })).toBe("warning");
		expect(phaseTone({ phase: "ready", state: "hot" })).toBe("success");
		expect(phaseTone({ phase: "provisioning", state: null })).toBe("pending");
	});
});

describe("sleepDisabledReason", () => {
	it("mirrors the SEA sleep-refusal contract", () => {
		expect(sleepDisabledReason({ state: "hot", protected: false, pool: null, origin: "user" })).toBeNull();
		expect(sleepDisabledReason({ state: "slept" })).toBe("Already sleeping");
		expect(sleepDisabledReason({ protected: true })).toContain("Protected");
		expect(sleepDisabledReason({ pool: "pool-1" })).toContain("warm-pool");
		expect(sleepDisabledReason({ origin: "pr" })).toContain("PR");
	});
});
