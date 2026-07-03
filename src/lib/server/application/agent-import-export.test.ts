import { describe, expect, it, vi } from "vitest";
import {
	ApplicationAgentImportExportService,
	type AgentImportExportReferenceRepository,
} from "$lib/server/application/agent-import-export";
import type { AgentCatalogRepository } from "$lib/server/application/ports";
import { createDefaultAgentConfig } from "$lib/types/agents";

describe("ApplicationAgentImportExportService", () => {
	it("imports markdown through agent and reference ports", async () => {
		const agents = fakeAgents();
		const references = fakeReferences();
		const service = new ApplicationAgentImportExportService({
			agents,
			references,
		});
		const source = [
			"---",
			"name: Imported Agent",
			"description: Useful",
			"runtime: dapr-agent-py",
			"environment: dev-env",
			"vaults:",
			"  - main-vault",
			"  - missing-vault",
			"---",
			"Use the repo carefully.",
		].join("\n");

		const result = await service.importAgent({
			source,
			userId: "user-1",
			projectId: "project-1",
		});

		expect(result).toMatchObject({
			status: "created",
			warnings: ["vault 'missing-vault' not found; skipped"],
		});
		expect(agents.createAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "Imported Agent",
				description: "Useful",
				runtime: "dapr-agent-py",
				environmentId: "env-1",
				environmentVersion: 3,
				defaultVaultIds: ["vault-1"],
				createdBy: "user-1",
				projectId: "project-1",
			}),
		);
	});

	it("exports markdown with resolved environment slug", async () => {
		const agents = fakeAgents();
		const references = fakeReferences();
		const service = new ApplicationAgentImportExportService({
			agents,
			references,
		});

		const result = await service.exportAgent({ agentId: "agent-1" });

		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.filename).toBe("coding-agent.md");
		expect(result.markdown).toContain("name: Coding Agent");
		expect(result.markdown).toContain("environment: dev-env");
		expect(result.markdown).toContain("vault-1");
		expect(references.resolveEnvironmentSlug).toHaveBeenCalledWith({
			id: "env-1",
			version: 3,
		});
	});
});

function fakeAgents(): Pick<
	AgentCatalogRepository,
	"createAgent" | "getAgent"
> {
	return {
		createAgent: vi.fn(async () => ({
			ok: true as const,
			agent: {
				id: "agent-1",
				slug: "coding-agent",
				name: "Coding Agent",
			} as never,
		})),
		getAgent: vi.fn(async () => ({
			id: "agent-1",
			slug: "coding-agent",
			name: "Coding Agent",
			description: "Helpful coding agent",
			config: createDefaultAgentConfig(),
			defaultVaultIds: ["vault-1"],
			environmentId: "env-1",
			environmentVersion: 3,
		}) as never),
	};
}

function fakeReferences(): AgentImportExportReferenceRepository {
	return {
		listEnvironments: vi.fn(async () => [
			{ id: "env-1", slug: "dev-env", currentVersion: 3 },
		]),
		listVaults: vi.fn(async () => [{ id: "vault-1", name: "main-vault" }]),
		resolveEnvironmentSlug: vi.fn(async () => "dev-env"),
	};
}
