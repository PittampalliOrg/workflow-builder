import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_EXPOSED_TOOLS,
	inlineImage,
	isExternallyCallableTool,
	preserveMultimodalToolResult,
	pruneExternalToolDefinition,
	resolveExposedTools,
	sanitizeAllowlistedArguments,
	sanitizeExternalToolArguments,
} from "./vision-contract.mjs";

describe("agent-browser vision contract", () => {
	it("exposes raw screenshots without visual-description surrogate tools", () => {
		assert.ok(DEFAULT_EXPOSED_TOOLS.includes("agent_browser_screenshot"));
		assert.ok(DEFAULT_EXPOSED_TOOLS.includes("agent_browser_snapshot"));
		assert.ok(DEFAULT_EXPOSED_TOOLS.includes("agent_browser_get_text"));
		assert.ok(DEFAULT_EXPOSED_TOOLS.includes("agent_browser_console"));
		assert.ok(DEFAULT_EXPOSED_TOOLS.includes("agent_browser_errors"));
		assert.equal(
			DEFAULT_EXPOSED_TOOLS.some((name) =>
				/(?:ocr|describe|caption|visual_analysis|image_analysis)/i.test(name),
			),
			false,
		);
	});

	it("enforces the curated call surface while keeping state tools internal", () => {
		const exposed = resolveExposedTools(
			"agent_browser_open,agent_browser_screenshot,agent_browser_cookies_get,agent_browser_cookies_set",
		);
		assert.deepEqual(exposed, [
			"agent_browser_open",
			"agent_browser_screenshot",
		]);
		assert.equal(isExternallyCallableTool("agent_browser_open", exposed), true);
		assert.equal(
			isExternallyCallableTool("agent_browser_cookies_get", exposed),
			false,
		);
		assert.equal(
			isExternallyCallableTool("agent_browser_cookies_set", exposed),
			false,
		);
		assert.equal(
			isExternallyCallableTool("demo_scene", exposed, ["demo_scene"]),
			true,
		);
		assert.deepEqual(resolveExposedTools(""), [...DEFAULT_EXPOSED_TOOLS]);
	});

	it("rebuilds call arguments without hidden lane or credential overrides", () => {
		assert.deepEqual(
			sanitizeExternalToolArguments("agent_browser_open", {
				url: "https://example.test",
				session: "attacker-session",
				namespace: "attacker-namespace",
				restore: "attacker-state",
				headers: { Authorization: "Bearer stolen" },
				extraArgs: ["--remote-debugging-port=1"],
			}),
			{ url: "https://example.test" },
		);
		assert.deepEqual(
			sanitizeExternalToolArguments("agent_browser_fill", {
				selector: "e53",
				text: "kimi/kimi-k3",
				value: "must-not-replace-child-contract",
				session: "other-lane",
			}),
			{ selector: "e53", text: "kimi/kimi-k3" },
		);
		assert.deepEqual(
			sanitizeExternalToolArguments("agent_browser_screenshot", {
				fullPage: true,
				format: "png",
				path: "/etc/cron.d/attacker",
				session: "other-lane",
			}),
			{ fullPage: true, format: "png" },
		);
		assert.deepEqual(
			sanitizeAllowlistedArguments(
				{ title: "Scene", caption: "Safe", session: "other-lane" },
				["title", "caption", "focus"],
			),
			{ title: "Scene", caption: "Safe" },
		);
	});

	it("keeps tools/list and tools/call on the same per-tool schema", () => {
		const pruned = pruneExternalToolDefinition({
			name: "agent_browser_open",
			inputSchema: {
				type: "object",
				properties: {
					url: { type: "string" },
					session: { type: "string" },
					headers: { type: "object" },
				},
				required: ["url", "session"],
			},
		});
		assert.deepEqual(pruned.inputSchema, {
			type: "object",
			properties: { url: { type: "string" } },
			required: ["url"],
			additionalProperties: false,
		});

		const fill = pruneExternalToolDefinition({
			name: "agent_browser_fill",
			inputSchema: {
				type: "object",
				properties: {
					selector: { type: "string" },
					text: { type: "string" },
					session: { type: "string" },
				},
				required: ["selector", "text", "session"],
			},
		});
		assert.deepEqual(fill.inputSchema, {
			type: "object",
			properties: {
				selector: { type: "string" },
				text: { type: "string" },
			},
			required: ["selector", "text"],
			additionalProperties: false,
		});
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
			inlineImage({
				content: [{ type: "text", text: '{"path":"screenshot.png"}' }],
			}),
			null,
		);
	});
});
