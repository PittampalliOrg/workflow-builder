import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { requireInternal } from "$lib/server/internal-auth";
import { db } from "$lib/server/db";
import {
	agents,
	benchmarkInstances,
	benchmarkSuites,
	environmentImageBuilds,
} from "$lib/server/db/schema";
import { buildSwebenchEnvironmentSpec } from "$lib/server/environments/environment-image-builds";
import {
	isExactValidatedSwebenchInferenceEnvironment,
	loadSwebenchInferenceEnvironmentMappings,
} from "$lib/server/benchmarks/inference-environments";
import { BenchmarkAgentValidationError } from "$lib/server/benchmarks/agents";
import {
	createBenchmarkRun,
	ensureDefaultBenchmarkSuites,
	getBenchmarkRun,
	markBenchmarkRunStatus,
	startSwebenchCoordinator,
} from "$lib/server/benchmarks/service";
import {
	normalizeInstanceIds,
	normalizeSwebenchSuiteSlug,
	type SwebenchSuiteSlug,
} from "$lib/server/benchmarks/swebench";

export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);
	if (!db) return error(503, "Database not configured");
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const projectId = readRequiredString(body.projectId, "projectId");
	const userId = readRequiredString(body.userId, "userId");
	const agentId =
		readOptionalString(body.agentId) ??
		(await resolveAgentId(projectId, readOptionalString(body.agentSlug)));
	if (!agentId) return error(400, "agentId or agentSlug is required");
	const suiteSlug = normalizeSwebenchSuiteSlug(
		readOptionalString(body.suiteSlug) ?? readOptionalString(body.suite) ?? "SWE-bench_Verified",
	);
	const selectedInstanceIds = await resolveInstanceIds({
		suiteSlug,
		instanceIds: body.instanceIds ?? body.selectedInstanceIds,
		limit: readOptionalInt(body.limit),
	});
	if (selectedInstanceIds.length === 0) {
		return error(409, "No prevalidated SWE-bench instances matched the request");
	}
	if (body.previewOnly === true || body.dryRun === true) {
		return json({
			preview: true,
			suiteSlug,
			selectedInstanceIds,
			selectedCount: selectedInstanceIds.length,
			requestedLimit: readOptionalInt(body.limit) ?? selectedInstanceIds.length,
		});
	}

	let run;
	try {
		run = await createBenchmarkRun({
			projectId,
			userId,
			suiteSlug,
			agentId,
			agentVersion: readOptionalInt(body.agentVersion) ?? undefined,
			instanceIds: selectedInstanceIds,
			modelNameOrPath: readOptionalString(body.modelNameOrPath) ?? undefined,
			modelConfigLabel: readOptionalString(body.modelConfigLabel),
			concurrency: readOptionalInt(body.concurrency) ?? undefined,
			evaluationConcurrency:
				readOptionalInt(body.evaluationConcurrency) ?? undefined,
			timeoutSeconds: readOptionalInt(body.timeoutSeconds) ?? undefined,
			maxTurns: readOptionalInt(body.maxTurns),
			evaluatorResourceClass: readOptionalString(body.evaluatorResourceClass),
			tags: normalizeTags(body.tags),
			requirePrevalidatedEnvironments: true,
			executionBackend: readOptionalString(body.executionBackend),
			executionClass: readOptionalString(body.executionClass),
		});
	} catch (err) {
		if (err instanceof BenchmarkAgentValidationError) {
			return json({ message: err.message }, { status: 400 });
		}
		throw err;
	}

	let coordinatorStartError: string | null = null;
	try {
		const coordinator = await startSwebenchCoordinator(run.id);
		if (typeof coordinator.executionId === "string") {
			await markBenchmarkRunStatus(run.id, "queued", {
				coordinatorExecutionId: coordinator.executionId,
			});
		}
	} catch (err) {
		coordinatorStartError = err instanceof Error ? err.message : String(err);
		await markBenchmarkRunStatus(run.id, "failed", {
			error: coordinatorStartError,
		});
	}

	const fullRun = await getBenchmarkRun(projectId, run.id);
	return json(
		{
			run: fullRun,
			coordinatorStartError,
			selectedInstanceIds,
		},
		{ status: 201 },
	);
};

function readRequiredString(value: unknown, name: string): string {
	const out = readOptionalString(value);
	if (!out) throw error(400, `${name} is required`);
	return out;
}

function readOptionalString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readOptionalInt(value: unknown): number | null {
	if (typeof value === "number" && Number.isInteger(value)) return value;
	if (typeof value !== "string" || !value.trim()) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isInteger(parsed) ? parsed : null;
}

function normalizeTags(value: unknown): string[] {
	if (!Array.isArray(value)) return ["operator"];
	const tags = value.filter(
		(tag): tag is string => typeof tag === "string" && !!tag.trim(),
	);
	return Array.from(new Set(["operator", ...tags]));
}

async function resolveAgentId(
	projectId: string,
	agentSlug: string | null,
): Promise<string | null> {
	const database = db;
	if (!database || !agentSlug) return null;
	const [agent] = await database
		.select({ id: agents.id })
		.from(agents)
		.where(
			and(
				eq(agents.projectId, projectId),
				eq(agents.slug, agentSlug),
				eq(agents.isArchived, false),
			),
		)
		.limit(1);
	return agent?.id ?? null;
}

async function resolveInstanceIds(input: {
	suiteSlug: SwebenchSuiteSlug;
	instanceIds: unknown;
	limit: number | null;
}): Promise<string[]> {
	const explicitIds = normalizeInstanceIds(input.instanceIds);
	if (explicitIds.length > 0) return explicitIds;
	const limit = Math.max(1, Math.min(input.limit ?? 1, 500));
	return selectPrevalidatedInstanceIds(input.suiteSlug, limit);
}

async function selectPrevalidatedInstanceIds(
	suiteSlug: SwebenchSuiteSlug,
	limit: number,
): Promise<string[]> {
	const database = db;
	if (!database) throw error(503, "Database not configured");
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
	if (!suite) throw error(400, `Unsupported benchmark suite: ${suiteSlug}`);
	const candidates = await database
		.select({
			instanceId: benchmarkInstances.instanceId,
			repo: benchmarkInstances.repo,
			baseCommit: benchmarkInstances.baseCommit,
			testMetadata: benchmarkInstances.testMetadata,
		})
		.from(benchmarkInstances)
		.where(eq(benchmarkInstances.suiteId, suite.id))
		.orderBy(asc(benchmarkInstances.instanceId))
		.limit(500);
	const staticMappings = loadSwebenchInferenceEnvironmentMappings();
	const hashByInstance = new Map<string, string>();
	const staticReady = new Set<string>();
	for (const candidate of candidates) {
		if (!candidate.repo || !candidate.baseCommit) continue;
		const spec = buildSwebenchEnvironmentSpec({
			dataset: suite.datasetName,
			suiteSlug,
			instanceId: candidate.instanceId,
			repo: candidate.repo,
			baseCommit: candidate.baseCommit,
			testMetadata: candidate.testMetadata,
		});
		if (
			isExactValidatedSwebenchInferenceEnvironment(
				{
					suiteSlug,
					repo: candidate.repo,
					baseCommit: candidate.baseCommit,
					testMetadata: candidate.testMetadata,
				},
				spec.envSpecHash,
				{ mappings: staticMappings },
			)
		) {
			staticReady.add(candidate.instanceId);
			continue;
		}
		hashByInstance.set(candidate.instanceId, spec.envSpecHash);
	}
	if (hashByInstance.size === 0) return [];
	const validatedBuilds = await database
		.select({ envSpecHash: environmentImageBuilds.envSpecHash })
		.from(environmentImageBuilds)
		.where(
			and(
				inArray(environmentImageBuilds.envSpecHash, Array.from(hashByInstance.values())),
				eq(environmentImageBuilds.status, "validated"),
				eq(environmentImageBuilds.validationStatus, "validated"),
				sql`${environmentImageBuilds.sandboxImage} is not null`,
				sql`${environmentImageBuilds.digest} is not null`,
			),
		);
	const validatedHashes = new Set(
		validatedBuilds.map((build) => build.envSpecHash),
	);
	const selected: string[] = [];
	for (const candidate of candidates) {
		if (staticReady.has(candidate.instanceId)) {
			selected.push(candidate.instanceId);
			if (selected.length >= limit) break;
			continue;
		}
		const hash = hashByInstance.get(candidate.instanceId);
		if (!hash || !validatedHashes.has(hash)) continue;
		selected.push(candidate.instanceId);
		if (selected.length >= limit) break;
	}
	return selected;
}
