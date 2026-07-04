import { createHash } from "node:crypto";
import { env } from "$env/dynamic/private";
import type { SwebenchSuiteSlug } from "$lib/server/benchmarks/swebench";
import type { ResolvedSwebenchInferenceEnvironment } from "$lib/server/benchmarks/inference-environments";

const DEFAULT_SANDBOX_TEMPLATE = "dapr-agent";
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

export type EnvironmentImageBuildStatus =
	| "queued"
	| "building"
	| "validated"
	| "failed"
	| "cancelled";

export type EnvironmentImageBuildStrategy =
	| "swebench-harness"
	| "buildpacks"
	| "dockerfile"
	| "scripted";

export type SwebenchInferenceBuildBackend = "buildah" | "nix";

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
	forceRefreshLegacyStatic?: boolean | null;
	buildBackend?: SwebenchInferenceBuildBackend | null;
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
	buildBackend: SwebenchInferenceBuildBackend;
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
	const buildBackend = resolveSwebenchBuildBackend(input.buildBackend, buildStrategy);
	const imageTagBase = `env-${envSpecHash.slice(0, 16)}`;
	const imageTag = buildBackend === "nix" ? `${imageTagBase}-nix` : imageTagBase;
	return {
		...baseSpec,
		instanceId: readString(input.instanceId) ?? undefined,
		envSpecHash,
		buildBackend,
		imageTag,
		environmentNotes: defaultTuning.environmentNotes,
		fallbackReason:
			buildStrategy === "buildpacks"
				? missingHarnessMetadataReason(repo, input.testMetadata)
				: undefined,
	};
}

export function resolveSwebenchBuildBackend(
	override: SwebenchInferenceBuildBackend | null | undefined,
	buildStrategy: EnvironmentImageBuildStrategy,
): SwebenchInferenceBuildBackend {
	if (buildStrategy !== "swebench-harness") {
		return "buildah";
	}
	if (override === "nix" || override === "buildah") {
		return override;
	}
	const raw = runtimeEnvString("SWEBENCH_INFERENCE_BUILD_BACKEND")?.toLowerCase();
	if (raw === "nix") return "nix";
	return "buildah";
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
					"Dependencies are installed from the SWE-bench harness spec in the conda testbed environment.",
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

function runtimeEnvString(name: string): string | null {
	return readString(env[name]) ?? readString(process.env[name]);
}

function compactObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined),
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
