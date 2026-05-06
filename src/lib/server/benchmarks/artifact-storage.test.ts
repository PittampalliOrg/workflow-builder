import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("$env/dynamic/private", () => ({ env: process.env }));
vi.mock("$lib/server/db", () => ({ db: null }));

import {
	benchmarkArtifactObjectKey,
	getBenchmarkArtifact,
	normalizeBenchmarkArtifactPath,
	putBenchmarkArtifact,
} from "./artifact-storage";

beforeEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("benchmark artifact storage", () => {
	it("rejects traversal paths", () => {
		expect(() => normalizeBenchmarkArtifactPath("../secret")).toThrow(/relative/);
		expect(() => normalizeBenchmarkArtifactPath("run/../../secret")).toThrow(
			/relative/,
		);
		expect(normalizeBenchmarkArtifactPath("/instance/report.json")).toBe(
			"instance/report.json",
		);
	});

	it("builds stable prefixed object keys", () => {
		vi.stubEnv("SWEBENCH_ARTIFACT_PREFIX", "swebench/dev/");
		expect(benchmarkArtifactObjectKey("run_1", "sympy__x/report.json")).toBe(
			"swebench/dev/run_1/sympy__x/report.json",
		);
	});

	it("uploads through the Dapr blob binding with base64 content", async () => {
		vi.stubEnv("SWEBENCH_ARTIFACT_STORAGE_BACKEND", "dapr-blob");
		vi.stubEnv("SWEBENCH_ARTIFACT_DAPR_BINDING", "swebench-artifacts");
		vi.stubEnv("DAPR_HTTP_PORT", "3500");
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ blobURL: "https://example/blob" }), {
				status: 200,
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await putBenchmarkArtifact({
			runId: "run_1",
			path: "predictions.jsonl",
			body: new TextEncoder().encode("hello"),
			record: false,
		});

		expect(result.objectKey).toBe("swebench/dev/run_1/predictions.jsonl");
		expect(fetchMock).toHaveBeenCalledWith(
			"http://localhost:3500/v1.0/bindings/swebench-artifacts",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					operation: "create",
					metadata: { blobName: "swebench/dev/run_1/predictions.jsonl" },
					data: "aGVsbG8=",
				}),
			}),
		);
	});

	it("treats Dapr blob binding not-found failures as missing artifacts", async () => {
		vi.stubEnv("SWEBENCH_ARTIFACT_STORAGE_BACKEND", "dapr-blob");
		vi.stubEnv("SWEBENCH_ARTIFACT_DAPR_BINDING", "swebench-artifacts");
		vi.stubEnv("DAPR_HTTP_PORT", "3500");
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						errorCode: "ERR_INVOKE_OUTPUT_BINDING",
						message: "error invoking output binding swebench-artifacts: blob not found",
					}),
					{ status: 500 },
				),
			),
		);

		await expect(getBenchmarkArtifact("run_1", "instance/.status")).resolves.toBeNull();
	});
});
