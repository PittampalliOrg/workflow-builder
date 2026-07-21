import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const raiseSessionEventMock = vi.fn();
const getSessionMock = vi.fn();
const resolveSessionAgentMock = vi.fn();
const resolveAgentConfigMcpForProjectMock = vi.fn();
const getStructuredOutputCapabilityMock = vi.fn();

vi.mock("./control", () => ({
	raiseSessionEvent: (...args: unknown[]) => raiseSessionEventMock(...args),
}));

vi.mock("$lib/server/agents/mcp-resolution-application", () => ({
	resolveAgentConfigMcpForProject: (...args: unknown[]) =>
		resolveAgentConfigMcpForProjectMock(...args),
}));

import {
	SESSION_AGENT_CONFIG_PATCH_EVENT,
	normalizeSessionAgentConfigPatch,
	raiseSessionAgentConfigPatch,
} from "./agent-config-patch";

describe("session agent config patch", () => {
	beforeEach(() => {
		raiseSessionEventMock.mockReset();
		getSessionMock.mockReset();
		resolveSessionAgentMock.mockReset();
		resolveAgentConfigMcpForProjectMock.mockReset();
		getStructuredOutputCapabilityMock.mockReset();
	});

	it("canonicalizes model aliases and mirrors builtin tool changes", () => {
		const result = normalizeSessionAgentConfigPatch({
			modelSpec: "claude-haiku-4-5",
			builtinTools: ["read_file", "write_file"],
		});

		expect(result).toEqual({
			ok: true,
			patch: {
				modelSpec: "anthropic/claude-haiku-4-5-20251001",
				builtinTools: ["read_file", "write_file"],
				tools: ["read_file", "write_file"],
				allowedTools: ["read_file", "write_file"],
			},
		});
	});

	it("mirrors an explicit empty tools patch into the runtime ceiling", () => {
		expect(normalizeSessionAgentConfigPatch({ tools: [] })).toEqual({
			ok: true,
			patch: { tools: [], allowedTools: [] },
		});
	});

	it("rejects model specs without a Dapr runtime component", () => {
		const result = normalizeSessionAgentConfigPatch({
			modelSpec: "openai/gpt-5-mini",
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected unsupported model to fail");
		expect(result.status).toBe(400);
	});

	it("canonicalizes NVIDIA model aliases", () => {
		const result = normalizeSessionAgentConfigPatch({
			modelSpec: "meta/llama-3.1-8b-instruct",
		});

		expect(result).toEqual({
			ok: true,
			patch: { modelSpec: "nvidia/meta/llama-3.1-8b-instruct" },
		});
	});

	it("accepts structured output as one atomic tool-and-schema patch", () => {
		const responseJsonSchema = {
			type: "object",
			properties: { answer: { type: "string" } },
			required: ["answer"],
		};

		expect(
			normalizeSessionAgentConfigPatch({
				structuredOutputMode: "tool",
				responseJsonSchema,
			}),
		).toEqual({
			ok: true,
			patch: { structuredOutputMode: "tool", responseJsonSchema },
		});
	});

	it.each([
		{
			name: "mode without schema",
			patch: { structuredOutputMode: "tool" },
			error: "must be provided together",
		},
		{
			name: "schema without mode",
			patch: { responseJsonSchema: { type: "object" } },
			error: "must be provided together",
		},
		{
			name: "unsupported mode",
			patch: {
				structuredOutputMode: "native",
				responseJsonSchema: { type: "object" },
			},
			error: "structuredOutputMode must be tool",
		},
		{
			name: "array value",
			patch: { structuredOutputMode: "tool", responseJsonSchema: [] },
			error: "responseJsonSchema must be a non-empty object",
		},
		{
			name: "empty schema",
			patch: { structuredOutputMode: "tool", responseJsonSchema: {} },
			error: "responseJsonSchema must be a non-empty object",
		},
		{
			name: "invalid Draft 2020-12 schema",
			patch: {
				structuredOutputMode: "tool",
				responseJsonSchema: {
					type: "object",
					properties: { answer: { type: "not-a-json-schema-type" } },
				},
			},
			error: "not valid Draft 2020-12",
		},
		{
			name: "non-object root",
			patch: {
				structuredOutputMode: "tool",
				responseJsonSchema: { type: "array", items: { type: "string" } },
			},
			error: "object-shaped schema",
		},
	])("rejects invalid structured output enablement: $name", ({ patch, error }) => {
		const result = normalizeSessionAgentConfigPatch(patch);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected structured output patch to fail");
		expect(result.status).toBe(400);
		expect(result.error).toContain(error);
	});

	it.each([
		{
			name: "partial mode clear",
			patch: {
				structuredOutputMode: null,
				responseJsonSchema: { type: "object" },
			},
		},
		{
			name: "partial schema clear",
			patch: { structuredOutputMode: "tool", responseJsonSchema: null },
		},
	])("rejects partial structured output clearing: $name", ({ patch }) => {
		const result = normalizeSessionAgentConfigPatch(patch);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected structured output clear to fail");
		expect(result.error).toContain("must be cleared together");
	});

	it("accepts one atomic paired clear", () => {
		expect(
			normalizeSessionAgentConfigPatch({
				structuredOutputMode: null,
				responseJsonSchema: null,
			}),
		).toEqual({
			ok: true,
			patch: {
				structuredOutputMode: null,
				responseJsonSchema: null,
			},
		});
	});

	it("accepts an object schema reached through a local Draft 2020-12 ref", () => {
		const schema = {
			$ref: "#/$defs/result",
			$defs: {
				result: {
					type: "object",
					properties: { answer: { type: "string" } },
				},
			},
		};
		expect(
			normalizeSessionAgentConfigPatch({
				structuredOutputMode: "tool",
				responseJsonSchema: schema,
			}),
		).toEqual({
			ok: true,
			patch: { structuredOutputMode: "tool", responseJsonSchema: schema },
		});
	});

	it("keeps direct session-registry access outside the patch helper", () => {
		const source = readFileSync(
			new URL("./agent-config-patch.ts", import.meta.url),
			"utf8",
		);

		expect(source).not.toContain("$lib/server/sessions/registry");
		expect(source).not.toContain("$lib/server/agents/registry");
		expect(source).toContain("workflowData.getSessionDetail");
		expect(source).toContain("workflowData.resolveSessionAgent");
	});

	it("raises one canonical config patch event", async () => {
		raiseSessionEventMock.mockResolvedValueOnce({ ok: true, status: 200 });

		const result = await raiseSessionAgentConfigPatchForTest("s1", {
			modelSpec: "openai/o3",
		});

		expect(result.ok).toBe(true);
		expect(raiseSessionEventMock).toHaveBeenCalledWith(
			"s1",
			SESSION_AGENT_CONFIG_PATCH_EVENT,
			{
				patch: { modelSpec: "openai/o3" },
				applies: "next_turn",
			},
		);
	});

	it("checks the resolved session runtime before enabling structured output", async () => {
		getSessionMock.mockResolvedValueOnce({
			id: "s1",
			agentId: "a1",
			agentVersion: 3,
		});
		resolveSessionAgentMock.mockResolvedValueOnce({
			config: { runtime: "claude-code-cli" },
			runtime: "claude-code-cli",
			projectId: "project-1",
		});
		getStructuredOutputCapabilityMock.mockResolvedValueOnce(null);

		const result = await raiseSessionAgentConfigPatchForTest("s1", {
			structuredOutputMode: "tool",
			responseJsonSchema: {
				type: "object",
				properties: { answer: { type: "string" } },
			},
		});

		expect(result).toMatchObject({ ok: false, status: 400 });
		expect(result.error).toContain('Runtime "claude-code-cli"');
		expect(raiseSessionEventMock).not.toHaveBeenCalled();
	});

	it("emits structured output after the resolved runtime capability passes", async () => {
		getSessionMock.mockResolvedValueOnce({
			id: "s1",
			agentId: "a1",
			agentVersion: 3,
		});
		resolveSessionAgentMock.mockResolvedValueOnce({
			config: { runtime: "pydantic-ai-agent-py" },
			runtime: "pydantic-ai-agent-py",
			projectId: "project-1",
		});
		getStructuredOutputCapabilityMock.mockResolvedValueOnce({
			mode: "tool",
			jsonSchemaDraft: "2020-12",
		});
		raiseSessionEventMock.mockResolvedValueOnce({ ok: true, status: 200 });

		const result = await raiseSessionAgentConfigPatchForTest("s1", {
			structuredOutputMode: "tool",
			responseJsonSchema: {
				type: "object",
				properties: { answer: { type: "string" } },
			},
		});

		expect(result.ok).toBe(true);
		expect(getStructuredOutputCapabilityMock).toHaveBeenCalledWith(
			"pydantic-ai-agent-py",
		);
		expect(raiseSessionEventMock).toHaveBeenCalledOnce();
	});

	it("emits the atomic paired clear without requiring runtime capability", async () => {
		raiseSessionEventMock.mockResolvedValueOnce({ ok: true, status: 200 });

		const result = await raiseSessionAgentConfigPatchForTest("s1", {
			structuredOutputMode: null,
			responseJsonSchema: null,
		});

		expect(result.ok).toBe(true);
		expect(getSessionMock).not.toHaveBeenCalled();
		expect(raiseSessionEventMock).toHaveBeenCalledWith(
			"s1",
			SESSION_AGENT_CONFIG_PATCH_EVENT,
			{
				patch: {
					structuredOutputMode: null,
					responseJsonSchema: null,
				},
				applies: "next_turn",
			},
		);
	});

	it("resolves MCP patches server-side before raising the event", async () => {
		getSessionMock.mockResolvedValueOnce({
			id: "s1",
			agentId: "a1",
			agentVersion: 3,
		});
		resolveSessionAgentMock.mockResolvedValueOnce({
			config: {
				builtinTools: ["read_file"],
				mcpConnectionMode: "explicit",
				mcpServers: [],
				skills: [],
				runtime: "dapr-agent-py",
				runtimeOverridePolicy: {},
			},
			projectId: "project-1",
		});
		resolveAgentConfigMcpForProjectMock.mockResolvedValueOnce({
			mcpServers: [
				{
					server_name: "piece_github",
					url: "http://ap-github-service.workflow-builder.svc.cluster.local/mcp",
				},
			],
			mcpConnectionWarnings: ["warning"],
		});
		raiseSessionEventMock.mockResolvedValueOnce({ ok: true, status: 200 });

		const result = await raiseSessionAgentConfigPatchForTest("s1", {
			mcpConnectionMode: "project",
		});

		expect(result.ok).toBe(true);
		expect(resolveAgentConfigMcpForProjectMock).toHaveBeenCalledWith(
			expect.objectContaining({ mcpConnectionMode: "project" }),
			"project-1",
			{ autoIncludesProjectConnections: true },
		);
		expect(raiseSessionEventMock).toHaveBeenCalledWith(
			"s1",
			SESSION_AGENT_CONFIG_PATCH_EVENT,
			expect.objectContaining({
				patch: expect.objectContaining({
					mcpConnectionMode: "project",
					mcpServers: [
						expect.objectContaining({ server_name: "piece_github" }),
					],
					mcpConnectionWarnings: ["warning"],
				}),
			}),
		);
	});

	it("does not expand AGY auto mode to all project MCP connections", async () => {
		getSessionMock.mockResolvedValueOnce({
			agentId: "agent-agy",
			agentVersion: null,
		});
		resolveSessionAgentMock.mockResolvedValueOnce({
			config: {
				builtinTools: ["read_file"],
				mcpConnectionMode: "explicit",
				mcpServers: [],
				skills: [],
				runtime: "agy-cli",
				runtimeOverridePolicy: {},
			},
			projectId: "project-1",
		});
		resolveAgentConfigMcpForProjectMock.mockResolvedValueOnce({
			mcpServers: [],
		});
		raiseSessionEventMock.mockResolvedValueOnce({ ok: true, status: 200 });

		const result = await raiseSessionAgentConfigPatchForTest("s1", {
			mcpConnectionMode: "auto",
		});

		expect(result.ok).toBe(true);
		expect(resolveAgentConfigMcpForProjectMock).toHaveBeenCalledWith(
			expect.objectContaining({
				mcpConnectionMode: "auto",
				runtime: "agy-cli",
			}),
			"project-1",
			{ autoIncludesProjectConnections: false },
		);
	});
});

function raiseSessionAgentConfigPatchForTest(sessionId: string, input: unknown) {
	return raiseSessionAgentConfigPatch(sessionId, input, {
		getSession: (id) => getSessionMock(id),
		resolveSessionAgent: (agent) => resolveSessionAgentMock(agent),
		getStructuredOutputCapability: (runtimeId) =>
			getStructuredOutputCapabilityMock(runtimeId),
	});
}
