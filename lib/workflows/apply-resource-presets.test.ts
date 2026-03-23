import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyResourcePresetsToNodes } from "./apply-resource-presets";

const { getResolvedAgentProfileTemplate } = vi.hoisted(() => ({
	getResolvedAgentProfileTemplate: vi.fn(),
}));

vi.mock("@/lib/db/agent-profiles", () => ({
	getResolvedAgentProfileTemplate,
}));

describe("applyResourcePresetsToNodes", () => {
	beforeEach(() => {
		getResolvedAgentProfileTemplate.mockReset();
	});

	it("applies agent profile templates to dapr-agent nodes", async () => {
		getResolvedAgentProfileTemplate.mockResolvedValue({
			template: {
				id: "profile_123",
				slug: "langgraph-feature-delivery",
				name: "LangGraph Feature Delivery",
			},
			templateVersion: {
				version: 7,
			},
			snapshot: {
				agentType: "code-assistant",
				instructions: "Follow the approved coding plan before editing.",
				model: { provider: "openai", name: "gpt-5.4" },
				maxTurns: 42,
				timeoutMinutes: 18,
				requiredCapabilities: ["git", "bash"],
				preferredExecutionProfile: "node-pnpm",
				preferredSandboxProfile: "node-pnpm",
				tools: [
					{ type: "workspace", ref: "read" },
					{ type: "workspace", ref: "write" },
					{ type: "workspace", ref: "edit" },
					{ type: "workspace", ref: "bash" },
				],
			},
		});

		const result = await applyResourcePresetsToNodes({
			nodes: [
				{
					id: "node-1",
					data: {
						config: {
							actionType: "dapr-agent/run",
							mode: "plan_mode",
							agentProfileTemplateId: "profile_123",
							instructionsOverlay: "Keep the summary concise.",
						},
					},
				},
			],
			userId: "user_123",
			projectId: "project_123",
		});

		const config = (
			result.nodes[0] as { data: { config: Record<string, unknown> } }
		).data.config;

		expect(config.engine).toBe("langgraph");
		expect(config.profile).toBe("feature-delivery");
		expect(config.instructionsOverlay).toBe(
			"Follow the approved coding plan before editing.\n\nAdditional workflow instructions:\nKeep the summary concise.",
		);
		expect(config.model).toBe("openai/gpt-5.4");
		expect(config.maxTurns).toBe("42");
		expect(config.timeoutMinutes).toBe("18");
		expect(config.tools).toBe('["read","write","edit","bash"]');
		expect(config.agentProfileRef).toEqual({
			id: "profile_123",
			slug: "langgraph-feature-delivery",
			name: "LangGraph Feature Delivery",
			version: 7,
		});
		expect(config.agentConfig).toEqual({
			name: "LangGraph Feature Delivery",
			instructions: "Follow the approved coding plan before editing.",
			modelSpec: "openai/gpt-5.4",
			maxTurns: 42,
			timeoutMinutes: 18,
			tools: ["read", "write", "edit", "bash"],
			requiredCapabilities: ["git", "bash"],
			preferredExecutionProfile: "node-pnpm",
			preferredSandboxProfile: "node-pnpm",
			workspaceBackend: "openshell",
		});
		expect(config.requiredCapabilities).toEqual(["git", "bash"]);
		expect(config.preferredExecutionProfile).toBe("node-pnpm");
		expect(config.preferredSandboxProfile).toBe("node-pnpm");
		expect(result.refs).toEqual([
			{
				nodeId: "node-1",
				resourceType: "agent_profile",
				resourceId: "profile_123",
				resourceVersion: 7,
			},
		]);
	});

	it("preserves an explicit LangGraph model on the resolved agent config", async () => {
		getResolvedAgentProfileTemplate.mockResolvedValue({
			template: {
				id: "profile_123",
				slug: "langgraph-feature-delivery",
				name: "LangGraph Feature Delivery",
			},
			templateVersion: {
				version: 7,
			},
			snapshot: {
				agentType: "code-assistant",
				instructions: "Follow the approved coding plan before editing.",
				model: { provider: "openai", name: "gpt-5.2-codex" },
				maxTurns: 42,
				timeoutMinutes: 18,
				requiredCapabilities: ["git", "bash"],
				preferredExecutionProfile: "node-pnpm",
				preferredSandboxProfile: "node-pnpm",
				tools: [{ type: "workspace", ref: "read" }],
			},
		});

		const result = await applyResourcePresetsToNodes({
			nodes: [
				{
					id: "node-1",
					data: {
						config: {
							actionType: "dapr-agent/run",
							mode: "plan_mode",
							agentProfileTemplateId: "profile_123",
							model: "gpt-5.4",
						},
					},
				},
			],
			userId: "user_123",
			projectId: "project_123",
		});

		const config = (
			result.nodes[0] as { data: { config: Record<string, unknown> } }
		).data.config;

		expect(config.model).toBe("gpt-5.4");
		expect(config.agentConfig).toEqual({
			name: "LangGraph Feature Delivery",
			instructions: "Follow the approved coding plan before editing.",
			modelSpec: "gpt-5.4",
			maxTurns: 42,
			timeoutMinutes: 18,
			tools: ["read"],
			requiredCapabilities: ["git", "bash"],
			preferredExecutionProfile: "node-pnpm",
			preferredSandboxProfile: "node-pnpm",
			workspaceBackend: "openshell",
		});
	});

	it("leaves dapr-agent nodes without a template untouched", async () => {
		const originalNodes = [
			{
				id: "node-2",
				data: {
					config: {
						actionType: "dapr-agent/run",
						mode: "plan_mode",
						prompt: "Plan a fix",
					},
				},
			},
		];

		const result = await applyResourcePresetsToNodes({
			nodes: originalNodes,
			userId: "user_123",
			projectId: "project_123",
		});

		expect(result.nodes).toEqual(originalNodes);
		expect(result.refs).toEqual([]);
		expect(getResolvedAgentProfileTemplate).not.toHaveBeenCalled();
	});

	it("applies agent profile templates to openshell-langgraph nodes", async () => {
		getResolvedAgentProfileTemplate.mockResolvedValue({
			template: {
				id: "profile_456",
				slug: "coding-agent",
				name: "Coding Agent",
			},
			templateVersion: {
				version: 3,
			},
			snapshot: {
				agentType: "code-assistant",
				instructions: "Use the sandbox and keep edits cohesive.",
				model: { provider: "openai", name: "gpt-5.4" },
				maxTurns: 30,
				timeoutMinutes: 25,
				requiredCapabilities: ["git", "bash"],
				preferredExecutionProfile: "node-pnpm",
				preferredSandboxProfile: "node-pnpm",
				tools: [
					{ type: "workspace", ref: "read" },
					{ type: "workspace", ref: "edit" },
					{ type: "workspace", ref: "bash" },
				],
			},
		});

		const result = await applyResourcePresetsToNodes({
			nodes: [
				{
					id: "node-3",
					data: {
						config: {
							actionType: "openshell-langgraph/run",
							mode: "execute_direct",
							agentProfileTemplateId: "profile_456",
						},
					},
				},
			],
			userId: "user_123",
			projectId: "project_123",
		});

		const config = (
			result.nodes[0] as { data: { config: Record<string, unknown> } }
		).data.config;

		expect(config.engine).toBe("langgraph");
		expect(config.profile).toBe("implement");
		expect(config.model).toBe("openai/gpt-5.4");
		expect(config.maxTurns).toBe("30");
		expect(config.timeoutMinutes).toBe("25");
		expect(config.tools).toBe('["read","edit","bash"]');
		expect(config.agentConfig).toEqual({
			name: "Coding Agent",
			instructions: "Use the sandbox and keep edits cohesive.",
			modelSpec: "openai/gpt-5.4",
			maxTurns: 30,
			timeoutMinutes: 25,
			tools: ["read", "edit", "bash"],
			requiredCapabilities: ["git", "bash"],
			preferredExecutionProfile: "node-pnpm",
			preferredSandboxProfile: "node-pnpm",
			workspaceBackend: "openshell",
		});
		expect(config.requiredCapabilities).toEqual(["git", "bash"]);
		expect(config.preferredExecutionProfile).toBe("node-pnpm");
		expect(config.preferredSandboxProfile).toBe("node-pnpm");
		expect(result.refs).toEqual([
			{
				nodeId: "node-3",
				resourceType: "agent_profile",
				resourceId: "profile_456",
				resourceVersion: 3,
			},
		]);
	});
});
