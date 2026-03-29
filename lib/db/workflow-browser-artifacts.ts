import "server-only";

import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "./index";
import {
	workflowBrowserArtifactBlobPayloads,
	workflowBrowserArtifacts,
} from "./schema";

export type WorkflowBrowserArtifactStatus =
	| "pending"
	| "completed"
	| "partial"
	| "failed";

export type WorkflowBrowserArtifactStep = {
	id: string;
	label: string;
	url: string;
	title?: string;
	waitForSelector?: string;
	waitForText?: string;
	delayMs?: number;
	capturedAt?: string;
	status: "completed" | "failed";
	screenshotStorageRef?: string;
	screenshotDataUrl?: string;
	error?: string;
};

export type WorkflowBrowserArtifactManifest = {
	baseUrl: string;
	startedAt: string;
	completedAt?: string;
	status: WorkflowBrowserArtifactStatus;
	steps: WorkflowBrowserArtifactStep[];
	metadata?: Record<string, unknown> | null;
};

export type WorkflowExecutionBrowserArtifact = {
	id: string;
	workflowExecutionId: string;
	workflowId: string;
	nodeId: string;
	workspaceRef: string | null;
	artifactType: string;
	artifactVersion: number;
	status: WorkflowBrowserArtifactStatus;
	manifest: WorkflowBrowserArtifactManifest;
	createdAt: Date;
	updatedAt: Date;
};

type CreateWorkflowBrowserArtifactInput = {
	workflowExecutionId: string;
	workflowId: string;
	nodeId: string;
	workspaceRef?: string | null;
	status: WorkflowBrowserArtifactStatus;
	baseUrl: string;
	metadata?: Record<string, unknown> | null;
	steps: WorkflowBrowserArtifactStep[];
	screenshots?: Array<{
		contentType?: string;
		payloadBase64: string;
		storageRef?: string;
	}>;
};

function parseManifest(
	input: unknown,
	withScreenshots = false,
	screenshotMap: Map<string, string> = new Map(),
): WorkflowBrowserArtifactManifest {
	const record =
		input && typeof input === "object"
			? (input as Record<string, unknown>)
			: {};
	const steps = Array.isArray(record.steps)
		? record.steps
				.filter(
					(step): step is Record<string, unknown> =>
						Boolean(step) && typeof step === "object",
				)
				.map((step, index) => {
					const screenshotStorageRef =
						typeof step.screenshotStorageRef === "string" &&
						step.screenshotStorageRef.trim()
							? step.screenshotStorageRef.trim()
							: undefined;
					return {
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
							typeof step.waitForSelector === "string" &&
							step.waitForSelector.trim()
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
						status:
							step.status === "failed"
								? ("failed" as const)
								: ("completed" as const),
						screenshotStorageRef,
						screenshotDataUrl:
							withScreenshots && screenshotStorageRef
								? screenshotMap.get(screenshotStorageRef)
								: undefined,
						error:
							typeof step.error === "string" && step.error.trim()
								? step.error.trim()
								: undefined,
					};
				})
		: [];

	return {
		baseUrl: typeof record.baseUrl === "string" ? record.baseUrl : "",
		startedAt:
			typeof record.startedAt === "string" && record.startedAt.trim()
				? record.startedAt.trim()
				: new Date(0).toISOString(),
		completedAt:
			typeof record.completedAt === "string" && record.completedAt.trim()
				? record.completedAt.trim()
				: undefined,
		status:
			record.status === "completed" ||
			record.status === "partial" ||
			record.status === "failed"
				? record.status
				: "pending",
		steps,
		metadata:
			record.metadata && typeof record.metadata === "object"
				? (record.metadata as Record<string, unknown>)
				: null,
	};
}

function toDataUrl(contentType: string, payloadBase64: string): string {
	return `data:${contentType};base64,${payloadBase64}`;
}

function buildStorageRef(
	workflowExecutionId: string,
	artifactId: string,
	index: number,
): string {
	const safeExecution = workflowExecutionId.replace(/[^a-zA-Z0-9._-]/g, "-");
	return `workflow-browser-artifacts/${safeExecution}/${artifactId}/step-${index + 1}.png`;
}

async function loadScreenshotMap(
	manifest: unknown,
): Promise<Map<string, string>> {
	const parsed = parseManifest(manifest);
	const refs = parsed.steps
		.map((step) => step.screenshotStorageRef)
		.filter((ref): ref is string => Boolean(ref));
	if (refs.length === 0) {
		return new Map();
	}
	const rows = await db
		.select({
			storageRef: workflowBrowserArtifactBlobPayloads.storageRef,
			payloadText: workflowBrowserArtifactBlobPayloads.payloadText,
			contentType: workflowBrowserArtifactBlobPayloads.contentType,
		})
		.from(workflowBrowserArtifactBlobPayloads)
		.where(eq(workflowBrowserArtifactBlobPayloads.storageRef, refs[0]!));

	const screenshotMap = new Map<string, string>();
	for (const row of rows) {
		screenshotMap.set(
			row.storageRef,
			toDataUrl(row.contentType, row.payloadText),
		);
	}

	if (refs.length > 1) {
		const rest = await Promise.all(
			refs.slice(1).map(async (ref) =>
				db
					.select({
						storageRef: workflowBrowserArtifactBlobPayloads.storageRef,
						payloadText: workflowBrowserArtifactBlobPayloads.payloadText,
						contentType: workflowBrowserArtifactBlobPayloads.contentType,
					})
					.from(workflowBrowserArtifactBlobPayloads)
					.where(eq(workflowBrowserArtifactBlobPayloads.storageRef, ref))
					.limit(1),
			),
		);
		for (const rowsForRef of rest) {
			const row = rowsForRef[0];
			if (!row) continue;
			screenshotMap.set(
				row.storageRef,
				toDataUrl(row.contentType, row.payloadText),
			);
		}
	}

	return screenshotMap;
}

function mapArtifactRow(
	row: typeof workflowBrowserArtifacts.$inferSelect,
	manifest: WorkflowBrowserArtifactManifest,
): WorkflowExecutionBrowserArtifact {
	return {
		id: row.id,
		workflowExecutionId: row.workflowExecutionId,
		workflowId: row.workflowId,
		nodeId: row.nodeId,
		workspaceRef: row.workspaceRef,
		artifactType: row.artifactType,
		artifactVersion: row.artifactVersion,
		status: row.status,
		manifest,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export async function listWorkflowBrowserArtifactsForExecution(input: {
	workflowExecutionId: string;
}): Promise<WorkflowExecutionBrowserArtifact[]> {
	const rows = await db.query.workflowBrowserArtifacts.findMany({
		where: eq(
			workflowBrowserArtifacts.workflowExecutionId,
			input.workflowExecutionId.trim(),
		),
		orderBy: [desc(workflowBrowserArtifacts.createdAt)],
	});

	return rows.map((row) =>
		mapArtifactRow(row, parseManifest(row.manifestJson)),
	);
}

export async function getWorkflowBrowserArtifactById(input: {
	artifactId: string;
	includeScreenshots?: boolean;
}): Promise<WorkflowExecutionBrowserArtifact | null> {
	const row = await db.query.workflowBrowserArtifacts.findFirst({
		where: eq(workflowBrowserArtifacts.id, input.artifactId.trim()),
	});
	if (!row) {
		return null;
	}
	const screenshotMap =
		input.includeScreenshots === true
			? await loadScreenshotMap(row.manifestJson)
			: new Map<string, string>();
	return mapArtifactRow(
		row,
		parseManifest(row.manifestJson, input.includeScreenshots, screenshotMap),
	);
}

export async function createWorkflowBrowserArtifact(
	input: CreateWorkflowBrowserArtifactInput,
): Promise<WorkflowExecutionBrowserArtifact> {
	const artifactId = `bwf_${nanoid(12)}`;
	const startedAt = new Date().toISOString();
	const completedAt = new Date().toISOString();
	const steps = input.steps.map((step) => ({ ...step }));
	const screenshots = input.screenshots ?? [];

	for (const [index, screenshot] of screenshots.entries()) {
		const storageRef =
			screenshot.storageRef ||
			buildStorageRef(input.workflowExecutionId, artifactId, index);
		const matchingStep = steps[index];
		if (matchingStep && !matchingStep.screenshotStorageRef) {
			matchingStep.screenshotStorageRef = storageRef;
		}
		await db
			.insert(workflowBrowserArtifactBlobPayloads)
			.values({
				storageRef,
				payloadText: screenshot.payloadBase64,
				contentType: screenshot.contentType || "image/png",
			})
			.onConflictDoUpdate({
				target: workflowBrowserArtifactBlobPayloads.storageRef,
				set: {
					payloadText: screenshot.payloadBase64,
					contentType: screenshot.contentType || "image/png",
				},
			});
	}

	const [row] = await db
		.insert(workflowBrowserArtifacts)
		.values({
			id: artifactId,
			workflowExecutionId: input.workflowExecutionId.trim(),
			workflowId: input.workflowId.trim(),
			nodeId: input.nodeId.trim(),
			workspaceRef: input.workspaceRef?.trim() || null,
			artifactType: "capture_flow_v1",
			artifactVersion: 1,
			status: input.status,
			manifestJson: {
				baseUrl: input.baseUrl,
				startedAt,
				completedAt,
				status: input.status,
				steps,
				metadata: input.metadata ?? null,
			},
		})
		.returning();

	return mapArtifactRow(row, parseManifest(row.manifestJson));
}
