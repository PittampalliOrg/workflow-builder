import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	getRuntimeDescriptor,
	listRuntimeIds,
	listBenchmarkRuntimeIds,
	listWorkflowDispatchRuntimeIds,
	shellableContainers,
	DEFAULT_RUNTIME_ID,
	DISPATCH_WORKFLOW_NAME
} from "./runtime-registry";
import { BENCHMARK_AGENT_RUNTIMES } from "$lib/benchmarks/agent-runtimes";

const CANONICAL = "services/shared/runtime-registry.json";
const BFF_COPY = "src/lib/server/agents/runtime-registry.data.json";

function readJson(rel: string): unknown {
	return JSON.parse(readFileSync(resolve(process.cwd(), rel), "utf8"));
}

describe("runtime registry — drift guard", () => {
	it("the BFF data copy is byte-identical JSON to the canonical SSOT", () => {
		// Guards against editing a copy directly instead of the canonical +
		// re-running scripts/sync-runtime-registry.mjs.
		expect(readJson(BFF_COPY)).toEqual(readJson(CANONICAL));
	});

	it("the orchestrator copy is also in sync with the canonical", () => {
		expect(
			readJson("services/workflow-orchestrator/core/runtime_registry.json")
		).toEqual(readJson(CANONICAL));
	});
});

describe("runtime registry — readers", () => {
	it("exposes the registered agent runtimes (incl. 4 interactive-cli)", () => {
		expect(listRuntimeIds().sort()).toEqual(
			[
				"adk-agent-py",
				"agy-cli",
				"browser-use-agent",
				"claude-agent-py",
				"claude-code-cli",
				"claude-code-cli-glm",
				"codex-cli",
				"dapr-agent-py",
				"dapr-agent-py-juicefs",
				"dapr-agent-py-testing"
			].sort()
		);
	});

	it("default runtime + dispatch workflow match the contract", () => {
		expect(DEFAULT_RUNTIME_ID).toBe("dapr-agent-py");
		expect(DISPATCH_WORKFLOW_NAME).toBe("session_workflow");
	});

	it("benchmark runtimes match the hand-typed BENCHMARK_AGENT_RUNTIMES const", () => {
		// BENCHMARK_AGENT_RUNTIMES stays a typed literal union; this asserts it
		// never drifts from the registry's benchmarkEligible descriptors.
		expect(listBenchmarkRuntimeIds().sort()).toEqual(
			[...BENCHMARK_AGENT_RUNTIMES].sort()
		);
	});

	it("workflow dispatch runtimes include durable runtimes and hook-backed CLI agents", () => {
		expect(listWorkflowDispatchRuntimeIds().sort()).toEqual(
			[
				"adk-agent-py",
				"agy-cli",
				"claude-agent-py",
				"claude-code-cli",
				"claude-code-cli-glm",
				"codex-cli",
				"dapr-agent-py",
				"dapr-agent-py-juicefs",
				"dapr-agent-py-testing"
			].sort()
		);
		expect(listWorkflowDispatchRuntimeIds()).not.toContain("browser-use-agent");
	});

	it("shellable containers = every runtime main container + browser sidecars", () => {
		const containers = shellableContainers();
		// dapr-agent-py (+ testing share the container), claude, adk, browser-use,
		// cli-agent-py (interactive-cli host).
		for (const c of [
			"dapr-agent-py",
			"claude-agent-py",
			"adk-agent-py",
			"browser-use-agent",
			"cli-agent-py",
			"chromium",
			"playwright-mcp"
		]) {
			expect(containers.has(c)).toBe(true);
		}
		// daprd is the Dapr sidecar — never shell-able.
		expect(containers.has("daprd")).toBe(false);
	});

	it("descriptors carry capabilities for the swap gate (Phase 3)", () => {
		const claude = getRuntimeDescriptor("claude-agent-py");
		expect(claude?.capabilities.durabilityGranularity).toBe("per-turn");
		expect(claude?.capabilities.supportsMcp).toBe(true);
		expect(claude?.agentMetadataFramework).toBe("Claude Agent SDK");
		const dapr = getRuntimeDescriptor("dapr-agent-py");
		expect(dapr?.capabilities.durabilityGranularity).toBe("per-activity");
		expect(dapr?.capabilities.multiProvider).toBe(true);
		expect(getRuntimeDescriptor("codex-cli")?.capabilities.supportsHooks).toBe(true);
		expect(getRuntimeDescriptor("agy-cli")?.capabilities.supportsHooks).toBe(true);
	});

	it("maps Claude Code GLM to a model id accepted by the Z.AI Anthropic gateway", () => {
		const glm = getRuntimeDescriptor("claude-code-cli-glm");
		expect(glm?.cliAuth?.provider).toBe("zai");
		expect(glm?.cliAuth?.apiBaseUrl).toBe("https://api.z.ai/api/anthropic");
		expect(glm?.cliModelEnv?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("glm-5.2");
		expect(glm?.cliModelEnv?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("glm-5.2");
		expect(glm?.cliModelEnv?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("glm-4.7");
	});
});

import { validateAgentMetadata } from "./application-state";

describe("Phase 2b — image override + framework", () => {
	it("imageEnvKey is set only for runtimes that override the executionClass image", () => {
		// adk + claude carry a per-session image override env; dapr is the default
		// image and browser-use takes the warm-pool lane, so both are null.
		expect(getRuntimeDescriptor("adk-agent-py")?.imageEnvKey).toBe("AGENT_RUNTIME_ADK_DEFAULT_IMAGE");
		expect(getRuntimeDescriptor("claude-agent-py")?.imageEnvKey).toBe("AGENT_RUNTIME_CLAUDE_DEFAULT_IMAGE");
		expect(getRuntimeDescriptor("claude-code-cli")?.imageEnvKey).toBe("AGENT_RUNTIME_CLAUDE_CLI_DEFAULT_IMAGE");
		expect(getRuntimeDescriptor("dapr-agent-py")?.imageEnvKey).toBeNull();
		expect(getRuntimeDescriptor("dapr-agent-py-testing")?.imageEnvKey).toBeNull();
		expect(getRuntimeDescriptor("browser-use-agent")?.imageEnvKey).toBeNull();
	});

	it("each runtime declares a distinct agentMetadataFramework", () => {
		expect(getRuntimeDescriptor("dapr-agent-py")?.agentMetadataFramework).toBe("Dapr Agents");
		expect(getRuntimeDescriptor("claude-agent-py")?.agentMetadataFramework).toBe("Claude Agent SDK");
		expect(getRuntimeDescriptor("adk-agent-py")?.agentMetadataFramework).toBe("Google ADK");
	});

	it("validateAgentMetadata accepts any registered framework, rejects unknown", () => {
		const blob = (framework: string) =>
			({ name: "x", agent: { appid: "a", type: "durable", framework }, tools: [] }) as never;
		// Previously only "Dapr Agents" passed — claude/adk are now first-class.
		expect(() => validateAgentMetadata(blob("Dapr Agents"))).not.toThrow();
		expect(() => validateAgentMetadata(blob("Claude Agent SDK"))).not.toThrow();
		expect(() => validateAgentMetadata(blob("Google ADK"))).not.toThrow();
		expect(() => validateAgentMetadata(blob("Bogus Framework"))).toThrow();
	});
});
