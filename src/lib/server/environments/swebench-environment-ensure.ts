import {
	containsContaminationRiskMetadata,
	mergeServerSwebenchTestMetadata,
} from "$lib/server/benchmarks/contamination";
import {
	normalizeSwebenchSuiteSlug,
	type SwebenchSuiteSlug,
} from "$lib/server/benchmarks/swebench";
import {
	type EnvironmentPrepareResult,
	type EnsureSwebenchEnvironmentInput,
} from "$lib/server/environments/swebench-environment-spec";

export class SwebenchEnvironmentEnsureRequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "SwebenchEnvironmentEnsureRequestError";
	}
}

export type ServerSwebenchEnvironmentInstance = {
	repo: string | null;
	baseCommit: string | null;
	testMetadata: Record<string, unknown> | null;
};

export type SwebenchEnvironmentEnsureDependencies = {
	requireImportedMetadata?: boolean;
	loadServerSwebenchInstance(input: {
		suiteSlug: SwebenchSuiteSlug;
		instanceId: string;
		requestMetadata: Record<string, unknown>;
	}): Promise<ServerSwebenchEnvironmentInstance | null>;
	ensureEnvironment(
		input: EnsureSwebenchEnvironmentInput,
	): Promise<EnvironmentPrepareResult>;
};

export async function ensureSwebenchEnvironmentFromInternalRequest(
	body: Record<string, unknown> | null,
	deps: SwebenchEnvironmentEnsureDependencies = {
		requireImportedMetadata: false,
		loadServerSwebenchInstance: loadLegacyServerSwebenchInstance,
		ensureEnvironment: ensureLegacySwebenchEnvironment,
	},
): Promise<EnvironmentPrepareResult> {
	if (!body)
		throw new SwebenchEnvironmentEnsureRequestError(400, "JSON body required");
	if (
		body.dataset &&
		body.dataset !== "swebench" &&
		body.dataset !== "SWE-bench_Lite" &&
		body.dataset !== "SWE-bench_Verified"
	) {
		throw new SwebenchEnvironmentEnsureRequestError(
			400,
			"Only SWE-bench environment preparation is supported",
		);
	}
	const suiteSlug = requireSuiteSlug(
		body.suiteSlug ?? body.datasetName ?? body.dataset,
	);
	const instanceId =
		typeof body.instanceId === "string" ? body.instanceId.trim() : null;
	const requestMetadata = isRecord(body.testMetadata) ? body.testMetadata : {};
	const serverInstance = instanceId
		? await deps.loadServerSwebenchInstance({
				suiteSlug,
				instanceId,
				requestMetadata,
			})
		: null;
	if (
		instanceId &&
		!serverInstance &&
		deps.requireImportedMetadata === true &&
		!containsContaminationRiskMetadata(requestMetadata)
	) {
		throw new SwebenchEnvironmentEnsureRequestError(
			409,
			`SWE-bench metadata for ${instanceId} has not been imported for ${suiteSlug}`,
		);
	}
	const requestRepo = requireString(body.repo, "repo");
	const requestBaseCommit = requireString(body.baseCommit, "baseCommit");
	if (serverInstance) {
		if (serverInstance.repo && serverInstance.repo !== requestRepo) {
			throw new SwebenchEnvironmentEnsureRequestError(
				409,
				`SWE-bench metadata mismatch for ${instanceId}: repo ${requestRepo} does not match imported ${serverInstance.repo}`,
			);
		}
		if (
			serverInstance.baseCommit &&
			serverInstance.baseCommit !== requestBaseCommit
		) {
			throw new SwebenchEnvironmentEnsureRequestError(
				409,
				`SWE-bench metadata mismatch for ${instanceId}: baseCommit ${requestBaseCommit} does not match imported ${serverInstance.baseCommit}`,
			);
		}
	}
	const testMetadata = mergeServerSwebenchTestMetadata({
		serverMetadata: serverInstance?.testMetadata,
		requestMetadata,
	});
	return deps.ensureEnvironment({
		dataset:
			typeof body.datasetName === "string"
				? body.datasetName
				: typeof body.dataset === "string"
					? body.dataset
					: "swebench",
		suiteSlug,
		instanceId,
		repo: serverInstance?.repo ?? requestRepo,
		baseCommit: serverInstance?.baseCommit ?? requestBaseCommit,
		testMetadata,
		timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : null,
		pollMs: typeof body.pollMs === "number" ? body.pollMs : null,
		allowBuild: body.allowBuild === true,
		forceRefreshLegacyStatic:
			body.forceRefreshLegacyStatic === true ||
			body.forceRefreshLegacy === true ||
			body.forceRefresh === true,
	});
}

async function ensureLegacySwebenchEnvironment(
	input: EnsureSwebenchEnvironmentInput,
): Promise<EnvironmentPrepareResult> {
	const { ensureSwebenchEnvironment } = await import(
		"$lib/server/environments/environment-image-builds"
	);
	return ensureSwebenchEnvironment(input);
}

function requireString(value: unknown, key: string): string {
	if (typeof value === "string" && value.trim()) return value.trim();
	throw new SwebenchEnvironmentEnsureRequestError(400, `${key} is required`);
}

function requireSuiteSlug(value: unknown): SwebenchSuiteSlug {
	if (typeof value !== "string" || !value.trim()) {
		throw new SwebenchEnvironmentEnsureRequestError(
			400,
			"suiteSlug is required",
		);
	}
	try {
		if (value.includes("SWE-bench_Verified")) return "SWE-bench_Verified";
		if (value.includes("SWE-bench_Lite")) return "SWE-bench_Lite";
		return normalizeSwebenchSuiteSlug(value);
	} catch (err) {
		throw new SwebenchEnvironmentEnsureRequestError(
			400,
			err instanceof Error ? err.message : "Unsupported SWE-bench suite",
		);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function loadLegacyServerSwebenchInstance(): Promise<null> {
	return null;
}
