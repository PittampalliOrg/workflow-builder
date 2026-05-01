import { error, json } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { ensureSwebenchEnvironment } from "$lib/server/environments/environment-image-builds";
import { requireInternal } from "$lib/server/internal-auth";
import {
	containsContaminationRiskMetadata,
	mergeServerSwebenchTestMetadata,
} from "$lib/server/benchmarks/contamination";
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
	const suiteSlug =
		body.suiteSlug === "SWE-bench_Verified" ? "SWE-bench_Verified" : "SWE-bench_Lite";
	const requestMetadata = isRecord(body.testMetadata) ? body.testMetadata : {};
	const testMetadata = await loadServerSwebenchTestMetadata({
		suiteSlug,
		instanceId: typeof body.instanceId === "string" ? body.instanceId : null,
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
		instanceId: typeof body.instanceId === "string" ? body.instanceId : null,
		repo: requireString(body.repo, "repo"),
		baseCommit: requireString(body.baseCommit, "baseCommit"),
		testMetadata,
		timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : null,
		pollMs: typeof body.pollMs === "number" ? body.pollMs : null,
	});
	return json(result);
};

function requireString(value: unknown, key: string): string {
	if (typeof value === "string" && value.trim()) return value.trim();
	throw error(400, `${key} is required`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function loadServerSwebenchTestMetadata(params: {
	suiteSlug: "SWE-bench_Lite" | "SWE-bench_Verified";
	instanceId: string | null;
	requestMetadata: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
	if (
		!db ||
		!params.instanceId ||
		containsContaminationRiskMetadata(params.requestMetadata)
	) {
		return params.requestMetadata;
	}
	const [row] = await db
		.select({ testMetadata: benchmarkInstances.testMetadata })
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
	return mergeServerSwebenchTestMetadata({
		serverMetadata: row?.testMetadata,
		requestMetadata: params.requestMetadata,
	});
}
