import { describe, expect, it } from "vitest";

import { sanitizeSessionEventDataForPostgres } from "./events";

describe("sanitizeSessionEventDataForPostgres", () => {
	it("removes NUL bytes from nested event payload strings", () => {
		const value = sanitizeSessionEventDataForPostgres({
			output: "system_u:system_r:pod_t:s0\u0000",
			content: [{ text: "ok\u0000done" }],
			"bad\u0000key": "value",
		});

		expect(value).toEqual({
			output: "system_u:system_r:pod_t:s0",
			content: [{ text: "okdone" }],
			badkey: "value",
		});
	});
});
