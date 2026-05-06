import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/private", () => ({ env: process.env }));
vi.mock("$env/dynamic/public", () => ({ env: process.env }));

import {
	downloadMlflowJsonArtifact,
	listMlflowArtifacts,
	logMlflowJsonArtifact,
	publicMlflowTracesUrl,
	publicWorkflowBuilderTraceUrl,
} from "./mlflow";

beforeEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.stubEnv("MLFLOW_TRACKING_URI", "http://mlflow.test");
});

describe("publicMlflowTracesUrl", () => {
	it("routes benchmark trace links through the trace-experiment redirect", () => {
		expect(publicMlflowTracesUrl("1", "abc123")).toBe(
			"/api/observability/mlflow/traces/abc123",
		);
	});

	it("omits links when no trace id was recorded", () => {
		expect(publicMlflowTracesUrl("1", null)).toBeNull();
	});

	it("builds absolute workflow-builder trace redirects when the app URL is configured", () => {
		vi.stubEnv("APP_PUBLIC_URL", "https://workflow-builder-dev.example.com/");

		expect(publicWorkflowBuilderTraceUrl("abc123")).toBe(
			"https://workflow-builder-dev.example.com/api/observability/mlflow/traces/abc123",
		);
	});
});

describe("MLflow artifact helpers", () => {
	it("lists run artifacts through the tracking API", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					files: [{ path: "traces/django/trace-bundle.json", is_dir: false, file_size: 42 }],
				}),
				{ status: 200 },
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		const files = await listMlflowArtifacts("run-1", "traces/django");

		expect(files).toEqual([
			{ path: "traces/django/trace-bundle.json", isDir: false, fileSize: 42 },
		]);
		expect(fetchMock).toHaveBeenCalledWith(
			"http://mlflow.test/api/2.0/mlflow/artifacts/list?run_id=run-1&path=traces%2Fdjango",
			expect.objectContaining({ method: "GET" }),
		);
	});

	it("downloads JSON artifacts after confirming the path exists", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						files: [{ path: "traces/django/trace-bundle.json", is_dir: false }],
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(new Response("{\"ok\":true}", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			downloadMlflowJsonArtifact("run-1", "traces/django/trace-bundle.json"),
		).resolves.toEqual({ ok: true });
		expect(fetchMock.mock.calls[1][0]).toBe(
			"http://mlflow.test/api/2.0/mlflow-artifacts/artifacts/traces/django/trace-bundle.json?run_id=run-1",
		);
	});

	it("downloads JSON artifacts directly when MLflow list omits files", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({ root_uri: "/artifacts" }), { status: 200 }))
			.mockResolvedValueOnce(new Response("{\"ok\":true}", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			downloadMlflowJsonArtifact("run-1", "traces/django/trace-bundle.json"),
		).resolves.toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("uploads JSON artifacts through the MLflow artifact API", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await logMlflowJsonArtifact({
			runId: "run-1",
			artifactPath: "traces/django/trace-bundle.json",
			value: { ok: true },
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"http://mlflow.test/api/2.0/mlflow-artifacts/artifacts/traces/django/trace-bundle.json?run_id=run-1",
			expect.objectContaining({
				method: "PUT",
				body: "{\n  \"ok\": true\n}\n",
			}),
		);
	});

	it("returns null when a JSON artifact is absent", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(new Response(JSON.stringify({ files: [] }), { status: 200 }))
				.mockResolvedValue(new Response("missing", { status: 404 })),
		);

		await expect(
			downloadMlflowJsonArtifact("run-1", "traces/missing/trace-bundle.json"),
		).resolves.toBeNull();
	});
});
