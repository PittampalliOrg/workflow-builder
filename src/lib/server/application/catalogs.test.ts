import { describe, expect, it, vi } from "vitest";
import {
	ApplicationRuntimeCatalogService,
	ApplicationWorkflowTriggerKindCatalogService,
	type RuntimeCatalogReader,
	type WorkflowTriggerKindCatalogReader,
} from "$lib/server/application/catalogs";

describe("ApplicationRuntimeCatalogService", () => {
	it("projects runtime catalog entries through a reader port", () => {
		const reader: RuntimeCatalogReader = {
			listRuntimes: vi.fn(() => [
				{
					id: "codex-cli",
					family: "interactive-cli",
					cliAdapter: "codex",
					capabilities: { supportsMcp: true },
					cliAuth: {
						provider: "openai",
						credentialKind: "file",
						loginStyle: "auth_file",
					},
				},
			]),
		};

		expect(new ApplicationRuntimeCatalogService(reader).listRuntimes()).toEqual({
			runtimes: [
				{
					id: "codex-cli",
					family: "interactive-cli",
					cliAdapter: "codex",
					capabilities: { supportsMcp: true },
					cliAuth: {
						provider: "openai",
						credentialKind: "file",
						loginStyle: "auth_file",
					},
				},
			],
		});
		expect(reader.listRuntimes).toHaveBeenCalledOnce();
	});
});

describe("ApplicationWorkflowTriggerKindCatalogService", () => {
	it("projects workflow trigger kinds through a reader port", () => {
		const reader: WorkflowTriggerKindCatalogReader = {
			listTriggerKinds: vi.fn(() => [
				{
					id: "schedule",
					label: "Schedule",
					icon: "clock",
					description: "Runs on a schedule",
					backing: "dapr-job",
					configSchema: [
						{ key: "schedule", label: "Schedule", type: "cron", required: true },
					],
					requiresActivation: true,
				},
			]),
		};

		expect(
			new ApplicationWorkflowTriggerKindCatalogService(reader).listKinds(),
		).toEqual({
			kinds: [
				{
					id: "schedule",
					label: "Schedule",
					icon: "clock",
					description: "Runs on a schedule",
					backing: "dapr-job",
					configSchema: [
						{ key: "schedule", label: "Schedule", type: "cron", required: true },
					],
					requiresActivation: true,
				},
			],
		});
		expect(reader.listTriggerKinds).toHaveBeenCalledOnce();
	});
});
