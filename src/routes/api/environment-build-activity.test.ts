import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentBuildActivityResponse } from "$lib/server/application/environment-build-activity";
import { GET as getRunActivity } from "./benchmarks/runs/[runId]/activity/+server";
import { GET as getBuildActivity } from "./environment-builds/[buildId]/activity/+server";
import { GET as getBuildStream } from "./environment-builds/[buildId]/stream/+server";

const mocks = vi.hoisted(() => ({
	environmentBuildActivity: {
		getBenchmarkRunActivity: vi.fn(),
		getBuildActivity: vi.fn(),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		environmentBuildActivity: mocks.environmentBuildActivity,
	}),
}));

describe("environment build activity API", () => {
	beforeEach(() => {
		mocks.environmentBuildActivity.getBenchmarkRunActivity.mockReset();
		mocks.environmentBuildActivity.getBuildActivity.mockReset();
	});

	it("returns a build snapshot and activity events without forcing sync when requested", async () => {
		mocks.environmentBuildActivity.getBuildActivity.mockResolvedValue(
			sampleActivity(),
		);

		const response = (await getBuildActivity({
			params: { buildId: "build_1" },
			locals: { session: { userId: "user_1", projectId: "project_1" } },
			url: new URL(
				"http://localhost/api/environment-builds/build_1/activity?sync=0",
			),
		} as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			build: { id: "build_1", status: "validated" },
			events: [{ id: "event_1", eventType: "build_succeeded" }],
		});
		expect(
			mocks.environmentBuildActivity.getBuildActivity,
		).toHaveBeenCalledWith("build_1", {
			sync: false,
			forceTerminal: true,
		});
	});

	it("returns environment build activity grouped by benchmark instance", async () => {
		mocks.environmentBuildActivity.getBenchmarkRunActivity.mockResolvedValue({
			runId: "run_1",
			instances: [
				{
					runInstanceId: "run_instance_1",
					instanceId: "sympy__sympy-20590",
					build: sampleActivity().build,
					events: sampleActivity().events,
					latestEvent: sampleActivity().latestEvent,
				},
			],
		});

		const response = (await getRunActivity({
			params: { runId: "run_1" },
			locals: { session: { userId: "user_1", projectId: "project_1" } },
			url: new URL(
				"http://localhost/api/benchmarks/runs/run_1/activity?sync=1",
			),
		} as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			runId: "run_1",
			instances: [
				{
					instanceId: "sympy__sympy-20590",
					build: { id: "build_1" },
					events: [{ eventType: "build_succeeded" }],
				},
			],
		});
		expect(
			mocks.environmentBuildActivity.getBenchmarkRunActivity,
		).toHaveBeenCalledWith("project_1", "run_1", { syncActive: true });
	});

	it("streams snapshots, new activity events, and terminal status over SSE", async () => {
		mocks.environmentBuildActivity.getBuildActivity.mockResolvedValue(
			sampleActivity(),
		);

		const response = (await getBuildStream({
			params: { buildId: "build_1" },
			locals: { session: { userId: "user_1", projectId: "project_1" } },
			request: new Request(
				"http://localhost/api/environment-builds/build_1/stream",
			),
		} as never)) as Response;

		expect(response.headers.get("content-type")).toBe("text/event-stream");
		const body = await response.text();
		expect(body).toContain("event: snapshot\n");
		expect(body).toContain("event: activity_event\n");
		expect(body).toContain('"eventType":"build_succeeded"');
		expect(body).toContain("event: heartbeat\n");
		expect(body).toContain('"final":true');
		expect(body).toContain("event: terminal\n");
		expect(body).toContain('"status":"validated"');
		expect(
			mocks.environmentBuildActivity.getBuildActivity,
		).toHaveBeenCalledWith("build_1", {
			sync: true,
			forceTerminal: true,
		});
	});

	it("keeps activity routes behind application services", () => {
		for (const relative of [
			"environment-builds/[buildId]/activity/+server.ts",
			"environment-builds/[buildId]/stream/+server.ts",
			"benchmarks/runs/[runId]/activity/+server.ts",
		]) {
			const source = readFileSync(
				join(dirname(fileURLToPath(import.meta.url)), relative),
				"utf8",
			);
			expect(source).toContain("getApplicationAdapters");
			expect(source).toContain("environmentBuildActivity");
			expect(source).not.toContain(
				"$lib/server/environments/environment-image-builds",
			);
			expect(source).not.toContain("$lib/server/db");
			expect(source).not.toContain("drizzle-orm");
		}
	});
});

function sampleActivity(): EnvironmentBuildActivityResponse {
	const timestamp = "2026-04-28T12:00:00.000Z";
	return {
		build: {
			id: "build_1",
			dataset: "SWE-bench/SWE-bench_Lite",
			suite: "SWE-bench_Lite",
			repo: "sympy/sympy",
			version: "1.7",
			environmentSetupCommit: null,
			baseCommit: "abc123",
			environmentKey: "sympy-1.7",
			envSpecHash: "a".repeat(64),
			buildStrategy: "swebench-harness",
			workspaceRoot: "/testbed",
			condaEnvironment: "testbed",
			swebenchSpec: {
				instanceImageKey: "sweb.eval.x86_64.sympy_1776_sympy-1.7",
			},
			status: "validated",
			sandboxTemplate: "dapr-agent",
			sandboxImage: "registry/swebench@sha256:111",
			digest: "sha256:111",
			imageName: "swebench-inference-sympy-1.7",
			imageTag: "env-abc",
			dockerfilePath: "Dockerfile",
			validationCommand: "python -m pytest --version",
			validationStatus: "validated",
			validationLogRef: "tekton://taskruns/validate-image",
			buildLogRef: "tekton://pipelineruns/tekton-pipelines/swe-env-abc",
			pipelineRunName: "swe-env-abc",
			pipelineRunNamespace: "tekton-pipelines",
			pipelineRunUrl:
				"https://tekton.example/namespaces/tekton-pipelines/pipelineruns/swe-env-abc",
			error: null,
			requestedAt: timestamp,
			startedAt: timestamp,
			completedAt: timestamp,
			builtAt: timestamp,
			createdAt: timestamp,
			updatedAt: timestamp,
		},
		events: [
			{
				id: "event_1",
				buildId: "build_1",
				environmentKey: "sympy-1.7",
				eventKey:
					"build_succeeded|tekton-pipelines|swe-env-abc||succeeded|2026-04-28T12:00:00.000Z",
				eventType: "build_succeeded",
				pipelineRunName: "swe-env-abc",
				pipelineRunNamespace: "tekton-pipelines",
				taskRunName: null,
				phase: "Succeeded",
				reason: "Succeeded",
				message: "Environment image build succeeded",
				timestamp,
				rawMetadata: {},
				createdAt: timestamp,
				updatedAt: timestamp,
			},
		],
		latestEvent: {
			id: "event_1",
			buildId: "build_1",
			environmentKey: "sympy-1.7",
			eventKey:
				"build_succeeded|tekton-pipelines|swe-env-abc||succeeded|2026-04-28T12:00:00.000Z",
			eventType: "build_succeeded",
			pipelineRunName: "swe-env-abc",
			pipelineRunNamespace: "tekton-pipelines",
			taskRunName: null,
			phase: "Succeeded",
			reason: "Succeeded",
			message: "Environment image build succeeded",
			timestamp,
			rawMetadata: {},
			createdAt: timestamp,
			updatedAt: timestamp,
		},
	};
}
