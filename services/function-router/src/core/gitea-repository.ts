const DEFAULT_GITEA_API_URL =
	process.env.GITEA_API_URL || "http://gitea-http.gitea.svc.cluster.local:3000";
const DEFAULT_GITEA_REPO_OWNER = process.env.GITEA_REPO_OWNER || "giteaadmin";
const DEFAULT_GITEA_INTERNAL_CLONE_BASE_URL =
	process.env.GITEA_INTERNAL_CLONE_BASE_URL ||
	"http://gitea-http.gitea.svc.cluster.local:3000";
const DEFAULT_GITEA_USERNAME = process.env.GITEA_USERNAME || "";
const DEFAULT_GITEA_TOKEN =
	process.env.GITEA_TOKEN || process.env.GITEA_PASSWORD || "";
const DAPR_CONFIG_STORE =
	process.env.DAPR_CONFIG_STORE || "azureappconfig-workflow-runtime";
const DAPR_SECRETS_STORE = process.env.DAPR_SECRETS_STORE || "azure-keyvault";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
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

type RuntimeGiteaSettings = {
	apiUrl: string;
	repoOwner: string;
	internalCloneBaseUrl: string;
	username: string;
	token: string;
};

type DaprGiteaConfig = Partial<
	Record<
		| "GITEA_API_URL"
		| "GITEA_REPO_OWNER"
		| "GITEA_INTERNAL_CLONE_BASE_URL"
		| "GITEA_USERNAME",
		string
	>
>;

let runtimeSettingsPromise: Promise<RuntimeGiteaSettings> | null = null;

async function getDaprConfiguration(
	keys: string[],
): Promise<DaprGiteaConfig> {
	const url = new URL(
		`http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/configuration/${DAPR_CONFIG_STORE}`,
	);
	for (const key of keys) {
		url.searchParams.append("key", key);
	}
	const response = await fetch(url.toString(), {
		signal: AbortSignal.timeout(5_000),
	});
	if (!response.ok) {
		return {};
	}
	const payload = (await response.json()) as Record<string, { value?: string }>;
	const values: Record<string, string> = {};
	for (const [key, item] of Object.entries(payload || {})) {
		if (typeof item?.value === "string") {
			values[key] = item.value;
		}
	}
	return values;
}

async function getDaprSecret(secretName: string): Promise<string> {
	const response = await fetch(
		`http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/secrets/${DAPR_SECRETS_STORE}/${encodeURIComponent(secretName)}`,
		{ signal: AbortSignal.timeout(5_000) },
	);
	if (!response.ok) {
		return "";
	}
	const payload = (await response.json()) as Record<string, string>;
	if (typeof payload?.[secretName] === "string") {
		return payload[secretName];
	}
	const firstValue = Object.values(payload || {})[0];
	return typeof firstValue === "string" ? firstValue : "";
}

async function getRuntimeGiteaSettings(): Promise<RuntimeGiteaSettings> {
	if (!runtimeSettingsPromise) {
		runtimeSettingsPromise = (async () => {
			const config = await getDaprConfiguration([
				"GITEA_API_URL",
				"GITEA_REPO_OWNER",
				"GITEA_INTERNAL_CLONE_BASE_URL",
				"GITEA_USERNAME",
			]).catch((): DaprGiteaConfig => ({}));
			const token =
				(await getDaprSecret("GITEA-TOKEN").catch(() => "")) ||
				(await getDaprSecret("GITEA-REGISTRY-PASSWORD").catch(() => "")) ||
				DEFAULT_GITEA_TOKEN;
			return {
				apiUrl: config.GITEA_API_URL || DEFAULT_GITEA_API_URL,
				repoOwner: config.GITEA_REPO_OWNER || DEFAULT_GITEA_REPO_OWNER,
				internalCloneBaseUrl:
					config.GITEA_INTERNAL_CLONE_BASE_URL ||
					DEFAULT_GITEA_INTERNAL_CLONE_BASE_URL,
				username: config.GITEA_USERNAME || DEFAULT_GITEA_USERNAME,
				token,
			};
		})();
	}
	return runtimeSettingsPromise;
}

async function getGiteaHosts(): Promise<Set<string>> {
	const settings = await getRuntimeGiteaSettings();
	return new Set<string>([
		...GITEA_HOST_ALIASES,
		hostFromUrl(settings.apiUrl),
		hostFromUrl(settings.internalCloneBaseUrl),
	]);
}

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

type PublishRepositoryResult = {
	repositoryUrl: string;
	repositoryOwner: string;
	repositoryRepo: string;
	repositoryUsername: string;
	repositoryToken: string;
	created: boolean;
	htmlUrl?: string | null;
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

async function isGiteaHost(host: string): Promise<boolean> {
	const giteaHosts = await getGiteaHosts();
	return giteaHosts.has(host.trim().toLowerCase());
}

async function giteaAuth(
	input: CloneResolutionInput,
): Promise<{ username: string; password: string } | undefined> {
	const settings = await getRuntimeGiteaSettings();
	if (settings.username && settings.token) {
		return {
			username: settings.username,
			password: settings.token,
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

async function buildGiteaCloneUrl(
	owner: string,
	repo: string,
): Promise<string> {
	const settings = await getRuntimeGiteaSettings();
	const base = settings.internalCloneBaseUrl.replace(/\/+$/, "");
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
	const settings = await getRuntimeGiteaSettings();
	const headers: Record<string, string> = {};
	if (input.body !== undefined) {
		headers["Content-Type"] = "application/json";
	}
	if (input.auth) {
		headers.Authorization = `Basic ${Buffer.from(`${input.auth.username}:${input.auth.password}`).toString("base64")}`;
	}
	return await fetch(`${settings.apiUrl}${path}`, {
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
): Promise<{ effectiveToken: string }> {
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
		return { effectiveToken: token };
	}

	const responseBody = await response.text();
	if (token && response.status === 401) {
		const fallback = await assertGitHubRepositoryAccessible(owner, repo, "");
		console.warn(
			`[Gitea Repository] Ignoring invalid GitHub token for public repository ${owner}/${repo}; continuing without token`,
		);
		return fallback;
	}

	if (response.status === 404) {
		throw new Error(
			token
				? `GitHub repository ${owner}/${repo} was not found or is not accessible with the configured token.`
				: `GitHub repository ${owner}/${repo} was not found or requires a GitHub token.`,
		);
	}

	throw new Error(
		`GitHub repository lookup failed for ${owner}/${repo} (${response.status}): ${responseBody.slice(0, 300)}`,
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
}): Promise<{ ensured: boolean; effectiveUpstreamToken: string }> {
	const existing = await getGiteaRepo(input.owner, input.repo);
	if (existing.status === 200 && existing.repo && !existing.repo.empty) {
		return {
			ensured: false,
			effectiveUpstreamToken: input.upstreamToken,
		};
	}

	const githubAccess = await assertGitHubRepositoryAccessible(
		input.upstreamOwner,
		input.upstreamRepo,
		input.upstreamToken,
	);
	const upstream = buildGitHubUpstream(
		input.upstreamOwner,
		input.upstreamRepo,
		githubAccess.effectiveToken,
	);

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
			clone_addr: upstream,
			repo_name: input.repo,
			repo_owner: input.owner,
			service: "git",
			mirror: false,
			private: false,
			description: "Imported by workflow-builder clone action",
		},
	});
	if (createResponse.status === 201 || createResponse.status === 409) {
		return {
			ensured: true,
			effectiveUpstreamToken: githubAccess.effectiveToken,
		};
	}
	const body = await createResponse.text();
	throw new Error(
		`Gitea repo import failed (${createResponse.status}): ${body.slice(0, 300)}`,
	);
}

export async function ensureGiteaPublishRepository(input: {
	repositoryOwner?: string;
	repositoryRepo: string;
	repositoryUsername?: string;
	repositoryToken?: string;
	repositoryBranch?: string;
	description?: string;
	private?: boolean;
}): Promise<PublishRepositoryResult> {
	const settings = await getRuntimeGiteaSettings();
	const owner = (input.repositoryOwner || settings.repoOwner).trim();
	const repo = input.repositoryRepo.trim();
	const auth = await giteaAuth({
		repositoryUrl: "",
		repositoryOwner: owner,
		repositoryRepo: repo,
		repositoryBranch: input.repositoryBranch || "main",
		repositoryUsername: input.repositoryUsername || "",
		repositoryToken: input.repositoryToken || "",
		githubToken: "",
	});

	if (!repo) {
		throw new Error("repositoryRepo is required for workspace/publish-gitea");
	}
	if (!owner) {
		throw new Error("repositoryOwner is required for workspace/publish-gitea");
	}
	if (!auth) {
		throw new Error(
			"Gitea credentials are required to publish a workspace. Set repositoryUsername/repositoryToken or configure GITEA_USERNAME/GITEA_PASSWORD.",
		);
	}

	const existing = await getGiteaRepo(owner, repo);
	if (existing.status === 200) {
		return {
			repositoryUrl: await buildGiteaCloneUrl(owner, repo),
			repositoryOwner: owner,
			repositoryRepo: repo,
			repositoryUsername: auth.username,
			repositoryToken: auth.password,
			created: false,
			htmlUrl: existing.repo?.full_name ? `${owner}/${repo}` : null,
		};
	}
	if (existing.status !== 404) {
		throw new Error(
			`Gitea repo lookup failed for ${owner}/${repo} (${existing.status}): ${existing.bodyText.slice(0, 300)}`,
		);
	}

	const body = {
		name: repo,
		private: input.private === true,
		auto_init: false,
		description:
			input.description?.trim() || "Created by workflow-builder publish action",
	};
	const createPath =
		owner === auth.username
			? "/api/v1/user/repos"
			: `/api/v1/orgs/${encodeURIComponent(owner)}/repos`;
	const createResponse = await giteaRequest(createPath, {
		method: "POST",
		auth,
		body,
	});

	if (createResponse.status !== 201 && createResponse.status !== 409) {
		const responseBody = await createResponse.text();
		throw new Error(
			`Gitea repo create failed for ${owner}/${repo} (${createResponse.status}): ${responseBody.slice(0, 300)}`,
		);
	}

	return {
		repositoryUrl: await buildGiteaCloneUrl(owner, repo),
		repositoryOwner: owner,
		repositoryRepo: repo,
		repositoryUsername: auth.username,
		repositoryToken: auth.password,
		created: createResponse.status === 201,
		htmlUrl: `${owner}/${repo}`,
	};
}

export async function resolveCloneRepository(
	input: CloneResolutionInput,
): Promise<CloneResolutionResult> {
	const repositoryUrl = input.repositoryUrl.trim();
	const repositoryOwner = input.repositoryOwner.trim();
	const repositoryRepo = input.repositoryRepo.trim();
	const repositoryBranch = input.repositoryBranch.trim();
	const auth = await giteaAuth(input);

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

		if (await isGiteaHost(parsed.host)) {
			await assertGiteaBranchExists(
				parsed.owner,
				parsed.repo,
				repositoryBranch,
			);
			return {
				repositoryUrl: await buildGiteaCloneUrl(parsed.owner, parsed.repo),
				repositoryOwner: parsed.owner,
				repositoryRepo: parsed.repo,
				repositoryUsername: auth?.username || input.repositoryUsername,
				repositoryToken: auth?.password || input.repositoryToken,
				ensuredInGitea: true,
			};
		}

		if (parsed.host === "github.com") {
			const giteaOwner = (await getRuntimeGiteaSettings()).repoOwner;
			const giteaRepo = parsed.repo;
			const ensuredResult = await ensureRepoInGitea({
				owner: giteaOwner,
				repo: giteaRepo,
				upstream: buildGitHubUpstream(
					parsed.owner,
					parsed.repo,
					input.githubToken,
				),
				upstreamOwner: parsed.owner,
				upstreamRepo: parsed.repo,
				upstreamToken: input.githubToken,
				auth,
			});
			await assertGiteaBranchExists(giteaOwner, giteaRepo, repositoryBranch);
			return {
				repositoryUrl: await buildGiteaCloneUrl(giteaOwner, giteaRepo),
				repositoryOwner: giteaOwner,
				repositoryRepo: giteaRepo,
				repositoryUsername: auth?.username || "",
				repositoryToken: auth?.password || "",
				ensuredInGitea: ensuredResult.ensured,
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

	const giteaOwner = (await getRuntimeGiteaSettings()).repoOwner;
	const giteaRepo = repositoryRepo;
	const ensuredResult = await ensureRepoInGitea({
		owner: giteaOwner,
		repo: giteaRepo,
		upstream: buildGitHubUpstream(
			repositoryOwner,
			repositoryRepo,
			input.githubToken,
		),
		upstreamOwner: repositoryOwner,
		upstreamRepo: repositoryRepo,
		upstreamToken: input.githubToken,
		auth,
	});
	await assertGiteaBranchExists(giteaOwner, giteaRepo, repositoryBranch);
	return {
		repositoryUrl: await buildGiteaCloneUrl(giteaOwner, giteaRepo),
		repositoryOwner: giteaOwner,
		repositoryRepo: giteaRepo,
		repositoryUsername: auth?.username || "",
		repositoryToken: auth?.password || "",
		ensuredInGitea: ensuredResult.ensured,
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
	const owner = (await getRuntimeGiteaSettings()).repoOwner;
	const repo = input.repositoryRepo.trim();
	const auth = await giteaAuth({
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
