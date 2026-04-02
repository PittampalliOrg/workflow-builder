import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { SUPPORTED_WORKFLOW_ID } from "@/lib/serverless-workflow/cutover";

const DEFAULT_TRIGGER_LABEL = "dapr-swe";

type WorkflowExecutionOutput = {
	workflowOutput?: {
		pr_url?: string;
		status?: string;
	};
	outputs?: {
		commitAndOpenPR?: {
			data?: {
				data?: {
					pr_url?: string;
					status?: string;
				};
			};
		};
	};
};

type GitHubLikeLabel = {
	name?: string;
};

type GitHubIssuesPayload = {
	action?: string;
	label?: GitHubLikeLabel;
	issue?: {
		number?: number;
		title?: string;
		body?: string | null;
		labels?: GitHubLikeLabel[];
	};
	repository?: {
		name?: string;
		owner?: {
			login?: string;
		};
	};
	sender?: {
		login?: string;
	};
};

type GiteaIssueLabelPayload = {
	action?: string;
	label?: GitHubLikeLabel;
	issue?: {
		number?: number;
		title?: string;
		body?: string | null;
		labels?: GitHubLikeLabel[];
	};
	repository?: {
		name?: string;
		owner?: {
			login?: string;
			username?: string;
			user_name?: string;
		};
	};
	sender?: {
		login?: string;
		username?: string;
		user_name?: string;
		type?: string;
	};
};

export type ExternalEventEnvelope = {
	source: "github" | "gitea";
	eventType: string;
	eventId?: string;
	receivedAt?: string;
	payload: unknown;
};

export type SupportedWorkflowTriggerInput = {
	provider: "github" | "gitea";
	owner: string;
	repo: string;
	issue_number: number;
	title: string;
	body: string;
	sender?: string;
};

type ResolveResult =
	| {
			status: "accepted";
			workflowId: typeof SUPPORTED_WORKFLOW_ID;
			input: SupportedWorkflowTriggerInput;
	  }
	| {
			status: "ignored";
			reason: string;
	  };

function asObject(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function normalizeLabelName(label: unknown): string {
	if (!label || typeof label !== "object") {
		return "";
	}
	const name = (label as GitHubLikeLabel).name;
	return typeof name === "string" ? name.trim().toLowerCase() : "";
}

function hasTriggerLabel(
	labels: unknown,
	triggerLabel = DEFAULT_TRIGGER_LABEL,
): boolean {
	if (!Array.isArray(labels)) {
		return false;
	}
	const expected = triggerLabel.trim().toLowerCase();
	return labels.some((label) => normalizeLabelName(label) === expected);
}

function getSenderLogin(sender: unknown): string | undefined {
	if (!sender || typeof sender !== "object") {
		return undefined;
	}
	const record = sender as Record<string, unknown>;
	for (const key of ["login", "username", "user_name"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

function getOwnerLogin(owner: unknown): string {
	if (!owner || typeof owner !== "object") {
		return "";
	}
	const record = owner as Record<string, unknown>;
	for (const key of ["login", "username", "user_name"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return "";
}

function normalizeGitHubIssuesPayload(
	payload: GitHubIssuesPayload,
	triggerLabel = DEFAULT_TRIGGER_LABEL,
): ResolveResult {
	if (payload.action !== "labeled") {
		return { status: "ignored", reason: "Unsupported GitHub issue action" };
	}

	if (!hasTriggerLabel(payload.issue?.labels ?? [], triggerLabel)) {
		return {
			status: "ignored",
			reason: "Issue does not have the trigger label",
		};
	}

	const owner = payload.repository?.owner?.login?.trim();
	const repo = payload.repository?.name?.trim();
	const issueNumber = payload.issue?.number;
	const title = payload.issue?.title?.trim();

	if (!owner || !repo || typeof issueNumber !== "number" || !title) {
		return {
			status: "ignored",
			reason: "GitHub payload is missing required issue fields",
		};
	}

	return {
		status: "accepted",
		workflowId: SUPPORTED_WORKFLOW_ID,
		input: {
			provider: "github",
			owner,
			repo,
			issue_number: issueNumber,
			title,
			body: payload.issue?.body?.trim() || title,
			sender: payload.sender?.login?.trim() || undefined,
		},
	};
}

function normalizeGiteaIssuePayload(
	payload: GiteaIssueLabelPayload,
	triggerLabel = DEFAULT_TRIGGER_LABEL,
): ResolveResult {
	const triggerLabelName = triggerLabel.trim().toLowerCase();
	const currentLabel =
		normalizeLabelName(payload.label) ||
		(Array.isArray(payload.issue?.labels)
			? payload.issue?.labels.map(normalizeLabelName).find(Boolean) || ""
			: "");

	if (currentLabel !== triggerLabelName) {
		return {
			status: "ignored",
			reason: "Issue does not have the trigger label",
		};
	}

	const owner = getOwnerLogin(payload.repository?.owner);
	const repo = payload.repository?.name?.trim() || "";
	const issueNumber = payload.issue?.number;
	const title = payload.issue?.title?.trim();

	if (!owner || !repo || typeof issueNumber !== "number" || !title) {
		return {
			status: "ignored",
			reason: "Gitea payload is missing required issue fields",
		};
	}

	if (
		payload.action &&
		!["label_updated", "labeled"].includes(payload.action)
	) {
		return { status: "ignored", reason: "Unsupported Gitea issue action" };
	}

	return {
		status: "accepted",
		workflowId: SUPPORTED_WORKFLOW_ID,
		input: {
			provider: "gitea",
			owner,
			repo,
			issue_number: issueNumber,
			title,
			body: payload.issue?.body?.trim() || title,
			sender: getSenderLogin(payload.sender),
		},
	};
}

export function resolveSupportedWorkflowTriggerFromEnvelope(
	envelope: ExternalEventEnvelope,
	triggerLabel = DEFAULT_TRIGGER_LABEL,
): ResolveResult {
	const payload = asObject(envelope.payload);
	if (!payload) {
		return {
			status: "ignored",
			reason: "External event payload must be an object",
		};
	}

	if (envelope.source === "github") {
		if (envelope.eventType !== "issues") {
			return { status: "ignored", reason: "Unsupported GitHub event type" };
		}
		return normalizeGitHubIssuesPayload(
			payload as unknown as GitHubIssuesPayload,
			triggerLabel,
		);
	}

	if (envelope.source === "gitea") {
		if (envelope.eventType !== "issue_label") {
			return { status: "ignored", reason: "Unsupported Gitea event type" };
		}
		return normalizeGiteaIssuePayload(
			payload as unknown as GiteaIssueLabelPayload,
			triggerLabel,
		);
	}

	return { status: "ignored", reason: "Unsupported event source" };
}

function getExecutionIssueKey(input: unknown) {
	if (!input || typeof input !== "object") {
		return null;
	}
	const data = input as Record<string, unknown>;
	const owner = typeof data.owner === "string" ? data.owner.trim() : "";
	const repo = typeof data.repo === "string" ? data.repo.trim() : "";
	const provider =
		typeof data.provider === "string" &&
		data.provider.trim().toLowerCase() === "gitea"
			? "gitea"
			: "github";
	const issueNumber =
		typeof data.issue_number === "number"
			? data.issue_number
			: typeof data.issue_number === "string"
				? Number(data.issue_number)
				: Number.NaN;

	if (!owner || !repo || !Number.isInteger(issueNumber)) {
		return null;
	}

	return { provider, owner, repo, issueNumber };
}

function getExecutionPrUrl(output: unknown): string {
	if (!output || typeof output !== "object") {
		return "";
	}
	const data = output as WorkflowExecutionOutput;
	return (
		data.workflowOutput?.pr_url?.trim() ||
		data.outputs?.commitAndOpenPR?.data?.data?.pr_url?.trim() ||
		""
	);
}

export async function findDuplicateSupportedWorkflowExecution(
	workflowId: string,
	input: SupportedWorkflowTriggerInput,
) {
	const recentExecutions = await db.query.workflowExecutions.findMany({
		where: eq(workflowExecutions.workflowId, workflowId),
		orderBy: [desc(workflowExecutions.startedAt)],
		limit: 25,
	});

	for (const execution of recentExecutions) {
		const issueKey = getExecutionIssueKey(execution.input);
		if (
			!issueKey ||
			issueKey.provider !== input.provider ||
			issueKey.owner !== input.owner ||
			issueKey.repo !== input.repo ||
			issueKey.issueNumber !== input.issue_number
		) {
			continue;
		}

		if (execution.status === "pending" || execution.status === "running") {
			return {
				reason: "A workflow execution is already in progress for this issue",
				executionId: execution.id,
			};
		}

		if (execution.status === "success" && getExecutionPrUrl(execution.output)) {
			return {
				reason: "A workflow execution already created a PR for this issue",
				executionId: execution.id,
			};
		}
	}

	return null;
}
