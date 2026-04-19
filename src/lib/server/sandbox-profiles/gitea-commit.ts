/**
 * Gitea REST helper for sandbox-profile image rebuilds. The workflow-builder
 * pod has admin credentials to the in-cluster Gitea via the
 * `workflow-builder-gitea-admin` secret (env: GITEA_USERNAME / GITEA_PASSWORD).
 * We reuse those to push generated Dockerfiles — same auth pattern the
 * webhook handler uses to push workflow JSON.
 *
 * The push triggers the existing Tekton EventListener
 * (`el-workflow-builder-image-builds`) which matches by changed paths and
 * dispatches the right PipelineRun.
 */

const GITEA_BASE_URL = (
	process.env.GITEA_API_URL ||
	process.env.GITEA_INTERNAL_CLONE_BASE_URL ||
	"http://gitea-http.gitea.svc.cluster.local:3000"
).replace(/\/$/, "");

const GITEA_USERNAME = (process.env.GITEA_USERNAME || "").trim();
const GITEA_PASSWORD = (process.env.GITEA_PASSWORD || "").trim();

// Repos live under the same gitea admin user the Tekton pipelines fetch from.
const WORKFLOW_BUILDER_REPO = {
	owner: process.env.GITEA_REPO_OWNER || "giteaadmin",
	name: "workflow-builder",
};

function authHeader(): string {
	const credential = Buffer.from(
		`${GITEA_USERNAME}:${GITEA_PASSWORD}`,
	).toString("base64");
	return `Basic ${credential}`;
}

export class GiteaCommitError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
	) {
		super(message);
		this.name = "GiteaCommitError";
	}
}

type UpsertFileResult = {
	path: string;
	sha: string; // blob sha
	commitSha: string;
};

/**
 * Create-or-update a file in the workflow-builder repo at the given path with
 * the provided content. Returns the commit SHA (which Tekton will tag the
 * built image with). Uses Gitea's contents API — atomic per-file write with
 * built-in optimistic concurrency (we pass the existing sha so a concurrent
 * edit doesn't silently clobber).
 */
export async function upsertDockerfile(params: {
	path: string;
	content: string;
	commitMessage: string;
	branch?: string;
}): Promise<UpsertFileResult> {
	if (!GITEA_USERNAME || !GITEA_PASSWORD) {
		throw new GiteaCommitError(
			"GITEA_USERNAME / GITEA_PASSWORD not configured",
		);
	}
	const branch = params.branch || "main";
	const repoApi = `${GITEA_BASE_URL}/api/v1/repos/${WORKFLOW_BUILDER_REPO.owner}/${WORKFLOW_BUILDER_REPO.name}`;
	const contentsUrl = `${repoApi}/contents/${encodeURI(params.path)}`;

	// Check for existing file. Gitea's contents API replies 404 for missing
	// files; any non-404/non-200 is propagated as a hard error.
	const existingResp = await fetch(
		`${contentsUrl}?ref=${encodeURIComponent(branch)}`,
		{ headers: { Authorization: authHeader() } },
	);
	let existingSha: string | undefined;
	if (existingResp.ok) {
		const existing = (await existingResp.json()) as { sha?: string };
		existingSha = existing.sha;
	} else if (existingResp.status !== 404) {
		const body = await existingResp.text();
		throw new GiteaCommitError(
			`Gitea contents GET failed: ${existingResp.status} ${body.slice(0, 200)}`,
			existingResp.status,
		);
	}

	const contentB64 = Buffer.from(params.content, "utf-8").toString("base64");
	const method = existingSha ? "PUT" : "POST";
	const upsertResp = await fetch(contentsUrl, {
		method,
		headers: {
			Authorization: authHeader(),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			branch,
			message: params.commitMessage,
			content: contentB64,
			sha: existingSha,
		}),
	});
	if (!upsertResp.ok) {
		const body = await upsertResp.text();
		throw new GiteaCommitError(
			`Gitea contents ${method} failed: ${upsertResp.status} ${body.slice(0, 400)}`,
			upsertResp.status,
		);
	}
	const payload = (await upsertResp.json()) as {
		content: { path: string; sha: string };
		commit: { sha: string };
	};
	return {
		path: payload.content.path,
		sha: payload.content.sha,
		commitSha: payload.commit.sha,
	};
}
