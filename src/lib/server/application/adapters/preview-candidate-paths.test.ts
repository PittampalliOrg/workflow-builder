import { describe, expect, it } from "vitest";
import { ManifestCandidatePathPolicyAdapter } from "$lib/server/application/adapters/preview-candidate-paths";

const contract = {
	schemaVersion: 1 as const,
	profile: "manifest-candidate" as const,
	allowedSurfaces: [
		{ pathPrefix: "packages/workloads/", renderer: "application" },
	],
	routeRules: [
		{
			pathPrefix: "packages/hub/",
			profile: "manifest-candidate" as const,
			lane: "management" as const,
			reason: "hub management plane",
		},
		{
			pathPrefix: "deployment/",
			profile: "host-candidate" as const,
			lane: "application" as const,
			reason: "physical cluster lifecycle",
		},
	],
};

describe("ManifestCandidatePathPolicyAdapter", () => {
	it("routes a complete normalized changed-path set to one profile", () => {
		const adapter = new ManifestCandidatePathPolicyAdapter({ contract });
		expect(
			adapter.routeCandidatePaths([
				"packages/workloads/service.yaml",
				"packages/workloads/config.yaml",
			]),
		).toEqual({
			profile: "manifest-candidate",
			lane: "application",
			paths: [
				"packages/workloads/config.yaml",
				"packages/workloads/service.yaml",
			],
		});
		expect(
			adapter.routeCandidatePaths(["packages/hub/promoter.yaml"]),
		).toMatchObject({ profile: "manifest-candidate", lane: "management" });
		expect(
			adapter.routeCandidatePaths(["deployment/recreate-dev.sh"]),
		).toMatchObject({ profile: "host-candidate", lane: "application" });
	});

	it("rejects mixed and unmapped surfaces", () => {
		const adapter = new ManifestCandidatePathPolicyAdapter({ contract });
		expect(() =>
			adapter.routeCandidatePaths([
				"packages/workloads/service.yaml",
				"deployment/recreate-dev.sh",
			]),
		).toThrow("multiple preview lanes");
		expect(() => adapter.routeCandidatePaths(["README.md"])).toThrow(
			"outside the executable preview surface",
		);
	});

	it("keeps the vCluster manifest assertion fail-closed", () => {
		const adapter = new ManifestCandidatePathPolicyAdapter({ contract });
		expect(() =>
			adapter.assertManifestCandidatePaths(["packages/hub/promoter.yaml"]),
		).toThrow("lane management");
	});
});
