import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { env } from "$env/dynamic/private";
import { db } from "$lib/server/db";
import {
	environmentImageBuilds,
	type EnvironmentImageBuild,
	type EnvironmentImageBuildStatus,
	type EnvironmentImageBuildStrategy,
} from "$lib/server/db/schema";
import {
	createTektonPipelineRun,
	getTektonPipelineRun,
	tektonPipelineRunResults,
	tektonSucceededCondition,
} from "$lib/server/kube/tekton";
import {
	resolveSwebenchInferenceEnvironment,
	type ResolvedSwebenchInferenceEnvironment,
} from "$lib/server/benchmarks/inference-environments";
import type { SwebenchSuiteSlug } from "$lib/server/benchmarks/swebench";

const DEFAULT_SANDBOX_TEMPLATE = "dapr-agent";
const DEFAULT_TEKTON_NAMESPACE = "tekton-pipelines";
const DEFAULT_GIT_REVISION = "main";

export type EnsureSwebenchEnvironmentInput = {
	dataset?: string | null;
	suiteSlug: SwebenchSuiteSlug;
	instanceId?: string | null;
	repo: string;
	baseCommit: string;
	testMetadata?: Record<string, unknown> | null;
	timeoutMs?: number | null;
	pollMs?: number | null;
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
	const dockerfilePath =
		readMetadataString(input.testMetadata, ["dockerfilePath", "dockerfile_path"]) ??
		`services/openshell-sandbox/environments/Dockerfile.swebench-inference-${environmentKey}`;
	const defaultTuning = defaultSwebenchEnvironmentTuning(repo);
	const validationCommand =
		readMetadataString(input.testMetadata, ["validationCommand", "validation_command"]) ??
		defaultTuning.validationCommand;
	const baseSpec = {
		dataset,
		suite: input.suiteSlug,
		repo,
		version,
		environmentSetupCommit,
		baseCommit: input.baseCommit,
		environmentKey,
		buildStrategy: "swebench-harness" as const,
		sandboxTemplate: DEFAULT_SANDBOX_TEMPLATE,
		imageName,
		dockerfilePath,
		validationCommand,
	};
	const envSpecHash = sha256Hex(stableJson(baseSpec));
	return {
		...baseSpec,
		instanceId: readString(input.instanceId) ?? undefined,
		envSpecHash,
		imageTag: `env-${envSpecHash.slice(0, 16)}`,
		environmentNotes: defaultTuning.environmentNotes,
	};
}

function defaultSwebenchEnvironmentTuning(repo: string): {
	validationCommand: string;
	environmentNotes: string[];
} {
	const commonNotes = [
		"This image was selected or built before the agent started and validated with a repository checkout smoke test.",
		"Dependencies are preinstalled in /sandbox/.venv; avoid reinstalling unless needed.",
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
		environmentNotes: spec.environmentNotes,
		source: "dynamic-build",
		reason: resolved.reason === "no_validated_mapping"
			? "dynamic_build_required"
			: resolved.reason,
		buildStrategy: spec.buildStrategy,
		envSpecHash: spec.envSpecHash,
	};
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

	const row = existing ?? (await insertBuild(spec, input));
	const pipelineRunName = row.pipelineRunName || stablePipelineRunName(spec);
	const pipelineRunNamespace = row.pipelineRunNamespace ?? DEFAULT_TEKTON_NAMESPACE;
	if (!row.pipelineRunName) {
		try {
			await submitSwebenchPipelineRun(spec, pipelineRunName, pipelineRunNamespace);
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
			return resultFromBuild(updated ?? row);
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
	return row ?? (await getBuildBySpecHash(spec.envSpecHash))!;
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

async function syncEnvironmentBuild(row: EnvironmentImageBuild): Promise<EnvironmentImageBuild> {
	if (!row.pipelineRunName || !row.pipelineRunNamespace) return row;
	if (row.status === "validated" || row.status === "failed" || row.status === "cancelled") {
		return row;
	}
	const pipelineRun = await getTektonPipelineRun(row.pipelineRunNamespace, row.pipelineRunName);
	if (!pipelineRun) return row;
	const condition = tektonSucceededCondition(pipelineRun);
	if (!condition || condition.status === "Unknown") return row;

	const database = requireDb();
	if (condition.status === "True") {
		const results = tektonPipelineRunResults(pipelineRun);
		const imageRef = readString(results.image_ref) ?? row.sandboxImage;
		const digest = readString(results.image_digest) ?? digestFromImage(imageRef) ?? row.digest;
		const sandboxImage = imageWithDigest(imageRef, digest) ?? imageRef ?? undefined;
		if (!sandboxImage || !digest) {
			const [updated] = await database
				.update(environmentImageBuilds)
				.set({
					status: "failed",
					error: "Tekton PipelineRun completed without an image ref and digest",
					completedAt: parseDate(pipelineRun.status?.completionTime) ?? new Date(),
					updatedAt: new Date(),
				})
				.where(eq(environmentImageBuilds.id, row.id))
				.returning();
			return updated ?? row;
		}
		const builtAt =
			parseDate(readString(results.built_at)) ??
			parseDate(pipelineRun.status?.completionTime) ??
			new Date();
		const [updated] = await database
			.update(environmentImageBuilds)
			.set({
				status: "validated",
				sandboxImage,
				digest,
				validationStatus: readString(results.validation_status) ?? "validated",
				validationLogRef: readString(results.validation_log_ref) ?? row.validationLogRef,
				builtAt,
				completedAt: parseDate(pipelineRun.status?.completionTime) ?? new Date(),
				updatedAt: new Date(),
			})
			.where(eq(environmentImageBuilds.id, row.id))
			.returning();
		return updated ?? row;
	}

	const [updated] = await database
		.update(environmentImageBuilds)
		.set({
			status: "failed",
			error: condition.message ?? condition.reason ?? "Tekton PipelineRun failed",
			completedAt: parseDate(pipelineRun.status?.completionTime) ?? new Date(),
			updatedAt: new Date(),
		})
		.where(eq(environmentImageBuilds.id, row.id))
		.returning();
	return updated ?? row;
}

async function submitSwebenchPipelineRun(
	spec: SwebenchEnvironmentSpec,
	pipelineRunName: string,
	namespace: string,
) {
	await createTektonPipelineRun(namespace, {
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
			params: [
				{ name: "git_sha", value: env.SWEBENCH_INFERENCE_BUILD_GIT_REVISION ?? DEFAULT_GIT_REVISION },
				{ name: "suite", value: spec.suite },
				{ name: "repo_slug", value: spec.repo },
				{ name: "environment_key", value: spec.environmentKey },
				{ name: "base_commit", value: spec.baseCommit },
				{ name: "dockerfile_path", value: spec.dockerfilePath },
				{ name: "image_name", value: spec.imageName },
				{ name: "image_tag", value: spec.imageTag },
				{ name: "validation_command", value: spec.validationCommand },
				{ name: "environment_notes", value: JSON.stringify(spec.environmentNotes) },
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
	});
}

function resultFromBuild(row: EnvironmentImageBuild): EnvironmentPrepareResult {
	const status = row.status;
	const environmentStatus =
		status === "validated" ? "validated" : status === "failed" || status === "cancelled" ? "failed" : "building";
	const environment = rowToEnvironment(row);
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
		validationCommand: row.validationCommand ?? undefined,
		buildLogRef: row.buildLogRef ?? undefined,
		pipelineRunName: row.pipelineRunName ?? undefined,
		pipelineRunNamespace: row.pipelineRunNamespace ?? undefined,
		builtAt: row.builtAt?.toISOString(),
		environment,
		promptNotes: promptNotes(environment),
		error: row.error ?? undefined,
		source: "environment_image_builds",
	};
}

function validatedResult(
	environment: ResolvedSwebenchInferenceEnvironment,
	source: string,
): EnvironmentPrepareResult {
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
		validationCommand: environment.validationCommand,
		builtAt: environment.builtAt,
		environment: { ...environment, source },
		promptNotes: promptNotes(environment),
		source,
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
};

function fallbackResult(
	input: FallbackEnvironmentInput,
	reason: string,
	error?: string,
	row?: EnvironmentImageBuild | null,
): EnvironmentPrepareResult {
	const sandboxTemplate = input.sandboxTemplate ?? DEFAULT_SANDBOX_TEMPLATE;
	const environment: ResolvedSwebenchInferenceEnvironment = {
		environmentStatus: "fallback",
		suite: input.suite ?? "",
		repo: input.repo,
		version: input.version ?? undefined,
		environmentSetupCommit: input.environmentSetupCommit ?? undefined,
		baseCommit: input.baseCommit ?? undefined,
		environmentKey: input.environmentKey ?? undefined,
		sandboxTemplate,
		validationCommand: input.validationCommand ?? undefined,
		source: "dynamic-build",
		reason,
		buildStrategy: input.buildStrategy ?? undefined,
		envSpecHash: input.envSpecHash ?? undefined,
		buildLogRef: row?.buildLogRef ?? undefined,
		pipelineRunName: row?.pipelineRunName ?? undefined,
	};
	return {
		success: true,
		complete: true,
		environmentStatus: "fallback",
		status: "fallback",
		environmentKey: input.environmentKey ?? undefined,
		envSpecHash: input.envSpecHash ?? undefined,
		buildId: row?.id,
		buildStrategy: input.buildStrategy ?? undefined,
		sandboxTemplate,
		validationCommand: input.validationCommand ?? undefined,
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

function rowToEnvironment(row: EnvironmentImageBuild): ResolvedSwebenchInferenceEnvironment {
	return {
		environmentStatus: row.status === "validated" ? "validated" : row.status === "failed" ? "failed" : "building",
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
		buildLogRef: row.buildLogRef ?? undefined,
		pipelineRunName: row.pipelineRunName ?? undefined,
	};
}

function promptNotes(environment: ResolvedSwebenchInferenceEnvironment | null | undefined): string {
	if (environment?.environmentStatus !== "validated") return "";
	const lines = [
		`- Inference image: ${environment.sandboxImage ?? "validated sandbox image"}`,
		environment.digest ? `- Image digest: ${environment.digest}` : "",
		environment.validationCommand
			? `- Environment validation command: ${environment.validationCommand}`
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
