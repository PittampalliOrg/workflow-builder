import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApplicationGitOpsDeploymentService } from "$lib/server/application/gitops-deployment";
import type { DeploymentMetadataPort } from "$lib/server/application/ports";
import type {
	DeploymentMetadataResponse,
	RuntimeMetadataResponse,
} from "$lib/types/deployment-metadata";

const baseMetadata = { generatedAt: "2026-07-05T00:00:00.000Z" } as unknown as DeploymentMetadataResponse;
const enrichedMetadata = { generatedAt: "2026-07-05T00:00:00.000Z", enriched: true } as unknown as DeploymentMetadataResponse;
const runtimeMetadata = { generatedAt: "2026-07-05T00:00:00.000Z" } as unknown as RuntimeMetadataResponse;

describe("ApplicationGitOpsDeploymentService", () => {
	let metadata: DeploymentMetadataPort;
	let service: ApplicationGitOpsDeploymentService;

	beforeEach(() => {
		metadata = {
			getDeploymentMetadata: vi.fn(async () => baseMetadata),
			enrichLiveCommits: vi.fn(async () => enrichedMetadata),
			getRuntimeMetadata: vi.fn(async () => runtimeMetadata),
			invalidate: vi.fn(),
		};
		service = new ApplicationGitOpsDeploymentService({ metadata });
	});

	it("returns the un-enriched snapshot by default without touching enrichment", async () => {
		const result = await service.getMetadata();

		expect(metadata.getDeploymentMetadata).toHaveBeenCalledWith({ fresh: undefined });
		expect(metadata.enrichLiveCommits).not.toHaveBeenCalled();
		expect(result).toBe(baseMetadata);
	});

	it("composes live-commit enrichment when requested", async () => {
		const result = await service.getMetadata({ fresh: true, enrichLive: true });

		expect(metadata.getDeploymentMetadata).toHaveBeenCalledWith({ fresh: true });
		expect(metadata.enrichLiveCommits).toHaveBeenCalledWith(baseMetadata);
		expect(result).toBe(enrichedMetadata);
	});

	it("delegates the runtime projection to the port", async () => {
		const result = await service.getRuntimeMetadata();

		expect(metadata.getRuntimeMetadata).toHaveBeenCalledOnce();
		expect(result).toBe(runtimeMetadata);
	});

	it("forwards each cache scope to the port", () => {
		service.invalidateCaches("pins");
		service.invalidateCaches("runtime");
		service.invalidateCaches("all");

		expect(metadata.invalidate).toHaveBeenNthCalledWith(1, "pins");
		expect(metadata.invalidate).toHaveBeenNthCalledWith(2, "runtime");
		expect(metadata.invalidate).toHaveBeenNthCalledWith(3, "all");
	});
});
