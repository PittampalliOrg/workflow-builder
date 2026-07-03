import { and, eq } from "drizzle-orm";
import {
	containsContaminationRiskMetadata,
	mergeServerSwebenchTestMetadata,
} from "$lib/server/benchmarks/contamination";
import {
	normalizeSwebenchSuiteSlug,
	type SwebenchSuiteSlug,
} from "$lib/server/benchmarks/swebench";
import { db } from "$lib/server/db";
import { benchmarkInstances, benchmarkSuites } from "$lib/server/db/schema";
import {
	ensureSwebenchEnvironment,
	type EnvironmentPrepareResult,
} from "$lib/server/environments/environment-image-builds";

export class SwebenchEnvironmentEnsureRequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "SwebenchEnvironmentEnsureRequestError";
	}
}

export async function ensureSwebenchEnvironmentFromInternalRequest(
	body: Record<string, unknown> | null,
): Promise<EnvironmentPrepareResult> {
	if (!body) throw new SwebenchEnvironmentEnsureRequestError(400, "JSON body required");
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
	const suiteSlug = requireSuiteSlug(body.suiteSlug ?? body.datasetName ?? body.dataset);
	const instanceId = typeof body.instanceId === "string" ? body.instanceId.trim() : null;
	const requestMetadata = isRecord(body.testMetadata) ? body.testMetadata : {};
	const serverInstance = await loadServerSwebenchInstance({
		suiteSlug,
		instanceId,
		requestMetadata,
	});
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
	return ensureSwebenchEnvironment({
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

function requireString(value: unknown, key: string): string {
	if (typeof value === "string" && value.trim()) return value.trim();
	throw new SwebenchEnvironmentEnsureRequestError(400, `${key} is required`);
}

function requireSuiteSlug(value: unknown): SwebenchSuiteSlug {
	if (typeof value !== "string" || !value.trim()) {
		throw new SwebenchEnvironmentEnsureRequestError(400, "suiteSlug is required");
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

async function loadServerSwebenchInstance(params: {
	suiteSlug: SwebenchSuiteSlug;
	instanceId: string | null;
	requestMetadata: Record<string, unknown>;
}): Promise<{
	repo: string | null;
	baseCommit: string | null;
	testMetadata: Record<string, unknown> | null;
} | null> {
	if (!db || !params.instanceId) return null;
	const [row] = await db
		.select({
			repo: benchmarkInstances.repo,
			baseCommit: benchmarkInstances.baseCommit,
			testMetadata: benchmarkInstances.testMetadata,
		})
		.from(benchmarkInstances)
		.innerJoin(
			benchmarkSuites,
			eq(benchmarkInstances.suiteId, benchmarkSuites.id),
		)
		.where(
			and(
				eq(benchmarkSuites.slug, params.suiteSlug),
				eq(benchmarkInstances.instanceId, params.instanceId),
			),
		)
		.limit(1);
	if (!row && !containsContaminationRiskMetadata(params.requestMetadata)) {
		throw new SwebenchEnvironmentEnsureRequestError(
			409,
			`SWE-bench metadata for ${params.instanceId} has not been imported for ${params.suiteSlug}`,
		);
	}
	return row
		? {
				repo: row.repo,
				baseCommit: row.baseCommit,
				testMetadata: isRecord(row.testMetadata) ? row.testMetadata : null,
			}
		: null;
}
