/**
 * POST /api/workflows/executions/[executionId]/versions/[artifactId]/promote
 *
 * "Apply" a chosen source-bundle VERSION on demand (docs/code-version-persistence.md
 * P2): provision an ephemeral helper pod, rehydrate the bundle (git clone for a
 * self-contained full/squashed bundle; clone target + fetch for a thin one), push a
 * branch to the target GitHub repo, and optionally open a PR. A PR is created ONLY
 * for the version you pick — no PR per iteration. Workspace-scoped.
 *
 * Body: { repo?, base?, title?, mode?: "pr" | "branch" }
 *  - repo: "owner/name" (defaults to the run's trigger `repoUrl`)
 *  - base: PR base branch (defaults to the run's `repoRef` or "main")
 *  - mode: "pr" (default) opens a PR; "branch" only pushes the branch
 */

import { error, json } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db";
import { workflowArtifacts, workflowExecutions } from "$lib/server/db/schema";
import { assertInScope } from "$lib/server/workflows/project-scope";
import { SOURCE_BUNDLE_KIND } from "$lib/server/workflows/source-bundle";
import {
	provisionWorkspaceHelperPod,
	runHelperCommand,
	internalBffBaseUrl,
} from "$lib/server/workflows/helper-pod";

type Body = { repo?: unknown; base?: unknown; title?: unknown; mode?: unknown };

/** Normalize "https://github.com/owner/name.git" | "owner/name" → "owner/name". */
function normalizeRepo(raw: unknown): string | null {
	if (typeof raw !== "string" || !raw.trim()) return null;
	const r = raw
		.trim()
		.replace(/^git@github\.com:/, "")
		.replace(/^https?:\/\/github\.com\//, "")
		.replace(/\.git$/, "")
		.replace(/^\/+|\/+$/g, "");
	return /^[\w.-]+\/[\w.-]+$/.test(r) ? r : null;
}

function shQuote(s: string): string {
	return `'${String(s).replace(/'/g, "'\\''")}'`;
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!db) return error(503, "Database not configured");
	if (!locals.session?.userId) return error(401, "Authentication required");
	const { executionId, artifactId } = params;

	const [exec] = await db
		.select({
			id: workflowExecutions.id,
			projectId: workflowExecutions.projectId,
			userId: workflowExecutions.userId,
			input: workflowExecutions.input,
		})
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, executionId))
		.limit(1);
	assertInScope(exec, locals.session, "Execution not found");

	const [artifact] = await db
		.select()
		.from(workflowArtifacts)
		.where(
			and(
				eq(workflowArtifacts.id, artifactId),
				eq(workflowArtifacts.workflowExecutionId, executionId),
			),
		)
		.limit(1);
	if (!artifact || artifact.kind !== SOURCE_BUNDLE_KIND || !artifact.fileId) {
		return error(404, "Source-bundle version not found");
	}

	let body: Body = {};
	try {
		body = (await request.json()) as Body;
	} catch {
		/* empty body ok */
	}
	const input = (exec.input ?? {}) as Record<string, unknown>;
	const repo = normalizeRepo(body.repo) ?? normalizeRepo(input.repoUrl);
	if (!repo) {
		return error(400, "Target repo could not be resolved — pass { repo: 'owner/name' }");
	}
	const base =
		(typeof body.base === "string" && body.base.trim()) ||
		(typeof input.repoRef === "string" && input.repoRef.trim()) ||
		"main";
	const mode = body.mode === "branch" ? "branch" : "pr";
	const title =
		(typeof body.title === "string" && body.title.trim()) || "Promoted change (workflow-builder)";
	const tier = (artifact.inlinePayload as { tier?: string } | null)?.tier ?? "full";

	const helper = await provisionWorkspaceHelperPod(executionId, "promote", { withGithubToken: true });
	if (!helper) return error(502, "could not provision a helper pod for promote");
	if (!helper.githubToken) {
		return error(
			409,
			"No GitHub connection — connect a GitHub app-connection to open a PR (branch/download still works via the bundle).",
		);
	}

	const bundleUrl = `${internalBffBaseUrl()}/api/internal/files/${artifact.fileId}/content`;
	const cloneStep =
		tier === "thin"
			? // Thin bundle is not self-contained: clone the target (has <base>), then fetch.
				`git clone -q "https://x-access-token:$GH@github.com/${repo}.git" /tmp/promote && cd /tmp/promote && ` +
				`git fetch -q /tmp/v.bundle 'refs/*:refs/wfb-bundle/*' >/dev/null 2>&1 || git fetch -q /tmp/v.bundle >/dev/null 2>&1; ` +
				`TGT=$(git bundle list-heads /tmp/v.bundle 2>/dev/null | head -1 | awk '{print $1}'); ` +
				`git checkout -q -b "$BR" "$TGT"`
			: // Self-contained (full / squashed): clone the bundle directly.
				`git clone -q /tmp/v.bundle /tmp/promote && cd /tmp/promote && git checkout -q -b "$BR"`;

	const command = [
		`set -e`,
		`TOK=${shQuote(helper.token)}`,
		`REPO=${shQuote(repo)}; BASE=${shQuote(base)}; MODE=${shQuote(mode)}; TITLE=${shQuote(title)}`,
		`GH="$GITHUB_TOKEN"`,
		`[ -n "$GH" ] || { echo "ERR=no_github_token"; exit 0; }`,
		`rm -rf /tmp/promote /tmp/v.bundle`,
		`curl -fsS -H "X-Internal-Token: $TOK" ${shQuote(bundleUrl)} -o /tmp/v.bundle || { echo "ERR=bundle_fetch_failed"; exit 0; }`,
		`git config --global --add safe.directory '*' 2>/dev/null || true`,
		`BR="wfb-promote-$(date +%s)"`,
		cloneStep,
		`git config user.email agent@workflow-builder.local; git config user.name 'workflow-builder'`,
		`git push -q "https://x-access-token:$GH@github.com/$REPO.git" HEAD:"$BR" || { echo "ERR=push_failed"; exit 0; }`,
		`if [ "$MODE" = pr ]; then`,
		`  PR=$(curl -fsS -X POST -H "Authorization: Bearer $GH" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/pulls" -d "{\\"title\\":\\"$TITLE\\",\\"head\\":\\"$BR\\",\\"base\\":\\"$BASE\\",\\"body\\":\\"Promoted from a workflow-builder code version (durable source bundle).\\"}" || echo '{}')`,
		`  URL=$(printf '%s' "$PR" | grep -oE 'https://github.com/[^"]+/pull/[0-9]+' | head -1)`,
		`  if [ -n "$URL" ]; then echo "PR_URL=$URL"; else echo "PR_ERR=$(printf '%s' "$PR" | grep -oE '"message"[^,}]*' | head -1)"; fi`,
		`else echo "BRANCH_PUSHED=$BR"; fi`,
	].join("\n");

	const result = await runHelperCommand(helper.baseUrl, helper.token, command, "/tmp", 300_000);
	if (!result) return error(502, "promote command failed (no pod response)");

	const out = `${result.stdout}\n${result.stderr}`;
	const errMatch = out.match(/ERR=(\w+)/);
	const prMatch = out.match(/PR_URL=(\S+)/);
	const branchMatch = out.match(/BRANCH_PUSHED=(\S+)/);
	if (errMatch && !prMatch && !branchMatch) {
		return json({ ok: false, error: errMatch[1], output: out.slice(0, 2000) }, { status: 502 });
	}
	const prErr = out.match(/PR_ERR=(.+)/);

	return json({
		ok: true,
		mode,
		repo,
		base,
		tier,
		prUrl: prMatch ? prMatch[1] : null,
		branch: branchMatch ? branchMatch[1] : null,
		prError: !prMatch && prErr ? prErr[1].trim() : null,
		output: out.slice(0, 2000),
	});
};
