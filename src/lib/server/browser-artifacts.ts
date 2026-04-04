import { nanoid } from 'nanoid';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	workflowBrowserArtifacts,
	workflowBrowserArtifactBlobPayloads
} from '$lib/server/db/schema';

export type WorkflowBrowserArtifactStatus = 'pending' | 'completed' | 'partial' | 'failed';

export type WorkflowBrowserCaptureStep = {
	id: string;
	label: string;
	url: string;
	title?: string;
	waitForSelector?: string;
	waitForText?: string;
	delayMs?: number;
	capturedAt?: string;
	status: 'completed' | 'failed';
	screenshotStorageRef?: string;
	error?: string;
};

export type WorkflowBrowserAsset = {
	kind: 'screenshot' | 'trace' | 'video';
	label: string;
	storageRef: string;
	contentType: string;
	fileName?: string;
	stepId?: string;
};

export type WorkflowBrowserArtifactManifest = {
	baseUrl: string;
	startedAt: string;
	completedAt?: string;
	status: WorkflowBrowserArtifactStatus;
	steps: WorkflowBrowserCaptureStep[];
	assets?: WorkflowBrowserAsset[];
	metadata?: Record<string, unknown> | null;
};

export type WorkflowBrowserArtifactRecord = {
	id: string;
	workflowExecutionId: string;
	workflowId: string;
	nodeId: string;
	workspaceRef?: string;
	artifactType: 'capture_flow_v1';
	artifactVersion: number;
	status: WorkflowBrowserArtifactStatus;
	manifestJson: WorkflowBrowserArtifactManifest;
	createdAt: string;
	updatedAt: string;
};

type SaveAssetInput = {
	kind: 'screenshot' | 'trace' | 'video';
	label: string;
	payloadBase64: string;
	contentType?: string;
	fileName?: string;
	stepId?: string;
	storageRef?: string;
};

type SaveBrowserArtifactInput = {
	workflowExecutionId: string;
	workflowId: string;
	nodeId: string;
	workspaceRef?: string;
	baseUrl: string;
	status: WorkflowBrowserArtifactStatus;
	metadata?: Record<string, unknown> | null;
	steps: WorkflowBrowserCaptureStep[];
	screenshots?: SaveAssetInput[];
	assets?: SaveAssetInput[];
};

const BLOB_PREFIX = 'workflow-browser-artifacts';

function toIsoString(input: string | Date): string {
	if (input instanceof Date) return input.toISOString();
	const parsed = Date.parse(input);
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function deriveContentType(asset: SaveAssetInput): string {
	if (asset.contentType?.trim()) return asset.contentType.trim();
	if (asset.kind === 'trace') return 'application/zip';
	if (asset.kind === 'video') return 'video/webm';
	return 'image/png';
}

function fileExtension(contentType: string, fileName?: string): string {
	if (fileName?.includes('.')) return fileName.split('.').pop() || 'bin';
	if (contentType === 'application/zip') return 'zip';
	if (contentType.startsWith('video/')) return 'webm';
	if (contentType === 'image/jpeg') return 'jpg';
	return 'png';
}

function buildStorageRef(input: {
	workflowExecutionId: string;
	artifactId: string;
	kind: string;
	index: number;
	contentType: string;
	fileName?: string;
}): string {
	const safeExecution = input.workflowExecutionId.replace(/[^a-zA-Z0-9._-]/g, '-');
	const ext = fileExtension(input.contentType, input.fileName);
	return `${BLOB_PREFIX}/${safeExecution}/${input.artifactId}/${input.kind}-${input.index + 1}.${ext}`;
}

function parseStep(input: unknown, index: number): WorkflowBrowserCaptureStep {
	const step = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
	return {
		id: typeof step.id === 'string' && step.id.trim() ? step.id.trim() : `step-${index + 1}`,
		label:
			typeof step.label === 'string' && step.label.trim()
				? step.label.trim()
				: `Step ${index + 1}`,
		url: typeof step.url === 'string' ? step.url : '',
		title: typeof step.title === 'string' && step.title.trim() ? step.title.trim() : undefined,
		waitForSelector:
			typeof step.waitForSelector === 'string' && step.waitForSelector.trim()
				? step.waitForSelector.trim()
				: undefined,
		waitForText:
			typeof step.waitForText === 'string' && step.waitForText.trim()
				? step.waitForText.trim()
				: undefined,
		delayMs:
			typeof step.delayMs === 'number' && Number.isFinite(step.delayMs) ? step.delayMs : undefined,
		capturedAt:
			typeof step.capturedAt === 'string' && step.capturedAt.trim()
				? step.capturedAt.trim()
				: undefined,
		status: step.status === 'failed' ? 'failed' : 'completed',
		screenshotStorageRef:
			typeof step.screenshotStorageRef === 'string' && step.screenshotStorageRef.trim()
				? step.screenshotStorageRef.trim()
				: undefined,
		error: typeof step.error === 'string' && step.error.trim() ? step.error.trim() : undefined
	};
}

function parseManifest(input: Record<string, unknown>): WorkflowBrowserArtifactManifest {
	const rawSteps = Array.isArray(input.steps) ? input.steps : [];
	const rawAssets = Array.isArray(input.assets) ? input.assets : [];
	return {
		baseUrl: typeof input.baseUrl === 'string' ? input.baseUrl : '',
		startedAt:
			typeof input.startedAt === 'string' && input.startedAt.trim()
				? input.startedAt.trim()
				: new Date(0).toISOString(),
		completedAt:
			typeof input.completedAt === 'string' && input.completedAt.trim()
				? input.completedAt.trim()
				: undefined,
		status:
			input.status === 'completed' || input.status === 'partial' || input.status === 'failed'
				? input.status
				: 'pending',
		steps: rawSteps.map((step, index) => parseStep(step, index)),
		assets: rawAssets
			.filter((asset): asset is Record<string, unknown> => Boolean(asset) && typeof asset === 'object')
			.map((asset) => ({
				kind:
					asset.kind === 'trace' || asset.kind === 'video' ? asset.kind : 'screenshot',
				label: typeof asset.label === 'string' && asset.label.trim() ? asset.label.trim() : 'Artifact',
				storageRef: typeof asset.storageRef === 'string' ? asset.storageRef : '',
				contentType: typeof asset.contentType === 'string' ? asset.contentType : 'application/octet-stream',
				fileName:
					typeof asset.fileName === 'string' && asset.fileName.trim() ? asset.fileName.trim() : undefined,
				stepId: typeof asset.stepId === 'string' && asset.stepId.trim() ? asset.stepId.trim() : undefined
			})),
		metadata:
			input.metadata && typeof input.metadata === 'object'
				? (input.metadata as Record<string, unknown>)
				: null
	};
}

function rowToRecord(row: typeof workflowBrowserArtifacts.$inferSelect): WorkflowBrowserArtifactRecord {
	return {
		id: row.id,
		workflowExecutionId: row.workflowExecutionId,
		workflowId: row.workflowId,
		nodeId: row.nodeId,
		workspaceRef: row.workspaceRef ?? undefined,
		artifactType: 'capture_flow_v1',
		artifactVersion: row.artifactVersion,
		status: row.status,
		manifestJson: parseManifest((row.manifestJson ?? {}) as Record<string, unknown>),
		createdAt: toIsoString(row.createdAt),
		updatedAt: toIsoString(row.updatedAt)
	};
}

export async function saveBrowserArtifact(input: SaveBrowserArtifactInput) {
	if (!db) throw new Error('Database not configured');

	const artifactId = `bwf_${nanoid(12)}`;
	const startedAt = new Date().toISOString();
	const steps = input.steps.map((step, index) => parseStep(step, index));
	const manifest: WorkflowBrowserArtifactManifest = {
		baseUrl: input.baseUrl,
		startedAt,
		completedAt: new Date().toISOString(),
		status: input.status,
		steps,
		assets: [],
		metadata: input.metadata ?? null
	};

	const screenshotAssets = (input.screenshots ?? []).map((asset) => ({
		...asset,
		kind: 'screenshot' as const
	}));
	const extraAssets = input.assets ?? [];
	const allAssets = [...screenshotAssets, ...extraAssets];

	for (const [index, asset] of allAssets.entries()) {
		const contentType = deriveContentType(asset);
		const storageRef =
			asset.storageRef ||
			buildStorageRef({
				workflowExecutionId: input.workflowExecutionId,
				artifactId,
				kind: asset.kind,
				index,
				contentType,
				fileName: asset.fileName
			});

		await db
			.insert(workflowBrowserArtifactBlobPayloads)
			.values({
				storageRef,
				payloadText: asset.payloadBase64,
				contentType
			})
			.onConflictDoUpdate({
				target: workflowBrowserArtifactBlobPayloads.storageRef,
				set: {
					payloadText: asset.payloadBase64,
					contentType
				}
			});

		if (asset.kind === 'screenshot') {
			const stepIndex = steps.findIndex((step) => step.id === asset.stepId);
			if (stepIndex >= 0 && !steps[stepIndex].screenshotStorageRef) {
				steps[stepIndex].screenshotStorageRef = storageRef;
			}
		}

		manifest.assets?.push({
			kind: asset.kind,
			label: asset.label,
			storageRef,
			contentType,
			fileName: asset.fileName,
			stepId: asset.stepId
		});
	}

	const [row] = await db
		.insert(workflowBrowserArtifacts)
		.values({
			id: artifactId,
			workflowExecutionId: input.workflowExecutionId,
			workflowId: input.workflowId,
			nodeId: input.nodeId,
			workspaceRef: input.workspaceRef ?? null,
			artifactType: 'capture_flow_v1',
			artifactVersion: 1,
			status: input.status,
			manifestJson: manifest
		})
		.returning();

	return rowToRecord(row);
}

export async function listBrowserArtifactsByExecutionId(workflowExecutionId: string) {
	if (!db) throw new Error('Database not configured');
	const rows = await db
		.select()
		.from(workflowBrowserArtifacts)
		.where(eq(workflowBrowserArtifacts.workflowExecutionId, workflowExecutionId))
		.orderBy(desc(workflowBrowserArtifacts.createdAt));
	return rows.map((row) => rowToRecord(row));
}

export async function getBrowserArtifactById(artifactId: string) {
	if (!db) throw new Error('Database not configured');
	const [row] = await db
		.select()
		.from(workflowBrowserArtifacts)
		.where(eq(workflowBrowserArtifacts.id, artifactId))
		.limit(1);
	return row ? rowToRecord(row) : null;
}

export async function getBrowserBlobPayload(storageRef: string) {
	if (!db) throw new Error('Database not configured');
	const [row] = await db
		.select()
		.from(workflowBrowserArtifactBlobPayloads)
		.where(eq(workflowBrowserArtifactBlobPayloads.storageRef, storageRef))
		.limit(1);
	return row
		? { payloadBase64: row.payloadText, contentType: row.contentType }
		: null;
}

export async function getLatestBrowserArtifactForNode(
	workflowExecutionId: string,
	nodeId: string
) {
	if (!db) throw new Error('Database not configured');
	const [row] = await db
		.select()
		.from(workflowBrowserArtifacts)
		.where(
			and(
				eq(workflowBrowserArtifacts.workflowExecutionId, workflowExecutionId),
				eq(workflowBrowserArtifacts.nodeId, nodeId)
			)
		)
		.orderBy(desc(workflowBrowserArtifacts.createdAt))
		.limit(1);
	return row ? rowToRecord(row) : null;
}
