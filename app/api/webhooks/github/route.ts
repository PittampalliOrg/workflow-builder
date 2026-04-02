import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { SUPPORTED_WORKFLOW_ID } from "@/lib/serverless-workflow/cutover";
import {
	findDuplicateSupportedWorkflowExecution,
	resolveSupportedWorkflowTriggerFromEnvelope,
} from "@/lib/workflows/external-event-registry";
import {
	StartSupportedWorkflowExecutionError,
	startSupportedWorkflowExecution,
} from "@/lib/workflows/start-supported-workflow-execution";

function getWebhookSecret(): string | null {
	const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
	return secret ? secret : null;
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

function getTriggerLabel(): string {
	return process.env.GITHUB_WEBHOOK_TRIGGER_LABEL?.trim() || "dapr-swe";
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

	let payload: unknown;
	try {
		payload = JSON.parse(rawBody) as unknown;
	} catch {
		return NextResponse.json(
			{ error: "Invalid JSON payload" },
			{ status: 400 },
		);
	}

	const action =
		typeof payload === "object" && payload && "action" in payload
			? (payload as { action?: unknown }).action
			: undefined;
	if (action !== "labeled") {
		return acceptedIgnored("Unsupported GitHub issue action");
	}

	const workflow = await db.query.workflows.findFirst({
		where: eq(workflows.id, SUPPORTED_WORKFLOW_ID),
	});
	if (!workflow) {
		return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
	}

	try {
		const resolved = resolveSupportedWorkflowTriggerFromEnvelope(
			{
				source: "github",
				eventType: event,
				payload,
			},
			getTriggerLabel(),
		);
		if (resolved.status === "ignored") {
			return acceptedIgnored(resolved.reason);
		}
		const duplicateExecution = await findDuplicateSupportedWorkflowExecution(
			workflow.id,
			resolved.input,
		);
		if (duplicateExecution) {
			return NextResponse.json(
				{ status: "ignored", ...duplicateExecution },
				{ status: 202 },
			);
		}
		const started = await startSupportedWorkflowExecution({
			request,
			workflow,
			input: resolved.input,
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
