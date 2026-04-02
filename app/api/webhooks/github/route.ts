import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
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

	if (!["opened", "labeled"].includes(payload.action ?? "")) {
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
