import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { env } from "$env/dynamic/private";
import { db } from "$lib/server/db";
import {
	benchmarkArtifacts,
	benchmarkRunInstances,
	type BenchmarkArtifactKind,
} from "$lib/server/db/schema";
import { getDaprSidecarUrl } from "$lib/server/dapr-client";

const DEFAULT_LOCAL_ROOT = "/artifacts";
const DEFAULT_BINDING_NAME = "swebench-artifacts";
const DEFAULT_OBJECT_PREFIX = "swebench";

export type BenchmarkArtifactUpload = {
	runId: string;
	path: string;
	body: Uint8Array;
	contentType?: string | null;
	kind?: BenchmarkArtifactKind | null;
	instanceId?: string | null;
	metadata?: Record<string, unknown>;
	record?: boolean;
};

export type BenchmarkArtifactDownload = {
	body: Uint8Array;
	contentType: string | null;
	backend: string;
	objectKey: string;
};

export function normalizeBenchmarkArtifactPath(path: string): string {
	const cleaned = path.trim().replace(/^\/+/, "");
	if (!cleaned) throw new Error("artifact path is required");
	const parts = cleaned.split("/").filter(Boolean);
	if (
		parts.length === 0 ||
		parts.some((part) => part === "." || part === ".." || part.includes("\0"))
	) {
		throw new Error("artifact path must be relative and cannot contain traversal segments");
	}
	return parts.join("/");
}

export function benchmarkArtifactSha256(body: Uint8Array): string {
	return createHash("sha256").update(body).digest("hex");
}

export function benchmarkArtifactBackend(): string {
	return (env.SWEBENCH_ARTIFACT_STORAGE_BACKEND || "local").trim().toLowerCase();
}

function localArtifactRoot(): string {
	return env.SWEBENCH_ARTIFACT_ROOT || DEFAULT_LOCAL_ROOT;
}

function objectPrefix(): string {
	const environment = (env.WORKFLOW_BUILDER_ENV || "dev")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-|-$/g, "") || "dev";
	return normalizePrefix(
		env.SWEBENCH_ARTIFACT_PREFIX || `${DEFAULT_OBJECT_PREFIX}/${environment}`,
	);
}

function normalizePrefix(prefix: string): string {
	return prefix
		.trim()
		.replace(/^\/+|\/+$/g, "")
		.split("/")
		.filter(Boolean)
		.map((part) => normalizeBenchmarkArtifactPath(part))
		.join("/");
}

export function benchmarkArtifactObjectKey(runId: string, path: string): string {
	const relPath = normalizeBenchmarkArtifactPath(path);
	const runPart = normalizeBenchmarkArtifactPath(runId);
	const prefix = objectPrefix();
	return [prefix, runPart, relPath].filter(Boolean).join("/");
}

function localArtifactFile(runId: string, path: string): string {
	return join(
		localArtifactRoot(),
		normalizeBenchmarkArtifactPath(runId),
		normalizeBenchmarkArtifactPath(path),
	);
}

export async function putBenchmarkArtifact(
	input: BenchmarkArtifactUpload,
): Promise<{
	path: string;
	backend: string;
	objectKey: string;
	sha256: string;
	sizeBytes: number;
}> {
	const path = normalizeBenchmarkArtifactPath(input.path);
	const backend = benchmarkArtifactBackend();
	const objectKey =
		backend === "dapr-blob" || backend === "dapr_blob" || backend === "azure-blob"
			? benchmarkArtifactObjectKey(input.runId, path)
			: `${normalizeBenchmarkArtifactPath(input.runId)}/${path}`;

	if (backend === "dapr-blob" || backend === "dapr_blob" || backend === "azure-blob") {
		await invokeDaprBlobBinding("create", input.body, { blobName: objectKey });
	} else {
		const file = localArtifactFile(input.runId, path);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, input.body);
	}

	const sha256 = benchmarkArtifactSha256(input.body);
	if (input.record !== false && input.kind) {
		await recordBenchmarkArtifact({
			runId: input.runId,
			instanceId: input.instanceId ?? null,
			kind: input.kind,
			path,
			contentType: input.contentType ?? null,
			sizeBytes: input.body.byteLength,
			sha256,
			metadata: {
				...(input.metadata ?? {}),
				backend,
				objectKey,
			},
		});
	}
	return { path, backend, objectKey, sha256, sizeBytes: input.body.byteLength };
}

export async function getBenchmarkArtifact(
	runId: string,
	path: string,
): Promise<BenchmarkArtifactDownload | null> {
	const relPath = normalizeBenchmarkArtifactPath(path);
	const backend = benchmarkArtifactBackend();
	if (backend === "dapr-blob" || backend === "dapr_blob" || backend === "azure-blob") {
		const objectKey = benchmarkArtifactObjectKey(runId, relPath);
		const response = await invokeDaprBlobBinding("get", null, { blobName: objectKey });
		if (response.status === 404) return null;
		if (!response.ok) {
			throw new Error(
				`Dapr blob get failed for ${objectKey}: ${response.status} ${await response.text()}`,
			);
		}
		return {
			body: new Uint8Array(await response.arrayBuffer()),
			contentType: response.headers.get("content-type"),
			backend,
			objectKey,
		};
	}

	const file = localArtifactFile(runId, relPath);
	try {
		return {
			body: await readFile(file),
			contentType: null,
			backend,
			objectKey: `${normalizeBenchmarkArtifactPath(runId)}/${relPath}`,
		};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

export async function deleteBenchmarkArtifact(runId: string, path: string) {
	const relPath = normalizeBenchmarkArtifactPath(path);
	const backend = benchmarkArtifactBackend();
	if (backend === "dapr-blob" || backend === "dapr_blob" || backend === "azure-blob") {
		const objectKey = benchmarkArtifactObjectKey(runId, relPath);
		const response = await invokeDaprBlobBinding("delete", null, { blobName: objectKey });
		if (!response.ok && response.status !== 404) {
			throw new Error(
				`Dapr blob delete failed for ${objectKey}: ${response.status} ${await response.text()}`,
			);
		}
		return;
	}
	await rm(localArtifactFile(runId, relPath), { force: true });
}

async function recordBenchmarkArtifact(input: {
	runId: string;
	instanceId: string | null;
	kind: BenchmarkArtifactKind;
	path: string;
	contentType: string | null;
	sizeBytes: number;
	sha256: string;
	metadata: Record<string, unknown>;
}) {
	if (!db) throw new Error("Database not configured");
	let runInstanceId: string | null = null;
	if (input.instanceId) {
		const [row] = await db
			.select({ id: benchmarkRunInstances.id })
			.from(benchmarkRunInstances)
			.where(
				and(
					eq(benchmarkRunInstances.runId, input.runId),
					eq(benchmarkRunInstances.instanceId, input.instanceId),
				),
			)
			.limit(1);
		runInstanceId = row?.id ?? null;
	}
	await db.insert(benchmarkArtifacts).values({
		runId: input.runId,
		runInstanceId,
		kind: input.kind,
		path: input.path,
		contentType: input.contentType,
		sizeBytes: input.sizeBytes,
		sha256: input.sha256,
		metadata: input.metadata,
	});
}

async function invokeDaprBlobBinding(
	operation: "create" | "get" | "delete" | "list",
	body: Uint8Array | null,
	metadata: Record<string, string>,
): Promise<Response> {
	const bindingName = env.SWEBENCH_ARTIFACT_DAPR_BINDING || DEFAULT_BINDING_NAME;
	const payload: Record<string, unknown> = { operation, metadata };
	if (body) payload.data = Buffer.from(body).toString("base64");
	const response = await fetch(
		`${getDaprSidecarUrl()}/v1.0/bindings/${encodeURIComponent(bindingName)}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		},
	);
	if (operation !== "get" && !response.ok) {
		throw new Error(
			`Dapr blob ${operation} failed: ${response.status} ${await response.text()}`,
		);
	}
	return response;
}
