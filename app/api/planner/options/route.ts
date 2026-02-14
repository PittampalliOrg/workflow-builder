import { NextResponse } from "next/server";
import { convertApPiecesToIntegrations } from "@/lib/activepieces/action-adapter";
import { isPieceInstalled } from "@/lib/activepieces/installed-pieces";
import { getBuiltinPieces } from "@/lib/actions/builtin-pieces";
import { normalizePlannerActionType } from "@/lib/actions/planner-actions";
import type { IntegrationDefinition } from "@/lib/actions/types";
import { flattenConfigFields } from "@/lib/actions/utils";
import { resolveConnectionValueForUse } from "@/lib/app-connections/resolve-connection-value";
import { getSession } from "@/lib/auth-helpers";
import { getAppConnectionByExternalId } from "@/lib/db/app-connections";
import { listPieceMetadata } from "@/lib/db/piece-metadata";
import {
	AppConnectionType,
	type AppConnectionValue,
} from "@/lib/types/app-connection";

const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_TIMEOUT_MS = Number.parseInt(
	process.env.PLANNER_OPTIONS_TIMEOUT_MS || "15000",
	10,
);
const GITHUB_ACCEPT_HEADER = "application/vnd.github+json";
const MASTRA_AGENT_API_BASE_URL =
	process.env.MASTRA_AGENT_API_BASE_URL ||
	"http://mastra-agent.dapr-agents.svc.cluster.local:3000";
const MASTRA_OPTIONS_TIMEOUT_MS = Number.parseInt(
	process.env.MASTRA_OPTIONS_TIMEOUT_MS || "5000",
	10,
);

type DropdownOption = {
	label: string;
	value: string;
};

type PlannerOptionsResponse = {
	options: DropdownOption[];
	disabled?: boolean;
	placeholder?: string;
};

type PlannerOptionsRequestBody = {
	actionName: string;
	propertyName: string;
	connectionExternalId?: string;
	input?: Record<string, unknown>;
	searchValue?: string;
};

function isValidBody(value: unknown): value is PlannerOptionsRequestBody {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const body = value as Record<string, unknown>;
	return (
		typeof body.actionName === "string" && typeof body.propertyName === "string"
	);
}

function buildDisabledResponse(placeholder: string): PlannerOptionsResponse {
	return {
		options: [],
		disabled: true,
		placeholder,
	};
}

function normalizeActionName(actionName: string): string {
	// This endpoint historically served only planner/* actions and would prefix
	// non-namespaced action names with "planner/". We now also serve internal
	// workflow-builder option providers (e.g. agent/run), so:
	// - If a name is already namespaced (contains "/"), leave it as-is.
	// - Otherwise, assume it is a planner action slug and prefix with "planner/".
	const trimmed = actionName.trim();
	if (trimmed.includes("/")) {
		return normalizePlannerActionType(trimmed);
	}
	return normalizePlannerActionType(`planner/${trimmed}`);
}

function buildModelsResponse(searchValue?: string): PlannerOptionsResponse {
	const envList = process.env.AGENT_MODELS_JSON || process.env.AI_MODELS_JSON;
	let models: string[] = [];

	if (envList) {
		try {
			const parsed = JSON.parse(envList) as unknown;
			if (Array.isArray(parsed)) {
				models = parsed.filter((m): m is string => typeof m === "string");
			}
		} catch {
			// ignore malformed env JSON
		}
	}

	if (models.length === 0) {
		models = [
			"gpt-5.2-codex",
			"gpt-4o-mini",
			"gpt-4o",
			"claude-sonnet-4-5",
			"claude-sonnet-4-6",
			"claude-opus-4-6",
			"openai/gpt-5.1-instant",
			"openai/gpt-4o-mini",
		];
	}

	return {
		options: filterOptions(
			models.map((m) => ({ label: getModelDisplayLabel(m), value: m })),
			searchValue,
		),
	};
}

function getModelDisplayLabel(modelId: string): string {
	const labels: Record<string, string> = {
		"gpt-5.2-codex": "GPT-5.2 Codex",
		"gpt-4o": "GPT-4o",
		"gpt-4o-mini": "GPT-4o mini",
		"openai/gpt-5.1-instant": "OpenAI GPT-5.1 Instant (Gateway)",
		"openai/gpt-4o-mini": "OpenAI GPT-4o mini (Gateway)",
		"claude-sonnet-4-5": "Claude Sonnet 4.5",
		"claude-sonnet-4-6": "Claude Sonnet 4.6",
		"claude-opus-4-6": "Claude Opus 4.6",
	};

	return labels[modelId] || modelId;
}

async function buildAllowedActionsResponse(
	searchValue?: string,
): Promise<PlannerOptionsResponse> {
	const allPieces = await listPieceMetadata({});
	const pieces = allPieces.filter((piece) => isPieceInstalled(piece.name));
	const builtinPieces = getBuiltinPieces();

	const integrations: IntegrationDefinition[] = [
		...builtinPieces,
		...(convertApPiecesToIntegrations(pieces) as IntegrationDefinition[]),
	];

	const rawOptions: DropdownOption[] = [];

	for (const piece of integrations) {
		for (const action of piece.actions) {
			const actionType = `${piece.type}/${action.slug}`;

			// Force field flattening to validate "actionType" is selectable even when
			// actions have nested field groups; also keeps parity with AI prompting.
			void flattenConfigFields(action.configFields);

			rawOptions.push({
				label: `${piece.label}: ${action.label}`,
				value: actionType,
			});
		}
	}

	// Deduplicate by value, then filter.
	const seen = new Set<string>();
	const deduped: DropdownOption[] = [];
	for (const opt of rawOptions) {
		if (seen.has(opt.value)) continue;
		seen.add(opt.value);
		deduped.push(opt);
	}

	return {
		options: filterOptions(deduped, searchValue),
	};
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
			"User-Agent": "workflow-builder-planner-options",
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

type MastraToolsResponse = {
	tools?: Array<{
		id?: unknown;
		description?: unknown;
	}>;
};

function getMastraFallbackOptions(): DropdownOption[] {
	return [
		{
			label: "greet - Generate a personalized greeting in different styles",
			value: "greet",
		},
		{
			label: "summarize_text - Summarize text into concise bullet points",
			value: "summarize_text",
		},
		{
			label:
				"current_time - Get the current time in various formats and timezones",
			value: "current_time",
		},
	];
}

async function getMastraToolOptions(
	searchValue?: string,
): Promise<PlannerOptionsResponse> {
	try {
		const response = await fetch(`${MASTRA_AGENT_API_BASE_URL}/api/tools`, {
			signal: AbortSignal.timeout(MASTRA_OPTIONS_TIMEOUT_MS),
		});

		if (!response.ok) {
			throw new Error(
				`Mastra tools request failed with HTTP ${response.status}`,
			);
		}

		const payload = (await response.json()) as MastraToolsResponse;
		const options: DropdownOption[] = Array.isArray(payload.tools)
			? payload.tools
					.map((tool) => {
						const id = typeof tool.id === "string" ? tool.id.trim() : undefined;
						if (!id) {
							return undefined;
						}
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
			return buildDisabledResponse("No tools available from mastra-agent");
		}

		return { options: filterOptions(options, searchValue) };
	} catch (error) {
		console.warn("[planner/options] Mastra tool lookup failed:", error);
		return {
			options: filterOptions(getMastraFallbackOptions(), searchValue),
			placeholder: "Mastra service unavailable; showing fallback tools",
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
 * POST /api/planner/options
 *
 * Fetch dynamic dropdown options for planner clone-style actions.
 * Session-authenticated. Uses the user's GitHub connection token.
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

		// workflow-builder internal dropdowns (not AP planner actions)
		if (
			normalizedActionName === "agent/run" &&
			rawBody.propertyName === "model"
		) {
			return NextResponse.json(buildModelsResponse(rawBody.searchValue));
		}
		if (
			normalizedActionName === "agent/run" &&
			rawBody.propertyName === "allowedActionsJson"
		) {
			return NextResponse.json(
				await buildAllowedActionsResponse(rawBody.searchValue),
			);
		}
		if (
			normalizedActionName === "mastra/run-tool" &&
			rawBody.propertyName === "toolId"
		) {
			return NextResponse.json(await getMastraToolOptions(rawBody.searchValue));
		}

		if (
			!(
				normalizedActionName === "planner/clone" ||
				normalizedActionName === "planner/multi-step" ||
				normalizedActionName === "mastra/clone"
			)
		) {
			return NextResponse.json(
				{ error: `Unsupported planner action: ${rawBody.actionName}` },
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
					error:
						"Planner options require a GitHub connection for Clone Repository actions",
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
		let response: PlannerOptionsResponse;

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
					{ error: `Unsupported planner property: ${rawBody.propertyName}` },
					{ status: 400 },
				);
			}
		}

		return NextResponse.json(response);
	} catch (error) {
		console.error("[planner/options] Error:", error);
		const message = error instanceof Error ? error.message : "Unknown error";
		return NextResponse.json(
			{
				error: "Failed to fetch planner dropdown options",
				details: message,
			},
			{ status: 500 },
		);
	}
}
