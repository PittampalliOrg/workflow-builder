import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ApplicationBenchmarkEnvironmentValidationService,
	type SwebenchEnvironmentBuildProvisioner,
	type SwebenchEnvironmentPlan,
	type SwebenchEnvironmentValidationRepository,
} from "$lib/server/application/benchmark-environment-validation";

describe("ApplicationBenchmarkEnvironmentValidationService", () => {
	let repository: SwebenchEnvironmentValidationRepository;
	let provisioner: SwebenchEnvironmentBuildProvisioner;
	let service: ApplicationBenchmarkEnvironmentValidationService;

	beforeEach(() => {
		repository = {
			ensureDefaultBenchmarkSuites: vi.fn(async () => {}),
			getSuiteBySlug: vi.fn(async () => ({
				id: "suite-1",
				slug: "SWE-bench_Verified",
				datasetName: "princeton-nlp/SWE-bench_Verified",
			})),
			listInstances: vi.fn(async () => [
				{
					instanceId: "astropy__astropy-7166",
					repo: null,
					baseCommit: null,
					testMetadata: null,
				},
			]),
			getInstanceBySuiteSlug: vi.fn(async () => ({
				repo: "astropy/astropy",
				baseCommit: "abc123",
				testMetadata: { FAIL_TO_PASS: ["test_example.py::test_fix"] },
			})),
			loadBuildStatusByHash: vi.fn(async () => new Map()),
		};
		provisioner = {
			ensureEnvironment: vi.fn(async () => ({
				success: true,
				complete: false,
				environmentStatus: "building" as const,
				status: "building" as const,
				sandboxTemplate: "swebench",
				buildId: "build-1",
				pipelineRunName: "swe-env-build-1",
				pipelineRunNamespace: "tekton-pipelines",
			})),
			syncSelectableBuilds: vi.fn(async () => {}),
		};
		service = new ApplicationBenchmarkEnvironmentValidationService({
			repository,
			provisioner,
		});
	});

	it("plans validation through repository ports", async () => {
		const plan = await service.plan({
			suiteSlug: "SWE-bench_Verified",
			instanceIds: ["astropy__astropy-7166"],
			limit: null,
		});

		expect(repository.ensureDefaultBenchmarkSuites).toHaveBeenCalled();
		expect(repository.getSuiteBySlug).toHaveBeenCalledWith(
			"SWE-bench_Verified",
		);
		expect(repository.listInstances).toHaveBeenCalledWith({
			suiteId: "suite-1",
			instanceIds: ["astropy__astropy-7166"],
			limit: null,
		});
		expect(plan.coverage).toMatchObject({
			total: 1,
			failed: 1,
			missingMetadata: 1,
		});
		expect(provisioner.syncSelectableBuilds).not.toHaveBeenCalled();
	});

	it("syncs selectable build statuses only when requested", async () => {
		await service.plan({
			suiteSlug: "SWE-bench_Verified",
			instanceIds: ["astropy__astropy-7166"],
			syncBuildStatuses: true,
		});

		expect(provisioner.syncSelectableBuilds).toHaveBeenCalledWith({
			envSpecHashes: [],
			limit: 32,
		});
	});

	it("submits validation builds through the provisioner port", async () => {
		const submission = await service.submit({
			plan: notBuiltPlan(),
			limit: 1,
			targetValidatedCount: null,
			allowBuild: true,
		});

		expect(provisioner.ensureEnvironment).toHaveBeenCalledWith(
			expect.objectContaining({
				dataset: "princeton-nlp/SWE-bench_Verified",
				suiteSlug: "SWE-bench_Verified",
				instanceId: "astropy__astropy-7166",
				repo: "astropy/astropy",
				baseCommit: "abc123",
				allowBuild: true,
			}),
		);
		expect(submission.submitted).toBe(1);
		expect(submission.results[0]).toMatchObject({
			instanceId: "astropy__astropy-7166",
			buildId: "build-1",
			environmentStatus: "building",
		});
	});

	it("prepares an internal ensure request through repository and provisioner ports", async () => {
		await service.ensureInternalRequest({
			dataset: "SWE-bench_Verified",
			instanceId: "astropy__astropy-7166",
			repo: "astropy/astropy",
			baseCommit: "abc123",
			allowBuild: true,
		});

		expect(repository.getInstanceBySuiteSlug).toHaveBeenCalledWith({
			suiteSlug: "SWE-bench_Verified",
			instanceId: "astropy__astropy-7166",
		});
		expect(provisioner.ensureEnvironment).toHaveBeenCalledWith(
			expect.objectContaining({
				dataset: "SWE-bench_Verified",
				suiteSlug: "SWE-bench_Verified",
				instanceId: "astropy__astropy-7166",
				repo: "astropy/astropy",
				baseCommit: "abc123",
				testMetadata: expect.objectContaining({
					FAIL_TO_PASS: ["test_example.py::test_fix"],
				}),
				allowBuild: true,
			}),
		);
	});

	it("rejects internal ensure requests when imported metadata is missing", async () => {
		vi.mocked(repository.getInstanceBySuiteSlug).mockResolvedValueOnce(null);

		await expect(
			service.ensureInternalRequest({
				dataset: "SWE-bench_Verified",
				instanceId: "astropy__astropy-7166",
				repo: "astropy/astropy",
				baseCommit: "abc123",
			}),
		).rejects.toMatchObject({
			status: 409,
			message:
				"SWE-bench metadata for astropy__astropy-7166 has not been imported for SWE-bench_Verified",
		});
		expect(provisioner.ensureEnvironment).not.toHaveBeenCalled();
	});

	it("keeps DB and Drizzle access out of the application use case", () => {
		const source = readFileSync(
			join(
				dirname(fileURLToPath(import.meta.url)),
				"benchmark-environment-validation.ts",
			),
			"utf8",
		);

		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});
});

function notBuiltPlan(): SwebenchEnvironmentPlan {
	return {
		suite: {
			id: "suite-1",
			slug: "SWE-bench_Verified",
			datasetName: "princeton-nlp/SWE-bench_Verified",
		},
		suiteSlug: "SWE-bench_Verified",
		requestedInstanceIds: ["astropy__astropy-7166"],
		missingInstanceIds: [],
		planned: [
			{
				status: "not_built",
				envSpecHash: "hash-1",
				environmentKey: "env-1",
				row: {
					instanceId: "astropy__astropy-7166",
					repo: "astropy/astropy",
					baseCommit: "abc123",
					testMetadata: {},
				},
			},
		],
		coverage: {
			total: 1,
			validated: 0,
			building: 0,
			failed: 0,
			notBuilt: 1,
			missingMetadata: 0,
		},
		nextExactReadyInstanceIds: [],
	};
}
