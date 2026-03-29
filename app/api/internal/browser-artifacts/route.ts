import { NextResponse } from "next/server";
import {
	createWorkflowBrowserArtifact,
	type WorkflowBrowserArtifactStep,
	type WorkflowBrowserArtifactStatus,
} from "@/lib/db/workflow-browser-artifacts";
import { isValidInternalToken } from "@/lib/internal-api";

type BrowserArtifactCreateRequest = {
	workflowExecutionId?: unknown;
	workflowId?: unknown;
	nodeId?: unknown;
	workspaceRef?: unknown;
	baseUrl?: unknown;
	status?: unknown;
	metadata?: unknown;
	steps?: unknown;
	screenshots?: unknown;
};

function isStatus(value: unknown): value is WorkflowBrowserArtifactStatus {
	return (
		value === "pending" ||
		value === "completed" ||
		value === "partial" ||
		value === "failed"
	);
}

function normalizeSteps(value: unknown): WorkflowBrowserArtifactStep[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter(
			(step): step is Record<string, unknown> =>
				Boolean(step) && typeof step === "object",
		)
		.map((step, index) => ({
			id:
				typeof step.id === "string" && step.id.trim()
					? step.id.trim()
					: `step-${index + 1}`,
			label:
				typeof step.label === "string" && step.label.trim()
					? step.label.trim()
					: `Step ${index + 1}`,
			url: typeof step.url === "string" ? step.url : "",
			title:
				typeof step.title === "string" && step.title.trim()
					? step.title.trim()
					: undefined,
			waitForSelector:
				typeof step.waitForSelector === "string" && step.waitForSelector.trim()
					? step.waitForSelector.trim()
					: undefined,
			waitForText:
				typeof step.waitForText === "string" && step.waitForText.trim()
					? step.waitForText.trim()
					: undefined,
			delayMs:
				typeof step.delayMs === "number" && Number.isFinite(step.delayMs)
					? step.delayMs
					: undefined,
			capturedAt:
				typeof step.capturedAt === "string" && step.capturedAt.trim()
					? step.capturedAt.trim()
					: undefined,
			status: step.status === "failed" ? "failed" : "completed",
			error:
				typeof step.error === "string" && step.error.trim()
					? step.error.trim()
					: undefined,
			screenshotStorageRef:
				typeof step.screenshotStorageRef === "string" &&
				step.screenshotStorageRef.trim()
					? step.screenshotStorageRef.trim()
					: undefined,
		}));
}

function normalizeScreenshots(
	value: unknown,
): Array<{ payloadBase64: string; contentType?: string; storageRef?: string }> {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter(
			(item): item is Record<string, unknown> =>
				Boolean(item) && typeof item === "object",
		)
		.map((item) => ({
			payloadBase64:
				typeof item.payloadBase64 === "string" ? item.payloadBase64.trim() : "",
			contentType:
				typeof item.contentType === "string" && item.contentType.trim()
					? item.contentType.trim()
					: undefined,
			storageRef:
				typeof item.storageRef === "string" && item.storageRef.trim()
					? item.storageRef.trim()
					: undefined,
		}))
		.filter((item) => item.payloadBase64.length > 0);
}

export async function POST(request: Request) {
	if (!isValidInternalToken(request)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	try {
		const body = (await request.json()) as BrowserArtifactCreateRequest;
		const workflowExecutionId =
			typeof body.workflowExecutionId === "string"
				? body.workflowExecutionId.trim()
				: "";
		const workflowId =
			typeof body.workflowId === "string" ? body.workflowId.trim() : "";
		const nodeId = typeof body.nodeId === "string" ? body.nodeId.trim() : "";
		const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
		if (!workflowExecutionId || !workflowId || !nodeId || !baseUrl) {
			return NextResponse.json(
				{
					error:
						"workflowExecutionId, workflowId, nodeId, and baseUrl are required",
				},
				{ status: 400 },
			);
		}

		const artifact = await createWorkflowBrowserArtifact({
			workflowExecutionId,
			workflowId,
			nodeId,
			workspaceRef:
				typeof body.workspaceRef === "string" ? body.workspaceRef.trim() : null,
			baseUrl,
			status: isStatus(body.status) ? body.status : "pending",
			metadata:
				body.metadata && typeof body.metadata === "object"
					? (body.metadata as Record<string, unknown>)
					: null,
			steps: normalizeSteps(body.steps),
			screenshots: normalizeScreenshots(body.screenshots),
		});

		return NextResponse.json(
			{
				success: true,
				artifact,
				artifactId: artifact.id,
			},
			{
				headers: {
					"Cache-Control": "no-store",
				},
			},
		);
	} catch (error) {
		console.error("Failed to create internal browser artifact:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to create browser artifact",
			},
			{ status: 500 },
		);
	}
}
