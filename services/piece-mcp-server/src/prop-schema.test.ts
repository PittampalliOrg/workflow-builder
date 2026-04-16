import { describe, expect, it } from "vitest";

import { apPropToJsonSchema } from "./prop-schema";

describe("apPropToJsonSchema", () => {
	it("exposes Activepieces FILE props as MCP file objects", () => {
		expect(
			apPropToJsonSchema({
				type: "FILE",
				displayName: "File",
				description: "Upload file content.",
				required: true,
			}),
		).toMatchObject({
			type: "object",
			title: "File",
			properties: {
				base64: { type: "string" },
				data: { type: "string" },
				extension: { type: "string" },
			},
			additionalProperties: true,
		});
	});
});
