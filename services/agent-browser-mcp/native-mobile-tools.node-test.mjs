import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
	DEFAULT_EXPOSED_TOOLS,
	pruneExternalToolDefinition,
	resolveExposedTools,
	sanitizeExternalToolArguments,
} from "./vision-contract.mjs";

async function nativeMobileTools() {
	const launcher = fileURLToPath(
		new URL("./node_modules/agent-browser/bin/agent-browser.js", import.meta.url),
	);
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [launcher, "mcp", "--tools", "mobile"],
		env: {
			...process.env,
			AGENT_BROWSER_SESSION: "wfb-native-mobile-schema-test",
		},
		stderr: "pipe",
	});
	const client = new Client({
		name: "wfb-agent-browser-schema-test",
		version: "1.0.0",
	});
	await client.connect(transport);
	try {
		const tools = [];
		let cursor;
		do {
			const page = await client.listTools(cursor ? { cursor } : {});
			tools.push(...(page.tools ?? []));
			cursor = page.nextCursor;
		} while (cursor);
		return tools;
	} finally {
		await client.close();
	}
}

describe("agent-browser 0.31.2 native mobile tools", () => {
	it("prunes viewport and media schemas to the exact curated arguments", async () => {
		const manifest = JSON.parse(
			await readFile(new URL("./package.json", import.meta.url), "utf8"),
		);
		assert.equal(manifest.dependencies["agent-browser"], "0.31.2");

		const tools = await nativeMobileTools();
		const viewport = tools.find(
			(tool) => tool.name === "agent_browser_set_viewport",
		);
		const media = tools.find((tool) => tool.name === "agent_browser_set_media");
		assert.ok(viewport);
		assert.ok(media);
		assert.ok(viewport.inputSchema.properties.extraArgs);
		assert.ok(viewport.inputSchema.properties.session);
		assert.ok(media.inputSchema.properties.namespace);
		assert.ok(media.inputSchema.properties.restore);

		assert.deepEqual(
			pruneExternalToolDefinition(viewport).inputSchema,
			{
				type: "object",
				properties: {
					height: { type: "integer" },
					scale: { type: "number" },
					width: { type: "integer" },
				},
				required: ["width", "height"],
				additionalProperties: false,
			},
		);
		assert.deepEqual(pruneExternalToolDefinition(media).inputSchema, {
			type: "object",
			properties: {
				colorScheme: {
					enum: ["dark", "light", "no-preference"],
					type: "string",
				},
				reducedMotion: {
					enum: ["reduce", "no-preference"],
					type: "string",
				},
			},
			additionalProperties: false,
		});
	});

	it("rebuilds calls without native session or extra-argument plumbing", () => {
		assert.ok(DEFAULT_EXPOSED_TOOLS.includes("agent_browser_set_viewport"));
		assert.ok(DEFAULT_EXPOSED_TOOLS.includes("agent_browser_set_media"));
		assert.equal(DEFAULT_EXPOSED_TOOLS.length, 23);
		assert.deepEqual(
			resolveExposedTools(
				"agent_browser_set_viewport,agent_browser_set_device,agent_browser_set_media",
			),
			["agent_browser_set_viewport", "agent_browser_set_media"],
		);
		assert.deepEqual(
			sanitizeExternalToolArguments("agent_browser_set_viewport", {
				width: 1440,
				height: 900,
				scale: 1,
				timeoutMs: 1,
				session: "attacker-session",
				namespace: "attacker-namespace",
				restore: "attacker-state",
				extraArgs: ["--remote-debugging-port=1"],
			}),
			{ width: 1440, height: 900, scale: 1 },
		);
		assert.deepEqual(
			sanitizeExternalToolArguments("agent_browser_set_media", {
				colorScheme: "dark",
				reducedMotion: "reduce",
				timeoutMs: 1,
				session: "attacker-session",
				namespace: "attacker-namespace",
				restoreSave: "always",
				extraArgs: ["--proxy-server=attacker.invalid"],
			}),
			{ colorScheme: "dark", reducedMotion: "reduce" },
		);
	});

	it("enables the mobile profile in both bridge and image defaults", async () => {
		const [bridge, dockerfile] = await Promise.all([
			readFile(new URL("./bridge.mjs", import.meta.url), "utf8"),
			readFile(new URL("./Dockerfile", import.meta.url), "utf8"),
		]);
		assert.match(
			bridge,
			/process\.env\.AGENT_BROWSER_TOOLS \|\| "core,network,debug,state,mobile"/,
		);
		assert.match(
			dockerfile,
			/AGENT_BROWSER_TOOLS=core,network,debug,state,mobile/,
		);
	});
});
