import { nanoid } from "nanoid";
import { eq, type SQL } from "drizzle-orm";
import { workflowBrowserArtifactBlobPayloads } from "$lib/server/db/schema";
import { DaprPostgresBindingClient } from "$lib/server/application/adapters/dapr-postgres-binding";
import {
	dateValue,
	jsonParam,
	jsonValue,
	numberValue,
	stringOrNull,
	stringValue,
} from "$lib/server/application/adapters/dapr-postgres-rows";
import type {
	SaveWorkflowBrowserArtifactInput,
	WorkflowBrowserArtifactAssetInput,
	WorkflowBrowserArtifactRecord,
	WorkflowBrowserArtifactStatus,
	WorkflowBrowserArtifactStore,
} from "$lib/server/application/ports";
import type {
	WorkflowBrowserBlobPayload,
	WorkflowBrowserCaptureStepInput,
} from "$lib/server/application/ports/workflows";

type BindingClient = Pick<DaprPostgresBindingClient, "query" | "exec">;

type BrowserArtifactBlobDatabase = {
	insert: (table: typeof workflowBrowserArtifactBlobPayloads) => {
		values: (value: {
			storageRef: string;
			payloadText: string;
			contentType: string;
		}) => {
			onConflictDoUpdate: (input: {
				target: typeof workflowBrowserArtifactBlobPayloads.storageRef;
				set: { payloadText: string; contentType: string };
			}) => Promise<unknown>;
		};
	};
	select: () => {
		from: (table: typeof workflowBrowserArtifactBlobPayloads) => {
			where: (condition: SQL<unknown>) => {
				limit: (limit: number) => Promise<
					Array<{
						payloadText: string;
						contentType: string;
					}>
				>;
			};
		};
	};
};

type BrowserArtifactBlobPayloadStore = {
	upsertBlobPayload(input: {
		storageRef: string;
		payloadBase64: string;
		contentType: string;
	}): Promise<void>;
	getBlobPayload(
		storageRef: string,
	): Promise<WorkflowBrowserBlobPayload | null>;
};

const BROWSER_ARTIFACT_BLOB_PREFIX = "workflow-browser-artifacts";

const WORKFLOW_BROWSER_ARTIFACT_COLUMNS = `
	id,
	workflow_execution_id,
	workflow_id,
	node_id,
	workspace_ref,
	artifact_type,
	artifact_version,
	status,
	manifest_json,
	created_at,
	updated_at
`;

function browserArtifactContentType(
	asset: WorkflowBrowserArtifactAssetInput,
): string {
	if (asset.contentType?.trim()) return asset.contentType.trim();
	if (asset.kind === "trace") return "application/zip";
	if (asset.kind === "video" || asset.kind === "video-annotated")
		return "video/webm";
	if (asset.kind === "caption") return "text/vtt";
	return "image/png";
}

function browserArtifactExtension(
	contentType: string,
	fileName?: string,
): string {
	if (fileName && fileName.includes(".")) {
		const ext = fileName.split(".").pop()?.trim().toLowerCase();
		if (ext && /^[a-z0-9]{1,8}$/.test(ext)) return ext;
	}
	if (contentType.includes("zip")) return "zip";
	if (contentType.includes("json")) return "json";
	if (contentType.startsWith("text/vtt")) return "vtt";
	if (contentType.startsWith("video/")) return "webm";
	if (contentType === "image/jpeg") return "jpg";
	return "png";
}

function browserArtifactStorageRef(input: {
	workflowExecutionId: string;
	artifactId: string;
	kind: string;
	index: number;
	contentType: string;
	fileName?: string;
}): string {
	const safeExecution = input.workflowExecutionId.replace(
		/[^a-zA-Z0-9._-]/g,
		"-",
	);
	const ext = browserArtifactExtension(input.contentType, input.fileName);
	return `${BROWSER_ARTIFACT_BLOB_PREFIX}/${safeExecution}/${input.artifactId}/${input.kind}-${input.index + 1}.${ext}`;
}

type BrowserArtifactManifestStep = {
	id: string;
	label: string;
	url: string;
	status: "completed" | "failed";
	action?: string;
	goal?: string;
	title?: string;
	waitForSelector?: string;
	waitForText?: string;
	delayMs?: number;
	pauseMs?: number;
	successCriteria?: string;
	capturedAt?: string;
	screenshotStorageRef?: string;
	error?: string;
};

function browserArtifactStep(
	input: WorkflowBrowserCaptureStepInput,
	index: number,
): BrowserArtifactManifestStep {
	return {
		id:
			typeof input.id === "string" && input.id.trim()
				? input.id.trim()
				: `step-${index + 1}`,
		label:
			typeof input.label === "string" && input.label.trim()
				? input.label.trim()
				: `Step ${index + 1}`,
		url: typeof input.url === "string" ? input.url : "",
		...(typeof input.action === "string" && input.action.trim()
			? { action: input.action.trim() }
			: {}),
		...(typeof input.goal === "string" && input.goal.trim()
			? { goal: input.goal.trim() }
			: {}),
		...(typeof input.title === "string" && input.title.trim()
			? { title: input.title.trim() }
			: {}),
		...(typeof input.waitForSelector === "string" &&
		input.waitForSelector.trim()
			? { waitForSelector: input.waitForSelector.trim() }
			: {}),
		...(typeof input.waitForText === "string" && input.waitForText.trim()
			? { waitForText: input.waitForText.trim() }
			: {}),
		...(typeof input.delayMs === "number" && Number.isFinite(input.delayMs)
			? { delayMs: input.delayMs }
			: {}),
		...(typeof input.pauseMs === "number" && Number.isFinite(input.pauseMs)
			? { pauseMs: input.pauseMs }
			: {}),
		...(typeof input.successCriteria === "string" &&
		input.successCriteria.trim()
			? { successCriteria: input.successCriteria.trim() }
			: {}),
		...(typeof input.capturedAt === "string" && input.capturedAt.trim()
			? { capturedAt: input.capturedAt.trim() }
			: {}),
		status: input.status === "failed" ? "failed" : "completed",
		...(typeof input.screenshotStorageRef === "string" &&
		input.screenshotStorageRef.trim()
			? { screenshotStorageRef: input.screenshotStorageRef.trim() }
			: {}),
		...(typeof input.error === "string" && input.error.trim()
			? { error: input.error.trim() }
			: {}),
	};
}

function rowToBrowserArtifact(
	row: readonly unknown[],
): WorkflowBrowserArtifactRecord {
	return {
		id: stringValue(row[0]),
		workflowExecutionId: stringValue(row[1]),
		workflowId: stringValue(row[2]),
		nodeId: stringValue(row[3]),
		workspaceRef: stringOrNull(row[4]),
		artifactType: stringValue(row[5], "capture_flow_v1") as "capture_flow_v1",
		artifactVersion: numberValue(row[6], 1),
		status: stringValue(row[7], "pending") as WorkflowBrowserArtifactStatus,
		manifestJson: jsonValue<Record<string, unknown>>(row[8], {}),
		createdAt: dateValue(row[9]),
		updatedAt: dateValue(row[10]),
	};
}

export class PostgresWorkflowBrowserArtifactBlobPayloadStore implements BrowserArtifactBlobPayloadStore {
	constructor(private readonly database: BrowserArtifactBlobDatabase) {}

	async upsertBlobPayload(input: {
		storageRef: string;
		payloadBase64: string;
		contentType: string;
	}): Promise<void> {
		await this.database
			.insert(workflowBrowserArtifactBlobPayloads)
			.values({
				storageRef: input.storageRef,
				payloadText: input.payloadBase64,
				contentType: input.contentType,
			})
			.onConflictDoUpdate({
				target: workflowBrowserArtifactBlobPayloads.storageRef,
				set: {
					payloadText: input.payloadBase64,
					contentType: input.contentType,
				},
			});
	}

	async getBlobPayload(
		storageRef: string,
	): Promise<WorkflowBrowserBlobPayload | null> {
		const [row] = await this.database
			.select()
			.from(workflowBrowserArtifactBlobPayloads)
			.where(eq(workflowBrowserArtifactBlobPayloads.storageRef, storageRef))
			.limit(1);
		return row
			? { payloadBase64: row.payloadText, contentType: row.contentType }
			: null;
	}
}

export class DaprPostgresWorkflowBrowserArtifactStore implements WorkflowBrowserArtifactStore {
	constructor(
		private readonly blobPayloads: BrowserArtifactBlobPayloadStore,
		private readonly client: BindingClient = new DaprPostgresBindingClient(),
	) {}

	async save(
		input: SaveWorkflowBrowserArtifactInput,
	): Promise<WorkflowBrowserArtifactRecord> {
		const artifactId = `bwf_${nanoid(12)}`;
		const now = new Date().toISOString();
		const steps = input.steps.map((step, index) =>
			browserArtifactStep(step, index),
		);
		const manifest: Record<string, unknown> = {
			baseUrl: input.baseUrl,
			startedAt: now,
			completedAt: new Date().toISOString(),
			status: input.status,
			steps,
			assets: [],
			metadata: input.metadata ?? null,
		};
		const screenshotAssets = (input.screenshots ?? []).map((asset) => ({
			...asset,
			kind: "screenshot" as const,
		}));
		const allAssets: WorkflowBrowserArtifactAssetInput[] = [
			...screenshotAssets,
			...(input.assets ?? []),
		];
		const manifestAssets = manifest.assets as Array<Record<string, unknown>>;
		for (const [index, asset] of allAssets.entries()) {
			const contentType = browserArtifactContentType(asset);
			const storageRef = browserArtifactStorageRef({
				workflowExecutionId: input.workflowExecutionId,
				artifactId,
				kind: asset.kind,
				index,
				contentType,
				fileName: asset.fileName,
			});
			await this.blobPayloads.upsertBlobPayload({
				storageRef,
				payloadBase64: asset.payloadBase64,
				contentType,
			});
			if (asset.kind === "screenshot") {
				const stepIndex = steps.findIndex((step) => step.id === asset.stepId);
				if (stepIndex >= 0 && !steps[stepIndex]?.screenshotStorageRef) {
					steps[stepIndex].screenshotStorageRef = storageRef;
				}
			}
			manifestAssets.push({
				kind: asset.kind,
				label: asset.label,
				storageRef,
				contentType,
				...(asset.fileName ? { fileName: asset.fileName } : {}),
				...(asset.stepId ? { stepId: asset.stepId } : {}),
			});
		}

		const params = [
			artifactId,
			input.workflowExecutionId,
			input.workflowId,
			input.nodeId,
			input.workspaceRef ?? null,
			"capture_flow_v1",
			1,
			input.status,
			jsonParam(manifest),
		];
		await this.client.exec({
			summary: "workflow_browser_artifacts.insert",
			collection: "workflow_browser_artifacts",
			sql: `
				INSERT INTO workflow_browser_artifacts (
					id,
					workflow_execution_id,
					workflow_id,
					node_id,
					workspace_ref,
					artifact_type,
					artifact_version,
					status,
					manifest_json
				)
				VALUES (
					$1, $2, $3, $4, $5, $6, $7, $8,
					CAST($9 AS jsonb)
				)
			`,
			params,
			spanParams: [...params.slice(0, 8), manifest],
			paramNames: [
				"id",
				"workflow_execution_id",
				"workflow_id",
				"node_id",
				"workspace_ref",
				"artifact_type",
				"artifact_version",
				"status",
				"manifest_json",
			],
		});
		const result = await this.client.query({
			summary: "workflow_browser_artifacts.select_by_id",
			collection: "workflow_browser_artifacts",
			sql: `
				SELECT ${WORKFLOW_BROWSER_ARTIFACT_COLUMNS}
				FROM workflow_browser_artifacts
				WHERE id = $1
				LIMIT 1
			`,
			params: [artifactId],
			paramNames: ["id"],
		});
		const row = result.rows[0];
		if (!row) throw new Error("Failed to save workflow browser artifact");
		return rowToBrowserArtifact(row);
	}

	async listByExecutionId(
		workflowExecutionId: string,
	): Promise<WorkflowBrowserArtifactRecord[]> {
		const result = await this.client.query({
			summary: "workflow_browser_artifacts.select_by_execution",
			collection: "workflow_browser_artifacts",
			sql: `
				SELECT ${WORKFLOW_BROWSER_ARTIFACT_COLUMNS}
				FROM workflow_browser_artifacts
				WHERE workflow_execution_id = $1
				ORDER BY created_at DESC
			`,
			params: [workflowExecutionId],
			paramNames: ["workflow_execution_id"],
		});
		return result.rows.map(rowToBrowserArtifact);
	}

	getBlobPayload(
		storageRef: string,
	): Promise<WorkflowBrowserBlobPayload | null> {
		return this.blobPayloads.getBlobPayload(storageRef);
	}
}
