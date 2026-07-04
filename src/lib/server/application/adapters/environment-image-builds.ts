import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { env } from "$env/dynamic/private";
import { db } from "$lib/server/db";
import {
	benchmarkRunInstances,
	benchmarkRuns,
	environmentBuildActivityEvents,
	environmentImageBuilds,
	type EnvironmentBuildActivityEvent,
	type EnvironmentBuildActivityEventType,
	type EnvironmentImageBuild,
	type EnvironmentImageBuildStatus,
	type NewEnvironmentBuildActivityEvent,
} from "$lib/server/db/schema";
import {
	createTektonPipelineRun,
	getTektonPipelineRun,
	hasConfiguredHubTektonKubeconfig,
	listTektonTaskRunsForPipelineRun,
	tektonPipelineRunResults,
	tektonSucceededCondition,
	tektonTaskRunResults,
	tektonTaskRunSucceededCondition,
	type TektonPipelineRun,
	type TektonTaskRun,
	type TektonTargetCluster,
} from "$lib/server/kube/tekton";
import {
	isExactValidatedSwebenchInferenceEnvironment,
	resolveSwebenchInferenceEnvironment,
	type ResolvedSwebenchInferenceEnvironment,
} from "$lib/server/benchmarks/inference-environments";
import type { SwebenchSuiteSlug } from "$lib/server/benchmarks/swebench";
import {
	buildSwebenchEnvironmentSpec,
	type EnvironmentImageBuildStrategy,
	type EnvironmentPrepareResult,
	type EnsureSwebenchEnvironmentInput,
	type SwebenchEnvironmentSpec,
} from "$lib/server/environments/swebench-environment-spec";

export {
	buildSwebenchEnvironmentSpec,
	resolveSwebenchBuildBackend,
} from "$lib/server/environments/swebench-environment-spec";
export type {
	EnvironmentPrepareResult,
	EnsureSwebenchEnvironmentInput,
	SwebenchEnvironmentSpec,
	SwebenchInferenceBuildBackend,
} from "$lib/server/environments/swebench-environment-spec";

const DEFAULT_SANDBOX_TEMPLATE = "dapr-agent";
const DEFAULT_TEKTON_NAMESPACE = "tekton-pipelines";
const DEFAULT_GIT_REVISION = "main";
const DEFAULT_SWEBENCH_BUILD_GIT_URL = "https://github.com/PittampalliOrg/workflow-builder.git";
const DEFAULT_SWEBENCH_STACKS_REPO = "https://github.com/PittampalliOrg/stacks.git";
const DEFAULT_SWEBENCH_BUILDAH_CACHE_CLAIM = "buildah-cache-swebench-inference";
const MAX_SWEBENCH_BUILDAH_CACHE_SHARDS = 16;
const DEFAULT_SWEBENCH_MAX_ACTIVE_BUILDS = 0;
const MAX_SWEBENCH_MAX_ACTIVE_BUILDS = 200;
const SWEBENCH_PIPELINE_TIMEOUTS = {
	pipeline: "6h0m0s",
	tasks: "5h45m0s",
	finally: "15m0s",
} as const;
const LEGACY_SWEBENCH_IMAGE_WORKSPACE_ROOT = "/testbed";
const OPENSHELL_RUNTIME_WORKSPACE_ROOT = "/sandbox/repo";
const SWEBENCH_WORKSPACE_ROOT = OPENSHELL_RUNTIME_WORKSPACE_ROOT;
const FALLBACK_WORKSPACE_ROOT = OPENSHELL_RUNTIME_WORKSPACE_ROOT;
const SWEBENCH_CONDA_ENV = "testbed";
const ACTIVE_BUILD_STATUSES = new Set<EnvironmentImageBuildStatus>([
	"queued",
	"building",
]);
const TERMINAL_BUILD_STATUSES = new Set<EnvironmentImageBuildStatus>([
	"validated",
	"failed",
	"cancelled",
]);

export type NormalizedEnvironmentBuildActivityEvent = Omit<
	NewEnvironmentBuildActivityEvent,
	"createdAt" | "updatedAt"
> & {
	id: string;
	eventTimestamp: Date;
};

export type SerializedEnvironmentBuildActivityEvent = {
	id: string;
	buildId: string;
	environmentKey: string;
	eventKey: string;
	eventType: EnvironmentBuildActivityEventType;
	pipelineRunName: string | null;
	pipelineRunNamespace: string | null;
	taskRunName: string | null;
	phase: string | null;
	reason: string | null;
	message: string | null;
	timestamp: string;
	rawMetadata: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
};

export type SerializedEnvironmentBuildSnapshot = {
	id: string;
	dataset: string;
	suite: string | null;
	repo: string;
	version: string | null;
	environmentSetupCommit: string | null;
	baseCommit: string | null;
	environmentKey: string;
	envSpecHash: string;
	buildStrategy: EnvironmentImageBuildStrategy;
	workspaceRoot: string | null;
	condaEnvironment: string | null;
	swebenchSpec: Record<string, unknown> | null;
	status: EnvironmentImageBuildStatus;
	sandboxTemplate: string;
	sandboxImage: string | null;
	digest: string | null;
	imageName: string | null;
	imageTag: string | null;
	dockerfilePath: string | null;
	validationCommand: string | null;
	validationStatus: string | null;
	validationLogRef: string | null;
	buildLogRef: string | null;
	pipelineRunName: string | null;
	pipelineRunNamespace: string | null;
	pipelineRunUrl: string | null;
	error: string | null;
	requestedAt: string;
	startedAt: string | null;
	completedAt: string | null;
	builtAt: string | null;
	createdAt: string;
	updatedAt: string;
};

export type EnvironmentBuildActivityResponse = {
	build: SerializedEnvironmentBuildSnapshot;
	events: SerializedEnvironmentBuildActivityEvent[];
	latestEvent: SerializedEnvironmentBuildActivityEvent | null;
	syncError?: string;
};

export type BenchmarkRunEnvironmentActivityResponse = {
	runId: string;
	instances: Array<{
		runInstanceId: string;
		instanceId: string;
		build: SerializedEnvironmentBuildSnapshot | null;
		events: SerializedEnvironmentBuildActivityEvent[];
		latestEvent: SerializedEnvironmentBuildActivityEvent | null;
	}>;
};

export function plannedSwebenchInferenceEnvironment(
	input: EnsureSwebenchEnvironmentInput,
): ResolvedSwebenchInferenceEnvironment {
	const spec = buildSwebenchEnvironmentSpec(input);
	const resolved = resolveSwebenchInferenceEnvironment(
		{
			suiteSlug: input.suiteSlug,
			repo: input.repo,
			baseCommit: input.baseCommit,
			testMetadata: input.testMetadata,
		},
		spec.envSpecHash,
	);
	if (resolved.environmentStatus === "validated") return resolved;
	return {
		environmentStatus: "building",
		suite: input.suiteSlug,
		repo: spec.repo,
		version: spec.version,
		environmentSetupCommit: spec.environmentSetupCommit,
		baseCommit: spec.baseCommit,
		environmentKey: spec.environmentKey,
		sandboxTemplate: spec.sandboxTemplate,
		validationCommand: spec.validationCommand,
		environmentNotes: runtimeEnvironmentNotes(
			spec.environmentNotes,
			spec.workspaceRoot,
			spec.buildStrategy,
		),
		source: "dynamic-build",
		reason: resolved.reason === "no_validated_mapping"
			? "dynamic_build_required"
			: resolved.reason,
		buildStrategy: spec.buildStrategy,
		envSpecHash: spec.envSpecHash,
		workspaceRoot: runtimeWorkspaceRoot(spec.workspaceRoot),
		condaEnvironment: spec.condaEnvironment,
		swebenchSpec: spec.swebenchSpec,
	};
}

export async function plannedSwebenchInferenceEnvironmentWithBuild(
	input: EnsureSwebenchEnvironmentInput,
): Promise<ResolvedSwebenchInferenceEnvironment> {
	const planned = plannedSwebenchInferenceEnvironment(input);
	if (!planned.envSpecHash || planned.environmentStatus === "validated") return planned;
	const build = await getBuildBySpecHash(planned.envSpecHash).catch(() => null);
	if (!build) return planned;
	const synced = await syncEnvironmentBuild(build, {
		forceTerminal: isPipelineManagedBuild(build),
	});
	if (
		(synced.status === "failed" || synced.status === "cancelled") &&
		isTektonBackendUnavailable(synced.error)
	) {
		return fallbackEnvironment(
			synced,
			"dynamic_build_backend_unavailable",
			synced,
		);
	}
	return rowToEnvironment(synced);
}

export async function ensureSwebenchEnvironment(
	input: EnsureSwebenchEnvironmentInput,
): Promise<EnvironmentPrepareResult> {
	const spec = buildSwebenchEnvironmentSpec(input);
	const staticResolved = resolveSwebenchInferenceEnvironment(
		{
			suiteSlug: input.suiteSlug,
			repo: input.repo,
			baseCommit: input.baseCommit,
			testMetadata: input.testMetadata,
		},
		spec.envSpecHash,
	);
	if (
		staticResolved.environmentStatus === "validated" &&
		!(
			input.forceRefreshLegacyStatic === true &&
			(isLegacyStaticSwebenchEnvironment(staticResolved) ||
				!isExactValidatedSwebenchInferenceEnvironment(
					{
						suiteSlug: input.suiteSlug,
						repo: input.repo,
						baseCommit: input.baseCommit,
						testMetadata: input.testMetadata,
					},
					spec.envSpecHash,
				))
		)
	) {
		return validatedResult(staticResolved, "static_mapping");
	}

	const database = requireDb();
	const existing = await getBuildBySpecHash(spec.envSpecHash);
	if (existing) {
		const synced = await syncEnvironmentBuild(existing);
		if (synced.status === "validated") return resultFromBuild(synced);
		if (synced.status === "failed" || synced.status === "cancelled") {
			if (isTektonBackendUnavailable(synced.error)) {
				return fallbackResult(spec, "dynamic_build_backend_unavailable", synced.error ?? undefined, synced);
			}
			return resultFromBuild(synced);
		}
		if (synced.pipelineRunName) return resultFromBuild(synced);
	}

	const submission = await dynamicBuildSubmissionGuard(input);
	if (!submission.allowed) {
		return buildNotSubmittedResult(spec, submission.reason, submission.message);
	}

	const row = existing ?? (await insertBuild(spec, input));
	const pipelineRunName = row.pipelineRunName || stablePipelineRunName(spec);
	const pipelineRunNamespace = row.pipelineRunNamespace ?? DEFAULT_TEKTON_NAMESPACE;
	if (!row.pipelineRunName) {
		try {
			const submitted = await submitSwebenchPipelineRun(
				spec,
				pipelineRunName,
				pipelineRunNamespace,
				submission.targetCluster,
			);
			const [updated] = await database
				.update(environmentImageBuilds)
				.set({
					status: "building",
					pipelineRunName,
					pipelineRunNamespace,
					buildLogRef: `tekton://pipelineruns/${pipelineRunNamespace}/${pipelineRunName}`,
					startedAt: row.startedAt ?? new Date(),
					updatedAt: new Date(),
				})
				.where(eq(environmentImageBuilds.id, row.id))
				.returning();
			const next = updated ?? row;
			await persistBuildActivityEvents(
				normalizeEnvironmentBuildActivityEvents({
					build: next,
					pipelineRun: submitted.pipelineRun ?? {
						metadata: {
							name: pipelineRunName,
							namespace: pipelineRunNamespace,
						},
					},
					taskRuns: [],
				}),
			);
			return resultFromBuild(next);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const [failed] = await database
				.update(environmentImageBuilds)
				.set({
					status: "failed",
					error: message,
					completedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(eq(environmentImageBuilds.id, row.id))
				.returning();
			await persistBuildActivityEvents(
				normalizeEnvironmentBuildActivityEvents({ build: failed ?? row, taskRuns: [] }),
			);
			if (isTektonBackendUnavailable(message)) {
				return fallbackResult(
					spec,
					"dynamic_build_backend_unavailable",
					message,
					failed ?? row,
				);
			}
			return resultFromBuild(failed ?? row);
		}
	}

	return resultFromBuild(row);
}

export async function getSwebenchEnvironmentStatus(input: {
	buildId?: string | null;
	envSpecHash?: string | null;
	environmentKey?: string | null;
}): Promise<EnvironmentPrepareResult> {
	const database = requireDb();
	const row = input.buildId
		? (
				await database
					.select()
					.from(environmentImageBuilds)
					.where(eq(environmentImageBuilds.id, input.buildId))
					.limit(1)
			)[0]
		: input.envSpecHash
			? await getBuildBySpecHash(input.envSpecHash)
			: null;
	if (!row) {
		return {
			success: false,
			complete: true,
			environmentStatus: "failed",
			status: "failed",
			sandboxTemplate: DEFAULT_SANDBOX_TEMPLATE,
			error: "environment build not found",
		};
	}
	const synced = await syncEnvironmentBuild(row);
	if (
		(synced.status === "failed" || synced.status === "cancelled") &&
		isTektonBackendUnavailable(synced.error)
	) {
		return fallbackResult(synced, "dynamic_build_backend_unavailable", synced.error ?? undefined, synced);
	}
	return resultFromBuild(synced);
}

async function insertBuild(
	spec: SwebenchEnvironmentSpec,
	input: EnsureSwebenchEnvironmentInput,
): Promise<EnvironmentImageBuild> {
	const database = requireDb();
	const [row] = await database
		.insert(environmentImageBuilds)
		.values({
			dataset: spec.dataset,
			suite: spec.suite,
			repo: spec.repo,
			version: spec.version,
			environmentSetupCommit: spec.environmentSetupCommit,
			baseCommit: spec.baseCommit,
			environmentKey: spec.environmentKey,
			envSpecHash: spec.envSpecHash,
			buildStrategy: spec.buildStrategy,
			status: "queued",
			sandboxTemplate: spec.sandboxTemplate,
			imageName: spec.imageName,
			imageTag: spec.imageTag,
			dockerfilePath: spec.dockerfilePath,
			validationCommand: spec.validationCommand,
			spec: spec as unknown as Record<string, unknown>,
			metadata: {
				instanceId: input.instanceId ?? null,
				testMetadata: input.testMetadata ?? {},
			},
		})
		.onConflictDoUpdate({
			target: environmentImageBuilds.envSpecHash,
			set: { updatedAt: new Date() },
		})
		.returning();
	const build = row ?? (await getBuildBySpecHash(spec.envSpecHash))!;
	await persistBuildActivityEvents(
		normalizeEnvironmentBuildActivityEvents({ build, taskRuns: [] }),
	);
	return build;
}

async function getBuildBySpecHash(hash: string): Promise<EnvironmentImageBuild | null> {
	const database = requireDb();
	const [row] = await database
		.select()
		.from(environmentImageBuilds)
		.where(eq(environmentImageBuilds.envSpecHash, hash))
		.limit(1);
	return row ?? null;
}

export async function syncEnvironmentBuild(
	row: EnvironmentImageBuild,
	options: { forceTerminal?: boolean } = {},
): Promise<EnvironmentImageBuild> {
	await persistBuildActivityEvents(
		normalizeEnvironmentBuildActivityEvents({ build: row, taskRuns: [] }),
	);
	if (!row.pipelineRunName || !row.pipelineRunNamespace) return row;
	if (
		TERMINAL_BUILD_STATUSES.has(row.status) &&
		!options.forceTerminal &&
		!isPipelineManagedBuild(row)
	) {
		return row;
	}
	const targetCluster = dynamicBuildTargetFromEnv();
	const pipelineRun = await getTektonPipelineRun(
		row.pipelineRunNamespace,
		row.pipelineRunName,
		{ targetCluster },
	);
	if (!pipelineRun) return row;
	const taskRuns = await listTektonTaskRunsForPipelineRun(
		row.pipelineRunNamespace,
		row.pipelineRunName,
		{ targetCluster },
	);
	await persistBuildActivityEvents(
		normalizeEnvironmentBuildActivityEvents({ build: row, pipelineRun, taskRuns }),
	);
	const condition = tektonSucceededCondition(pipelineRun);
	if (!condition || condition.status === "Unknown") return row;

	const database = requireDb();
	if (condition.status === "True") {
		const results = tektonPipelineRunResults(pipelineRun);
		const validationStatus = readString(results.validation_status);
		const validationLogRef = readString(results.validation_log_ref);
		const builtAtResult = readString(results.built_at);
		const builtAt = parseDate(builtAtResult);
		if (validationStatus !== "validated" || !validationLogRef || !builtAt) {
			const [updated] = await database
				.update(environmentImageBuilds)
				.set({
					status: "failed",
					validationStatus: "failed",
					validationLogRef: null,
					builtAt: null,
					error: "Tekton PipelineRun completed without validated image results",
					completedAt: parseDate(pipelineRun.status?.completionTime) ?? new Date(),
					updatedAt: new Date(),
				})
				.where(eq(environmentImageBuilds.id, row.id))
				.returning();
			await persistBuildActivityEvents(
				normalizeEnvironmentBuildActivityEvents({
					build: updated ?? row,
					pipelineRun,
					taskRuns,
				}),
			);
			return updated ?? row;
		}
		const imageRef = readString(results.image_ref) ?? row.sandboxImage;
		const digest = readString(results.image_digest) ?? digestFromImage(imageRef) ?? row.digest;
		const sandboxImage = imageWithDigest(imageRef, digest) ?? imageRef ?? undefined;
		if (!sandboxImage || !digest) {
			const [updated] = await database
				.update(environmentImageBuilds)
				.set({
					status: "failed",
					validationStatus: "failed",
					validationLogRef: null,
					builtAt: null,
					error: "Tekton PipelineRun completed without an image ref and digest",
					completedAt: parseDate(pipelineRun.status?.completionTime) ?? new Date(),
					updatedAt: new Date(),
				})
				.where(eq(environmentImageBuilds.id, row.id))
				.returning();
			await persistBuildActivityEvents(
				normalizeEnvironmentBuildActivityEvents({
					build: updated ?? row,
					pipelineRun,
					taskRuns,
				}),
			);
			return updated ?? row;
		}
		const spec = mergeSwebenchSpecMetadata(
			row.spec,
			parseJsonRecord(results.swebench_spec_metadata),
		);
		const [updated] = await database
			.update(environmentImageBuilds)
			.set({
				status: "validated",
				sandboxImage,
				digest,
				validationStatus,
				validationLogRef,
				spec,
				builtAt,
				completedAt: parseDate(pipelineRun.status?.completionTime) ?? new Date(),
				updatedAt: new Date(),
			})
			.where(eq(environmentImageBuilds.id, row.id))
			.returning();
		await persistBuildActivityEvents(
			normalizeEnvironmentBuildActivityEvents({
				build: updated ?? row,
				pipelineRun,
				taskRuns,
			}),
		);
		return updated ?? row;
	}

	const failedStatus = isTektonCancelled(condition.reason, condition.message)
		? "cancelled"
		: "failed";
	const [updated] = await database
		.update(environmentImageBuilds)
		.set({
			status: failedStatus,
			validationStatus: failedStatus,
			validationLogRef: null,
			builtAt: null,
			error: condition.message ?? condition.reason ?? "Tekton PipelineRun failed",
			completedAt: parseDate(pipelineRun.status?.completionTime) ?? new Date(),
			updatedAt: new Date(),
		})
		.where(eq(environmentImageBuilds.id, row.id))
		.returning();
	await persistBuildActivityEvents(
		normalizeEnvironmentBuildActivityEvents({
			build: updated ?? row,
			pipelineRun,
			taskRuns,
		}),
	);
	return updated ?? row;
}

export function hasUsableValidatedImage(
	row: Pick<EnvironmentImageBuild, "validationStatus" | "sandboxImage" | "digest"> &
		Partial<Pick<EnvironmentImageBuild, "pipelineRunName">>,
): boolean {
	if (row.pipelineRunName) return false;
	return (
		row.validationStatus === "validated" &&
		Boolean(row.sandboxImage) &&
		Boolean(row.digest ?? digestFromImage(row.sandboxImage))
	);
}

async function submitSwebenchPipelineRun(
	spec: SwebenchEnvironmentSpec,
	pipelineRunName: string,
	namespace: string,
	targetCluster: TektonTargetCluster,
) {
	const buildahCache =
		spec.buildBackend === "nix"
			? undefined
			: await selectSwebenchBuildahCacheForSubmission(spec);
	return createTektonPipelineRun(
		namespace,
		buildSwebenchPipelineRunManifest(spec, pipelineRunName, namespace, {
			buildahCache,
		}),
		{ targetCluster },
	);
}

export function buildSwebenchPipelineRunManifest(
	spec: SwebenchEnvironmentSpec,
	pipelineRunName: string,
	namespace: string,
	options: { buildahCache?: SwebenchBuildahCacheSelection } = {},
): TektonPipelineRun {
	if (spec.buildBackend === "nix") {
		return buildSwebenchNixPipelineRunManifest(spec, pipelineRunName, namespace);
	}
	const buildahCache = options.buildahCache ?? swebenchBuildahCacheSelection(spec);
	const kueueQueueName = configuredSwebenchBuildKueueQueueName();
	const nodeSelector = {
		"stacks.io/build-pool": "hub",
		...(buildahCache.nodeName ? { "kubernetes.io/hostname": buildahCache.nodeName } : {}),
	};
	return {
		apiVersion: "tekton.dev/v1",
		kind: "PipelineRun",
		metadata: {
			name: pipelineRunName,
			namespace,
			labels: {
				"app.kubernetes.io/name": "workflow-builder-image-builds",
				"app.kubernetes.io/component": "pipeline-run",
				"app.kubernetes.io/part-of": "workflow-builder",
				"workflow-builder.cnoe.io/image": spec.imageName,
				"workflow-builder.cnoe.io/environment-key": spec.environmentKey,
				"workflow-builder.cnoe.io/env-spec-hash": spec.envSpecHash.slice(0, 63),
				"workflow-builder.cnoe.io/build-strategy": spec.buildStrategy,
				"workflow-builder.cnoe.io/build-backend": "buildah",
				"workflow-builder.cnoe.io/build-cache": buildahCache.claimName,
				...(kueueQueueName ? { "kueue.x-k8s.io/queue-name": kueueQueueName } : {}),
			},
		},
		spec: {
			pipelineRef: { name: "swebench-inference-image-build" },
			taskRunTemplate: {
				serviceAccountName: "workflow-builder-build-trigger",
				podTemplate: {
					nodeSelector,
					tolerations: [
						{
							key: "stacks.io/build-pool",
							operator: "Equal",
							value: "hub",
							effect: "NoSchedule",
						},
					],
				},
			},
			timeouts: SWEBENCH_PIPELINE_TIMEOUTS,
			params: [
				{
					name: "git_url",
					value: env.SWEBENCH_INFERENCE_BUILD_GIT_URL ?? DEFAULT_SWEBENCH_BUILD_GIT_URL,
				},
				{ name: "git_sha", value: env.SWEBENCH_INFERENCE_BUILD_GIT_REVISION ?? DEFAULT_GIT_REVISION },
				{ name: "suite", value: spec.suite },
				{ name: "repo_slug", value: spec.repo },
				{ name: "environment_key", value: spec.environmentKey },
				{ name: "base_commit", value: spec.baseCommit },
				{ name: "env_spec_hash", value: spec.envSpecHash },
				{ name: "build_strategy", value: spec.buildStrategy },
				{ name: "workspace_root", value: spec.workspaceRoot },
				{ name: "dockerfile_path", value: spec.dockerfilePath },
				{ name: "image_name", value: spec.imageName },
				{ name: "image_tag", value: spec.imageTag },
				{ name: "validation_command", value: spec.validationCommand },
				{ name: "environment_notes", value: JSON.stringify(spec.environmentNotes) },
				{ name: "swebench_spec_json", value: JSON.stringify(spec.swebenchSpecInput ?? {}) },
				{
					name: "stacks_repo",
					value:
						env.SWEBENCH_INFERENCE_BUILD_STACKS_REPO ??
						DEFAULT_SWEBENCH_STACKS_REPO,
				},
			],
			workspaces: [
				{
					name: "buildah-cache",
					persistentVolumeClaim: { claimName: buildahCache.claimName },
				},
				{ name: "dockerconfig", secret: { secretName: "gitea-registry-credentials" } },
				{ name: "stacks-source", emptyDir: {} },
			],
		},
	};
}

/**
 * Build a PipelineRun manifest for the Nix-backend variant. Runs alongside
 * the Buildah path during the parallel rollout. Notable differences from the
 * Buildah path:
 *   - Targets the `swebench-inference-image-build-nix` Pipeline (Cachix-backed).
 *   - No buildah-cache PVC: workspace is an emptyDir consumed by the
 *     validate-image task only.
 *   - No hostname pin in nodeSelector — Cachix removes the PVC node-affinity
 *     constraint so builds can land on either hub-build-1 or hub-build-2.
 *   - Drops `dockerfile_path` and `build_strategy` params (Nix only implements
 *     the swebench-harness path; non-harness builds are routed back to Buildah
 *     by `resolveSwebenchBuildBackend`).
 *   - Adds `cachix_cache` param (defaults to `pittampalliorg`).
 */
function buildSwebenchNixPipelineRunManifest(
	spec: SwebenchEnvironmentSpec,
	pipelineRunName: string,
	namespace: string,
): TektonPipelineRun {
	const kueueQueueName = configuredSwebenchBuildKueueQueueName();
	const cachixCache =
		runtimeEnvString("SWEBENCH_INFERENCE_BUILD_CACHIX_CACHE") ?? "pittampalliorg";
	return {
		apiVersion: "tekton.dev/v1",
		kind: "PipelineRun",
		metadata: {
			name: pipelineRunName,
			namespace,
			labels: {
				"app.kubernetes.io/name": "workflow-builder-image-builds",
				"app.kubernetes.io/component": "pipeline-run",
				"app.kubernetes.io/part-of": "workflow-builder",
				"workflow-builder.cnoe.io/image": spec.imageName,
				"workflow-builder.cnoe.io/environment-key": spec.environmentKey,
				"workflow-builder.cnoe.io/env-spec-hash": spec.envSpecHash.slice(0, 63),
				"workflow-builder.cnoe.io/build-strategy": spec.buildStrategy,
				"workflow-builder.cnoe.io/build-backend": "nix",
				"workflow-builder.cnoe.io/build-cache": `cachix:${cachixCache}`,
				...(kueueQueueName ? { "kueue.x-k8s.io/queue-name": kueueQueueName } : {}),
			},
		},
		spec: {
			pipelineRef: { name: "swebench-inference-image-build-nix" },
			taskRunTemplate: {
				serviceAccountName: "workflow-builder-build-trigger",
				podTemplate: {
					nodeSelector: { "stacks.io/build-pool": "hub" },
					tolerations: [
						{
							key: "stacks.io/build-pool",
							operator: "Equal",
							value: "hub",
							effect: "NoSchedule",
						},
					],
				},
			},
			timeouts: SWEBENCH_PIPELINE_TIMEOUTS,
			params: [
				{
					name: "git_url",
					value: env.SWEBENCH_INFERENCE_BUILD_GIT_URL ?? DEFAULT_SWEBENCH_BUILD_GIT_URL,
				},
				{
					name: "git_sha",
					value: env.SWEBENCH_INFERENCE_BUILD_GIT_REVISION ?? DEFAULT_GIT_REVISION,
				},
				{ name: "suite", value: spec.suite },
				{ name: "repo_slug", value: spec.repo },
				{ name: "environment_key", value: spec.environmentKey },
				{ name: "base_commit", value: spec.baseCommit },
				{ name: "env_spec_hash", value: spec.envSpecHash },
				{ name: "workspace_root", value: spec.workspaceRoot },
				{ name: "image_name", value: spec.imageName },
				{ name: "image_tag", value: spec.imageTag },
				{ name: "validation_command", value: spec.validationCommand },
				{ name: "environment_notes", value: JSON.stringify(spec.environmentNotes) },
				{ name: "swebench_spec_json", value: JSON.stringify(spec.swebenchSpecInput ?? {}) },
				{
					name: "stacks_repo",
					value: env.SWEBENCH_INFERENCE_BUILD_STACKS_REPO ?? DEFAULT_SWEBENCH_STACKS_REPO,
				},
				{ name: "cachix_cache", value: cachixCache },
			],
			workspaces: [
				{ name: "buildah-cache", emptyDir: {} },
				{ name: "dockerconfig", secret: { secretName: "gitea-registry-credentials" } },
				{ name: "stacks-source", emptyDir: {} },
			],
		},
	};
}

function swebenchBuildahCacheClaimName(spec: SwebenchEnvironmentSpec): string {
	return swebenchBuildahCacheSelection(spec).claimName;
}

type SwebenchBuildahCacheSelection = {
	claimName: string;
	shard: number | null;
	nodeName: string | null;
};

function swebenchBuildahCacheSelection(
	spec: SwebenchEnvironmentSpec,
): SwebenchBuildahCacheSelection {
	const shards = configuredSwebenchBuildahCacheShards();
	if (shards <= 1) {
		return {
			claimName: DEFAULT_SWEBENCH_BUILDAH_CACHE_CLAIM,
			shard: null,
			nodeName: configuredSwebenchBuildahCacheShardNodes()[0] ?? null,
		};
	}
	return swebenchBuildahCacheSelectionForShard(
		hashedSwebenchBuildahCacheShard(spec.envSpecHash, shards),
	);
}

function swebenchBuildahCacheSelectionForShard(
	shard: number,
): SwebenchBuildahCacheSelection {
	const nodeName = configuredSwebenchBuildahCacheShardNodes()[shard] ?? null;
	return {
		claimName: `${DEFAULT_SWEBENCH_BUILDAH_CACHE_CLAIM}-${shard}`,
		shard,
		nodeName,
	};
}

function hashedSwebenchBuildahCacheShard(envSpecHash: string, shards: number): number {
	const hash = createHash("sha256").update(envSpecHash).digest();
	return hash.readUInt32BE(0) % shards;
}

export function selectSwebenchBuildahCacheShard(input: {
	envSpecHash: string;
	shards: number;
	activeShardCounts?: Record<number, number>;
}): number | null {
	if (input.shards <= 1) return null;
	const preferred = hashedSwebenchBuildahCacheShard(input.envSpecHash, input.shards);
	const counts = input.activeShardCounts ?? {};
	let selected = preferred;
	let selectedCount = counts[preferred] ?? 0;
	for (let shard = 0; shard < input.shards; shard += 1) {
		const count = counts[shard] ?? 0;
		if (count < selectedCount) {
			selected = shard;
			selectedCount = count;
		}
	}
	return selected;
}

async function selectSwebenchBuildahCacheForSubmission(
	spec: SwebenchEnvironmentSpec,
): Promise<SwebenchBuildahCacheSelection> {
	const shards = configuredSwebenchBuildahCacheShards();
	if (shards <= 1) return swebenchBuildahCacheSelection(spec);
	try {
		const database = requireDb();
		const rows = await database
			.select({ envSpecHash: environmentImageBuilds.envSpecHash })
			.from(environmentImageBuilds)
			.where(inArray(environmentImageBuilds.status, ["queued", "building"]))
			.limit(Math.max(configuredSwebenchMaxActiveBuilds(), shards) + 1);
		const activeShardCounts: Record<number, number> = {};
		for (const row of rows) {
			if (!row.envSpecHash || row.envSpecHash === spec.envSpecHash) continue;
			const shard = hashedSwebenchBuildahCacheShard(row.envSpecHash, shards);
			activeShardCounts[shard] = (activeShardCounts[shard] ?? 0) + 1;
		}
		const shard = selectSwebenchBuildahCacheShard({
			envSpecHash: spec.envSpecHash,
			shards,
			activeShardCounts,
		});
		return shard == null
			? swebenchBuildahCacheSelection(spec)
			: swebenchBuildahCacheSelectionForShard(shard);
	} catch {
		return swebenchBuildahCacheSelection(spec);
	}
}

function configuredSwebenchBuildahCacheShards(): number {
	const raw =
		env.SWEBENCH_INFERENCE_BUILD_CACHE_SHARDS ??
		process.env.SWEBENCH_INFERENCE_BUILD_CACHE_SHARDS;
	if (!raw) {
		return 1;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 1) {
		return 1;
	}
	return Math.min(parsed, MAX_SWEBENCH_BUILDAH_CACHE_SHARDS);
}

function configuredSwebenchBuildahCacheShardNodes(): string[] {
	const raw = runtimeEnvString("SWEBENCH_INFERENCE_BUILD_CACHE_SHARD_NODES");
	if (!raw) return [];
	return raw.split(",").map((part) => part.trim());
}

function configuredSwebenchBuildKueueQueueName(): string | null {
	return (
		runtimeEnvString("SWEBENCH_INFERENCE_BUILD_KUEUE_QUEUE_NAME") ??
		runtimeEnvString("SWEBENCH_INFERENCE_BUILD_LOCAL_QUEUE")
	);
}

export function normalizeEnvironmentBuildActivityEvents(input: {
	build: EnvironmentImageBuild;
	pipelineRun?: TektonPipelineRun | null;
	taskRuns?: TektonTaskRun[];
}): NormalizedEnvironmentBuildActivityEvent[] {
	const { build, pipelineRun = null, taskRuns = [] } = input;
	const events: NormalizedEnvironmentBuildActivityEvent[] = [];
	const pipelineRunName =
		readString(pipelineRun?.metadata?.name) ?? build.pipelineRunName ?? null;
	const pipelineRunNamespace =
		readString(pipelineRun?.metadata?.namespace) ?? build.pipelineRunNamespace ?? null;

	function pushEvent(args: {
		eventType: EnvironmentBuildActivityEventType;
		timestamp: unknown;
		pipelineRunName?: string | null;
		pipelineRunNamespace?: string | null;
		taskRunName?: string | null;
		phase?: string | null;
		reason?: string | null;
		message?: string | null;
		rawMetadata?: Record<string, unknown>;
	}) {
		const eventPipelineRunName =
			args.pipelineRunName === undefined ? pipelineRunName : args.pipelineRunName;
		const eventPipelineRunNamespace =
			args.pipelineRunNamespace === undefined
				? pipelineRunNamespace
				: args.pipelineRunNamespace;
		const eventTimestamp =
			coerceDate(args.timestamp) ??
			build.completedAt ??
			build.startedAt ??
			build.requestedAt ??
			build.createdAt;
		const eventKey = buildActivityEventKey({
			eventType: args.eventType,
			pipelineRunName: eventPipelineRunName,
			pipelineRunNamespace: eventPipelineRunNamespace,
			taskRunName: args.taskRunName ?? null,
			phase: args.phase ?? null,
			timestamp: eventTimestamp,
		});
		events.push({
			id: deterministicActivityId(build.id, eventKey),
			buildId: build.id,
			environmentKey: build.environmentKey,
			eventKey,
			eventType: args.eventType,
			pipelineRunName: eventPipelineRunName,
			pipelineRunNamespace: eventPipelineRunNamespace,
			taskRunName: args.taskRunName ?? null,
			phase: args.phase ?? null,
			reason: args.reason ?? null,
			message: args.message ?? null,
			eventTimestamp,
			rawMetadata: args.rawMetadata ?? {},
		});
	}

	pushEvent({
		eventType: "build_queued",
		timestamp: build.requestedAt ?? build.createdAt,
		pipelineRunName: null,
		pipelineRunNamespace: null,
		phase: "queued",
		reason: "requested",
		message: `Environment build queued for ${build.environmentKey}`,
		rawMetadata: {
			source: "environment_image_builds",
			envSpecHash: build.envSpecHash,
			status: build.status,
		},
	});

	if (pipelineRunName) {
		pushEvent({
			eventType: "pipelinerun_created",
			timestamp: build.startedAt ?? pipelineRun?.metadata?.creationTimestamp ?? build.createdAt,
			phase: "created",
			reason: "PipelineRunCreated",
			message: `Tekton PipelineRun ${pipelineRunName} created`,
			rawMetadata: compactObject({
				metadata: pipelineRun?.metadata,
				spec: pipelineRun?.spec,
			}),
		});
	}

	const sortedTaskRuns = [...taskRuns].sort((a, b) => {
		const aTime =
			coerceDate(a.status?.startTime)?.getTime() ??
			coerceDate(a.metadata?.creationTimestamp)?.getTime() ??
			0;
		const bTime =
			coerceDate(b.status?.startTime)?.getTime() ??
			coerceDate(b.metadata?.creationTimestamp)?.getTime() ??
			0;
		if (aTime !== bTime) return aTime - bTime;
		return (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? "");
	});

	for (const taskRun of sortedTaskRuns) {
		const taskRunName = readString(taskRun.metadata?.name);
		if (!taskRunName) continue;
		const pipelineTaskName =
			readString(taskRun.metadata?.labels?.["tekton.dev/pipelineTask"]) ?? taskRunName;
		const taskCondition = tektonTaskRunSucceededCondition(taskRun);
		const taskResults = tektonTaskRunResults(taskRun);
		const taskRaw = compactObject({
			metadata: taskRun.metadata,
			status: {
				conditions: taskRun.status?.conditions,
				startTime: taskRun.status?.startTime,
				completionTime: taskRun.status?.completionTime,
				podName: taskRun.status?.podName,
				steps: taskRun.status?.steps,
				results: taskResults,
			},
		});

		if (taskRun.status?.startTime) {
			pushEvent({
				eventType: "task_started",
				timestamp: taskRun.status.startTime,
				taskRunName,
				phase: pipelineTaskName,
				reason: "TaskRunStarted",
				message: `Task ${pipelineTaskName} started`,
				rawMetadata: taskRaw,
			});
			if (isValidationTask(pipelineTaskName, taskRunName)) {
				pushEvent({
					eventType: "validation_started",
					timestamp: taskRun.status.startTime,
					taskRunName,
					phase: pipelineTaskName,
					reason: "ValidationStarted",
					message: "Environment image validation started",
					rawMetadata: taskRaw,
				});
			}
		}

		if (taskCondition?.status === "True") {
			pushEvent({
				eventType: "task_succeeded",
				timestamp:
					taskRun.status?.completionTime ??
					taskCondition.lastTransitionTime ??
					taskRun.status?.startTime,
				taskRunName,
				phase: pipelineTaskName,
				reason: taskCondition.reason ?? "Succeeded",
				message: taskCondition.message ?? `Task ${pipelineTaskName} succeeded`,
				rawMetadata: taskRaw,
			});
			if (isValidationTask(pipelineTaskName, taskRunName)) {
				pushEvent({
					eventType: "validation_succeeded",
					timestamp:
						taskRun.status?.completionTime ??
						taskCondition.lastTransitionTime ??
						taskRun.status?.startTime,
					taskRunName,
					phase: pipelineTaskName,
					reason: taskResults.validation_status || taskCondition.reason || "Validated",
					message:
						readString(taskResults.validation_log_ref) ??
						taskCondition.message ??
						"Environment image validation succeeded",
					rawMetadata: taskRaw,
				});
			}
		} else if (taskCondition?.status === "False") {
			const message =
				taskCondition.message ??
				failedTaskStepMessage(taskRun) ??
				`Task ${pipelineTaskName} failed`;
			pushEvent({
				eventType: "task_failed",
				timestamp:
					taskRun.status?.completionTime ??
					taskCondition.lastTransitionTime ??
					taskRun.status?.startTime,
				taskRunName,
				phase: pipelineTaskName,
				reason: taskCondition.reason ?? "Failed",
				message,
				rawMetadata: taskRaw,
			});
			if (isValidationTask(pipelineTaskName, taskRunName)) {
				pushEvent({
					eventType: "validation_failed",
					timestamp:
						taskRun.status?.completionTime ??
						taskCondition.lastTransitionTime ??
						taskRun.status?.startTime,
					taskRunName,
					phase: pipelineTaskName,
					reason: taskCondition.reason ?? "ValidationFailed",
					message,
					rawMetadata: taskRaw,
				});
			}
		}
	}

	if (pipelineRun) {
		const condition = tektonSucceededCondition(pipelineRun);
		const results = tektonPipelineRunResults(pipelineRun);
		const resultTimestamp =
			readString(results.built_at) ??
			pipelineRun.status?.completionTime ??
			build.completedAt ??
			build.builtAt ??
			build.startedAt ??
			build.createdAt;
		const pipelineRaw = compactObject({
			metadata: pipelineRun.metadata,
			status: {
				conditions: pipelineRun.status?.conditions,
				startTime: pipelineRun.status?.startTime,
				completionTime: pipelineRun.status?.completionTime,
				results,
			},
		});

		if (readString(results.validation_status)) {
			const validationStatus = readString(results.validation_status)!;
			const validationFailed = /fail|error|invalid/i.test(validationStatus);
			pushEvent({
				eventType: validationFailed ? "validation_failed" : "validation_succeeded",
				timestamp: resultTimestamp,
				phase: "validation",
				reason: validationStatus,
				message:
					readString(results.validation_log_ref) ??
					(validationFailed
						? "Environment image validation failed"
						: "Environment image validation succeeded"),
				rawMetadata: pipelineRaw,
			});
		}

		if (readString(results.image_ref)) {
			pushEvent({
				eventType: "image_pushed",
				timestamp: resultTimestamp,
				phase: "pushed",
				reason: "ImagePushed",
				message: readString(results.image_ref),
				rawMetadata: pipelineRaw,
			});
		}
		if (readString(results.image_digest)) {
			pushEvent({
				eventType: "digest_captured",
				timestamp: resultTimestamp,
				phase: "captured",
				reason: "DigestCaptured",
				message: readString(results.image_digest),
				rawMetadata: pipelineRaw,
			});
		}

		if (condition?.status === "True") {
			pushEvent({
				eventType: "build_succeeded",
				timestamp:
					pipelineRun.status?.completionTime ??
					condition.lastTransitionTime ??
					build.completedAt,
				phase: "Succeeded",
				reason: condition.reason ?? "Succeeded",
				message: condition.message ?? "Environment image build succeeded",
				rawMetadata: pipelineRaw,
			});
		} else if (condition?.status === "False") {
			pushEvent({
				eventType: "build_failed",
				timestamp:
					pipelineRun.status?.completionTime ??
					condition.lastTransitionTime ??
					build.completedAt,
				phase: "Failed",
				reason: condition.reason ?? "Failed",
				message: condition.message ?? "Tekton PipelineRun failed",
				rawMetadata: pipelineRaw,
			});
		}
	} else if (build.status === "validated") {
		pushEvent({
			eventType: "build_succeeded",
			timestamp: build.completedAt ?? build.builtAt ?? build.updatedAt,
			phase: "Succeeded",
			reason: "Validated",
			message: "Environment image build succeeded",
			rawMetadata: { source: "environment_image_builds", status: build.status },
		});
	} else if (build.status === "failed" || build.status === "cancelled") {
		pushEvent({
			eventType: "build_failed",
			timestamp: build.completedAt ?? build.updatedAt,
			phase: build.status === "cancelled" ? "Cancelled" : "Failed",
			reason: build.status,
			message: build.error ?? "Environment image build failed",
			rawMetadata: { source: "environment_image_builds", status: build.status },
		});
	}

	return dedupeEvents(events);
}

async function persistBuildActivityEvents(
	events: NormalizedEnvironmentBuildActivityEvent[],
): Promise<number> {
	if (events.length === 0) return 0;
	const database = requireDb();
	await database
		.insert(environmentBuildActivityEvents)
		.values(events)
		.onConflictDoUpdate({
			target: environmentBuildActivityEvents.id,
			set: {
				pipelineRunName: drizzleSql`excluded.pipeline_run_name`,
				pipelineRunNamespace: drizzleSql`excluded.pipeline_run_namespace`,
				taskRunName: drizzleSql`excluded.task_run_name`,
				phase: drizzleSql`excluded.phase`,
				reason: drizzleSql`excluded.reason`,
				message: drizzleSql`excluded.message`,
				rawMetadata: drizzleSql`excluded.raw_metadata`,
				updatedAt: new Date(),
			},
		});
	return events.length;
}

export async function getEnvironmentBuildActivity(
	buildId: string,
	options: { sync?: boolean; forceTerminal?: boolean } = {},
): Promise<EnvironmentBuildActivityResponse | null> {
	const database = requireDb();
	const [initial] = await database
		.select()
		.from(environmentImageBuilds)
		.where(eq(environmentImageBuilds.id, buildId))
		.limit(1);
	if (!initial) return null;

	let build = initial;
	let syncError: string | undefined;
	if (options.sync ?? true) {
		try {
			build = await syncEnvironmentBuild(initial, {
				forceTerminal: options.forceTerminal ?? true,
			});
		} catch (err) {
			syncError = err instanceof Error ? err.message : String(err);
		}
	}

	const events = await database
		.select()
		.from(environmentBuildActivityEvents)
		.where(eq(environmentBuildActivityEvents.buildId, build.id))
		.orderBy(
			asc(environmentBuildActivityEvents.eventTimestamp),
			asc(environmentBuildActivityEvents.eventType),
			asc(environmentBuildActivityEvents.createdAt),
		);
	const serializedEvents = events.map(serializeActivityEvent);
	return {
		build: serializeBuildSnapshot(build),
		events: serializedEvents,
		latestEvent: serializedEvents.at(-1) ?? null,
		...(syncError ? { syncError } : {}),
	};
}

export async function getBenchmarkRunEnvironmentActivity(
	projectId: string,
	runId: string,
	options: { syncActive?: boolean } = {},
): Promise<BenchmarkRunEnvironmentActivityResponse | null> {
	const database = requireDb();
	const [run] = await database
		.select({ id: benchmarkRuns.id })
		.from(benchmarkRuns)
		.where(and(eq(benchmarkRuns.id, runId), eq(benchmarkRuns.projectId, projectId)))
		.limit(1);
	if (!run) return null;

	const rows = await database
		.select({
			runInstanceId: benchmarkRunInstances.id,
			instanceId: benchmarkRunInstances.instanceId,
			inferenceEnvironment: benchmarkRunInstances.inferenceEnvironment,
		})
		.from(benchmarkRunInstances)
		.innerJoin(benchmarkRuns, eq(benchmarkRuns.id, benchmarkRunInstances.runId))
		.where(and(eq(benchmarkRunInstances.runId, runId), eq(benchmarkRuns.projectId, projectId)))
		.orderBy(benchmarkRunInstances.createdAt);

	const refs = rows.map((row) => ({
		...row,
		ref: environmentBuildRef(row.inferenceEnvironment),
	}));
	const buildIds = uniqueStrings(refs.map((row) => row.ref.buildId));
	const envSpecHashes = uniqueStrings(refs.map((row) => row.ref.envSpecHash));
	const environmentKeys = uniqueStrings(refs.map((row) => row.ref.environmentKey));

	const buildsById = new Map<string, EnvironmentImageBuild>();
	const buildsByHash = new Map<string, EnvironmentImageBuild>();
	const buildsByKey = new Map<string, EnvironmentImageBuild>();
	for (const build of await selectBuildsByRefs(buildIds, envSpecHashes, environmentKeys)) {
		buildsById.set(build.id, build);
		buildsByHash.set(build.envSpecHash, build);
		if (!buildsByKey.has(build.environmentKey)) buildsByKey.set(build.environmentKey, build);
	}

	if (options.syncActive) {
		for (const [key, build] of Array.from(buildsById.entries())) {
			if (!ACTIVE_BUILD_STATUSES.has(build.status) && !isPipelineManagedBuild(build)) continue;
			try {
				const synced = await syncEnvironmentBuild(build, {
					forceTerminal: isPipelineManagedBuild(build),
				});
				buildsById.set(key, synced);
				buildsByHash.set(synced.envSpecHash, synced);
				if (!buildsByKey.has(synced.environmentKey)) {
					buildsByKey.set(synced.environmentKey, synced);
				}
			} catch {
				/* Activity endpoints should remain readable during transient Tekton errors. */
			}
		}
	}

	const resolvedRefs = refs.map((row) => {
		const build =
			(row.ref.buildId ? buildsById.get(row.ref.buildId) : null) ??
			(row.ref.envSpecHash ? buildsByHash.get(row.ref.envSpecHash) : null) ??
			(row.ref.environmentKey ? buildsByKey.get(row.ref.environmentKey) : null) ??
			null;
		return { ...row, build };
	});
	for (const row of resolvedRefs) {
		if (!row.build || row.ref.buildId) continue;
		if (!row.ref.envSpecHash || row.ref.envSpecHash !== row.build.envSpecHash) continue;
		const inferenceEnvironment = mergeBuildMetadataIntoInferenceEnvironment(
			row.inferenceEnvironment,
			row.build,
		);
		if (!inferenceEnvironment) continue;
		await database
			.update(benchmarkRunInstances)
			.set({ inferenceEnvironment, updatedAt: new Date() })
			.where(eq(benchmarkRunInstances.id, row.runInstanceId));
	}

	const allBuildIds = Array.from(buildsById.keys());
	const eventRows = allBuildIds.length
		? await database
				.select()
				.from(environmentBuildActivityEvents)
				.where(inArray(environmentBuildActivityEvents.buildId, allBuildIds))
				.orderBy(
					asc(environmentBuildActivityEvents.eventTimestamp),
					asc(environmentBuildActivityEvents.eventType),
					asc(environmentBuildActivityEvents.createdAt),
				)
		: [];
	const eventsByBuildId = new Map<string, SerializedEnvironmentBuildActivityEvent[]>();
	for (const event of eventRows) {
		const list = eventsByBuildId.get(event.buildId) ?? [];
		list.push(serializeActivityEvent(event));
		eventsByBuildId.set(event.buildId, list);
	}

	return {
		runId,
		instances: resolvedRefs.map((row) => {
			const build = row.build;
			const events = build ? eventsByBuildId.get(build.id) ?? [] : [];
			return {
				runInstanceId: row.runInstanceId,
				instanceId: row.instanceId,
				build: build ? serializeBuildSnapshot(build) : null,
				events,
				latestEvent: events.at(-1) ?? null,
			};
		}),
	};
}

function serializeActivityEvent(
	event: EnvironmentBuildActivityEvent,
): SerializedEnvironmentBuildActivityEvent {
	return {
		id: event.id,
		buildId: event.buildId,
		environmentKey: event.environmentKey,
		eventKey: event.eventKey,
		eventType: event.eventType,
		pipelineRunName: event.pipelineRunName,
		pipelineRunNamespace: event.pipelineRunNamespace,
		taskRunName: event.taskRunName,
		phase: event.phase,
		reason: event.reason,
		message: event.message,
		timestamp: event.eventTimestamp.toISOString(),
		rawMetadata: event.rawMetadata,
		createdAt: event.createdAt.toISOString(),
		updatedAt: event.updatedAt.toISOString(),
	};
}

function serializeBuildSnapshot(build: EnvironmentImageBuild): SerializedEnvironmentBuildSnapshot {
	const spec = isRecord(build.spec) ? build.spec : {};
	return {
		id: build.id,
		dataset: build.dataset,
		suite: build.suite,
		repo: build.repo,
		version: build.version,
		environmentSetupCommit: build.environmentSetupCommit,
		baseCommit: build.baseCommit,
		environmentKey: build.environmentKey,
		envSpecHash: build.envSpecHash,
		buildStrategy: build.buildStrategy,
		workspaceRoot: readString(spec.workspaceRoot),
		condaEnvironment: readString(spec.condaEnvironment),
		swebenchSpec: isRecord(spec.swebenchSpec) ? spec.swebenchSpec : null,
		status: build.status,
		sandboxTemplate: build.sandboxTemplate,
		sandboxImage: build.sandboxImage,
		digest: build.digest,
		imageName: build.imageName,
		imageTag: build.imageTag,
		dockerfilePath: build.dockerfilePath,
		validationCommand: build.validationCommand,
		validationStatus: build.validationStatus,
		validationLogRef: build.validationLogRef,
		buildLogRef: build.buildLogRef,
		pipelineRunName: build.pipelineRunName,
		pipelineRunNamespace: build.pipelineRunNamespace,
		pipelineRunUrl: tektonPipelineRunUrl(build.pipelineRunNamespace, build.pipelineRunName),
		error: build.error,
		requestedAt: build.requestedAt.toISOString(),
		startedAt: build.startedAt?.toISOString() ?? null,
		completedAt: build.completedAt?.toISOString() ?? null,
		builtAt: build.builtAt?.toISOString() ?? null,
		createdAt: build.createdAt.toISOString(),
		updatedAt: build.updatedAt.toISOString(),
	};
}

async function selectBuildsByRefs(
	buildIds: string[],
	envSpecHashes: string[],
	environmentKeys: string[],
): Promise<EnvironmentImageBuild[]> {
	const database = requireDb();
	const byId = buildIds.length
		? await database
				.select()
				.from(environmentImageBuilds)
				.where(inArray(environmentImageBuilds.id, buildIds))
		: [];
	const byHash = envSpecHashes.length
		? await database
				.select()
				.from(environmentImageBuilds)
				.where(inArray(environmentImageBuilds.envSpecHash, envSpecHashes))
		: [];
	const byKey = environmentKeys.length
		? await database
				.select()
				.from(environmentImageBuilds)
				.where(inArray(environmentImageBuilds.environmentKey, environmentKeys))
				.orderBy(desc(environmentImageBuilds.updatedAt))
		: [];
	const seen = new Set<string>();
	const builds: EnvironmentImageBuild[] = [];
	for (const build of [...byId, ...byHash, ...byKey]) {
		if (seen.has(build.id)) continue;
		seen.add(build.id);
		builds.push(build);
	}
	return builds;
}

function environmentBuildRef(value: unknown): {
	buildId: string | null;
	envSpecHash: string | null;
	environmentKey: string | null;
} {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { buildId: null, envSpecHash: null, environmentKey: null };
	}
	const record = value as Record<string, unknown>;
	return {
		buildId: readString(record.buildId) ?? readString(record.build_id),
		envSpecHash: readString(record.envSpecHash) ?? readString(record.env_spec_hash),
		environmentKey:
			readString(record.environmentKey) ?? readString(record.environment_key),
	};
}

function mergeBuildMetadataIntoInferenceEnvironment(
	value: unknown,
	build: EnvironmentImageBuild,
): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const current = value as Record<string, unknown>;
	const next: Record<string, unknown> = { ...current };
	next.buildId = build.id;
	next.environmentStatus = buildStatusForInferenceEnvironment(build.status);
	next.status = build.status;
	next.environmentKey = build.environmentKey;
	next.envSpecHash = build.envSpecHash;
	next.buildStrategy = build.buildStrategy;
	next.sandboxTemplate = build.sandboxTemplate;
	if (build.sandboxImage) next.sandboxImage = build.sandboxImage;
	if (build.digest) next.digest = build.digest;
	if (build.validationStatus) next.validationStatus = build.validationStatus;
	if (build.validationLogRef) next.validationLogRef = build.validationLogRef;
	if (build.validationCommand) next.validationCommand = build.validationCommand;
	if (build.buildLogRef) next.buildLogRef = build.buildLogRef;
	if (build.pipelineRunName) next.pipelineRunName = build.pipelineRunName;
	if (build.pipelineRunNamespace) next.pipelineRunNamespace = build.pipelineRunNamespace;
	if (build.builtAt) next.builtAt = build.builtAt.toISOString();
	const spec = isRecord(build.spec) ? build.spec : {};
	const workspaceRoot = readString(spec.workspaceRoot);
	const condaEnvironment = readString(spec.condaEnvironment);
	const runtimeRoot = runtimeWorkspaceRoot(workspaceRoot);
	if (runtimeRoot) next.workspaceRoot = runtimeRoot;
	if (condaEnvironment) next.condaEnvironment = condaEnvironment;
	if (isRecord(spec.swebenchSpec)) next.swebenchSpec = spec.swebenchSpec;
	return next;
}

function buildStatusForInferenceEnvironment(
	status: EnvironmentImageBuildStatus,
): "validated" | "failed" | "building" {
	if (status === "validated") return "validated";
	if (status === "failed" || status === "cancelled") return "failed";
	return "building";
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
	return Array.from(
		new Set(values.filter((value): value is string => Boolean(value?.trim()))),
	);
}

function dedupeEvents(
	events: NormalizedEnvironmentBuildActivityEvent[],
): NormalizedEnvironmentBuildActivityEvent[] {
	const seen = new Set<string>();
	const out: NormalizedEnvironmentBuildActivityEvent[] = [];
	for (const event of events) {
		if (seen.has(event.eventKey)) continue;
		seen.add(event.eventKey);
		out.push(event);
	}
	return out.sort(
		(a, b) =>
			a.eventTimestamp.getTime() - b.eventTimestamp.getTime() ||
			a.eventType.localeCompare(b.eventType),
	);
}

function buildActivityEventKey(input: {
	eventType: EnvironmentBuildActivityEventType;
	pipelineRunName: string | null | undefined;
	pipelineRunNamespace: string | null | undefined;
	taskRunName: string | null | undefined;
	phase: string | null | undefined;
	timestamp: Date;
}): string {
	return [
		input.eventType,
		input.pipelineRunNamespace ?? "",
		input.pipelineRunName ?? "",
		input.taskRunName ?? "",
		input.phase ?? "",
		input.timestamp.toISOString(),
	]
		.join("|")
		.toLowerCase();
}

function deterministicActivityId(buildId: string, eventKey: string): string {
	return `eba_${sha256Hex(`${buildId}:${eventKey}`).slice(0, 40)}`;
}

function isValidationTask(...values: Array<string | null | undefined>): boolean {
	return values.some((value) => /validat(e|ion)|smoke[-_ ]?test/i.test(value ?? ""));
}

function isPipelineManagedBuild(
	build: Pick<EnvironmentImageBuild, "pipelineRunName" | "pipelineRunNamespace">,
): boolean {
	return Boolean(build.pipelineRunName && build.pipelineRunNamespace);
}

function isTektonCancelled(...values: Array<string | null | undefined>): boolean {
	return values.some((value) => {
		if (!value) return false;
		const withoutZeroCounts = value
			.replace(/\b(cancelled|canceled)\s*[:=]?\s*0\b/gi, "")
			.replace(/\b0\s+(cancelled|canceled)\b/gi, "");
		return /cancel/i.test(withoutZeroCounts);
	});
}

function failedTaskStepMessage(taskRun: TektonTaskRun): string | null {
	const failedStep = taskRun.status?.steps?.find((step) => step.terminated);
	const terminated = failedStep?.terminated as Record<string, unknown> | undefined;
	return (
		readString(terminated?.message) ??
		readString(terminated?.reason) ??
		(failedStep?.name ? `Step ${failedStep.name} failed` : null)
	);
}

function compactObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined),
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
	const raw = readString(value);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed) || Object.keys(parsed).length === 0) return null;
		return parsed;
	} catch {
		return null;
	}
}

function mergeSwebenchSpecMetadata(
	specValue: unknown,
	metadata: Record<string, unknown> | null,
): Record<string, unknown> {
	const spec = isRecord(specValue) ? specValue : {};
	if (!metadata) return spec;
	const currentSwebenchSpec = isRecord(spec.swebenchSpec) ? spec.swebenchSpec : {};
	const workspaceRoot = runtimeWorkspaceRoot(
		readString(metadata.workspaceRoot) ?? readString(spec.workspaceRoot),
	);
	const condaEnvironment =
		readString(metadata.condaEnvironment) ?? readString(spec.condaEnvironment) ?? undefined;
	return compactObject({
		...spec,
		workspaceRoot,
		condaEnvironment,
		swebenchSpec: compactObject({
			...currentSwebenchSpec,
			...metadata,
		}),
	});
}

function coerceDate(value: unknown): Date | null {
	if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
	return parseDate(value);
}

function tektonPipelineRunUrl(
	namespace: string | null | undefined,
	name: string | null | undefined,
): string | null {
	const base = readString(env.TEKTON_DASHBOARD_BASE_URL) ?? readString(env.TEKTON_DASHBOARD_URL);
	if (!base || !namespace || !name) return null;
	return `${base.replace(/\/+$/, "")}/namespaces/${encodeURIComponent(namespace)}/pipelineruns/${encodeURIComponent(name)}`;
}

function resultFromBuild(row: EnvironmentImageBuild): EnvironmentPrepareResult {
	const status = row.status;
	const environmentStatus =
		status === "validated" ? "validated" : status === "failed" || status === "cancelled" ? "failed" : "building";
	const environment = rowToEnvironment(row);
	const runtimeEnvironment = runtimeSafeEnvironment(environment);
	return {
		success: status !== "failed" && status !== "cancelled",
		complete: status === "validated" || status === "failed" || status === "cancelled",
		environmentStatus,
		status,
		environmentKey: row.environmentKey,
		envSpecHash: row.envSpecHash,
		buildId: row.id,
		buildStrategy: row.buildStrategy,
		sandboxTemplate: row.sandboxTemplate,
		sandboxImage: row.sandboxImage ?? undefined,
		digest: row.digest ?? undefined,
		validationStatus: row.validationStatus ?? undefined,
		validationLogRef: row.validationLogRef ?? undefined,
		buildLogRef: row.buildLogRef ?? undefined,
		pipelineRunName: row.pipelineRunName ?? undefined,
		pipelineRunNamespace: row.pipelineRunNamespace ?? undefined,
		builtAt: row.builtAt?.toISOString(),
		environment: runtimeEnvironment,
		promptNotes: promptNotes(environment),
		error: row.error ?? undefined,
		source: "environment_image_builds",
	};
}

function isLegacyStaticSwebenchEnvironment(
	environment: ResolvedSwebenchInferenceEnvironment,
): boolean {
	if (environment.buildStrategy !== "swebench-harness") return true;
	if (!environment.envSpecHash) return true;
	if (
		environment.condaEnvironment &&
		environment.condaEnvironment !== SWEBENCH_CONDA_ENV
	) {
		return true;
	}
	return false;
}

function validatedResult(
	environment: ResolvedSwebenchInferenceEnvironment,
	source: string,
): EnvironmentPrepareResult {
	const runtimeEnvironment = runtimeSafeEnvironment({ ...environment, source });
	return {
		success: true,
		complete: true,
		environmentStatus: "validated",
		status: "validated",
		environmentKey: environment.environmentKey,
		buildStrategy: environment.buildStrategy,
		envSpecHash: environment.envSpecHash,
		sandboxTemplate: environment.sandboxTemplate,
		sandboxImage: environment.sandboxImage,
		digest: environment.digest,
		validationStatus: environment.validationStatus,
		validationLogRef: environment.validationLogRef,
		builtAt: environment.builtAt,
		environment: runtimeEnvironment,
		promptNotes: promptNotes(environment),
		source,
	};
}

function buildNotSubmittedResult(
	input: SwebenchEnvironmentSpec,
	reason: string,
	message: string,
): EnvironmentPrepareResult {
	const environment: ResolvedSwebenchInferenceEnvironment = {
		environmentStatus: "failed",
		suite: input.suite,
		repo: input.repo,
		version: input.version,
		environmentSetupCommit: input.environmentSetupCommit,
		baseCommit: input.baseCommit,
		environmentKey: input.environmentKey,
		envSpecHash: input.envSpecHash,
		sandboxTemplate: input.sandboxTemplate,
		validationStatus: "failed",
		reason,
		source: "dynamic-build",
		buildStrategy: input.buildStrategy,
		workspaceRoot: runtimeWorkspaceRoot(input.workspaceRoot),
		condaEnvironment: input.condaEnvironment,
		environmentNotes: runtimeEnvironmentNotes(
			input.environmentNotes,
			input.workspaceRoot,
			input.buildStrategy,
		),
	};
	return {
		success: false,
		complete: true,
		environmentStatus: "failed",
		status: "failed",
		environmentKey: input.environmentKey,
		envSpecHash: input.envSpecHash,
		buildStrategy: input.buildStrategy,
		sandboxTemplate: input.sandboxTemplate,
		validationStatus: "failed",
		environment,
		error: message,
		source: "dynamic-build",
		reason,
	};
}

async function dynamicBuildSubmissionGuard(
	input: EnsureSwebenchEnvironmentInput,
): Promise<
	| { allowed: true; targetCluster: TektonTargetCluster }
	| { allowed: false; reason: string; message: string }
> {
	if (input.allowBuild !== true) {
		return {
			allowed: false,
			reason: "dynamic_build_not_allowed",
			message:
				"Dynamic SWE-bench inference image builds require allowBuild=true; returning without creating a PipelineRun.",
		};
	}
	const mode = runtimeEnvString("SWEBENCH_INFERENCE_BUILD_SUBMISSION_MODE")?.toLowerCase() ?? "disabled";
	if (mode === "local") {
		if (runtimeEnvString("SWEBENCH_INFERENCE_BUILD_ALLOW_LOCAL_PIPELINERUNS") === "true") {
			return { allowed: true, targetCluster: "local" };
		}
		return {
			allowed: false,
			reason: "dynamic_build_local_target_not_allowed",
			message:
				"Local SWE-bench inference image PipelineRuns are disabled; set SWEBENCH_INFERENCE_BUILD_ALLOW_LOCAL_PIPELINERUNS=true only for intentional local testing.",
		};
	}
	if (mode === "hub") {
		if (hasConfiguredHubTektonKubeconfig()) {
			const capacity = await dynamicBuildCapacityGuard();
			if (!capacity.allowed) return capacity;
			return { allowed: true, targetCluster: "hub" };
		}
		return {
			allowed: false,
			reason: "dynamic_build_hub_target_not_configured",
			message:
				"Hub SWE-bench inference image build submission is not configured in this runtime; refusing to create a local PipelineRun.",
		};
	}
	return {
		allowed: false,
		reason: "dynamic_build_submission_disabled",
		message:
			"Dynamic SWE-bench inference image build submission is disabled; refusing to create a PipelineRun.",
	};
}

async function dynamicBuildCapacityGuard(): Promise<
	| { allowed: true }
	| { allowed: false; reason: string; message: string }
> {
	const maxActive = configuredSwebenchMaxActiveBuilds();
	if (maxActive <= 0) return { allowed: true };
	const active = await countActiveEnvironmentBuilds(maxActive);
	if (active < maxActive) return { allowed: true };
	return {
		allowed: false,
		reason: "dynamic_build_capacity_exhausted",
		message: `SWE-bench inference image build submission is throttled: ${active} active build(s) meet or exceed SWEBENCH_INFERENCE_BUILD_MAX_ACTIVE=${maxActive}.`,
	};
}

async function countActiveEnvironmentBuilds(limit: number): Promise<number> {
	const database = requireDb();
	const rows = await database
		.select({ id: environmentImageBuilds.id })
		.from(environmentImageBuilds)
		.where(inArray(environmentImageBuilds.status, ["queued", "building"]))
		.limit(limit);
	return rows.length;
}

function configuredSwebenchMaxActiveBuilds(): number {
	const raw =
		env.SWEBENCH_INFERENCE_BUILD_MAX_ACTIVE ??
		process.env.SWEBENCH_INFERENCE_BUILD_MAX_ACTIVE;
	if (!raw) return DEFAULT_SWEBENCH_MAX_ACTIVE_BUILDS;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SWEBENCH_MAX_ACTIVE_BUILDS;
	return Math.min(parsed, MAX_SWEBENCH_MAX_ACTIVE_BUILDS);
}

function dynamicBuildTargetFromEnv(): TektonTargetCluster {
	const mode = runtimeEnvString("SWEBENCH_INFERENCE_BUILD_SUBMISSION_MODE")?.toLowerCase() ?? "disabled";
	return mode === "hub" ? "hub" : "local";
}

function runtimeEnvString(name: string): string | null {
	return readString(env[name]) ?? readString(process.env[name]);
}

type FallbackEnvironmentInput = {
	suite: SwebenchSuiteSlug | string | null;
	repo: string;
	version?: string | null;
	environmentSetupCommit?: string | null;
	baseCommit?: string | null;
	environmentKey?: string | null;
	envSpecHash?: string | null;
	buildStrategy?: string | null;
	sandboxTemplate?: string | null;
	validationCommand?: string | null;
	workspaceRoot?: string | null;
};

function fallbackResult(
	input: FallbackEnvironmentInput,
	reason: string,
	error?: string,
	row?: EnvironmentImageBuild | null,
): EnvironmentPrepareResult {
	const environment = fallbackEnvironment(input, reason, row);
	return {
		success: true,
		complete: true,
		environmentStatus: "fallback",
		status: "fallback",
		environmentKey: input.environmentKey ?? undefined,
		envSpecHash: input.envSpecHash ?? undefined,
		buildId: row?.id,
		sandboxTemplate: environment.sandboxTemplate,
		buildLogRef: row?.buildLogRef ?? undefined,
		pipelineRunName: row?.pipelineRunName ?? undefined,
		pipelineRunNamespace: row?.pipelineRunNamespace ?? undefined,
		environment,
		promptNotes: [
			"- No validated repo-specific inference image is available for this run; using the default dapr-agent sandbox.",
			"- Dependency setup is best-effort in this fallback mode; install only the minimal missing packages needed for local checks.",
		].join("\n"),
		error,
		source: "dynamic-build",
		reason,
	};
}

function fallbackEnvironment(
	input: FallbackEnvironmentInput,
	reason: string,
	row?: EnvironmentImageBuild | null,
): ResolvedSwebenchInferenceEnvironment {
	const sandboxTemplate = input.sandboxTemplate ?? DEFAULT_SANDBOX_TEMPLATE;
	return {
		environmentStatus: "fallback",
		suite: input.suite ?? "",
		repo: input.repo,
		version: input.version ?? undefined,
		environmentSetupCommit: input.environmentSetupCommit ?? undefined,
		baseCommit: input.baseCommit ?? undefined,
		environmentKey: input.environmentKey ?? undefined,
		sandboxTemplate,
		source: "dynamic-build",
		reason,
		envSpecHash: input.envSpecHash ?? undefined,
		buildId: row?.id,
		buildLogRef: row?.buildLogRef ?? undefined,
		pipelineRunName: row?.pipelineRunName ?? undefined,
		pipelineRunNamespace: row?.pipelineRunNamespace ?? undefined,
		workspaceRoot: FALLBACK_WORKSPACE_ROOT,
	};
}

function runtimeWorkspaceRoot(workspaceRoot: string | null | undefined): string | undefined {
	const root = readString(workspaceRoot);
	if (
		root === LEGACY_SWEBENCH_IMAGE_WORKSPACE_ROOT ||
		root === SWEBENCH_WORKSPACE_ROOT
	) {
		return OPENSHELL_RUNTIME_WORKSPACE_ROOT;
	}
	return root ?? undefined;
}

function runtimeEnvironmentNotes(
	notes: string[] | undefined,
	workspaceRoot: string | null | undefined,
	buildStrategy?: string | null | undefined,
): string[] | undefined {
	const filteredNotes = (notes ?? []).filter(
		(note) => !containsSensitiveSwebenchRuntimeTerm(note),
	);
	if (buildStrategy !== "swebench-harness") {
		return filteredNotes.length ? [...new Set(filteredNotes)] : undefined;
	}
	const runtimeNotes = [
		...filteredNotes,
		"The validated image provides the SWE-bench Python environment; the repository is cloned into /sandbox/repo for OpenShell runtime access.",
		"Use python or /sandbox/.venv/bin/python for local checks; avoid conda activation inside the solve phase.",
	];
	return [...new Set(runtimeNotes)];
}

export function runtimeSafeEnvironment(
	environment: ResolvedSwebenchInferenceEnvironment,
): ResolvedSwebenchInferenceEnvironment {
	const { validationCommand: _validationCommand, swebenchSpec: _swebenchSpec, ...safe } = environment;
	return {
		...safe,
		workspaceRoot: FALLBACK_WORKSPACE_ROOT,
		environmentNotes: runtimeEnvironmentNotes(
			environment.environmentNotes,
			environment.workspaceRoot,
			environment.buildStrategy,
		),
	};
}

function containsSensitiveSwebenchRuntimeTerm(value: string): boolean {
	return /\/testbed|test[_-]?patch|fail_to_pass|pass_to_pass|goldpatch/i.test(
		value,
	);
}

function rowToEnvironment(row: EnvironmentImageBuild): ResolvedSwebenchInferenceEnvironment {
	const spec = isRecord(row.spec) ? row.spec : {};
	const workspaceRoot = readString(spec.workspaceRoot);
	const environmentNotes = readStringList(spec.environmentNotes);
	return {
		environmentStatus: buildStatusForInferenceEnvironment(row.status),
		suite: row.suite ?? "",
		repo: row.repo,
		version: row.version ?? undefined,
		environmentSetupCommit: row.environmentSetupCommit ?? undefined,
		baseCommit: row.baseCommit ?? undefined,
		environmentKey: row.environmentKey,
		sandboxTemplate: row.sandboxTemplate,
		sandboxImage: row.sandboxImage ?? undefined,
		digest: row.digest ?? undefined,
		validationStatus: row.validationStatus ?? undefined,
		validationLogRef: row.validationLogRef ?? undefined,
		validationCommand: row.validationCommand ?? undefined,
		builtAt: row.builtAt?.toISOString(),
		source: "environment_image_builds",
		reason: row.error ?? undefined,
		buildStrategy: row.buildStrategy,
		envSpecHash: row.envSpecHash,
		buildId: row.id,
		buildLogRef: row.buildLogRef ?? undefined,
		pipelineRunName: row.pipelineRunName ?? undefined,
		pipelineRunNamespace: row.pipelineRunNamespace ?? undefined,
		workspaceRoot: runtimeWorkspaceRoot(workspaceRoot),
		condaEnvironment: readString(spec.condaEnvironment) ?? undefined,
		swebenchSpec: isRecord(spec.swebenchSpec) ? spec.swebenchSpec : undefined,
		environmentNotes: runtimeEnvironmentNotes(
			environmentNotes,
			workspaceRoot,
			row.buildStrategy,
		),
	};
}

function promptNotes(environment: ResolvedSwebenchInferenceEnvironment | null | undefined): string {
	if (environment?.environmentStatus !== "validated") return "";
	const lines = [
		`- Inference image: ${environment.sandboxImage ?? "validated sandbox image"}`,
		environment.digest ? `- Image digest: ${environment.digest}` : "",
		environment.workspaceRoot
			? `- Prepared repository root: ${environment.workspaceRoot}`
			: "",
		environment.condaEnvironment
			? `- Conda environment: ${environment.condaEnvironment}`
			: "",
		environment.validationLogRef
			? `- Environment validation log: ${environment.validationLogRef}`
			: "",
		...(environment.environmentNotes ?? []).map((note) => `- ${note}`),
	];
	return lines.filter(Boolean).join("\n");
}

function stablePipelineRunName(spec: SwebenchEnvironmentSpec): string {
	return `swe-env-${spec.envSpecHash.slice(0, 24)}`;
}

function requireDb() {
	if (!db) throw new Error("Database not configured");
	return db;
}

function imageWithDigest(image: string | null | undefined, digest: string | null | undefined) {
	const normalizedImage = readString(image);
	if (!normalizedImage) return null;
	if (normalizedImage.includes("@sha256:")) return normalizedImage;
	const normalizedDigest = readString(digest);
	if (!normalizedDigest?.startsWith("sha256:")) return null;
	return `${normalizedImage}@${normalizedDigest}`;
}

function digestFromImage(image: string | null | undefined): string | null {
	const normalizedImage = readString(image);
	if (!normalizedImage) return null;
	const marker = "@sha256:";
	const index = normalizedImage.indexOf(marker);
	return index < 0 ? null : normalizedImage.slice(index + 1);
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const parsed = value
		.map((entry) => readString(entry))
		.filter((entry): entry is string => Boolean(entry));
	return parsed.length ? parsed : undefined;
}

function parseDate(value: unknown): Date | null {
	const raw = readString(value);
	if (!raw) return null;
	const date = new Date(raw);
	return Number.isNaN(date.getTime()) ? null : date;
}

function isTektonBackendUnavailable(value: unknown): boolean {
	const message = readString(value)?.toLowerCase();
	if (!message) return false;
	const mentionsPipelineRun =
		message.includes("pipelinerun") ||
		message.includes("tekton.dev") ||
		message.includes("tekton");
	if (!mentionsPipelineRun) return false;
	return (
		message.includes("could not find the requested resource") ||
		message.includes("server doesn't have a resource type") ||
		message.includes("no matches for kind") ||
		message.includes("not found") ||
		message.includes("forbidden")
	);
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
