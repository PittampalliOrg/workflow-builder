import { error, json } from "@sveltejs/kit";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db";
import {
	benchmarkInstances,
	benchmarkSuites,
	environmentImageBuilds,
	type BenchmarkInstance,
} from "$lib/server/db/schema";
import {
	isExactValidatedSwebenchInferenceEnvironment,
	loadSwebenchInferenceEnvironmentMappings,
} from "$lib/server/benchmarks/inference-environments";
import {
	normalizeInstanceIds,
	normalizeSwebenchSuiteSlug,
	type SwebenchSuiteSlug,
} from "$lib/server/benchmarks/swebench";
import {
	buildSwebenchEnvironmentSpec,
	ensureSwebenchEnvironment,
} from "$lib/server/environments/environment-image-builds";

const DEFAULT_VALIDATION_LIMIT = 10;
const MAX_VALIDATION_LIMIT = 100;

type EnvironmentStatus = "validated" | "building" | "failed" | "not_built";

type BuildProjection = {
	envSpecHash: string;
	status: "queued" | "building" | "validated" | "failed" | "cancelled";
	validationStatus: string | null;
	sandboxImage: string | null;
	digest: string | null;
	environmentKey: string | null;
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!db) return error(503, "Database not configured");
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const suiteSlug = requireSuiteSlug(body.suiteSlug ?? body.suite);
	const requestedInstanceIds = normalizeInstanceIds(
		body.instanceIds ?? body.selectedInstanceIds ?? [],
	);
	const limit = clampInt(body.limit, 1, MAX_VALIDATION_LIMIT, DEFAULT_VALIDATION_LIMIT);
	const targetValidatedCount =
		body.targetValidatedCount == null
			? null
			: clampInt(body.targetValidatedCount, 1, 500, limit);

	const [suite] = await db
		.select()
		.from(benchmarkSuites)
		.where(eq(benchmarkSuites.slug, suiteSlug))
		.limit(1);
	if (!suite) return error(400, `Unsupported benchmark suite: ${suiteSlug}`);

	const rows = await db
		.select()
		.from(benchmarkInstances)
		.where(
			requestedInstanceIds.length > 0
				? and(
						eq(benchmarkInstances.suiteId, suite.id),
						inArray(benchmarkInstances.instanceId, requestedInstanceIds),
					)
				: eq(benchmarkInstances.suiteId, suite.id),
		)
		.orderBy(asc(benchmarkInstances.instanceId));
	const foundIds = new Set(rows.map((row) => row.instanceId));
	const missingInstanceIds = requestedInstanceIds.filter((id) => !foundIds.has(id));
	if (missingInstanceIds.length > 0) {
		return error(
			409,
			`SWE-bench metadata has not been imported for ${missingInstanceIds.length} selected instance(s): ${missingInstanceIds.slice(0, 20).join(", ")}`,
		);
	}

	const buildStatusByHash = await loadBuildStatusByHash(suiteSlug);
	const mappings = loadSwebenchInferenceEnvironmentMappings();
	const planned = rows.map((row) => {
		const status = classifyInstanceEnvironment({
			row,
			suiteSlug,
			datasetName: suite.datasetName,
			buildStatusByHash,
			mappings,
		});
		return { row, ...status };
	});

	const alreadyValidated = planned.filter((item) => item.status === "validated").length;
	const alreadyBuilding = planned.filter((item) => item.status === "building").length;
	const failed = planned.filter((item) => item.status === "failed").length;
	const eligible = planned.filter(
		(item) =>
			item.status === "not_built" &&
			Boolean(item.envSpecHash) &&
			Boolean(item.row.repo) &&
			Boolean(item.row.baseCommit),
	);
	const requestedBuildCount =
		targetValidatedCount == null
			? limit
			: Math.max(targetValidatedCount - alreadyValidated - alreadyBuilding, 0);
	const selected = eligible.slice(0, Math.min(limit, requestedBuildCount));

	const results = [];
	for (const item of selected) {
		const result = await ensureSwebenchEnvironment({
			dataset: suite.datasetName,
			suiteSlug,
			instanceId: item.row.instanceId,
			repo: item.row.repo!,
			baseCommit: item.row.baseCommit!,
			testMetadata: isRecord(item.row.testMetadata) ? item.row.testMetadata : {},
			allowBuild: true,
		});
		results.push({
			instanceId: item.row.instanceId,
			environmentKey: result.environmentKey ?? item.environmentKey ?? null,
			envSpecHash: result.envSpecHash ?? item.envSpecHash ?? null,
			status: result.status,
			environmentStatus: result.environmentStatus,
			buildId: result.buildId ?? null,
			pipelineRunName: result.pipelineRunName ?? null,
			pipelineRunNamespace: result.pipelineRunNamespace ?? null,
			error: result.error ?? null,
			reason: result.reason ?? null,
		});
	}

	const submitted = results.filter(
		(result) =>
			result.environmentStatus === "building" ||
			result.environmentStatus === "validated" ||
			Boolean(result.pipelineRunName),
	).length;

	return json({
		suiteSlug,
		limit,
		targetValidatedCount,
		missingInstanceIds,
		coverage: {
			total: planned.length,
			validated: alreadyValidated,
			building: alreadyBuilding,
			failed,
			notBuilt: planned.filter((item) => item.status === "not_built").length,
		},
		selected: selected.length,
		submitted,
		results,
		skipped: {
			alreadyValidated,
			alreadyBuilding,
			failedRequiresReset: failed,
			missingMetadata: planned.filter(
				(item) => !item.row.repo || !item.row.baseCommit,
			).length,
		},
	});
};

async function loadBuildStatusByHash(
	suiteSlug: SwebenchSuiteSlug,
): Promise<Map<string, BuildProjection>> {
	const rows = await db!
		.select({
			envSpecHash: environmentImageBuilds.envSpecHash,
			status: environmentImageBuilds.status,
			validationStatus: environmentImageBuilds.validationStatus,
			sandboxImage: environmentImageBuilds.sandboxImage,
			digest: environmentImageBuilds.digest,
			environmentKey: environmentImageBuilds.environmentKey,
		})
		.from(environmentImageBuilds)
		.where(eq(environmentImageBuilds.suite, suiteSlug))
		.orderBy(desc(environmentImageBuilds.updatedAt));
	const byHash = new Map<string, BuildProjection>();
	for (const row of rows) {
		if (!row.envSpecHash || byHash.has(row.envSpecHash)) continue;
		byHash.set(row.envSpecHash, row);
	}
	return byHash;
}

function classifyInstanceEnvironment(input: {
	row: BenchmarkInstance;
	suiteSlug: SwebenchSuiteSlug;
	datasetName: string;
	buildStatusByHash: Map<string, BuildProjection>;
	mappings: ReturnType<typeof loadSwebenchInferenceEnvironmentMappings>;
}): {
	status: EnvironmentStatus;
	envSpecHash: string | null;
	environmentKey: string | null;
} {
	const metadata = isRecord(input.row.testMetadata) ? input.row.testMetadata : {};
	if (!input.row.repo || !input.row.baseCommit) {
		return { status: "failed", envSpecHash: null, environmentKey: null };
	}
	const spec = buildSwebenchEnvironmentSpec({
		dataset: input.datasetName,
		suiteSlug: input.suiteSlug,
		instanceId: input.row.instanceId,
		repo: input.row.repo,
		baseCommit: input.row.baseCommit,
		testMetadata: metadata,
	});
	if (
		isExactValidatedSwebenchInferenceEnvironment(
			{
				suiteSlug: input.suiteSlug,
				repo: input.row.repo,
				baseCommit: input.row.baseCommit,
				testMetadata: metadata,
			},
			spec.envSpecHash,
			{ mappings: input.mappings },
		)
	) {
		return {
			status: "validated",
			envSpecHash: spec.envSpecHash,
			environmentKey: spec.environmentKey,
		};
	}
	const build = input.buildStatusByHash.get(spec.envSpecHash);
	if (!build) {
		return {
			status: "not_built",
			envSpecHash: spec.envSpecHash,
			environmentKey: spec.environmentKey,
		};
	}
	if (
		build.status === "validated" &&
		build.validationStatus === "validated" &&
		build.sandboxImage &&
		build.digest
	) {
		return {
			status: "validated",
			envSpecHash: spec.envSpecHash,
			environmentKey: build.environmentKey ?? spec.environmentKey,
		};
	}
	if (build.status === "queued" || build.status === "building") {
		return {
			status: "building",
			envSpecHash: spec.envSpecHash,
			environmentKey: build.environmentKey ?? spec.environmentKey,
		};
	}
	return {
		status: "failed",
		envSpecHash: spec.envSpecHash,
		environmentKey: build.environmentKey ?? spec.environmentKey,
	};
}

function requireSuiteSlug(value: unknown): SwebenchSuiteSlug {
	if (typeof value !== "string" || !value.trim()) {
		throw error(400, "suiteSlug is required");
	}
	return normalizeSwebenchSuiteSlug(value);
}

function clampInt(
	value: unknown,
	min: number,
	max: number,
	fallback: number,
): number {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number.parseInt(value, 10)
				: NaN;
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
