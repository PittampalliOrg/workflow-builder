import { describe, expect, it } from "vitest";
import { buildCliSessionSecretEnv } from "./session-secret-env";
import type { RuntimeDescriptor } from "$lib/server/agents/runtime-registry";

const baseCapabilities = {
	durabilityGranularity: "per-session",
	workspaceBackend: "juicefs-shared",
	workflowDispatch: "auto-turn",
	retryMaxAttempts: 2,
	durableTurnTimer: false,
	supportsMcp: true,
	supportsSkills: true,
	supportsBuiltinOpenShellTools: false,
	supportsHooks: true,
	supportsTeamMailboxReceipts: false,
	hookTiming: "live",
	supportsPermissionGating: true,
	supportsPlugins: true,
	supportsCompaction: true,
	incrementalEvents: true,
	ownsSandbox: true,
	requiresWarmPool: false,
	requiresBrowserSidecars: false,
	multiProvider: false,
	supportedProviders: ["anthropic"],
	interactiveTerminal: true,
} satisfies RuntimeDescriptor["capabilities"];

function runtime(
	overrides: Partial<RuntimeDescriptor>,
): RuntimeDescriptor {
	return {
		id: "claude-code-cli",
		appIdConfigKey: "CLAUDE_CODE_CLI_APP_ID",
		instancePrefix: "durable-claude-cli",
		family: "interactive-cli",
		mainContainerName: "cli-agent-py",
		imageEnvKey: "AGENT_RUNTIME_CLAUDE_CLI_DEFAULT_IMAGE",
		agentMetadataFramework: "Claude Code CLI",
		benchmarkEligible: true,
		capabilitiesVerified: false,
		executionClass: "interactive-cli",
		cliAdapter: "claude-code",
		cliAuth: {
			provider: "anthropic",
			tokenKind: "subscription_oauth",
			credentialKind: "env_token",
			envVar: "CLAUDE_CODE_OAUTH_TOKEN",
		},
		capabilities: baseCapabilities,
		...overrides,
	};
}

describe("buildCliSessionSecretEnv", () => {
	it("injects only the stock credential env for subscription CLI runtimes", () => {
		expect(buildCliSessionSecretEnv(runtime({}), "oauth-token")).toEqual({
			CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
		});
	});

	it("adds gateway base URL and model-tier env for GLM Claude Code sessions", () => {
		const descriptor = runtime({
			id: "claude-code-cli-glm",
			cliAuth: {
				provider: "zai",
				tokenKind: "api_key",
				credentialKind: "env_token",
				envVar: "ANTHROPIC_AUTH_TOKEN",
				apiBaseUrl: "https://api.z.ai/api/anthropic",
			},
			cliModelEnv: {
				ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.2",
				ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.2",
				ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.7",
				CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
				API_TIMEOUT_MS: "3000000",
			},
			capabilities: {
				...baseCapabilities,
				supportedProviders: ["zai"],
			},
		});

		expect(buildCliSessionSecretEnv(descriptor, "glm-key")).toEqual({
			ANTHROPIC_AUTH_TOKEN: "glm-key",
			ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
			ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.2",
			ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.2",
			ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.7",
			CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			API_TIMEOUT_MS: "3000000",
		});
	});
});
