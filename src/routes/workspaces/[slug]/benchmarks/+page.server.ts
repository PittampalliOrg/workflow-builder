import { error } from "@sveltejs/kit";
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	agents,
	agentVersions,
	environmentImageBuilds,
	benchmarkInstances,
	benchmarkSuites,
} from "$lib/server/db/schema";
import { ensureDefaultBenchmarkSuites } from "$lib/server/benchmarks/service";
import {
	isExactValidatedSwebenchInferenceEnvironment,
	loadSwebenchInferenceEnvironmentMappings,
	resolveSwebenchInferenceEnvironment,
} from "$lib/server/benchmarks/inference-environments";
import { buildSwebenchEnvironmentSpec } from "$lib/server/environments/environment-image-builds";
import { normalizeSwebenchSuiteSlug } from "$lib/server/benchmarks/swebench";
import { resolveAgentRuntimeRoute } from "$lib/server/agents/runtime-routing";
import { estimateBenchmarkRuntimeCapacity } from "$lib/server/benchmarks/runtime-capacity";
import { agentModelOptionFor } from "$lib/agents/model-options";
import type { AgentConfig } from "$lib/types/agents";
import type {
	BenchmarkInstanceRow,
	RepoFacet,
	RunnableAgent,
	SuiteFacet,
} from "$lib/types/benchmark-instance";
import type { PageServerLoad } from "./$types";

const PROBLEM_PREVIEW_LEN = 240;
const TOOL_CAPABLE_BENCHMARK_PROVIDERS = new Set([
	"anthropic",
	"openai",
	"together",
	"nvidia",
	"deepseek",
	"alibaba",
	"kimi",
]);

type BenchmarkInstanceEnvironmentStatus =
	BenchmarkInstanceRow["environmentStatus"];

function trimProblem(s: string | null): string {
	if (!s) return "";
	const cleaned = s.replace(/\s+/g, " ").trim();
	return cleaned.length > PROBLEM_PREVIEW_LEN
		? `${cleaned.slice(0, PROBLEM_PREVIEW_LEN).trimEnd()}…`
		: cleaned;
}

function metadataString(
	metadata: Record<string, unknown> | null | undefined,
	keys: string[],
): string | null {
	for (const key of keys) {
		const value = metadata?.[key];
		if (typeof value === "string" && value.trim()) return value.trim();
		if (typeof value === "number") return String(value);
	}
	return null;
}

function classifyEnvironmentBuild(build: {
	status: "queued" | "building" | "validated" | "failed" | "cancelled";
	validationStatus: string | null;
	sandboxImage: string | null;
	digest: string | null;
}): BenchmarkInstanceEnvironmentStatus {
	if (
		build.status === "validated" &&
		build.validationStatus === "validated" &&
		build.sandboxImage &&
		build.digest
	) {
		return "validated";
	}
	if (build.status === "queued" || build.status === "building")
		return "building";
	return "failed";
}

const ENVIRONMENT_STATUS_RANK: Record<
	BenchmarkInstanceEnvironmentStatus,
	number
> = {
	validated: 4,
	building: 3,
	failed: 2,
	not_built: 1,
};

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.session?.userId) error(401, "Authentication required");
	const projectId = locals.session.projectId ?? null;
	if (!db) error(503, "Database not configured");
	const database = db;

	await ensureDefaultBenchmarkSuites();

	const agentsQuery = projectId
		? database
				.select({
					id: agents.id,
					slug: agents.slug,
					name: agents.name,
					avatar: agents.avatar,
					runtime: agents.runtime,
					registryStatus: agents.registryStatus,
					currentVersionId: agents.currentVersionId,
					runtimeAppId: agents.runtimeAppId,
					versionNumber: agentVersions.version,
					config: agentVersions.config,
				})
				.from(agents)
				.leftJoin(
					agentVersions,
					eq(agentVersions.id, agents.currentVersionId),
				)
				.where(
					and(
						eq(agents.projectId, projectId),
						eq(agents.isArchived, false),
						eq(agents.runtime, "dapr-agent-py"),
						eq(agents.registryStatus, "registered"),
						sql`NOT (${agents.tags} @> '["workflow-ephemeral"]'::jsonb)`,
					),
				)
				.orderBy(asc(agents.name))
		: Promise.resolve(
				[] as Array<{
					id: string;
					slug: string;
					name: string;
					avatar: string | null;
					runtime: string;
					registryStatus: string | null;
					currentVersionId: string | null;
					runtimeAppId: string | null;
					versionNumber: number | null;
					config: Record<string, unknown> | null;
				}>,
			);

	const [
		instanceRows,
		repoFacetRows,
		suiteRows,
		agentRows,
		environmentBuildRows,
	] = await Promise.all([
		database
			.select({
				id: benchmarkInstances.id,
				instanceId: benchmarkInstances.instanceId,
				repo: benchmarkInstances.repo,
				baseCommit: benchmarkInstances.baseCommit,
				problemStatement: benchmarkInstances.problemStatement,
				hintsText: benchmarkInstances.hintsText,
				testMetadata: benchmarkInstances.testMetadata,
				suiteSlug: benchmarkSuites.slug,
				suiteName: benchmarkSuites.name,
				datasetName: benchmarkSuites.datasetName,
			})
			.from(benchmarkInstances)
			.innerJoin(
				benchmarkSuites,
				eq(benchmarkInstances.suiteId, benchmarkSuites.id),
			)
			.orderBy(asc(benchmarkInstances.instanceId)),
		database
			.select({
				repo: benchmarkInstances.repo,
				count: count(),
			})
			.from(benchmarkInstances)
			.groupBy(benchmarkInstances.repo),
		database
			.select({
				id: benchmarkSuites.id,
				slug: benchmarkSuites.slug,
				name: benchmarkSuites.name,
			})
			.from(benchmarkSuites)
			.orderBy(asc(benchmarkSuites.name)),
		agentsQuery,
		database
			.select({
				suite: environmentImageBuilds.suite,
				repo: environmentImageBuilds.repo,
				baseCommit: environmentImageBuilds.baseCommit,
				version: environmentImageBuilds.version,
				environmentSetupCommit: environmentImageBuilds.environmentSetupCommit,
				environmentKey: environmentImageBuilds.environmentKey,
				envSpecHash: environmentImageBuilds.envSpecHash,
				status: environmentImageBuilds.status,
				validationStatus: environmentImageBuilds.validationStatus,
				sandboxImage: environmentImageBuilds.sandboxImage,
				digest: environmentImageBuilds.digest,
			})
			.from(environmentImageBuilds)
			.orderBy(desc(environmentImageBuilds.updatedAt)),
	]);

	const staticEnvironmentMappings = loadSwebenchInferenceEnvironmentMappings();
	const buildStatusByHash = new Map<
		string,
		{
			status: BenchmarkInstanceEnvironmentStatus;
			environmentKey: string | null;
		}
	>();
	for (const build of environmentBuildRows) {
		const hash = build.envSpecHash?.trim();
		if (!hash) continue;
		const status = classifyEnvironmentBuild(build);
		const existing = buildStatusByHash.get(hash);
		if (
			existing &&
			ENVIRONMENT_STATUS_RANK[existing.status] >=
				ENVIRONMENT_STATUS_RANK[status]
		) {
			continue;
		}
		buildStatusByHash.set(hash, {
			status,
			environmentKey: build.environmentKey ?? null,
		});
	}

	const instances: BenchmarkInstanceRow[] = instanceRows.map((row) => {
		const md = (row.testMetadata ?? {}) as Record<string, unknown>;
		const versionField = metadataString(md, ["version"]);
		const staticEnvironment = resolveSwebenchInferenceEnvironment(
			{
				suiteSlug: row.suiteSlug,
				repo: row.repo,
				baseCommit: row.baseCommit,
				testMetadata: md,
			},
			{ mappings: staticEnvironmentMappings },
		);
		const exactStaticEnvironment = isExactValidatedSwebenchInferenceEnvironment(
			{
				suiteSlug: row.suiteSlug,
				repo: row.repo,
				baseCommit: row.baseCommit,
				testMetadata: md,
			},
			{ mappings: staticEnvironmentMappings },
		);
		const dynamicEnvironmentSpecHash =
			row.repo && row.baseCommit
				? buildSwebenchEnvironmentSpec({
						dataset: row.datasetName,
						suiteSlug: normalizeSwebenchSuiteSlug(row.suiteSlug),
						instanceId: row.instanceId,
						repo: row.repo,
						baseCommit: row.baseCommit,
						testMetadata: md,
					}).envSpecHash
				: null;
		const buildStatus = dynamicEnvironmentSpecHash
			? buildStatusByHash.get(dynamicEnvironmentSpecHash)
			: null;
		const environmentStatus: BenchmarkInstanceEnvironmentStatus =
			exactStaticEnvironment
				? "validated"
				: (buildStatus?.status ?? "not_built");
		const environmentKey =
			exactStaticEnvironment
				? (staticEnvironment.environmentKey ?? null)
				: (buildStatus?.environmentKey ?? null);
		const hintsLen = row.hintsText ? row.hintsText.length : 0;
		return {
			id: row.id,
			instanceId: row.instanceId,
			suiteSlug: row.suiteSlug,
			suiteName: row.suiteName,
			repo: row.repo,
			baseCommit: row.baseCommit ? row.baseCommit.slice(0, 12) : null,
			version: versionField,
			environmentStatus,
			environmentKey,
			problemPreview: trimProblem(row.problemStatement),
			hasHints: hintsLen > 0,
			hintsLen,
		};
	});

	const repoFacets: RepoFacet[] = repoFacetRows
		.filter((r): r is { repo: string; count: number } => Boolean(r.repo))
		.map((r) => ({
			value: r.repo,
			label: r.repo,
			count: Number(r.count),
		}))
		.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

	const suiteCounts = new Map<string, number>();
	const suiteEnvironmentCoverage = new Map<
		string,
		{ validated: number; building: number; failed: number; notBuilt: number }
	>();
	for (const i of instances)
		suiteCounts.set(i.suiteSlug, (suiteCounts.get(i.suiteSlug) ?? 0) + 1);
	for (const instance of instances) {
		const coverage =
			suiteEnvironmentCoverage.get(instance.suiteSlug) ??
			{ validated: 0, building: 0, failed: 0, notBuilt: 0 };
		if (instance.environmentStatus === "validated") coverage.validated += 1;
		else if (instance.environmentStatus === "building") coverage.building += 1;
		else if (instance.environmentStatus === "failed") coverage.failed += 1;
		else coverage.notBuilt += 1;
		suiteEnvironmentCoverage.set(instance.suiteSlug, coverage);
	}
	const suiteFacets: SuiteFacet[] = suiteRows.map((s) => ({
		slug: s.slug,
		name: s.name,
		instanceCount: suiteCounts.get(s.slug) ?? 0,
		environmentCoverage: suiteEnvironmentCoverage.get(s.slug) ?? {
			validated: 0,
			building: 0,
			failed: 0,
			notBuilt: 0,
		},
	}));

	const runnableAgents: RunnableAgent[] = agentRows
		.filter(
			(row): row is typeof row & { versionNumber: number } =>
				row.currentVersionId != null && row.versionNumber != null,
		)
		.filter((row) => {
			const cfg = (row.config ?? {}) as Record<string, unknown>;
			const modelSpec =
				typeof cfg.modelSpec === "string" ? cfg.modelSpec : null;
			const option = agentModelOptionFor(modelSpec);
			return Boolean(
				option &&
					option.sweBenchCapable !== false &&
					TOOL_CAPABLE_BENCHMARK_PROVIDERS.has(option.provider),
			);
		})
		.map((row) => {
			const cfg = (row.config ?? {}) as Record<string, unknown>;
			const modelSpec =
				typeof cfg.modelSpec === "string" ? cfg.modelSpec : null;
			const runtimeRoute = resolveAgentRuntimeRoute({
				agentSlug: row.slug,
				runtimeAppId: row.runtimeAppId,
				config: cfg as AgentConfig,
			});
			const capacity = estimateBenchmarkRuntimeCapacity({
				runtimeClass: runtimeRoute.runtimeClass,
				runtimeIsolation: runtimeRoute.isolation,
				runtimeAppId: runtimeRoute.appId,
				poolMaxReplicas: runtimeRoute.pool?.maxReplicas,
				slotsPerReplica: runtimeRoute.pool?.slotsPerReplica,
				maxActiveSessions: runtimeRoute.pool?.maxActiveSessions,
				requestedInstanceCount: 500,
				requestedConcurrency: 500,
			});
			return {
				id: row.id,
				slug: row.slug,
				name: row.name,
				avatar: row.avatar,
				runtime: row.runtime,
				currentVersion: row.versionNumber,
				registryStatus: row.registryStatus ?? "unregistered",
				modelSpec,
				benchmarkCapacity: {
					runtimeClass: capacity.runtimeClass,
					runtimeAppId: capacity.runtimeAppId,
					runtimeReplicas: capacity.runtimeReplicas,
					perSidecarWorkflowLimit: capacity.perSidecarWorkflowLimit,
					slotsPerReplica: capacity.slotsPerReplica,
					maxActiveSessions: capacity.maxActiveSessions,
					maxActiveSandboxes: capacity.maxActiveSandboxes,
				},
			};
		});

	return {
		instances,
		repoFacets,
		suiteFacets,
		runnableAgents,
	};
};
