import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_EXPOSED_TOOLS,
	inlineImage,
	preserveMultimodalToolResult,
} from "./vision-contract.mjs";

describe("agent-browser vision contract", () => {
	it("exposes raw screenshots without visual-description surrogate tools", () => {
		assert.ok(DEFAULT_EXPOSED_TOOLS.includes("agent_browser_screenshot"));
		assert.ok(DEFAULT_EXPOSED_TOOLS.includes("agent_browser_snapshot"));
		assert.ok(DEFAULT_EXPOSED_TOOLS.includes("agent_browser_get_text"));
		assert.equal(
			DEFAULT_EXPOSED_TOOLS.some((name) =>
				/(?:ocr|describe|caption|visual_analysis|image_analysis)/i.test(name),
			),
			false,
		);
	});

	it("keeps screenshot bytes in a structured MCP image block", () => {
		const result = {
			content: [
				{ type: "text", text: "Screenshot captured" },
				{ type: "image", data: "iVBORw0KGgoAAA", mimeType: "image/png" },
			],
		};

		assert.strictEqual(preserveMultimodalToolResult(result), result);
		assert.deepEqual(inlineImage(result), {
			data: "iVBORw0KGgoAAA",
			mime: "image/png",
		});
		assert.equal(typeof result.content[1], "object");
	});

	it("does not mistake textual screenshot metadata for pixels", () => {
		assert.equal(
			inlineImage({ content: [{ type: "text", text: '{"path":"screenshot.png"}' }] }),
			null,
		);
	});
});
