import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import {
	deleteBenchmarkArtifact,
	getBenchmarkArtifact,
	normalizeBenchmarkArtifactPath,
	putBenchmarkArtifact,
} from "$lib/server/benchmarks/artifact-storage";
import type { BenchmarkArtifactKind } from "$lib/server/db/schema";

const VALID_ARTIFACT_KINDS = new Set<BenchmarkArtifactKind>([
	"dataset_jsonl",
	"predictions_jsonl",
	"model_patch",
	"harness_result",
	"logs",
	"test_output",
]);

export const PUT: RequestHandler = async ({ request, params, url }) => {
	requireInternal(request);
	const artifactPath = normalizePathParam(params.artifactPath);
	const body = new Uint8Array(await request.arrayBuffer());
	const kind = artifactKind(
		request.headers.get("x-benchmark-artifact-kind") ||
			url.searchParams.get("kind"),
	);
	const instanceId =
		request.headers.get("x-benchmark-instance-id") ||
		url.searchParams.get("instanceId") ||
		null;
	const result = await putBenchmarkArtifact({
		runId: params.runId,
		path: artifactPath,
		body,
		contentType: request.headers.get("content-type"),
		kind,
		instanceId,
		metadata: {
			source: "internal-artifact-api",
			uploadedAt: new Date().toISOString(),
		},
		record: url.searchParams.get("record") !== "false",
	});
	return json({ success: true, ...result });
};

export const GET: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const artifactPath = normalizePathParam(params.artifactPath);
	const artifact = await getBenchmarkArtifact(params.runId, artifactPath);
	if (!artifact) return error(404, "Artifact not found");
	const body = Buffer.from(artifact.body) as unknown as BodyInit;
	return new Response(body, {
		headers: {
			"Content-Type": artifact.contentType || contentTypeForPath(artifactPath),
			"Cache-Control": "no-store",
			"X-Artifact-Backend": artifact.backend,
			"X-Artifact-Object-Key": artifact.objectKey,
		},
	});
};

export const DELETE: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const artifactPath = normalizePathParam(params.artifactPath);
	await deleteBenchmarkArtifact(params.runId, artifactPath);
	return json({ success: true });
};

function normalizePathParam(value: string | undefined): string {
	try {
		return normalizeBenchmarkArtifactPath(value ?? "");
	} catch (err) {
		throw error(400, err instanceof Error ? err.message : "invalid artifact path");
	}
}

function artifactKind(value: string | null): BenchmarkArtifactKind | null {
	if (!value) return null;
	const normalized = value.trim() as BenchmarkArtifactKind;
	if (!VALID_ARTIFACT_KINDS.has(normalized)) {
		throw error(400, `Unsupported benchmark artifact kind: ${value}`);
	}
	return normalized;
}

function contentTypeForPath(path: string): string {
	if (path.endsWith(".json")) return "application/json; charset=utf-8";
	if (path.endsWith(".jsonl")) return "application/jsonl; charset=utf-8";
	if (path.endsWith(".diff") || path.endsWith(".patch")) return "text/x-diff; charset=utf-8";
	if (path.endsWith(".sh")) return "text/x-shellscript; charset=utf-8";
	return "text/plain; charset=utf-8";
}
