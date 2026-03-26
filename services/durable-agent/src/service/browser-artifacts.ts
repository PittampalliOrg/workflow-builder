import { nanoid } from "nanoid";
import postgres, { type Sql } from "postgres";

export type WorkflowBrowserArtifactStatus =
	| "pending"
	| "completed"
	| "partial"
	| "failed";

export type WorkflowBrowserCaptureStep = {
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
	error?: string;
};

export type WorkflowBrowserArtifactManifest = {
	baseUrl: string;
	startedAt: string;
	completedAt?: string;
	status: WorkflowBrowserArtifactStatus;
	steps: WorkflowBrowserCaptureStep[];
	metadata?: Record<string, unknown> | null;
};

export type WorkflowBrowserArtifactRecord = {
	id: string;
	workflowExecutionId: string;
	workflowId: string;
	nodeId: string;
	workspaceRef?: string;
	artifactType: "capture_flow_v1";
	artifactVersion: number;
	status: WorkflowBrowserArtifactStatus;
	manifestJson: WorkflowBrowserArtifactManifest;
	createdAt: string;
	updatedAt: string;
};

type SaveWorkflowBrowserArtifactInput = {
	workflowExecutionId: string;
	workflowId: string;
	nodeId: string;
	workspaceRef?: string;
	status: WorkflowBrowserArtifactStatus;
	manifest: WorkflowBrowserArtifactManifest;
	screenshots: Array<{
		storageRef?: string;
		contentType?: string;
		payload: Buffer;
	}>;
};

type BrowserArtifactRow = {
	id: string;
	workflow_execution_id: string;
	workflow_id: string;
	node_id: string;
	workspace_ref: string | null;
	artifact_type: string;
	artifact_version: number;
	status: WorkflowBrowserArtifactStatus;
	manifest_json: Record<string, unknown> | string;
	created_at: string | Date;
	updated_at: string | Date;
};

type BrowserBlobRow = {
	payload_text: string;
	content_type: string;
};

const DATABASE_URL =
	process.env.WORKSPACE_RECON_DATABASE_URL || process.env.DATABASE_URL || "";
const BLOB_PREFIX = (
	process.env.WORKFLOW_BROWSER_ARTIFACT_BLOB_PREFIX ||
	"workflow-browser-artifacts"
).replace(/\/+$/, "");

function toIsoString(input: string | Date): string {
	if (input instanceof Date) {
		return input.toISOString();
	}
	const parsed = Date.parse(input);
	if (Number.isFinite(parsed)) {
		return new Date(parsed).toISOString();
	}
	return new Date().toISOString();
}

function parseManifest(
	input: Record<string, unknown> | string,
): WorkflowBrowserArtifactManifest {
	const raw =
		typeof input === "string"
			? (() => {
					try {
						return JSON.parse(input) as Record<string, unknown>;
					} catch {
						return {};
					}
				})()
			: input;
	const steps = Array.isArray(raw.steps)
		? raw.steps
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
					screenshotStorageRef:
						typeof step.screenshotStorageRef === "string" &&
						step.screenshotStorageRef.trim()
							? step.screenshotStorageRef.trim()
							: undefined,
					error:
						typeof step.error === "string" && step.error.trim()
							? step.error.trim()
							: undefined,
				}))
		: [];

	return {
		baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : "",
		startedAt:
			typeof raw.startedAt === "string" && raw.startedAt.trim()
				? raw.startedAt.trim()
				: new Date(0).toISOString(),
		completedAt:
			typeof raw.completedAt === "string" && raw.completedAt.trim()
				? raw.completedAt.trim()
				: undefined,
		status:
			raw.status === "completed" ||
			raw.status === "partial" ||
			raw.status === "failed"
				? raw.status
				: "pending",
		steps,
		metadata:
			raw.metadata && typeof raw.metadata === "object"
				? (raw.metadata as Record<string, unknown>)
				: null,
	};
}

function mapArtifactRow(
	row: BrowserArtifactRow,
): WorkflowBrowserArtifactRecord {
	return {
		id: row.id,
		workflowExecutionId: row.workflow_execution_id,
		workflowId: row.workflow_id,
		nodeId: row.node_id,
		workspaceRef: row.workspace_ref ?? undefined,
		artifactType: "capture_flow_v1",
		artifactVersion: row.artifact_version,
		status: row.status,
		manifestJson: parseManifest(row.manifest_json),
		createdAt: toIsoString(row.created_at),
		updatedAt: toIsoString(row.updated_at),
	};
}

function buildStorageRef(
	workflowExecutionId: string,
	artifactId: string,
	index: number,
): string {
	const safeExecution = workflowExecutionId.replace(/[^a-zA-Z0-9._-]/g, "-");
	return `${BLOB_PREFIX}/${safeExecution}/${artifactId}/step-${index + 1}.png`;
}

class BrowserArtifactStore {
	private sql: Sql | null = null;
	private initialized = false;

	async ensureReady(): Promise<void> {
		if (this.initialized) {
			return;
		}
		if (!DATABASE_URL.trim()) {
			throw new Error(
				"DATABASE_URL is required for browser artifact persistence",
			);
		}
		this.sql = postgres(DATABASE_URL, {
			max: 1,
			prepare: false,
			onnotice: () => {},
		});
		this.initialized = true;
	}

	private requireSql(): Sql {
		if (!this.sql) {
			throw new Error("Browser artifact store not initialized");
		}
		return this.sql;
	}

	async save(
		input: SaveWorkflowBrowserArtifactInput,
	): Promise<WorkflowBrowserArtifactRecord> {
		await this.ensureReady();
		const sql = this.requireSql();
		const artifactId = `bwf_${nanoid(12)}`;

		const manifest: WorkflowBrowserArtifactManifest = {
			...input.manifest,
			status: input.status,
			steps: input.manifest.steps.map((step) => ({ ...step })),
		};

		for (const [index, screenshot] of input.screenshots.entries()) {
			const storageRef =
				screenshot.storageRef ||
				buildStorageRef(input.workflowExecutionId, artifactId, index);
			const matchingStep = manifest.steps[index];
			if (matchingStep && !matchingStep.screenshotStorageRef) {
				matchingStep.screenshotStorageRef = storageRef;
			}
			await sql`
				insert into workflow_browser_artifact_blob_payloads (
					storage_ref,
					payload_text,
					content_type
				)
				values (
					${storageRef},
					${screenshot.payload.toString("base64")},
					${screenshot.contentType || "image/png"}
				)
				on conflict (storage_ref) do update
				set payload_text = excluded.payload_text,
					content_type = excluded.content_type
			`;
		}

		const manifestJson = JSON.stringify(manifest);
		const rows = await sql<BrowserArtifactRow[]>`
			insert into workflow_browser_artifacts (
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
			values (
				${artifactId},
				${input.workflowExecutionId},
				${input.workflowId},
				${input.nodeId},
				${input.workspaceRef || null},
				${"capture_flow_v1"},
				${1},
				${input.status},
				${manifestJson}::jsonb
			)
			returning *
		`;

		return mapArtifactRow(rows[0]);
	}

	async listByExecutionId(
		workflowExecutionId: string,
	): Promise<WorkflowBrowserArtifactRecord[]> {
		await this.ensureReady();
		const sql = this.requireSql();
		const rows = await sql<BrowserArtifactRow[]>`
			select *
			from workflow_browser_artifacts
			where workflow_execution_id = ${workflowExecutionId}
			order by created_at desc
		`;
		return rows.map((row) => mapArtifactRow(row));
	}

	async getById(
		artifactId: string,
	): Promise<WorkflowBrowserArtifactRecord | null> {
		await this.ensureReady();
		const sql = this.requireSql();
		const rows = await sql<BrowserArtifactRow[]>`
			select *
			from workflow_browser_artifacts
			where id = ${artifactId}
			limit 1
		`;
		return rows[0] ? mapArtifactRow(rows[0]) : null;
	}

	async getBlobPayload(
		storageRef: string,
	): Promise<{ payloadBase64: string; contentType: string } | null> {
		await this.ensureReady();
		const sql = this.requireSql();
		const rows = await sql<BrowserBlobRow[]>`
			select payload_text, content_type
			from workflow_browser_artifact_blob_payloads
			where storage_ref = ${storageRef}
			limit 1
		`;
		if (!rows[0]) {
			return null;
		}
		return {
			payloadBase64: rows[0].payload_text,
			contentType: rows[0].content_type,
		};
	}
}

export const browserArtifacts = new BrowserArtifactStore();
