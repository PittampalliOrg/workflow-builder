import { and, asc, desc, eq, inArray } from "drizzle-orm";
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
	type SwebenchInferenceEnvironmentMapping,
} from "$lib/server/benchmarks/inference-environments";
import {
	normalizeInstanceIds,
	normalizeSwebenchSuiteSlug,
	type SwebenchSuiteSlug,
} from "$lib/server/benchmarks/swebench";
import {
	buildSwebenchEnvironmentSpec,
	ensureSwebenchEnvironment,
	syncEnvironmentBuild,
} from "$lib/server/environments/environment-image-builds";
import { ensureDefaultBenchmarkSuites } from "$lib/server/benchmarks/service";

export type SwebenchEnvironmentStatus =
	| "validated"
	| "building"
	| "failed"
	| "not_built";

export type SwebenchEnvironmentBuildProjection = {
	envSpecHash: string;
	status: "queued" | "building" | "validated" | "failed" | "cancelled";
	validationStatus: string | null;
	sandboxImage: string | null;
	digest: string | null;
	environmentKey: string | null;
	pipelineRunName: string | null;
	pipelineRunNamespace: string | null;
	id: string | null;
};

export type PlannedSwebenchEnvironment = {
	row: BenchmarkInstance;
	status: SwebenchEnvironmentStatus;
	envSpecHash: string | null;
	environmentKey: string | null;
};

export type SwebenchEnvironmentPlan = {
	suite: {
		id: string;
		slug: SwebenchSuiteSlug;
		datasetName: string;
	};
	suiteSlug: SwebenchSuiteSlug;
	requestedInstanceIds: string[];
	missingInstanceIds: string[];
	planned: PlannedSwebenchEnvironment[];
	coverage: {
		total: number;
		validated: number;
		building: number;
		failed: number;
		notBuilt: number;
		missingMetadata: number;
	};
	nextExactReadyInstanceIds: string[];
};

export type ExactReadySelection = {
	suiteSlug: SwebenchSuiteSlug;
	requestedLimit: number;
	selectedInstanceIds: string[];
	selectedCount: number;
	missingValidatedCount: number;
	primaryLimiter: "selected_instance_count" | null;
	missingInstanceIds: string[];
	missingExactInstanceIds: string[];
	coverage: SwebenchEnvironmentPlan["coverage"];
	nextExactReadyInstanceIds: string[];
};

export type EnvironmentValidationSubmission = {
	instanceId: string;
	environmentKey: string | null;
	envSpecHash: string | null;
	status: string;
	environmentStatus: string;
	buildId: string | null;
	pipelineRunName: string | null;
	pipelineRunNamespace: string | null;
	error: string | null;
	reason: string | null;
};

export async function planSwebenchEnvironmentValidation(input: {
	suiteSlug: SwebenchSuiteSlug | string;
	instanceIds?: unknown;
	limit?: number | null;
	syncBuildStatuses?: boolean;
}): Promise<SwebenchEnvironmentPlan> {
	const database = db;
	if (!database) throw new Error("Database not configured");
	const suiteSlug = normalizeSwebenchSuiteSlug(String(input.suiteSlug));
	const requestedInstanceIds = normalizeInstanceIds(input.instanceIds);
	await ensureDefaultBenchmarkSuites();
	const [suite] = await database
		.select({
			id: benchmarkSuites.id,
			slug: benchmarkSuites.slug,
			datasetName: benchmarkSuites.datasetName,
		})
		.from(benchmarkSuites)
		.where(eq(benchmarkSuites.slug, suiteSlug))
		.limit(1);
	if (!suite) throw new Error(`Unsupported benchmark suite: ${suiteSlug}`);

	const query = database
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
	const rows =
		requestedInstanceIds.length > 0 || !input.limit
			? await query
			: await query.limit(Math.max(input.limit, 1));
	const foundIds = new Set(rows.map((row) => row.instanceId));
	const missingInstanceIds = requestedInstanceIds.filter((id) => !foundIds.has(id));

	let buildStatusByHash = await loadSwebenchEnvironmentBuildStatusByHash(suiteSlug);
	const mappings = loadSwebenchInferenceEnvironmentMappings();
	let planned = classifyRows({
		rows,
		suiteSlug,
		datasetName: suite.datasetName,
		buildStatusByHash,
		mappings,
	});
	if (input.syncBuildStatuses) {
		await syncSelectableEnvironmentBuilds(
			planned
				.map((item) => item.envSpecHash)
				.filter((hash): hash is string => Boolean(hash)),
		);
		buildStatusByHash = await loadSwebenchEnvironmentBuildStatusByHash(suiteSlug);
		planned = classifyRows({
			rows,
			suiteSlug,
			datasetName: suite.datasetName,
			buildStatusByHash,
			mappings,
		});
	}

	return {
		suite: {
			id: suite.id,
			slug: suite.slug as SwebenchSuiteSlug,
			datasetName: suite.datasetName,
		},
		suiteSlug,
		requestedInstanceIds,
		missingInstanceIds,
		planned,
		coverage: summarizeEnvironmentPlan(planned),
		nextExactReadyInstanceIds: planned
			.filter((item) => item.status === "validated")
			.map((item) => item.row.instanceId),
	};
}

export async function selectExactReadySwebenchInstanceIds(input: {
	suiteSlug: SwebenchSuiteSlug | string;
	instanceIds?: unknown;
	limit?: number | null;
	syncBuildStatuses?: boolean;
}): Promise<ExactReadySelection> {
	const requestedInstanceIds = normalizeInstanceIds(input.instanceIds);
	const requestedLimit =
		input.limit && input.limit > 0
			? Math.trunc(input.limit)
			: requestedInstanceIds.length > 0
				? requestedInstanceIds.length
				: 1;
	const plan = await planSwebenchEnvironmentValidation({
		suiteSlug: input.suiteSlug,
		instanceIds: requestedInstanceIds,
		limit:
			requestedInstanceIds.length > 0
				? null
				: Math.max(requestedLimit * 4, requestedLimit, 500),
		syncBuildStatuses: input.syncBuildStatuses,
	});
	return buildExactReadySelection({
		plan,
		requestedLimit,
		requestedInstanceIds,
	});
}

export function buildExactReadySelection(input: {
	plan: SwebenchEnvironmentPlan;
	requestedLimit: number;
	requestedInstanceIds?: string[];
}): ExactReadySelection {
	const requestedLimit = Math.max(1, Math.trunc(input.requestedLimit));
	const requestedInstanceIds =
		input.requestedInstanceIds ?? input.plan.requestedInstanceIds;
	const readyIds = input.plan.nextExactReadyInstanceIds;
	const readySet = new Set(readyIds);
	const requestedSelectionIds =
		requestedInstanceIds.length > 0
			? requestedInstanceIds.slice(0, requestedLimit)
			: readyIds.slice(0, requestedLimit);
	const selectedInstanceIds = requestedSelectionIds.filter((id) =>
		readySet.has(id),
	);
	const missingExactInstanceIds = requestedSelectionIds.filter(
		(id) => !readySet.has(id),
	);
	const missingValidatedCount = Math.max(
		requestedLimit - selectedInstanceIds.length,
		missingExactInstanceIds.length,
		0,
	);
	return {
		suiteSlug: input.plan.suiteSlug,
		requestedLimit,
		selectedInstanceIds,
		selectedCount: selectedInstanceIds.length,
		missingValidatedCount,
		primaryLimiter:
			selectedInstanceIds.length < requestedLimit
				? "selected_instance_count"
				: null,
		missingInstanceIds: input.plan.missingInstanceIds,
		missingExactInstanceIds,
		coverage: input.plan.coverage,
		nextExactReadyInstanceIds: readyIds.slice(0, requestedLimit),
	};
}

export async function submitSwebenchEnvironmentValidationBuilds(input: {
	plan: SwebenchEnvironmentPlan;
	limit: number;
	targetValidatedCount: number | null;
	allowBuild?: boolean;
}): Promise<{
	selected: PlannedSwebenchEnvironment[];
	results: EnvironmentValidationSubmission[];
	submitted: number;
}> {
	const alreadyValidated = input.plan.coverage.validated;
	const alreadyBuilding = input.plan.coverage.building;
	const requestedBuildCount =
		input.targetValidatedCount == null
			? input.limit
			: Math.max(
					input.targetValidatedCount - alreadyValidated - alreadyBuilding,
					0,
				);
	const eligible = input.plan.planned.filter(
		(item) =>
			item.status === "not_built" &&
			Boolean(item.envSpecHash) &&
			Boolean(item.row.repo) &&
			Boolean(item.row.baseCommit),
	);
	const selected =
		input.allowBuild === false
			? []
			: eligible.slice(0, Math.min(input.limit, requestedBuildCount));
	const results: EnvironmentValidationSubmission[] = [];
	for (const item of selected) {
		const result = await ensureSwebenchEnvironment({
			dataset: input.plan.suite.datasetName,
			suiteSlug: input.plan.suiteSlug,
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
	return {
		selected,
		results,
		submitted: results.filter(
			(result) =>
				result.environmentStatus === "building" ||
				result.environmentStatus === "validated" ||
				Boolean(result.pipelineRunName),
		).length,
	};
}

export async function loadSwebenchEnvironmentBuildStatusByHash(
	suiteSlug: SwebenchSuiteSlug,
): Promise<Map<string, SwebenchEnvironmentBuildProjection>> {
	const rows = await db!
		.select({
			id: environmentImageBuilds.id,
			envSpecHash: environmentImageBuilds.envSpecHash,
			status: environmentImageBuilds.status,
			validationStatus: environmentImageBuilds.validationStatus,
			sandboxImage: environmentImageBuilds.sandboxImage,
			digest: environmentImageBuilds.digest,
			environmentKey: environmentImageBuilds.environmentKey,
			pipelineRunName: environmentImageBuilds.pipelineRunName,
			pipelineRunNamespace: environmentImageBuilds.pipelineRunNamespace,
		})
		.from(environmentImageBuilds)
		.where(eq(environmentImageBuilds.suite, suiteSlug))
		.orderBy(desc(environmentImageBuilds.updatedAt));
	const byHash = new Map<string, SwebenchEnvironmentBuildProjection>();
	for (const row of rows) {
		if (!row.envSpecHash || byHash.has(row.envSpecHash)) continue;
		byHash.set(row.envSpecHash, row);
	}
	return byHash;
}

export function classifyInstanceEnvironment(input: {
	row: Pick<
		BenchmarkInstance,
		"instanceId" | "repo" | "baseCommit" | "testMetadata"
	>;
	suiteSlug: SwebenchSuiteSlug;
	datasetName: string;
	buildStatusByHash: Map<string, SwebenchEnvironmentBuildProjection>;
	mappings: SwebenchInferenceEnvironmentMapping[];
}): {
	status: SwebenchEnvironmentStatus;
	envSpecHash: string | null;
	environmentKey: string | null;
} {
	const metadata = isRecord(input.row.testMetadata)
		? input.row.testMetadata
		: {};
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

function classifyRows(input: {
	rows: BenchmarkInstance[];
	suiteSlug: SwebenchSuiteSlug;
	datasetName: string;
	buildStatusByHash: Map<string, SwebenchEnvironmentBuildProjection>;
	mappings: SwebenchInferenceEnvironmentMapping[];
}): PlannedSwebenchEnvironment[] {
	return input.rows.map((row) => {
		const status = classifyInstanceEnvironment({
			row,
			suiteSlug: input.suiteSlug,
			datasetName: input.datasetName,
			buildStatusByHash: input.buildStatusByHash,
			mappings: input.mappings,
		});
		return { row, ...status };
	});
}

function summarizeEnvironmentPlan(planned: PlannedSwebenchEnvironment[]) {
	return {
		total: planned.length,
		validated: planned.filter((item) => item.status === "validated").length,
		building: planned.filter((item) => item.status === "building").length,
		failed: planned.filter((item) => item.status === "failed").length,
		notBuilt: planned.filter((item) => item.status === "not_built").length,
		missingMetadata: planned.filter(
			(item) => !item.row.repo || !item.row.baseCommit,
		).length,
	};
}

async function syncSelectableEnvironmentBuilds(envSpecHashes: string[]) {
	const database = db;
	if (!database || envSpecHashes.length === 0) return;
	const uniqueHashes = Array.from(new Set(envSpecHashes));
	const limit = readPositiveEnvInt("SWEBENCH_RANDOM_SELECTION_SYNC_BUILDS_LIMIT", 32);
	if (limit <= 0) return;
	const rows = await database
		.select()
		.from(environmentImageBuilds)
		.where(
			and(
				inArray(environmentImageBuilds.envSpecHash, uniqueHashes),
				inArray(environmentImageBuilds.status, ["queued", "building"]),
			),
		)
		.orderBy(asc(environmentImageBuilds.updatedAt))
		.limit(limit);
	for (const row of rows) {
		try {
			await syncEnvironmentBuild(row);
		} catch (err) {
			console.warn(
				"[benchmarks] failed to sync selectable SWE-bench environment build",
				{
					buildId: row.id,
					pipelineRunName: row.pipelineRunName,
					error: err instanceof Error ? err.message : String(err),
				},
			);
		}
	}
}

function readPositiveEnvInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
