import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { ensureSwebenchEnvironment } from "$lib/server/environments/environment-image-builds";
import { requireInternal } from "$lib/server/internal-auth";

export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body) return error(400, "JSON body required");
	if (
		body.dataset &&
		body.dataset !== "swebench" &&
		body.dataset !== "SWE-bench_Lite" &&
		body.dataset !== "SWE-bench_Verified"
	) {
		return error(400, "Only SWE-bench environment preparation is supported");
	}
	const result = await ensureSwebenchEnvironment({
		dataset: typeof body.datasetName === "string" ? body.datasetName : typeof body.dataset === "string" ? body.dataset : "swebench",
		suiteSlug: body.suiteSlug === "SWE-bench_Verified" ? "SWE-bench_Verified" : "SWE-bench_Lite",
		instanceId: typeof body.instanceId === "string" ? body.instanceId : null,
		repo: requireString(body.repo, "repo"),
		baseCommit: requireString(body.baseCommit, "baseCommit"),
		testMetadata: isRecord(body.testMetadata) ? body.testMetadata : {},
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
