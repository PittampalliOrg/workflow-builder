import { describe, expect, it } from "vitest";
import { KroPreviewEnvironmentProvisioner } from "$lib/server/application/adapters/preview";

describe("KroPreviewEnvironmentProvisioner", () => {
	it("fails explicitly until BFF-side CR instance creation is wired", async () => {
		const provisioner = new KroPreviewEnvironmentProvisioner();

		await expect(
			provisioner.provision({
				executionId: "exec-1",
			}),
		).rejects.toThrow("WorkflowBuilderPreviewEnvironment instance creation");
	});

	it("also throws for the multi-service provisionMany fan-out", async () => {
		const provisioner = new KroPreviewEnvironmentProvisioner();

		await expect(
			provisioner.provisionMany({
				executionId: "exec-1",
				services: ["workflow-builder", "workflow-orchestrator"],
			}),
		).rejects.toThrow("WorkflowBuilderPreviewEnvironment instance creation");
	});
});
