import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { isValidInternalToken } from "@/lib/internal-api";
import { SUPPORTED_WORKFLOW_ID } from "@/lib/serverless-workflow/cutover";
import {
	findDuplicateSupportedWorkflowExecution,
	resolveSupportedWorkflowTriggerFromEnvelope,
	type ExternalEventEnvelope,
} from "@/lib/workflows/external-event-registry";
import {
	StartSupportedWorkflowExecutionError,
	startSupportedWorkflowExecution,
} from "@/lib/workflows/start-supported-workflow-execution";

function acceptedIgnored(reason: string) {
	return NextResponse.json({ status: "ignored", reason }, { status: 202 });
}

function getTriggerLabel(source: "github" | "gitea"): string {
	if (source === "gitea") {
		return process.env.GITEA_WEBHOOK_TRIGGER_LABEL?.trim() || "dapr-swe";
	}
	return process.env.GITHUB_WEBHOOK_TRIGGER_LABEL?.trim() || "dapr-swe";
}

function getSingleQueryParam(url: URL, key: string): string | undefined {
	const value = url.searchParams.get(key)?.trim();
	return value ? value : undefined;
}

export async function POST(request: Request) {
	if (!isValidInternalToken(request)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const url = new URL(request.url);
	const source = getSingleQueryParam(url, "source");
	const eventType = getSingleQueryParam(url, "eventType");

	if (
		(source !== "github" && source !== "gitea") ||
		typeof eventType !== "string"
	) {
		return NextResponse.json(
			{ error: "Missing required source or eventType query parameter" },
			{ status: 400 },
		);
	}

	const body = (await request.json().catch(() => null)) as {
		eventId?: string;
		receivedAt?: string;
		payload?: unknown;
	} | null;

	if (!body || typeof body !== "object") {
		return NextResponse.json(
			{ error: "Invalid JSON payload" },
			{ status: 400 },
		);
	}

	const envelope: ExternalEventEnvelope = {
		source,
		eventType,
		eventId: typeof body.eventId === "string" ? body.eventId : undefined,
		receivedAt:
			typeof body.receivedAt === "string" ? body.receivedAt : undefined,
		payload: body.payload,
	};

	const resolved = resolveSupportedWorkflowTriggerFromEnvelope(
		envelope,
		getTriggerLabel(source),
	);
	if (resolved.status === "ignored") {
		return acceptedIgnored(resolved.reason);
	}

	const workflow = await db.query.workflows.findFirst({
		where: eq(workflows.id, SUPPORTED_WORKFLOW_ID),
	});
	if (!workflow) {
		return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
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

	try {
		const started = await startSupportedWorkflowExecution({
			request,
			workflow,
			input: resolved.input,
		});

		return NextResponse.json(
			{
				status: "accepted",
				source,
				eventType,
				workflowId: workflow.id,
				executionId: started.executionId,
				instanceId: started.instanceId,
				eventId: envelope.eventId,
			},
			{ status: 202 },
		);
	} catch (error) {
		if (error instanceof StartSupportedWorkflowExecutionError) {
			return NextResponse.json(
				{
					error: error.message,
					issues: error.issues,
				},
				{ status: error.status },
			);
		}

		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to start workflow execution",
			},
			{ status: 500 },
		);
	}
}
