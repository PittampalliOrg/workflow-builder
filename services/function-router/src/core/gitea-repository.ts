const GITEA_API_URL =
	process.env.GITEA_API_URL || "http://gitea-http.gitea.svc.cluster.local:3000";
const GITEA_REPO_OWNER = process.env.GITEA_REPO_OWNER || "giteaadmin";
const GITEA_INTERNAL_CLONE_BASE_URL =
	process.env.GITEA_INTERNAL_CLONE_BASE_URL ||
	"http://gitea-http.gitea.svc.cluster.local:3000";
const GITEA_USERNAME = process.env.GITEA_USERNAME || "";
const GITEA_PASSWORD = process.env.GITEA_PASSWORD || "";
const GITHUB_API_URL = "https://api.github.com";
const GITHUB_ACCEPT_HEADER = "application/vnd.github+json";
const GITHUB_USER_AGENT = "workflow-builder-function-router";

const GITEA_HOST_ALIASES = (
	process.env.GITEA_HOST_ALIASES ||
	"gitea.cnoe.localtest.me:8443,gitea.cnoe.localtest.me,gitea-http.gitea.svc.cluster.local:3000,gitea-http.gitea.svc.cluster.local,my-gitea-http.gitea.svc.cluster.local:3000,my-gitea-http.gitea.svc.cluster.local"
)
	.split(",")
	.map((value) => value.trim().toLowerCase())
	.filter(Boolean);

function hostFromUrl(value: string): string {
	try {
		return new URL(value).host.trim().toLowerCase();
	} catch {
		return "";
	}
}

const GITEA_HOSTS = new Set<string>([
	...GITEA_HOST_ALIASES,
	hostFromUrl(GITEA_API_URL),
	hostFromUrl(GITEA_INTERNAL_CLONE_BASE_URL),
]);

type CloneResolutionInput = {
	repositoryUrl: string;
	repositoryOwner: string;
	repositoryRepo: string;
	repositoryBranch: string;
	repositoryUsername: string;
	repositoryToken: string;
	githubToken: string;
};

type CloneResolutionResult = {
	repositoryUrl: string;
	repositoryOwner: string;
	repositoryRepo: string;
	repositoryUsername: string;
	repositoryToken: string;
	ensuredInGitea: boolean;
};

type ParsedRepoUrl = {
	host: string;
	owner: string;
	repo: string;
};

type GiteaRepoRecord = {
	default_branch?: string;
	empty?: boolean;
	full_name?: string;
	name?: string;
	original_url?: string;
};

function parseRepositoryUrl(value: string): ParsedRepoUrl | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	try {
		const parsed = new URL(trimmed);
		const parts = parsed.pathname.split("/").filter(Boolean);
		if (parts.length < 2) return null;
		const owner = parts[0]?.trim() || "";
		const repo = (parts[1] || "").replace(/\.git$/i, "").trim();
		if (!owner || !repo) return null;
		return {
			host: parsed.host.trim().toLowerCase(),
			owner,
			repo,
		};
	} catch {
		return null;
	}
}

function isGiteaHost(host: string): boolean {
	return GITEA_HOSTS.has(host.trim().toLowerCase());
}

function giteaAuth(
	input: CloneResolutionInput,
): { username: string; password: string } | undefined {
	if (GITEA_USERNAME && GITEA_PASSWORD) {
		return {
			username: GITEA_USERNAME,
			password: GITEA_PASSWORD,
		};
	}
	if (input.repositoryUsername && input.repositoryToken) {
		return {
			username: input.repositoryUsername,
			password: input.repositoryToken,
		};
	}
	return undefined;
}

function buildGiteaCloneUrl(owner: string, repo: string): string {
	const base = GITEA_INTERNAL_CLONE_BASE_URL.replace(/\/+$/, "");
	return `${base}/${owner}/${repo}.git`;
}

function buildGitHubUpstream(
	owner: string,
	repo: string,
	token: string,
): string {
	if (!token) {
		return `https://github.com/${owner}/${repo}.git`;
	}
	return `https://${token}@github.com/${owner}/${repo}.git`;
}

async function giteaRequest(
	path: string,
	input: {
		method?: string;
		body?: unknown;
		auth?: { username: string; password: string };
	},
): Promise<Response> {
	const headers: Record<string, string> = {};
	if (input.body !== undefined) {
		headers["Content-Type"] = "application/json";
	}
	if (input.auth) {
		headers.Authorization = `Basic ${Buffer.from(`${input.auth.username}:${input.auth.password}`).toString("base64")}`;
	}
	return await fetch(`${GITEA_API_URL}${path}`, {
		method: input.method || "GET",
		headers,
		body: input.body === undefined ? undefined : JSON.stringify(input.body),
	});
}

function isGiteaRepoRecord(value: unknown): value is GiteaRepoRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		typeof record.full_name === "string" || typeof record.name === "string"
	);
}

async function getGiteaRepo(
	owner: string,
	repo: string,
): Promise<{ status: number; bodyText: string; repo?: GiteaRepoRecord }> {
	const response = await giteaRequest(
		`/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
		{},
	);
	const bodyText = await response.text();
	if (response.status !== 200) {
		return { status: response.status, bodyText };
	}
	try {
		const parsed = JSON.parse(bodyText) as unknown;
		if (isGiteaRepoRecord(parsed)) {
			return { status: response.status, bodyText, repo: parsed };
		}
	} catch {
		// Ignore parse errors and surface the raw body below.
	}
	return { status: response.status, bodyText };
}

async function deleteGiteaRepo(
	owner: string,
	repo: string,
	auth: { username: string; password: string },
): Promise<void> {
	const response = await giteaRequest(
		`/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
		{
			method: "DELETE",
			auth,
		},
	);
	if (
		response.status === 200 ||
		response.status === 202 ||
		response.status === 204 ||
		response.status === 404
	) {
		return;
	}
	const body = await response.text();
	throw new Error(
		`Failed to delete broken Gitea repo ${owner}/${repo} (${response.status}): ${body.slice(0, 300)}`,
	);
}

async function assertGitHubRepositoryAccessible(
	owner: string,
	repo: string,
	token: string,
): Promise<void> {
	const headers: Record<string, string> = {
		Accept: GITHUB_ACCEPT_HEADER,
		"User-Agent": GITHUB_USER_AGENT,
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}

	const response = await fetch(
		`${GITHUB_API_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
		{
			headers,
			signal: AbortSignal.timeout(15_000),
		},
	);
	if (response.status === 200) {
		return;
	}

	if (response.status === 404) {
		throw new Error(
			token
				? `GitHub repository ${owner}/${repo} was not found or is not accessible with the configured token.`
				: `GitHub repository ${owner}/${repo} was not found or requires a GitHub token.`,
		);
	}

	const body = await response.text();
	throw new Error(
		`GitHub repository lookup failed for ${owner}/${repo} (${response.status}): ${body.slice(0, 300)}`,
	);
}

async function assertGiteaBranchExists(
	owner: string,
	repo: string,
	branch: string,
): Promise<void> {
	const normalizedBranch = branch.trim();
	if (!normalizedBranch) {
		return;
	}

	const response = await giteaRequest(
		`/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(normalizedBranch)}`,
		{},
	);
	if (response.status === 200) {
		return;
	}
	if (response.status !== 404) {
		const body = await response.text();
		throw new Error(
			`Gitea branch lookup failed for ${owner}/${repo}@${normalizedBranch} (${response.status}): ${body.slice(0, 300)}`,
		);
	}

	const repoLookup = await getGiteaRepo(owner, repo);
	const originalUrl = repoLookup.repo?.original_url?.trim();
	if (repoLookup.repo?.empty) {
		throw new Error(
			originalUrl
				? `Gitea repository ${owner}/${repo} is empty, so branch ${normalizedBranch} is unavailable. The configured upstream ${originalUrl} likely failed to import.`
				: `Gitea repository ${owner}/${repo} is empty, so branch ${normalizedBranch} is unavailable.`,
		);
	}

	throw new Error(
		`Branch ${normalizedBranch} was not found in Gitea repository ${owner}/${repo}.`,
	);
}

async function ensureRepoInGitea(input: {
	owner: string;
	repo: string;
	upstream: string;
	upstreamOwner: string;
	upstreamRepo: string;
	upstreamToken: string;
	auth?: { username: string; password: string };
}): Promise<boolean> {
	await assertGitHubRepositoryAccessible(
		input.upstreamOwner,
		input.upstreamRepo,
		input.upstreamToken,
	);

	const existing = await getGiteaRepo(input.owner, input.repo);
	if (existing.status === 200 && existing.repo && !existing.repo.empty) {
		return false;
	}
	if (existing.status === 200 && existing.repo?.empty) {
		if (!input.auth) {
			throw new Error(
				`Gitea repo ${input.owner}/${input.repo} exists but is empty. Configure GITEA_USERNAME/GITEA_PASSWORD so workflow-builder can repair the import.`,
			);
		}
		await deleteGiteaRepo(input.owner, input.repo, input.auth);
	} else if (existing.status !== 404) {
		throw new Error(
			`Gitea repo lookup failed (${existing.status}): ${existing.bodyText.slice(0, 300)}`,
		);
	}
	if (!input.auth) {
		throw new Error(
			"Gitea credentials are required to import missing repos. Set repositoryUsername/repositoryToken on clone step or configure GITEA_USERNAME/GITEA_PASSWORD.",
		);
	}

	const createResponse = await giteaRequest("/api/v1/repos/migrate", {
		method: "POST",
		auth: input.auth,
		body: {
			clone_addr: input.upstream,
			repo_name: input.repo,
			repo_owner: input.owner,
			service: "git",
			mirror: false,
			private: false,
			description: "Imported by workflow-builder clone action",
		},
	});
	if (createResponse.status === 201 || createResponse.status === 409) {
		return true;
	}
	const body = await createResponse.text();
	throw new Error(
		`Gitea repo import failed (${createResponse.status}): ${body.slice(0, 300)}`,
	);
}

export async function resolveCloneRepository(
	input: CloneResolutionInput,
): Promise<CloneResolutionResult> {
	const repositoryUrl = input.repositoryUrl.trim();
	const repositoryOwner = input.repositoryOwner.trim();
	const repositoryRepo = input.repositoryRepo.trim();
	const repositoryBranch = input.repositoryBranch.trim();
	const auth = giteaAuth(input);

	if (repositoryUrl) {
		const parsed = parseRepositoryUrl(repositoryUrl);
		if (!parsed) {
			return {
				repositoryUrl,
				repositoryOwner,
				repositoryRepo,
				repositoryUsername: input.repositoryUsername,
				repositoryToken: input.repositoryToken,
				ensuredInGitea: false,
			};
		}

		if (isGiteaHost(parsed.host)) {
			await assertGiteaBranchExists(
				parsed.owner,
				parsed.repo,
				repositoryBranch,
			);
			return {
				repositoryUrl: buildGiteaCloneUrl(parsed.owner, parsed.repo),
				repositoryOwner: parsed.owner,
				repositoryRepo: parsed.repo,
				repositoryUsername: auth?.username || input.repositoryUsername,
				repositoryToken: auth?.password || input.repositoryToken,
				ensuredInGitea: true,
			};
		}

		if (parsed.host === "github.com") {
			const giteaOwner = GITEA_REPO_OWNER;
			const giteaRepo = parsed.repo;
			const upstream = buildGitHubUpstream(
				parsed.owner,
				parsed.repo,
				input.githubToken,
			);
			const ensured = await ensureRepoInGitea({
				owner: giteaOwner,
				repo: giteaRepo,
				upstream,
				upstreamOwner: parsed.owner,
				upstreamRepo: parsed.repo,
				upstreamToken: input.githubToken,
				auth,
			});
			await assertGiteaBranchExists(giteaOwner, giteaRepo, repositoryBranch);
			return {
				repositoryUrl: buildGiteaCloneUrl(giteaOwner, giteaRepo),
				repositoryOwner: giteaOwner,
				repositoryRepo: giteaRepo,
				repositoryUsername: auth?.username || "",
				repositoryToken: auth?.password || "",
				ensuredInGitea: ensured,
			};
		}

		return {
			repositoryUrl,
			repositoryOwner,
			repositoryRepo,
			repositoryUsername: input.repositoryUsername,
			repositoryToken: input.repositoryToken,
			ensuredInGitea: false,
		};
	}

	if (!repositoryOwner || !repositoryRepo) {
		throw new Error(
			"repositoryUrl or repositoryOwner/repositoryRepo is required for workspace/clone",
		);
	}

	const giteaOwner = GITEA_REPO_OWNER;
	const giteaRepo = repositoryRepo;
	const upstream = buildGitHubUpstream(
		repositoryOwner,
		repositoryRepo,
		input.githubToken,
	);
	const ensured = await ensureRepoInGitea({
		owner: giteaOwner,
		repo: giteaRepo,
		upstream,
		upstreamOwner: repositoryOwner,
		upstreamRepo: repositoryRepo,
		upstreamToken: input.githubToken,
		auth,
	});
	await assertGiteaBranchExists(giteaOwner, giteaRepo, repositoryBranch);
	return {
		repositoryUrl: buildGiteaCloneUrl(giteaOwner, giteaRepo),
		repositoryOwner: giteaOwner,
		repositoryRepo: giteaRepo,
		repositoryUsername: auth?.username || "",
		repositoryToken: auth?.password || "",
		ensuredInGitea: ensured,
	};
}

export async function createGiteaPullRequest(input: {
	repositoryOwner: string;
	repositoryRepo: string;
	repositoryUsername?: string;
	repositoryToken?: string;
	headBranch: string;
	baseBranch: string;
	title: string;
	body?: string;
}) {
	// Always use GITEA_REPO_OWNER — repos are mirrored from GitHub under the
	// Gitea admin user, so the provided owner (e.g. a GitHub org) won't exist.
	const owner = GITEA_REPO_OWNER;
	const repo = input.repositoryRepo.trim();
	const auth = giteaAuth({
		repositoryUrl: "",
		repositoryOwner: owner,
		repositoryRepo: repo,
		repositoryBranch: "",
		repositoryUsername: input.repositoryUsername || "",
		repositoryToken: input.repositoryToken || "",
		githubToken: "",
	});

	if (!auth) {
		throw new Error(
			"Gitea credentials are required to create a PR. Set repositoryUsername/repositoryToken or configure GITEA_USERNAME/GITEA_PASSWORD.",
		);
	}

	const response = await giteaRequest(
		`/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
		{
			method: "POST",
			auth,
			body: {
				head: input.headBranch,
				base: input.baseBranch,
				title: input.title,
				body: input.body || "Automated PR created by Workflow Builder",
			},
		},
	);

	if (response.status === 201) {
		const pr = (await response.json()) as {
			html_url?: string | null;
			number?: number | null;
		};
		return {
			success: true,
			url: pr.html_url ?? null,
			prNumber: pr.number ?? null,
		};
	}

	const text = await response.text();
	if (response.status === 409) {
		// 409 Conflict usually means PR already exists
		return { success: true, url: null, message: "Pull request already exists" };
	}

	throw new Error(
		`Failed to create pull request (${response.status}): ${text.slice(0, 300)}`,
	);
}
