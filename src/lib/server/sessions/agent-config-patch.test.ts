import { beforeEach, describe, expect, it, vi } from "vitest";

const raiseSessionEventMock = vi.fn();
const getSessionMock = vi.fn();
const resolveAgentRefMock = vi.fn();
const resolveAgentConfigMcpForProjectMock = vi.fn();

vi.mock("./control", () => ({
	raiseSessionEvent: (...args: unknown[]) => raiseSessionEventMock(...args),
}));

vi.mock("$lib/server/sessions/registry", () => ({
	getSession: (...args: unknown[]) => getSessionMock(...args),
}));

vi.mock("$lib/server/agents/registry", () => ({
	resolveAgentRef: (...args: unknown[]) => resolveAgentRefMock(...args),
}));

vi.mock("$lib/server/agents/mcp-resolution", () => ({
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
		resolveAgentRefMock.mockReset();
		resolveAgentConfigMcpForProjectMock.mockReset();
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
			},
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

	it("raises one canonical config patch event", async () => {
		raiseSessionEventMock.mockResolvedValueOnce({ ok: true, status: 200 });

		const result = await raiseSessionAgentConfigPatch("s1", {
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

	it("resolves MCP patches server-side before raising the event", async () => {
		getSessionMock.mockResolvedValueOnce({
			id: "s1",
			agentId: "a1",
			agentVersion: 3,
		});
		resolveAgentRefMock.mockResolvedValueOnce({
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

		const result = await raiseSessionAgentConfigPatch("s1", {
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
		resolveAgentRefMock.mockResolvedValueOnce({
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

		const result = await raiseSessionAgentConfigPatch("s1", {
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
