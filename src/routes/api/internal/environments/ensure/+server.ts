import { error, json } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { ensureSwebenchEnvironment } from "$lib/server/environments/environment-image-builds";
import { requireInternal } from "$lib/server/internal-auth";
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

export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);
	const body = (await request.json().catch(() => null)) as Record<
		string,
		unknown
	> | null;
	if (!body) return error(400, "JSON body required");
	if (
		body.dataset &&
		body.dataset !== "swebench" &&
		body.dataset !== "SWE-bench_Lite" &&
		body.dataset !== "SWE-bench_Verified"
	) {
		return error(400, "Only SWE-bench environment preparation is supported");
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
			return error(
				409,
				`SWE-bench metadata mismatch for ${instanceId}: repo ${requestRepo} does not match imported ${serverInstance.repo}`,
			);
		}
		if (
			serverInstance.baseCommit &&
			serverInstance.baseCommit !== requestBaseCommit
		) {
			return error(
				409,
				`SWE-bench metadata mismatch for ${instanceId}: baseCommit ${requestBaseCommit} does not match imported ${serverInstance.baseCommit}`,
			);
		}
	}
	const testMetadata = mergeServerSwebenchTestMetadata({
		serverMetadata: serverInstance?.testMetadata,
		requestMetadata,
	});
	const result = await ensureSwebenchEnvironment({
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
	});
	return json(result);
};

function requireString(value: unknown, key: string): string {
	if (typeof value === "string" && value.trim()) return value.trim();
	throw error(400, `${key} is required`);
}

function requireSuiteSlug(value: unknown): SwebenchSuiteSlug {
	if (typeof value !== "string" || !value.trim()) {
		throw error(400, "suiteSlug is required");
	}
	try {
		if (value.includes("SWE-bench_Verified")) return "SWE-bench_Verified";
		if (value.includes("SWE-bench_Lite")) return "SWE-bench_Lite";
		return normalizeSwebenchSuiteSlug(value);
	} catch (err) {
		throw error(
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
		throw error(
			409,
			`SWE-bench metadata for ${params.instanceId} has not been imported for ${params.suiteSlug}`,
		);
	}
	return row ?? null;
}
