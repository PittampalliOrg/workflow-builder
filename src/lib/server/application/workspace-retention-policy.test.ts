import { describe, expect, it } from "vitest";
import {
	MAX_WORKSPACE_RETENTION_TTL_SECONDS,
	retainedWorkspaceTtlSeconds,
} from "./workspace-retention-policy";

describe("retainedWorkspaceTtlSeconds", () => {
	it("keeps the existing one-hour post-timeout buffer", () => {
		expect(retainedWorkspaceTtlSeconds(7_200)).toBe(10_800);
	});

	it("keeps the minimum for short runs", () => {
		expect(retainedWorkspaceTtlSeconds(60)).toBe(7_200);
	});

	it("caps 24-hour runs at the provider maximum", () => {
		expect(retainedWorkspaceTtlSeconds(24 * 60 * 60)).toBe(
			MAX_WORKSPACE_RETENTION_TTL_SECONDS,
		);
	});
});
