import { beforeEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "$lib/types/agents";
import { resolveAgentRuntimeRoute } from "./runtime-routing";

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		builtinTools: [],
		mcpConnectionMode: "explicit",
		mcpServers: [],
		skills: [],
		runtime: "dapr-agent-py",
		runtimeOverridePolicy: {
			allowToolNarrowing: true,
			allowServerAdditions: false,
			allowCredentialBinding: true,
			allowSkillAdditions: false,
			allowSkillNarrowing: true,
		},
		...overrides,
	};
}

describe("resolveAgentRuntimeRoute", () => {
	beforeEach(() => {
		delete process.env.AGENT_RUNTIME_SHARED_POOLS_ENABLED;
		delete process.env.AGENT_RUNTIME_POOL_APP_IDS_JSON;
		delete process.env.AGENT_RUNTIME_POOL_MAX_REPLICAS;
		delete process.env.AGENT_RUNTIME_POOL_MIN_REPLICAS;
	});

	it("defaults to a dedicated per-agent runtime (per-session-pod hostMode)", () => {
		// adk-agent-py has no registry hostMode, so the pre-P3 default applies.
		const route = resolveAgentRuntimeRoute({
			agentSlug: "code-agent",
			config: config({ runtime: "adk-agent-py" }),
		});

		expect(route).toMatchObject({
			appId: "agent-runtime-code-agent",
			slug: "code-agent",
			runtimeClass: "coding",
			isolation: "dedicated",
		});
	});

	it("routes shared-pool hostMode runtimes to the class pool with the rollout flag OFF (concurrency plan P3)", () => {
		// dapr-agent-py carries hostMode="shared-pool" in the runtime registry;
		// the pool route must not depend on AGENT_RUNTIME_SHARED_POOLS_ENABLED
		// (the per-session-host skip keyed on hostMode is flag-independent too).
		const route = resolveAgentRuntimeRoute({
			agentSlug: "code-agent",
			config: config(),
		});

		expect(route).toMatchObject({
			appId: "agent-runtime-pool-coding",
			slug: "pool-coding",
			runtimeClass: "coding",
			isolation: "shared",
			reason: "dapr-agent-py registry hostMode is shared-pool",
		});
	});

	it("lets explicit dedicated isolation override shared-pool hostMode", () => {
		const route = resolveAgentRuntimeRoute({
			agentSlug: "code-agent",
			config: config({ runtimeIsolation: "dedicated" }),
		});

		expect(route).toMatchObject({
			appId: "agent-runtime-code-agent",
			isolation: "dedicated",
			reason: "agent requested dedicated runtime isolation",
		});
	});

	it("keeps the seeded Kimi K3 JuiceFS builder on its per-agent runtime when shared pools are enabled", () => {
		process.env.AGENT_RUNTIME_SHARED_POOLS_ENABLED = "true";
		process.env.AGENT_RUNTIME_POOL_APP_IDS_JSON = JSON.stringify({
			coding: "agent-runtime-pool-coding",
		});

		const route = resolveAgentRuntimeRoute({
			agentSlug: "glm-juicefs-builder-agent",
			runtimeAppId: "agent-runtime-pool-coding",
			config: config({
				runtime: "dapr-agent-py-juicefs",
				modelSpec: "kimi/kimi-k3",
				runtimeIsolation: "dedicated",
			}),
		});

		expect(route).toEqual({
			appId: "agent-runtime-glm-juicefs-builder-agent",
			slug: "glm-juicefs-builder-agent",
			runtimeClass: "coding",
			isolation: "dedicated",
			reason: "agent requested dedicated runtime isolation",
		});
	});

	it("routes non-browser dapr-agent-py agents to a shared class pool when enabled", () => {
		process.env.AGENT_RUNTIME_SHARED_POOLS_ENABLED = "true";
		process.env.AGENT_RUNTIME_POOL_APP_IDS_JSON = JSON.stringify({
			coding: {
				appId: "agent-runtime-pool-coding",
				idleTtlSeconds: 7200,
				maxReplicas: 4,
			},
		});

		const route = resolveAgentRuntimeRoute({
			agentSlug: "code-agent",
			runtimeAppId: "agent-runtime-code-agent",
			config: config(),
		});

		expect(route).toMatchObject({
			appId: "agent-runtime-pool-coding",
			slug: "pool-coding",
			runtimeClass: "coding",
			isolation: "shared",
			pool: { idleTtlSeconds: 7200, maxReplicas: 4 },
		});
	});

	it("keeps interactive CLI runtimes off shared pools even when the agent row points at one", () => {
		process.env.AGENT_RUNTIME_SHARED_POOLS_ENABLED = "true";
		process.env.AGENT_RUNTIME_POOL_APP_IDS_JSON = JSON.stringify({
			coding: {
				appId: "agent-runtime-pool-coding",
				maxReplicas: 4,
			},
		});

		const route = resolveAgentRuntimeRoute({
			agentSlug: "codex-swebench",
			runtimeAppId: "agent-runtime-pool-coding",
			config: config({
				runtime: "codex-cli",
				runtimeIsolation: "shared",
			}),
		});

		expect(route).toMatchObject({
			appId: "agent-runtime-codex-swebench",
			slug: "codex-swebench",
			runtimeClass: "coding",
			isolation: "dedicated",
		});
		expect(route.reason).toContain("per-session interactive CLI workflow host");
		expect(route.pool).toBeUndefined();
	});

	it("honors an explicit shared runtimePool binding without the global feature gate", () => {
		const route = resolveAgentRuntimeRoute({
			agentSlug: "office-agent",
			config: config({
				runtimeClass: "office",
				runtimeIsolation: "shared",
				runtimePool: {
					appId: "agent-runtime-pool-office",
					idleTtlSeconds: 3600,
					minReplicas: 1,
					slotsPerReplica: 2,
					maxActiveSessions: 4,
				},
			}),
		});

		expect(route).toMatchObject({
			appId: "agent-runtime-pool-office",
			slug: "pool-office",
			runtimeClass: "office",
			isolation: "shared",
			pool: {
				idleTtlSeconds: 3600,
				minReplicas: 1,
				slotsPerReplica: 2,
				maxActiveSessions: 4,
			},
		});
	});

	it("keeps Playwright MCP agents dedicated because they need pod-local sidecars", () => {
		process.env.AGENT_RUNTIME_SHARED_POOLS_ENABLED = "true";

		const route = resolveAgentRuntimeRoute({
			agentSlug: "browser-helper",
			config: config({
				mcpServers: [
					{
						server_name: "playwright",
						name: "playwright",
						transport: "stdio",
						command: "npx",
						args: ["@playwright/mcp@latest"],
					},
				],
			}),
		});

		expect(route).toMatchObject({
			appId: "agent-runtime-browser-helper",
			isolation: "dedicated",
		});
		expect(route.reason).toContain("Playwright");
	});

	it("keeps browser-use agents dedicated", () => {
		process.env.AGENT_RUNTIME_SHARED_POOLS_ENABLED = "true";

		const route = resolveAgentRuntimeRoute({
			agentSlug: "web-nav",
			config: config({ runtime: "browser-use-agent" }),
		});

		expect(route).toMatchObject({
			appId: "agent-runtime-web-nav",
			runtimeClass: "browser",
			isolation: "dedicated",
		});
	});
});
