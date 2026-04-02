import { createHmac, timingSafeEqual } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import { SUPPORTED_WORKFLOW_ID } from "@/lib/serverless-workflow/cutover";
import {
	StartSupportedWorkflowExecutionError,
	startSupportedWorkflowExecution,
} from "@/lib/workflows/start-supported-workflow-execution";

const DEFAULT_TRIGGER_LABEL = "dapr-swe";

type GitHubLabel = {
	name?: string;
};

type GitHubIssuesPayload = {
	action?: string;
	issue?: {
		number?: number;
		title?: string;
		body?: string | null;
		labels?: GitHubLabel[];
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

function getWebhookSecret(): string | null {
	const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
	return secret ? secret : null;
}

function getTriggerLabel(): string {
	return (
		process.env.GITHUB_WEBHOOK_TRIGGER_LABEL?.trim() || DEFAULT_TRIGGER_LABEL
	);
}

function verifyGitHubSignature(
	rawBody: string,
	signatureHeader: string,
): boolean {
	const secret = getWebhookSecret();
	if (!secret) {
		console.error("[GitHub webhook] Missing GITHUB_WEBHOOK_SECRET");
		return false;
	}
	if (!signatureHeader.startsWith("sha256=")) {
		return false;
	}
	const providedHex = signatureHeader.slice("sha256=".length);
	if (!providedHex) {
		return false;
	}
	const expectedHex = createHmac("sha256", secret)
		.update(rawBody)
		.digest("hex");

	try {
		return timingSafeEqual(
			Buffer.from(expectedHex, "hex"),
			Buffer.from(providedHex, "hex"),
		);
	} catch {
		return false;
	}
}

function acceptedIgnored(reason: string) {
	return NextResponse.json({ status: "ignored", reason }, { status: 202 });
}

function hasTriggerLabel(payload: GitHubIssuesPayload): boolean {
	const labels = payload.issue?.labels ?? [];
	const triggerLabel = getTriggerLabel().toLowerCase();
	return labels.some(
		(label) =>
			typeof label.name === "string" &&
			label.name.toLowerCase() === triggerLabel,
	);
}

function normalizeIssuesPayload(payload: GitHubIssuesPayload) {
	const owner = payload.repository?.owner?.login?.trim();
	const repo = payload.repository?.name?.trim();
	const issueNumber = payload.issue?.number;
	const title = payload.issue?.title?.trim();

	if (!owner || !repo || typeof issueNumber !== "number" || !title) {
		throw new StartSupportedWorkflowExecutionError(
			"GitHub payload is missing required issue fields",
			400,
		);
	}

	return {
		owner,
		repo,
		issue_number: issueNumber,
		title,
		body: payload.issue?.body?.trim() || title,
		sender: payload.sender?.login?.trim() || undefined,
	};
}

function getExecutionIssueKey(input: unknown) {
	if (!input || typeof input !== "object") {
		return null;
	}
	const data = input as Record<string, unknown>;
	const owner = typeof data.owner === "string" ? data.owner.trim() : "";
	const repo = typeof data.repo === "string" ? data.repo.trim() : "";
	const issueNumber =
		typeof data.issue_number === "number"
			? data.issue_number
			: typeof data.issue_number === "string"
				? Number(data.issue_number)
				: Number.NaN;

	if (!owner || !repo || !Number.isInteger(issueNumber)) {
		return null;
	}

	return { owner, repo, issueNumber };
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

async function findDuplicateExecution(
	workflowId: string,
	input: ReturnType<typeof normalizeIssuesPayload>,
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

export async function POST(request: Request) {
	const signature = request.headers.get("X-Hub-Signature-256")?.trim() || "";
	const event = request.headers.get("X-GitHub-Event")?.trim() || "";

	const rawBody = await request.text();
	if (!verifyGitHubSignature(rawBody, signature)) {
		return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
	}

	if (event !== "issues") {
		return acceptedIgnored("Unsupported GitHub event");
	}

	let payload: GitHubIssuesPayload;
	try {
		payload = JSON.parse(rawBody) as GitHubIssuesPayload;
	} catch {
		return NextResponse.json(
			{ error: "Invalid JSON payload" },
			{ status: 400 },
		);
	}

	if (payload.action !== "labeled") {
		return acceptedIgnored("Unsupported issue action");
	}

	if (!hasTriggerLabel(payload)) {
		return acceptedIgnored("Issue does not have the trigger label");
	}

	const workflow = await db.query.workflows.findFirst({
		where: eq(workflows.id, SUPPORTED_WORKFLOW_ID),
	});
	if (!workflow) {
		return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
	}

	try {
		const input = normalizeIssuesPayload(payload);
		const duplicateExecution = await findDuplicateExecution(workflow.id, input);
		if (duplicateExecution) {
			return NextResponse.json(
				{ status: "ignored", ...duplicateExecution },
				{ status: 202 },
			);
		}
		const started = await startSupportedWorkflowExecution({
			request,
			workflow,
			input,
		});

		return NextResponse.json(
			{
				status: "accepted",
				workflowId: workflow.id,
				executionId: started.executionId,
				instanceId: started.instanceId,
			},
			{ status: 202 },
		);
	} catch (error) {
		if (error instanceof StartSupportedWorkflowExecutionError) {
			return NextResponse.json(
				{
					error: error.message,
					...(error.issues ? { issues: error.issues } : {}),
				},
				{ status: error.status },
			);
		}
		console.error("[GitHub webhook] Failed to start execution:", error);
		return NextResponse.json(
			{ error: "Failed to process GitHub webhook" },
			{ status: 500 },
		);
	}
}
