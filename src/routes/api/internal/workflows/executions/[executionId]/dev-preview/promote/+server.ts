/**
 * POST /api/internal/workflows/executions/[executionId]/dev-preview/promote
 *
 * Internal-only "promote-from-best": open a GitHub PR from a dev-pod-as-source
 * (in-preview GAN) run. Resolves the durable `source-bundle` version for the
 * requested iteration (`"best"` → `bestIteration`, a number → that iteration,
 * null/absent → capture live now), then hands it to the tested helper-pod
 * promotion runner to branch + push + open the PR. The GAN loop node is the gate,
 * so this path deliberately does NOT re-run the D2 promotion gate.
 *
 * Failures return HTTP 200 with `{ ok: false, error }` (the workflow needs the
 * reason as data, not an opaque 500). Auth: requires INTERNAL_API_TOKEN.
 */

import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { requireInternal } from "$lib/server/internal-auth";
import { captureDevPreviewSource } from "$lib/server/workflows/dev-preview";
import type { WorkflowArtifactRecord } from "$lib/server/application/ports";

const SOURCE_BUNDLE_KIND = "source-bundle";
const DEFAULT_BRANCH_PREFIX = "gan-ui-feature";

type Body = {
	iteration?: number | "best" | null;
	bestIteration?: number | null;
	draft?: boolean;
	title?: string;
	bodyMarkdown?: string;
	repoUrl?: string;
	baseBranch?: string;
	branchPrefix?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeRepo(raw: unknown): string | null {
	const value = readString(raw);
	if (!value) return null;
	const repo = value
		.replace(/^git@github\.com:/, "")
		.replace(/^https?:\/\/github\.com\//, "")
		.replace(/\.git$/, "")
		.replace(/^\/+|\/+$/g, "");
	return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null;
}

function normalizeRepoSubdir(raw: unknown): string {
	const value = readString(raw);
	if (!value || value === ".") return "";
	return value.replace(/^\/+|\/+$/g, "");
}

function normalizeSyncPaths(raw: unknown): string[] {
	if (!Array.isArray(raw)) return ["src"];
	const paths = raw.filter((p): p is string => Boolean(readString(p)));
	return paths.length ? paths : ["src"];
}

function iterationOf(artifact: WorkflowArtifactRecord): number | null {
	const payload = asRecord(artifact.inlinePayload);
	const raw = payload.iteration;
	return typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : null;
}

export const POST: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	const rawId = params.executionId;
	if (!rawId) return json({ ok: false, error: "executionId required" }, { status: 400 });

	const workflowData = getApplicationAdapters().workflowData;
	// The orchestrator passes the Dapr instance id; the execution + artifact rows
	// are keyed on the canonical execution id (same as the sibling snapshot route).
	const executionId = await workflowData.resolveCanonicalExecutionId({
		executionId: rawId,
	});

	let body: Body = {};
	try {
		body = (await request.json()) as Body;
	} catch {
		/* empty body is allowed → capture-live path */
	}

	const iterationField = body.iteration;
	const bestIteration =
		typeof body.bestIteration === "number" && Number.isFinite(body.bestIteration)
			? Math.floor(body.bestIteration)
			: null;
	// Resolve which iteration the caller wants a bundle for:
	//  - "best"          → bestIteration (else latest bundle regardless of iteration)
	//  - <number>        → that iteration
	//  - null / absent   → no target; capture live now
	let targetIteration: number | null = null;
	let wantLatest = false;
	let captureLive = false;
	if (iterationField === "best") {
		if (bestIteration != null) targetIteration = bestIteration;
		else wantLatest = true;
	} else if (typeof iterationField === "number" && Number.isFinite(iterationField)) {
		targetIteration = Math.floor(iterationField);
	} else {
		captureLive = true;
	}

	// Resolve an existing source-bundle artifact unless the caller asked for the
	// live path.
	let artifact: WorkflowArtifactRecord | null = null;
	if (!captureLive) {
		try {
			const all = await workflowData.listWorkflowArtifactsByExecutionId(executionId);
			const bundles = all
				.filter((a) => a.kind === SOURCE_BUNDLE_KIND && a.fileId)
				.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
			if (wantLatest) {
				artifact = bundles[0] ?? null;
			} else if (targetIteration != null) {
				artifact = bundles.find((a) => iterationOf(a) === targetIteration) ?? null;
			}
		} catch (err) {
			return json({
				ok: false,
				error: `failed to list source bundles: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}

	// No stored bundle (missing iteration, or caller wanted live): capture the dev
	// pod's current source via /__export and promote that.
	if (!artifact) {
		const captured = await captureDevPreviewSource(
			executionId,
			{
				nodeId: "dev-preview",
				iteration: targetIteration,
			},
			workflowData,
		);
		if (!captured.ok || !captured.artifactId) {
			return json({
				ok: false,
				error: `no_source_bundle${captured.skipped ? `: ${captured.skipped}` : ""}`,
			});
		}
		artifact = await workflowData.getWorkflowArtifactForExecution({
			executionId,
			artifactId: captured.artifactId,
		});
		if (!artifact?.fileId) {
			return json({ ok: false, error: "captured bundle has no file" });
		}
	}

	const payload = asRecord(artifact.inlinePayload);
	const repo = normalizeRepo(body.repoUrl) ?? normalizeRepo(payload.repoUrl);
	if (!repo) {
		return json({
			ok: false,
			error: "target repo could not be resolved — pass { repoUrl: 'owner/name' }",
		});
	}
	const base = readString(body.baseBranch) ?? readString(payload.base) ?? "main";
	const tier = readString(payload.tier) ?? "tar-overlay";
	const draft = body.draft === true;

	const runner = getApplicationAdapters().sourceBundlePromotionRunner;
	const result = await runner.promoteSourceBundle({
		executionId,
		fileId: artifact.fileId as string,
		repo,
		base,
		mode: "pr",
		title: readString(body.title) ?? "Promoted change (workflow-builder)",
		tier,
		repoSubdir: normalizeRepoSubdir(payload.repoSubdir),
		syncPaths: normalizeSyncPaths(payload.syncPaths),
		branchPrefix: readString(body.branchPrefix) ?? DEFAULT_BRANCH_PREFIX,
		draft,
		prBody: readString(body.bodyMarkdown) ?? undefined,
	});

	if (result.status === "unavailable") {
		return json({ ok: false, error: result.message });
	}
	if (result.status === "command_error") {
		return json({ ok: false, error: result.error, branch: null });
	}
	// status: "ok" — the branch was pushed; the PR may still have failed to open.
	if (!result.prUrl) {
		return json({
			ok: false,
			branch: result.branch,
			draft,
			error: result.prError ?? "pr_not_opened",
		});
	}
	return json({
		ok: true,
		prUrl: result.prUrl,
		branch: result.branch,
		draft,
	});
};
