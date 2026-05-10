/**
 * Deep-link builders for the GitOps Promoter views. Pulls bases from the
 * `+page.server.ts` `links` payload so the same builders work across envs
 * (ryzen / dev / staging) and across local-dev fixtures.
 */

export type PromoterLinkBases = {
	stacksRepo: string;
	workflowBuilderRepo: string;
	argoCdBase: string;
	tektonBase: string | null;
};

const TRIM_TRAILING = /\/+$/;

function trim(base: string | null | undefined): string | null {
	if (!base) return null;
	return base.replace(TRIM_TRAILING, "");
}

export function githubCommitUrl(
	repoUrl: string | null | undefined,
	sha: string | null | undefined,
): string | null {
	if (!repoUrl || !sha) return null;
	return `${repoUrl.replace(TRIM_TRAILING, "")}/commit/${sha}`;
}

export function githubBranchUrl(
	repoUrl: string | null | undefined,
	branch: string | null | undefined,
): string | null {
	if (!repoUrl || !branch) return null;
	return `${repoUrl.replace(TRIM_TRAILING, "")}/tree/${encodeURIComponent(branch)}`;
}

export function githubPrUrl(
	repoUrl: string | null | undefined,
	number: number | string | null | undefined,
): string | null {
	if (!repoUrl || number == null || number === "") return null;
	return `${repoUrl.replace(TRIM_TRAILING, "")}/pull/${number}`;
}

export function argoCdAppUrl(
	bases: Pick<PromoterLinkBases, "argoCdBase">,
	app: { name?: string | null; namespace?: string | null } | null,
): string | null {
	const argo = trim(bases.argoCdBase);
	if (!argo || !app?.name) return null;
	const ns = app.namespace ?? "argocd";
	return `${argo}/applications/${encodeURIComponent(ns)}/${encodeURIComponent(app.name)}`;
}

export function tektonRunUrl(
	bases: Pick<PromoterLinkBases, "tektonBase">,
	pipelineRun: string | null | undefined,
	namespace = "tekton-pipelines",
): string | null {
	const tekton = trim(bases.tektonBase);
	if (!tekton || !pipelineRun) return null;
	return `${tekton}/#/namespaces/${encodeURIComponent(namespace)}/pipelineruns/${encodeURIComponent(pipelineRun)}`;
}

export function giteaBranchUrl(
	repoBase: string | null | undefined,
	branch: string | null | undefined,
): string | null {
	if (!repoBase || !branch) return null;
	return `${repoBase.replace(TRIM_TRAILING, "")}/src/branch/${encodeURIComponent(branch)}`;
}

/**
 * Best-effort guess of the SCM repo URL from a Promoter `Commit.repoURL` (which
 * is a Git URL that may include `.git` or be a `https://` form). Returns the
 * "browseable" form: `https://github.com/owner/repo` (no `.git`).
 */
export function repoBrowseUrl(
	repoUrl: string | null | undefined,
): string | null {
	if (!repoUrl) return null;
	const trimmed = repoUrl.trim().replace(/\.git$/, "");
	if (trimmed.startsWith("git@")) {
		// git@github.com:owner/repo → https://github.com/owner/repo
		const match = trimmed.match(/^git@([^:]+):(.+)$/);
		if (!match) return null;
		return `https://${match[1]}/${match[2]}`;
	}
	return trimmed;
}
