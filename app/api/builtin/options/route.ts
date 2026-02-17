import { NextResponse } from "next/server";
import { resolveConnectionValueForUse } from "@/lib/app-connections/resolve-connection-value";
import { getSession } from "@/lib/auth-helpers";
import { listAgentProfileTemplates } from "@/lib/db/agent-profiles";
import { getAppConnectionByExternalId } from "@/lib/db/app-connections";
import { listWorkflowPlanArtifactsForUser } from "@/lib/db/workflow-plan-artifacts";
import {
	AppConnectionType,
	type AppConnectionValue,
} from "@/lib/types/app-connection";

const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_TIMEOUT_MS = Number.parseInt(
	process.env.BUILTIN_OPTIONS_TIMEOUT_MS || "15000",
	10,
);
const GITHUB_ACCEPT_HEADER = "application/vnd.github+json";
const DURABLE_AGENT_API_BASE_URL =
	process.env.DURABLE_AGENT_API_BASE_URL ||
	"http://durable-agent.dapr-agents.svc.cluster.local:8001";
const DURABLE_AGENT_OPTIONS_TIMEOUT_MS = Number.parseInt(
	process.env.DURABLE_AGENT_OPTIONS_TIMEOUT_MS || "5000",
	10,
);

type DropdownOption = {
	label: string;
	value: string;
};

type OptionsResponse = {
	options: DropdownOption[];
	disabled?: boolean;
	placeholder?: string;
};

type OptionsRequestBody = {
	actionName: string;
	propertyName: string;
	connectionExternalId?: string;
	workflowId?: string;
	input?: Record<string, unknown>;
	searchValue?: string;
};

function isValidBody(value: unknown): value is OptionsRequestBody {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const body = value as Record<string, unknown>;
	return (
		typeof body.actionName === "string" && typeof body.propertyName === "string"
	);
}

function buildDisabledResponse(placeholder: string): OptionsResponse {
	return {
		options: [],
		disabled: true,
		placeholder,
	};
}

function normalizeActionName(actionName: string): string {
	return actionName.trim();
}

async function buildAgentProfileTemplateListResponse(
	searchValue?: string,
): Promise<OptionsResponse> {
	const rows = await listAgentProfileTemplates({ includeDisabled: false });
	const options = rows.map((row) => ({
		label: `${row.name} (v${row.defaultVersion})`,
		value: row.id,
	}));
	if (options.length === 0) {
		return buildDisabledResponse(
			"No agent profiles — add templates before building a durable run",
		);
	}
	return { options: filterOptions(options, searchValue) };
}

async function buildWorkflowPlanArtifactListResponse(input: {
	userId: string;
	workflowId?: string;
	searchValue?: string;
}): Promise<OptionsResponse> {
	const rows = await listWorkflowPlanArtifactsForUser({
		userId: input.userId,
		workflowId: input.workflowId,
		searchValue: input.searchValue,
		limit: 100,
	});
	const options = rows.map((row) => {
		const created = row.createdAt.toISOString().slice(0, 19).replace("T", " ");
		const status = row.status.toUpperCase();
		const shortId = row.id.slice(0, 12);
		const workflow = row.workflowId.slice(0, 8);
		const goal = row.goal.slice(0, 80);
		return {
			label: `[${status}] ${created}Z · ${shortId} · wf:${workflow} · ${goal}`,
			value: row.id,
		};
	});
	if (options.length === 0) {
		return buildDisabledResponse(
			"No plan artifacts found. Run durable/run in plan mode first.",
		);
	}
	return { options: filterOptions(options, input.searchValue) };
}

function filterOptions(
	options: DropdownOption[],
	searchValue: string | undefined,
): DropdownOption[] {
	const normalized = searchValue?.trim().toLowerCase();
	if (!normalized) {
		return options;
	}
	return options.filter(
		(option) =>
			option.label.toLowerCase().includes(normalized) ||
			option.value.toLowerCase().includes(normalized),
	);
}

function extractTokenFromConnectionValue(
	connectionValue: AppConnectionValue,
): string | undefined {
	if (
		connectionValue.type === AppConnectionType.OAUTH2 ||
		connectionValue.type === AppConnectionType.CLOUD_OAUTH2 ||
		connectionValue.type === AppConnectionType.PLATFORM_OAUTH2
	) {
		return connectionValue.access_token;
	}

	if (connectionValue.type === AppConnectionType.SECRET_TEXT) {
		return connectionValue.secret_text;
	}

	if (connectionValue.type === AppConnectionType.CUSTOM_AUTH) {
		const props = connectionValue.props || {};
		const candidates = [
			props.token,
			props.accessToken,
			props.personalAccessToken,
			props.pat,
			props.apiKey,
		];
		for (const candidate of candidates) {
			if (typeof candidate === "string" && candidate.trim().length > 0) {
				return candidate.trim();
			}
		}
	}

	return undefined;
}

async function githubRequest<T>(
	path: string,
	token: string,
): Promise<{ data: T; status: number }> {
	const response = await fetch(`${GITHUB_API_BASE_URL}${path}`, {
		headers: {
			Accept: GITHUB_ACCEPT_HEADER,
			Authorization: `Bearer ${token}`,
			"User-Agent": "workflow-builder-builtin-options",
			"X-GitHub-Api-Version": "2022-11-28",
		},
		signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			`GitHub API ${response.status} for ${path}: ${errorText || response.statusText}`,
		);
	}

	const data = (await response.json()) as T;
	return { data, status: response.status };
}

type GithubUser = {
	login: string;
};

type GithubOrg = {
	login: string;
};

type GithubRepo = {
	name: string;
	full_name?: string;
	private?: boolean;
	owner?: {
		login?: string;
	};
};

type GithubBranch = {
	name: string;
};

type DurableToolsResponse = {
	success?: boolean;
	tools?: Array<{
		id?: unknown;
		description?: unknown;
	}>;
};

const DURABLE_AGENT_FALLBACK_TOOLS = [
	"read_file",
	"write_file",
	"edit_file",
	"list_files",
	"delete_file",
	"mkdir",
	"file_stat",
	"execute_command",
	"clone",
];

async function getDurableToolOptions(
	searchValue?: string,
): Promise<OptionsResponse> {
	try {
		const response = await fetch(`${DURABLE_AGENT_API_BASE_URL}/api/tools`, {
			signal: AbortSignal.timeout(DURABLE_AGENT_OPTIONS_TIMEOUT_MS),
		});

		if (!response.ok) {
			throw new Error(
				`Durable agent tools request failed with HTTP ${response.status}`,
			);
		}

		const payload = (await response.json()) as DurableToolsResponse;
		const options: DropdownOption[] = Array.isArray(payload.tools)
			? payload.tools
					.map((tool) => {
						const id = typeof tool.id === "string" ? tool.id.trim() : undefined;
						if (!id) return undefined;
						const description =
							typeof tool.description === "string"
								? tool.description.trim()
								: "";
						return {
							label: description ? `${id} - ${description}` : id,
							value: id,
						} satisfies DropdownOption;
					})
					.filter((option): option is DropdownOption => Boolean(option))
			: [];

		if (options.length === 0) {
			return buildDisabledResponse("No tools available from durable-agent");
		}

		return { options: filterOptions(options, searchValue) };
	} catch (error) {
		console.warn("[builtin/options] Durable agent tool lookup failed:", error);
		return {
			options: filterOptions(
				DURABLE_AGENT_FALLBACK_TOOLS.map((t) => ({ label: t, value: t })),
				searchValue,
			),
			placeholder: "Durable agent unavailable; showing default tools",
		};
	}
}

async function getOwnerOptions(token: string): Promise<DropdownOption[]> {
	const [{ data: user }, { data: orgs }] = await Promise.all([
		githubRequest<GithubUser>("/user", token),
		githubRequest<GithubOrg[]>("/user/orgs?per_page=100", token),
	]);

	const seen = new Set<string>();
	const options: DropdownOption[] = [];

	const owner = user.login.trim();
	if (owner) {
		seen.add(owner.toLowerCase());
		options.push({ label: `${owner} (You)`, value: owner });
	}

	for (const org of orgs) {
		const login = org.login.trim();
		if (!login) {
			continue;
		}
		const key = login.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		options.push({ label: login, value: login });
	}

	return options;
}

async function getRepoOptions(
	token: string,
	owner: string,
): Promise<DropdownOption[]> {
	const { data: user } = await githubRequest<GithubUser>("/user", token);
	const normalizedOwner = owner.trim().toLowerCase();
	const normalizedUser = user.login.trim().toLowerCase();

	let repos: GithubRepo[] = [];
	if (normalizedOwner === normalizedUser) {
		const response = await githubRequest<GithubRepo[]>(
			"/user/repos?per_page=100&type=all&sort=updated",
			token,
		);
		// /user/repos can include org/collaborator repositories. Filter to owner repos.
		repos = response.data.filter((repo) => {
			const repoOwner = repo.owner?.login?.trim().toLowerCase();
			if (repoOwner) {
				return repoOwner === normalizedOwner;
			}
			const fullName = repo.full_name?.trim().toLowerCase();
			return fullName ? fullName.startsWith(`${normalizedOwner}/`) : true;
		});
	} else {
		try {
			const response = await githubRequest<GithubRepo[]>(
				`/orgs/${encodeURIComponent(owner)}/repos?per_page=100&type=all&sort=updated`,
				token,
			);
			repos = response.data;
		} catch {
			const response = await githubRequest<GithubRepo[]>(
				`/users/${encodeURIComponent(owner)}/repos?per_page=100&type=owner&sort=updated`,
				token,
			);
			repos = response.data;
		}
	}

	return repos
		.filter((repo) => typeof repo.name === "string" && repo.name.length > 0)
		.map((repo) => ({
			label: repo.full_name || `${owner}/${repo.name}`,
			value: repo.name,
		}));
}

function resolveOwnerAndRepo(
	ownerInput: string,
	repoInput: string,
): { owner: string; repo: string } {
	const owner = ownerInput.trim();
	const repo = repoInput.trim();
	if (repo.includes("/")) {
		const [parsedOwner, ...rest] = repo.split("/");
		const parsedRepo = rest.join("/").trim();
		if (parsedOwner?.trim() && parsedRepo) {
			return { owner: parsedOwner.trim(), repo: parsedRepo };
		}
	}
	return { owner, repo };
}

async function getBranchOptions(
	token: string,
	owner: string,
	repo: string,
): Promise<DropdownOption[]> {
	const response = await githubRequest<GithubBranch[]>(
		`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
		token,
	);
	return response.data
		.filter(
			(branch) => typeof branch.name === "string" && branch.name.length > 0,
		)
		.map((branch) => ({
			label: branch.name,
			value: branch.name,
		}));
}

/**
 * POST /api/builtin/options
 *
 * Fetch dynamic dropdown options for builtin action config fields.
 * Handles durable profile selection, GitHub repos/branches, and tool lists.
 * Session-authenticated.
 */
export async function POST(request: Request) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		let rawBody: unknown;
		try {
			rawBody = await request.json();
		} catch {
			return NextResponse.json(
				{
					error:
						"Invalid request body. Expected JSON with actionName and propertyName.",
				},
				{ status: 400 },
			);
		}
		if (!isValidBody(rawBody)) {
			return NextResponse.json(
				{ error: "Invalid request body. Required: actionName, propertyName" },
				{ status: 400 },
			);
		}

		const normalizedActionName = normalizeActionName(rawBody.actionName);

		if (
			normalizedActionName === "durable/run" &&
			rawBody.propertyName === "agentProfileTemplateId"
		) {
			return NextResponse.json(
				await buildAgentProfileTemplateListResponse(rawBody.searchValue),
			);
		}

		if (
			normalizedActionName === "durable/run" &&
			rawBody.propertyName === "artifactRef"
		) {
			return NextResponse.json(
				await buildWorkflowPlanArtifactListResponse({
					userId: session.user.id,
					workflowId:
						typeof rawBody.workflowId === "string"
							? rawBody.workflowId.trim()
							: undefined,
					searchValue: rawBody.searchValue,
				}),
			);
		}

		// Tools multi-select for workspace/profile
		if (
			normalizedActionName === "workspace/profile" &&
			rawBody.propertyName === "enabledTools"
		) {
			return NextResponse.json(
				await getDurableToolOptions(rawBody.searchValue),
			);
		}

		// GitHub repo/branch selectors for clone actions
		// Keep mastra/clone for backward compatibility and support workspace/clone.
		if (
			normalizedActionName !== "mastra/clone" &&
			normalizedActionName !== "workspace/clone"
		) {
			return NextResponse.json(
				{ error: `Unsupported action: ${rawBody.actionName}` },
				{ status: 400 },
			);
		}

		if (!rawBody.connectionExternalId) {
			return NextResponse.json(
				buildDisabledResponse("Select a GitHub connection first"),
			);
		}

		const connection = await getAppConnectionByExternalId(
			rawBody.connectionExternalId,
			session.user.id,
		);

		if (!connection) {
			return NextResponse.json(
				{ error: "Connection not found" },
				{ status: 404 },
			);
		}

		if (!connection.pieceName.toLowerCase().includes("github")) {
			return NextResponse.json(
				{
					error: "Clone Repository options require a GitHub connection",
				},
				{ status: 400 },
			);
		}

		const resolvedValue = await resolveConnectionValueForUse(connection);
		const token = extractTokenFromConnectionValue(resolvedValue);

		if (!token) {
			return NextResponse.json(
				{
					error:
						"Selected GitHub connection does not contain a usable access token",
				},
				{ status: 400 },
			);
		}

		const input = rawBody.input || {};
		let response: OptionsResponse;

		switch (rawBody.propertyName) {
			case "repositoryOwner": {
				response = {
					options: filterOptions(
						await getOwnerOptions(token),
						rawBody.searchValue,
					),
				};
				break;
			}
			case "repositoryRepo": {
				const owner = String(input.repositoryOwner || "").trim();
				if (!owner) {
					response = buildDisabledResponse("Select a GitHub owner first");
					break;
				}
				response = {
					options: filterOptions(
						await getRepoOptions(token, owner),
						rawBody.searchValue,
					),
				};
				break;
			}
			case "repositoryBranch": {
				const rawOwner = String(input.repositoryOwner || "").trim();
				const rawRepo = String(input.repositoryRepo || "").trim();
				const { owner, repo } = resolveOwnerAndRepo(rawOwner, rawRepo);
				if (!owner) {
					response = buildDisabledResponse("Select a GitHub owner first");
					break;
				}
				if (!repo) {
					response = buildDisabledResponse("Select a repository first");
					break;
				}
				response = {
					options: filterOptions(
						await getBranchOptions(token, owner, repo),
						rawBody.searchValue,
					),
				};
				break;
			}
			default: {
				return NextResponse.json(
					{ error: `Unsupported property: ${rawBody.propertyName}` },
					{ status: 400 },
				);
			}
		}

		return NextResponse.json(response);
	} catch (error) {
		console.error("[builtin/options] Error:", error);
		const message = error instanceof Error ? error.message : "Unknown error";
		return NextResponse.json(
			{
				error: "Failed to fetch dropdown options",
				details: message,
			},
			{ status: 500 },
		);
	}
}
