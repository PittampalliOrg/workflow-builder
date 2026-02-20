const GITEA_API_URL =
	process.env.GITEA_API_URL ||
	"http://my-gitea-http.gitea.svc.cluster.local:3000";
const GITEA_REPO_OWNER = process.env.GITEA_REPO_OWNER || "giteaAdmin";
const GITEA_INTERNAL_CLONE_BASE_URL =
	process.env.GITEA_INTERNAL_CLONE_BASE_URL ||
	"http://my-gitea-http.gitea.svc.cluster.local:3000";
const GITEA_USERNAME = process.env.GITEA_USERNAME || "";
const GITEA_PASSWORD = process.env.GITEA_PASSWORD || "";

const GITEA_HOST_ALIASES = (
	process.env.GITEA_HOST_ALIASES ||
	"gitea.cnoe.localtest.me:8443,gitea.cnoe.localtest.me,my-gitea-http.gitea.svc.cluster.local:3000,my-gitea-http.gitea.svc.cluster.local"
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

function giteaAuth(input: CloneResolutionInput):
	| { username: string; password: string }
	| undefined {
	if (input.repositoryUsername && input.repositoryToken) {
		return {
			username: input.repositoryUsername,
			password: input.repositoryToken,
		};
	}
	if (GITEA_USERNAME && GITEA_PASSWORD) {
		return {
			username: GITEA_USERNAME,
			password: GITEA_PASSWORD,
		};
	}
	return undefined;
}

function buildGiteaCloneUrl(owner: string, repo: string): string {
	const base = GITEA_INTERNAL_CLONE_BASE_URL.replace(/\/+$/, "");
	return `${base}/${owner}/${repo}.git`;
}

function buildGitHubUpstream(owner: string, repo: string, token: string): string {
	if (!token) {
		return `https://github.com/${owner}/${repo}.git`;
	}
	return `https://${token}@github.com/${owner}/${repo}.git`;
}

async function giteaRequest(path: string, input: {
	method?: string;
	body?: unknown;
	auth?: { username: string; password: string };
}): Promise<Response> {
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

async function ensureRepoInGitea(input: {
	owner: string;
	repo: string;
	upstream: string;
	auth?: { username: string; password: string };
}): Promise<boolean> {
	const existsResponse = await giteaRequest(
		`/api/v1/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`,
		{ auth: input.auth },
	);
	if (existsResponse.status === 200) {
		return false;
	}
	if (existsResponse.status !== 404) {
		const body = await existsResponse.text();
		throw new Error(
			`Gitea repo lookup failed (${existsResponse.status}): ${body.slice(0, 300)}`,
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
			return {
				repositoryUrl: buildGiteaCloneUrl(parsed.owner, parsed.repo),
				repositoryOwner: parsed.owner,
				repositoryRepo: parsed.repo,
				repositoryUsername: input.repositoryUsername,
				repositoryToken: input.repositoryToken,
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
				auth,
			});
			return {
				repositoryUrl: buildGiteaCloneUrl(giteaOwner, giteaRepo),
				repositoryOwner: giteaOwner,
				repositoryRepo: giteaRepo,
				repositoryUsername: input.repositoryUsername,
				repositoryToken: input.repositoryToken,
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
		auth,
	});
	return {
		repositoryUrl: buildGiteaCloneUrl(giteaOwner, giteaRepo),
		repositoryOwner: giteaOwner,
		repositoryRepo: giteaRepo,
		repositoryUsername: input.repositoryUsername,
		repositoryToken: input.repositoryToken,
		ensuredInGitea: ensured,
	};
}
