import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	requireInternal: vi.fn(),
	plan: vi.fn(),
	submit: vi.fn(),
}));

vi.mock("$lib/server/internal-auth", () => ({
	requireInternal: mocks.requireInternal,
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		benchmarkEnvironmentValidation: {
			plan: mocks.plan,
			submit: mocks.submit,
		},
	}),
}));

import { POST as publicPost } from "./validate/+server";
import { POST as internalPost } from "../../internal/benchmarks/environments/validate/+server";

const plan = {
	suiteSlug: "SWE-bench_Verified",
	requestedInstanceIds: ["astropy__astropy-7166"],
	missingInstanceIds: [],
	coverage: {
		total: 1,
		validated: 1,
		building: 0,
		failed: 0,
		notBuilt: 0,
		missingMetadata: 0,
	},
	planned: [
		{
			status: "validated",
			row: { instanceId: "astropy__astropy-7166" },
		},
	],
	nextExactReadyInstanceIds: ["astropy__astropy-7166"],
};

const submission = {
	selected: [],
	submitted: 0,
	results: [
		{
			instanceId: "astropy__astropy-7166",
			buildId: null,
			pipelineRunName: null,
			pipelineRunNamespace: null,
			envSpecHash: "env-hash",
			environmentStatus: "validated",
			reason: null,
			error: null,
		},
	],
};

describe("benchmark environment validation routes", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.plan.mockResolvedValue(plan);
		mocks.submit.mockResolvedValue(submission);
	});

	it("delegates public validation to the validation service", async () => {
		const response = (await publicPost({
			request: new Request("http://localhost", {
				method: "POST",
				body: JSON.stringify({
					suiteSlug: "SWE-bench_Verified",
					instanceIds: ["astropy__astropy-7166"],
					limit: 5,
				}),
			}),
			locals: {
				session: {
					userId: "user-1",
				},
			},
		} as never)) as Response;
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(mocks.plan).toHaveBeenCalledWith({
			suiteSlug: "SWE-bench_Verified",
			instanceIds: ["astropy__astropy-7166"],
			limit: null,
		});
		expect(mocks.submit).toHaveBeenCalledWith({
			plan,
			limit: 5,
			targetValidatedCount: null,
			allowBuild: true,
		});
		expect(body.submittedBuilds).toEqual([
			expect.objectContaining({
				instanceId: "astropy__astropy-7166",
				status: "validated",
			}),
		]);
	});

	it("delegates internal validation to the validation service", async () => {
		const response = (await internalPost({
			request: new Request("http://localhost", {
				method: "POST",
				body: JSON.stringify({
					suiteSlug: "SWE-bench_Verified",
					limit: 2,
					targetValidatedCount: 3,
					allowBuild: false,
				}),
			}),
		} as never)) as Response;
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(mocks.requireInternal).toHaveBeenCalledTimes(1);
		expect(mocks.plan).toHaveBeenCalledWith({
			suiteSlug: "SWE-bench_Verified",
			instanceIds: [],
			limit: 500,
			syncBuildStatuses: true,
		});
		expect(mocks.submit).toHaveBeenCalledWith({
			plan,
			limit: 2,
			targetValidatedCount: 3,
			allowBuild: false,
		});
		expect(body.allowBuild).toBe(false);
		expect(body.submittedBuilds).toEqual([
			expect.objectContaining({
				instanceId: "astropy__astropy-7166",
				status: "validated",
			}),
		]);
	});

	it("keeps validation routes free of direct DB imports", () => {
		for (const relativePath of [
			"validate/+server.ts",
			"../../internal/benchmarks/environments/validate/+server.ts",
		]) {
			const source = readFileSync(
				join(dirname(fileURLToPath(import.meta.url)), relativePath),
				"utf8",
			);

			expect(source).toContain("getApplicationAdapters");
			expect(source).toContain("benchmarkEnvironmentValidation");
			expect(source).not.toContain("$lib/server/db");
			expect(source).not.toContain("$lib/server/db/schema");
			expect(source).not.toContain("drizzle-orm");
		}
	});
});
