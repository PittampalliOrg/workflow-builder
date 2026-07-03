import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	requireInternal: vi.fn(),
	createBenchmarkRun: vi.fn(),
	getBenchmarkRun: vi.fn(),
	markBenchmarkRunStatus: vi.fn(),
	startSwebenchCoordinator: vi.fn(),
	selectExactReady: vi.fn(),
	loadBenchmarkLaunchControlPlaneStability: vi.fn(),
	benchmarkLaunchControlPlaneError: vi.fn(),
}));

vi.mock("$lib/server/internal-auth", () => ({
	requireInternal: mocks.requireInternal,
}));

vi.mock("$lib/server/benchmarks/service", () => ({
	createBenchmarkRun: mocks.createBenchmarkRun,
	getBenchmarkRun: mocks.getBenchmarkRun,
	markBenchmarkRunStatus: mocks.markBenchmarkRunStatus,
	startSwebenchCoordinator: mocks.startSwebenchCoordinator,
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		benchmarkEnvironmentValidation: {
			selectExactReady: mocks.selectExactReady,
		},
	}),
}));

vi.mock("$lib/server/benchmarks/launch-stability", () => ({
	loadBenchmarkLaunchControlPlaneStability:
		mocks.loadBenchmarkLaunchControlPlaneStability,
	benchmarkLaunchControlPlaneError: mocks.benchmarkLaunchControlPlaneError,
}));

import { POST } from "./+server";

describe("internal benchmark run launch route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.selectExactReady.mockResolvedValue({
			requestedLimit: 1,
			selectedCount: 1,
			selectedInstanceIds: ["astropy__astropy-7166"],
			missingInstanceIds: [],
		});
		mocks.loadBenchmarkLaunchControlPlaneStability.mockResolvedValue({
			healthy: true,
		});
		mocks.benchmarkLaunchControlPlaneError.mockReturnValue(null);
		mocks.createBenchmarkRun.mockResolvedValue({ id: "run-1" });
		mocks.startSwebenchCoordinator.mockResolvedValue({ executionId: "coord-1" });
		mocks.markBenchmarkRunStatus.mockResolvedValue({ id: "run-1" });
		mocks.getBenchmarkRun.mockResolvedValue({
			id: "run-1",
			status: "queued",
		});
	});

	it("keeps the launch route free of direct DB imports", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("createBenchmarkRun");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates agent slug resolution to createBenchmarkRun", async () => {
		const response = (await POST({
			request: new Request("http://localhost", {
				method: "POST",
				body: JSON.stringify({
					projectId: "project-1",
					userId: "user-1",
					agentSlug: "codex-cli-smoke",
					suiteSlug: "SWE-bench_Verified",
					limit: 1,
					tags: ["smoke"],
				}),
			}),
		} as never)) as Response;

		expect(response.status).toBe(201);
		expect(mocks.requireInternal).toHaveBeenCalled();
		expect(mocks.selectExactReady).toHaveBeenCalledWith({
			suiteSlug: "SWE-bench_Verified",
			instanceIds: undefined,
			limit: 1,
			syncBuildStatuses: true,
		});
		expect(mocks.createBenchmarkRun).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "project-1",
				userId: "user-1",
				agentId: undefined,
				agentSlug: "codex-cli-smoke",
				instanceIds: ["astropy__astropy-7166"],
				tags: ["operator", "smoke"],
				requirePrevalidatedEnvironments: true,
			}),
		);
		expect(mocks.startSwebenchCoordinator).toHaveBeenCalledWith("run-1");
		expect(mocks.markBenchmarkRunStatus).toHaveBeenCalledWith("run-1", "queued", {
			coordinatorExecutionId: "coord-1",
		});
	});
});
