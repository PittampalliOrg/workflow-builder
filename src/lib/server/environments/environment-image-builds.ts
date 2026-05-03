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
	type EnvironmentImageBuildStrategy,
	type NewEnvironmentBuildActivityEvent,
} from "$lib/server/db/schema";
import {
	createTektonPipelineRun,
	getTektonPipelineRun,
	listTektonTaskRunsForPipelineRun,
	tektonPipelineRunResults,
	tektonSucceededCondition,
	tektonTaskRunResults,
	tektonTaskRunSucceededCondition,
	type TektonPipelineRun,
	type TektonTaskRun,
} from "$lib/server/kube/tekton";
import {
	resolveSwebenchInferenceEnvironment,
	type ResolvedSwebenchInferenceEnvironment,
} from "$lib/server/benchmarks/inference-environments";
import type { SwebenchSuiteSlug } from "$lib/server/benchmarks/swebench";

const DEFAULT_SANDBOX_TEMPLATE = "dapr-agent";
const DEFAULT_TEKTON_NAMESPACE = "tekton-pipelines";
const DEFAULT_GIT_REVISION = "main";
const SWEBENCH_PIPELINE_TIMEOUTS = {
	pipeline: "4h0m0s",
	tasks: "3h45m0s",
} as const;
const LEGACY_SWEBENCH_IMAGE_WORKSPACE_ROOT = "/testbed";
const OPENSHELL_RUNTIME_WORKSPACE_ROOT = "/sandbox/repo";
const SWEBENCH_WORKSPACE_ROOT = OPENSHELL_RUNTIME_WORKSPACE_ROOT;
const FALLBACK_WORKSPACE_ROOT = OPENSHELL_RUNTIME_WORKSPACE_ROOT;
const SWEBENCH_CONDA_ENV = "testbed";
const SUPPORTED_SWEBENCH_HARNESS_VERSIONS: Record<string, readonly string[]> = {
	"astropy/astropy": ["0.1", "0.2", "0.3", "0.4", "1.1", "1.2", "1.3", "3.0", "3.1", "3.2", "4.1", "4.2", "4.3", "5.0", "5.1", "5.2", "v5.3"],
	"dbt-labs/dbt-core": ["0.13", "0.14", "0.15", "0.16", "0.17", "0.18", "0.19", "0.20", "0.21", "1.0", "1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7"],
	"django/django": ["1.10", "1.11", "1.4", "1.5", "1.6", "1.7", "1.8", "1.9", "2.0", "2.1", "2.2", "3.0", "3.1", "3.2", "4.0", "4.1", "4.2", "5.0", "5.1", "5.2"],
	"matplotlib/matplotlib": ["1.0", "1.1", "1.2", "1.3", "1.4", "1.5", "2.0", "2.1", "2.2", "3.0", "3.1", "3.2", "3.3", "3.4", "3.5", "3.6", "3.7", "3.8", "3.9"],
	"marshmallow-code/marshmallow": ["2.18", "2.19", "2.20", "3.0", "3.1", "3.10", "3.11", "3.12", "3.13", "3.15", "3.16", "3.19", "3.2", "3.4", "3.8", "3.9"],
	"mwaskom/seaborn": ["0.11", "0.12", "0.13", "0.14"],
	"pallets/flask": ["2.0", "2.1", "2.2", "2.3", "3.0", "3.1"],
	"psf/requests": ["0.11", "0.13", "0.14", "0.7", "0.8", "0.9", "1.1", "1.2", "2.0", "2.10", "2.11", "2.12", "2.17", "2.18", "2.19", "2.2", "2.22", "2.25", "2.26", "2.27", "2.3", "2.31", "2.4", "2.5", "2.7", "2.8", "2.9", "3.0"],
	"pvlib/pvlib-python": ["0.1", "0.2", "0.3", "0.4", "0.5", "0.6", "0.7", "0.8", "0.9"],
	"pydata/xarray": ["0.12", "0.18", "0.19", "0.20", "2022.03", "2022.06", "2022.09", "2023.07", "2024.05"],
	"pydicom/pydicom": ["1.0", "1.1", "1.2", "1.3", "1.4", "2.0", "2.1", "2.2", "2.3", "2.4", "3.0"],
	"pylint-dev/astroid": ["2.10", "2.12", "2.13", "2.14", "2.15", "2.16", "2.5", "2.6", "2.7", "2.8", "2.9", "3.0"],
	"pylint-dev/pylint": ["2.10", "2.11", "2.13", "2.14", "2.15", "2.16", "2.17", "2.8", "2.9", "3.0", "3.1", "3.2", "3.3", "4.0"],
	"pytest-dev/pytest": ["4.4", "4.5", "4.6", "5.0", "5.1", "5.2", "5.3", "5.4", "6.0", "6.2", "6.3", "7.0", "7.1", "7.2", "7.4", "8.0", "8.1", "8.2", "8.3", "8.4"],
	"pyvista/pyvista": ["0.20", "0.21", "0.22", "0.23", "0.24", "0.25", "0.26", "0.27", "0.28", "0.29", "0.30", "0.31", "0.32", "0.33", "0.34", "0.35", "0.36", "0.37", "0.38", "0.39", "0.40", "0.41", "0.42", "0.43"],
	"scikit-learn/scikit-learn": ["0.20", "0.21", "0.22", "1.3", "1.4", "1.5", "1.6"],
	"sphinx-doc/sphinx": ["1.5", "1.6", "1.7", "1.8", "2.0", "2.1", "2.2", "2.3", "2.4", "3.0", "3.1", "3.2", "3.3", "3.4", "3.5", "4.0", "4.1", "4.2", "4.3", "4.4", "4.5", "5.0", "5.1", "5.2", "5.3", "6.0", "6.2", "7.0", "7.1", "7.2", "7.3", "7.4", "8.0", "8.1"],
	"sqlfluff/sqlfluff": ["0.10", "0.11", "0.12", "0.13", "0.4", "0.5", "0.6", "0.8", "0.9", "1.0", "1.1", "1.2", "1.3", "1.4", "2.0", "2.1", "2.2"],
	"sympy/sympy": ["0.7", "1.0", "1.1", "1.10", "1.11", "1.12", "1.13", "1.14", "1.2", "1.4", "1.5", "1.6", "1.7", "1.8", "1.9"],
};
const ACTIVE_BUILD_STATUSES = new Set<EnvironmentImageBuildStatus>([
	"queued",
	"building",
]);
const TERMINAL_BUILD_STATUSES = new Set<EnvironmentImageBuildStatus>([
	"validated",
	"failed",
	"cancelled",
]);

export type EnsureSwebenchEnvironmentInput = {
	dataset?: string | null;
	suiteSlug: SwebenchSuiteSlug;
	instanceId?: string | null;
	repo: string;
	baseCommit: string;
	testMetadata?: Record<string, unknown> | null;
	timeoutMs?: number | null;
	pollMs?: number | null;
	allowBuild?: boolean | null;
};

export type SwebenchEnvironmentSpec = {
	dataset: string;
	suite: SwebenchSuiteSlug;
	instanceId?: string;
	repo: string;
	version?: string;
	environmentSetupCommit?: string;
	baseCommit: string;
	environmentKey: string;
	envSpecHash: string;
	buildStrategy: EnvironmentImageBuildStrategy;
	sandboxTemplate: string;
	imageName: string;
	imageTag: string;
	dockerfilePath: string;
	validationCommand: string;
	environmentNotes: string[];
	workspaceRoot: string;
	condaEnvironment?: string;
	swebenchSpec?: Record<string, unknown>;
	swebenchSpecInput?: Record<string, unknown>;
	fallbackReason?: string;
};

export type EnvironmentPrepareResult = {
	success: boolean;
	complete: boolean;
	environmentStatus: "validated" | "building" | "failed" | "fallback";
	status: EnvironmentImageBuildStatus | "validated" | "fallback";
	environmentKey?: string;
	envSpecHash?: string;
	buildId?: string;
	buildStrategy?: string;
	sandboxTemplate: string;
	sandboxImage?: string;
	digest?: string;
	validationStatus?: string;
	validationLogRef?: string;
	validationCommand?: string;
	buildLogRef?: string;
	pipelineRunName?: string;
	pipelineRunNamespace?: string;
	builtAt?: string;
	environment?: ResolvedSwebenchInferenceEnvironment;
	promptNotes?: string;
	error?: string;
	source?: string;
	reason?: string;
};

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

export function buildSwebenchEnvironmentSpec(
	input: EnsureSwebenchEnvironmentInput,
): SwebenchEnvironmentSpec {
	const dataset = readString(input.dataset) ?? input.suiteSlug;
	const repo = normalizeRepo(input.repo) ?? input.repo;
	const repoName = repo.split("/").pop() ?? repo.replace("/", "-");
	const version = readMetadataString(input.testMetadata, ["version"]) ?? undefined;
	const environmentSetupCommit = readMetadataString(input.testMetadata, [
		"environmentSetupCommit",
		"environment_setup_commit",
	]) ?? undefined;
	const selector = version ?? environmentSetupCommit?.slice(0, 12) ?? input.baseCommit.slice(0, 12);
	const environmentKey = sanitizeSlug(`${repoName}-${selector}`);
	const imageName = `swebench-inference-${environmentKey}`;
	const harnessSpecInput = buildSwebenchHarnessSpecInput({
		dataset,
		suite: input.suiteSlug,
		instanceId: readString(input.instanceId) ?? undefined,
		repo,
		version,
		baseCommit: input.baseCommit,
		testMetadata: input.testMetadata,
	});
	const buildStrategy: EnvironmentImageBuildStrategy = harnessSpecInput
		? "swebench-harness"
		: "buildpacks";
	const workspaceRoot =
		buildStrategy === "swebench-harness"
			? SWEBENCH_WORKSPACE_ROOT
			: FALLBACK_WORKSPACE_ROOT;
	const dockerfilePath =
		buildStrategy === "swebench-harness"
			? "Dockerfile"
			: readMetadataString(input.testMetadata, ["dockerfilePath", "dockerfile_path"]) ??
				`services/openshell-sandbox/environments/Dockerfile.swebench-inference-${environmentKey}`;
	const defaultTuning = defaultSwebenchEnvironmentTuning(repo, buildStrategy);
	const validationCommand =
		readMetadataString(input.testMetadata, ["validationCommand", "validation_command"]) ??
		(buildStrategy === "swebench-harness"
			? defaultSwebenchHarnessValidationCommand(workspaceRoot)
			: defaultTuning.validationCommand);
	const swebenchSpec =
		buildStrategy === "swebench-harness"
			? compactObject({
					source: "swebench-harness-generator",
					workspaceRoot,
					condaEnvironment: SWEBENCH_CONDA_ENV,
					generatorModule: "swebench.harness.environment_spec",
					buildContextDockerfile: dockerfilePath,
				})
			: undefined;
	const baseSpec = {
		dataset,
		suite: input.suiteSlug,
		repo,
		version,
		environmentSetupCommit,
		baseCommit: input.baseCommit,
		environmentKey,
		buildStrategy,
		sandboxTemplate: DEFAULT_SANDBOX_TEMPLATE,
		imageName,
		dockerfilePath,
		validationCommand,
		workspaceRoot,
		condaEnvironment:
			buildStrategy === "swebench-harness" ? SWEBENCH_CONDA_ENV : undefined,
		swebenchSpecInput: harnessSpecInput ?? undefined,
		swebenchSpec,
	};
	const envSpecHash = sha256Hex(stableJson(baseSpec));
	return {
		...baseSpec,
		instanceId: readString(input.instanceId) ?? undefined,
		envSpecHash,
		imageTag: `env-${envSpecHash.slice(0, 16)}`,
		environmentNotes: defaultTuning.environmentNotes,
		fallbackReason:
			buildStrategy === "buildpacks"
				? missingHarnessMetadataReason(repo, input.testMetadata)
				: undefined,
	};
}

function defaultSwebenchEnvironmentTuning(
	repo: string,
	buildStrategy: EnvironmentImageBuildStrategy,
): {
	validationCommand: string;
	environmentNotes: string[];
} {
	const commonNotes =
		buildStrategy === "swebench-harness"
			? [
					"The repository is cloned into /sandbox/repo at the SWE-bench base commit before validation and runtime solve steps.",
					"Dependencies are installed from the SWE-bench harness spec and exposed through /sandbox/.venv at runtime.",
					"Use the existing environment and avoid reinstalling project dependencies during the solve phase.",
				]
			: [
					"This fallback image was selected or built before the agent started and validated with a repository checkout smoke test.",
					"Dependency setup is best-effort in fallback mode; install only minimal missing packages if local checks require it.",
				];
	switch (repo) {
		case "pallets/flask":
			return {
				validationCommand:
					"PYTHONPATH=src python -c 'import flask, pytest; print(\"flask\", flask.__version__); print(\"pytest\", pytest.__version__)'",
				environmentNotes: [
					"For local imports and tests in this source-layout repo, prefix Python commands with PYTHONPATH=src.",
					...commonNotes,
				],
			};
		case "psf/requests":
			return {
				validationCommand:
					"python -c 'import requests, pytest; print(\"requests\", requests.__version__); print(\"pytest\", pytest.__version__)'",
				environmentNotes: commonNotes,
			};
		case "pytest-dev/pytest":
			return {
				validationCommand:
					"python -c 'import pytest; print(\"pytest\", pytest.__version__)'",
				environmentNotes: commonNotes,
			};
		case "sympy/sympy":
			return {
				validationCommand:
					"python -c 'import sympy, mpmath; print(\"sympy\", sympy.__version__); print(\"mpmath\", mpmath.__version__)' && python -m pip show flake8-comprehensions >/dev/null && python -c 'import pytest; print(\"pytest\", pytest.__version__)'",
				environmentNotes: commonNotes,
			};
		default:
			return {
				validationCommand:
					"python --version && python -c 'import pytest; print(\"pytest\", pytest.__version__)'",
				environmentNotes: commonNotes,
			};
	}
}

export function plannedSwebenchInferenceEnvironment(
	input: EnsureSwebenchEnvironmentInput,
): ResolvedSwebenchInferenceEnvironment {
	const resolved = resolveSwebenchInferenceEnvironment({
		suiteSlug: input.suiteSlug,
		repo: input.repo,
		baseCommit: input.baseCommit,
		testMetadata: input.testMetadata,
	});
	if (resolved.environmentStatus === "validated") return resolved;
	const spec = buildSwebenchEnvironmentSpec(input);
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
	const staticResolved = resolveSwebenchInferenceEnvironment({
		suiteSlug: input.suiteSlug,
		repo: input.repo,
		baseCommit: input.baseCommit,
		testMetadata: input.testMetadata,
	});
	if (staticResolved.environmentStatus === "validated") {
		return validatedResult(staticResolved, "static_mapping");
	}

	const spec = buildSwebenchEnvironmentSpec(input);
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

	const submission = dynamicBuildSubmissionGuard(input);
	if (!submission.allowed) {
		return buildNotSubmittedResult(spec, submission.reason, submission.message);
	}

	const row = existing ?? (await insertBuild(spec, input));
	const pipelineRunName = row.pipelineRunName || stablePipelineRunName(spec);
	const pipelineRunNamespace = row.pipelineRunNamespace ?? DEFAULT_TEKTON_NAMESPACE;
	if (!row.pipelineRunName) {
		try {
			const submitted = await submitSwebenchPipelineRun(spec, pipelineRunName, pipelineRunNamespace);
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
	const pipelineRun = await getTektonPipelineRun(row.pipelineRunNamespace, row.pipelineRunName);
	if (!pipelineRun) return row;
	const taskRuns = await listTektonTaskRunsForPipelineRun(
		row.pipelineRunNamespace,
		row.pipelineRunName,
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
) {
	return createTektonPipelineRun(namespace, buildSwebenchPipelineRunManifest(spec, pipelineRunName, namespace));
}

export function buildSwebenchPipelineRunManifest(
	spec: SwebenchEnvironmentSpec,
	pipelineRunName: string,
	namespace: string,
): TektonPipelineRun {
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
			},
		},
		spec: {
			pipelineRef: { name: "swebench-inference-image-build" },
			taskRunTemplate: { serviceAccountName: "workflow-builder-build-trigger" },
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
			timeouts: SWEBENCH_PIPELINE_TIMEOUTS,
			params: [
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
			],
			workspaces: [
				{
					name: "buildah-cache",
					persistentVolumeClaim: { claimName: "buildah-cache-swebench-inference" },
				},
				{ name: "dockerconfig", secret: { secretName: "gitea-registry-credentials" } },
				{ name: "stacks-source", emptyDir: {} },
			],
		},
	};
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

function dynamicBuildSubmissionGuard(
	input: EnsureSwebenchEnvironmentInput,
): { allowed: true } | { allowed: false; reason: string; message: string } {
	if (input.allowBuild !== true) {
		return {
			allowed: false,
			reason: "dynamic_build_not_allowed",
			message:
				"Dynamic SWE-bench inference image builds require allowBuild=true; returning without creating a PipelineRun.",
		};
	}
	const mode = readString(env.SWEBENCH_INFERENCE_BUILD_SUBMISSION_MODE)?.toLowerCase() ?? "disabled";
	if (mode === "local") return { allowed: true };
	if (mode === "hub") {
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

function readMetadataString(
	metadata: Record<string, unknown> | null | undefined,
	keys: string[],
): string | null {
	if (!metadata) return null;
	for (const key of keys) {
		const value = readString(metadata[key]);
		if (value) return value;
	}
	return null;
}

/**
 * Read a metadata field that contains structured text (unified-diff bodies,
 * shell scripts, etc.) where trailing whitespace is semantically significant.
 *
 * Plain `readMetadataString` calls `readString().trim()` which strips trailing
 * ` \n\n` from a unified diff — that sequence represents the empty-source-line
 * context marker plus the diff's final newline, and the hunk header's line
 * count assumes both are present. Trimming desynchronizes the hunk count and
 * makes `unidiff.PatchSet(...)` raise `Hunk is shorter than expected` inside
 * the SWE-bench harness's `make_eval_script_list_py`. See
 * `services/swebench-coordinator` env-build failures on `django__django-13128`.
 */
function readMetadataRawString(
	metadata: Record<string, unknown> | null | undefined,
	keys: string[],
): string | null {
	if (!metadata) return null;
	for (const key of keys) {
		const value = metadata[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
}

function buildSwebenchHarnessSpecInput(input: {
	dataset: string;
	suite: SwebenchSuiteSlug;
	instanceId?: string;
	repo: string;
	version?: string;
	baseCommit: string;
	testMetadata?: Record<string, unknown> | null;
}): Record<string, unknown> | null {
	// test_patch must NOT be trimmed — trailing ` \n\n` is the unidiff context
	// marker for an empty source line. See readMetadataRawString docstring.
	const testPatch = readMetadataRawString(input.testMetadata, [
		"test_patch",
		"testPatch",
	]);
	if (!input.version || !isSupportedSwebenchHarnessSpec(input.repo, input.version) || !testPatch) {
		return null;
	}
	return compactObject({
		dataset: input.dataset,
		suite: input.suite,
		instance_id: input.instanceId,
		repo: input.repo,
		version: input.version,
		base_commit: input.baseCommit,
		test_patch: testPatch,
		FAIL_TO_PASS: readMetadataJsonish(input.testMetadata, ["FAIL_TO_PASS", "fail_to_pass"]),
		PASS_TO_PASS: readMetadataJsonish(input.testMetadata, ["PASS_TO_PASS", "pass_to_pass"]),
		environment_setup_commit: readMetadataString(input.testMetadata, [
			"environmentSetupCommit",
			"environment_setup_commit",
		]),
	});
}

function readMetadataJsonish(
	metadata: Record<string, unknown> | null | undefined,
	keys: string[],
): unknown {
	if (!metadata) return undefined;
	for (const key of keys) {
		const value = metadata[key];
		if (value === undefined || value === null) continue;
		if (typeof value === "string") {
			const raw = value.trim();
			if (!raw) continue;
			try {
				return JSON.parse(raw) as unknown;
			} catch {
				return raw;
			}
		}
		return value;
	}
	return undefined;
}

function missingHarnessMetadataReason(
	repo: string,
	metadata: Record<string, unknown> | null | undefined,
): string {
	const version = readMetadataString(metadata, ["version"]);
	if (!version) return "missing_swebench_version";
	if (!SUPPORTED_SWEBENCH_HARNESS_VERSIONS[repo]) return "unsupported_swebench_harness_spec";
	if (!isSupportedSwebenchHarnessSpec(repo, version)) return "unsupported_swebench_harness_version";
	if (!readMetadataString(metadata, ["test_patch", "testPatch"])) return "missing_test_patch";
	return "unsupported_swebench_harness_spec";
}

function isSupportedSwebenchHarnessSpec(repo: string, version: string): boolean {
	return SUPPORTED_SWEBENCH_HARNESS_VERSIONS[repo]?.includes(version) ?? false;
}

function defaultSwebenchHarnessValidationCommand(workspaceRoot: string): string {
	return [
		`cd ${quoteShell(workspaceRoot)}`,
		"git rev-parse --is-inside-work-tree >/dev/null",
		"git status --short",
		"python --version",
	].join(" && ");
}

function quoteShell(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function normalizeRepo(value: unknown): string | null {
	const raw = readString(value);
	if (!raw) return null;
	return raw.replace("__", "/").replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
}

function sanitizeSlug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 54);
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

function stableJson(value: unknown): string {
	return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
	if (!value || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(sortJson);
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([, child]) => child !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, child]) => [key, sortJson(child)]),
	);
}
