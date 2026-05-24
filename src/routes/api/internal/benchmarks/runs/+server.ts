import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { and, eq } from "drizzle-orm";
import { requireInternal } from "$lib/server/internal-auth";
import { db } from "$lib/server/db";
import { agents } from "$lib/server/db/schema";
import { BenchmarkAgentValidationError } from "$lib/server/benchmarks/agents";
import {
	createBenchmarkRun,
	getBenchmarkRun,
	markBenchmarkRunStatus,
	startSwebenchCoordinator,
} from "$lib/server/benchmarks/service";
import { normalizeSwebenchSuiteSlug } from "$lib/server/benchmarks/swebench";
import { selectExactReadySwebenchInstanceIds } from "$lib/server/benchmarks/environment-validation";
import {
	benchmarkLaunchControlPlaneError,
	loadBenchmarkLaunchControlPlaneStability,
} from "$lib/server/benchmarks/launch-stability";

export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);
	if (!db) return error(503, "Database not configured");
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const projectId = readRequiredString(body.projectId, "projectId");
	const userId = readRequiredString(body.userId, "userId");
	const agentId =
		readOptionalString(body.agentId) ??
		(await resolveAgentId(projectId, readOptionalString(body.agentSlug)));
	if (!agentId) return error(400, "agentId or agentSlug is required");
	const suiteSlug = normalizeSwebenchSuiteSlug(
		readOptionalString(body.suiteSlug) ?? readOptionalString(body.suite) ?? "SWE-bench_Verified",
	);
	const requestedLimit = readOptionalInt(body.limit);
	const selection = await selectExactReadySwebenchInstanceIds({
		suiteSlug,
		instanceIds: body.instanceIds ?? body.selectedInstanceIds,
		limit: requestedLimit,
		syncBuildStatuses: body.previewOnly !== true && body.dryRun !== true,
	});
	if (selection.missingInstanceIds.length > 0) {
		return json(
			{
				message: `SWE-bench metadata has not been imported for ${selection.missingInstanceIds.length} selected instance(s)`,
				...selection,
			},
			{ status: 409 },
		);
	}
	if (body.previewOnly === true || body.dryRun === true) {
		const launchControlPlane =
			await loadBenchmarkLaunchControlPlaneStability();
		return json({
			preview: true,
			...selection,
			launchControlPlane,
			launchControlPlaneError:
				benchmarkLaunchControlPlaneError(launchControlPlane),
		});
	}
	const allowPartialSelection = body.allowPartialSelection === true;
	if (
		!allowPartialSelection &&
		selection.selectedCount < selection.requestedLimit
	) {
		return json(
			{
				message: `Only ${selection.selectedCount} exact prevalidated SWE-bench instance(s) matched requested limit ${selection.requestedLimit}`,
				...selection,
			},
			{ status: 409 },
		);
	}
	if (selection.selectedInstanceIds.length === 0) {
		return json(
			{
				message: "No prevalidated SWE-bench instances matched the request",
				...selection,
			},
			{ status: 409 },
		);
	}

	let run;
	try {
		run = await createBenchmarkRun({
			projectId,
			userId,
			suiteSlug,
			agentId,
			agentVersion: readOptionalInt(body.agentVersion) ?? undefined,
			instanceIds: selection.selectedInstanceIds,
			modelNameOrPath: readOptionalString(body.modelNameOrPath) ?? undefined,
			modelConfigLabel: readOptionalString(body.modelConfigLabel),
			concurrency: readOptionalInt(body.concurrency) ?? undefined,
			evaluationConcurrency:
				readOptionalInt(body.evaluationConcurrency) ?? undefined,
			timeoutSeconds: readOptionalInt(body.timeoutSeconds) ?? undefined,
			maxTurns: readOptionalInt(body.maxTurns),
			evaluatorResourceClass: readOptionalString(body.evaluatorResourceClass),
			tags: normalizeTags(body.tags),
			requirePrevalidatedEnvironments: true,
			executionBackend: readOptionalString(body.executionBackend),
			executionClass: readOptionalString(body.executionClass),
		});
	} catch (err) {
		if (err instanceof BenchmarkAgentValidationError) {
			return json({ message: err.message }, { status: 400 });
		}
		throw err;
	}

	let coordinatorStartError: string | null = null;
	try {
		const coordinator = await startSwebenchCoordinator(run.id);
		if (typeof coordinator.executionId === "string") {
			await markBenchmarkRunStatus(run.id, "queued", {
				coordinatorExecutionId: coordinator.executionId,
			});
		}
	} catch (err) {
		coordinatorStartError = err instanceof Error ? err.message : String(err);
		await markBenchmarkRunStatus(run.id, "failed", {
			error: coordinatorStartError,
		});
	}

	const fullRun = await getBenchmarkRun(projectId, run.id);
	return json(
		{
			run: fullRun,
			coordinatorStartError,
			selectedInstanceIds: selection.selectedInstanceIds,
			selection,
		},
		{ status: 201 },
	);
};

function readRequiredString(value: unknown, name: string): string {
	const out = readOptionalString(value);
	if (!out) throw error(400, `${name} is required`);
	return out;
}

function readOptionalString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readOptionalInt(value: unknown): number | null {
	if (typeof value === "number" && Number.isInteger(value)) return value;
	if (typeof value !== "string" || !value.trim()) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isInteger(parsed) ? parsed : null;
}

function normalizeTags(value: unknown): string[] {
	if (!Array.isArray(value)) return ["operator"];
	const tags = value.filter(
		(tag): tag is string => typeof tag === "string" && !!tag.trim(),
	);
	return Array.from(new Set(["operator", ...tags]));
}

async function resolveAgentId(
	projectId: string,
	agentSlug: string | null,
): Promise<string | null> {
	const database = db;
	if (!database || !agentSlug) return null;
	const [agent] = await database
		.select({ id: agents.id })
		.from(agents)
		.where(
			and(
				eq(agents.projectId, projectId),
				eq(agents.slug, agentSlug),
				eq(agents.isArchived, false),
			),
		)
		.limit(1);
	return agent?.id ?? null;
}
