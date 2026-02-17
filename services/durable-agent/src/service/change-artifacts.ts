import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { DaprClient } from "@dapr/dapr";
import { nanoid } from "nanoid";
import postgres, { type Sql } from "postgres";

export type ChangeFileStatus = "A" | "M" | "D" | "R";

export type ChangeFileEntry = {
	path: string;
	status: ChangeFileStatus;
};

export type ChangeArtifactMetadata = {
	changeSetId: string;
	executionId: string;
	workspaceRef: string;
	durableInstanceId?: string;
	operation: string;
	sequence: number;
	format: "git-unified-v1";
	sha256: string;
	filesChanged: number;
	additions: number;
	deletions: number;
	bytes: number;
	compressed: boolean;
	storageRef: string;
	createdAt: string;
	includeInExecutionPatch: boolean;
	truncated: boolean;
	originalBytes: number;
	files: ChangeFileEntry[];
	baseRevision?: string;
	headRevision?: string;
};

type SaveChangeArtifactInput = {
	executionId: string;
	workspaceRef: string;
	operation: string;
	sequence: number;
	patch: string;
	files: ChangeFileEntry[];
	additions: number;
	deletions: number;
	durableInstanceId?: string;
	includeInExecutionPatch?: boolean;
	baseRevision?: string;
	headRevision?: string;
};

type ChangeArtifactRow = {
	change_set_id: string;
	execution_id: string;
	workspace_ref: string;
	durable_instance_id: string | null;
	operation: string;
	sequence: number;
	format: string;
	sha256: string;
	files_changed: number;
	additions: number;
	deletions: number;
	bytes: number;
	compressed: boolean;
	storage_ref: string;
	created_at: string | Date;
	include_in_execution_patch: boolean;
	truncated: boolean;
	original_bytes: number;
	files: ChangeFileEntry[] | string;
	base_revision: string | null;
	head_revision: string | null;
};

type BlobPayloadEnvelope = {
	encoding: "base64";
	payload: string;
	compressed: boolean;
};

const COMPRESS_THRESHOLD_BYTES = parseInt(
	process.env.WORKSPACE_CHANGE_COMPRESS_THRESHOLD_BYTES || "4096",
	10,
);
const MAX_PATCH_BYTES = parseInt(
	process.env.WORKSPACE_CHANGE_MAX_PATCH_BYTES || `${50 * 1024 * 1024}`,
	10,
);
const PERSISTENCE_REQUIRED =
	process.env.WORKSPACE_CHANGE_PERSISTENCE_REQUIRED !== "false";
const RECON_DATABASE_URL =
	process.env.WORKSPACE_RECON_DATABASE_URL || process.env.DATABASE_URL || "";
const RECON_BLOB_BINDING = process.env.WORKSPACE_RECON_BLOB_BINDING || "";
const RECON_BLOB_PREFIX = (
	process.env.WORKSPACE_RECON_BLOB_PREFIX || "workspace-change-artifacts"
).replace(/\/+$/, "");
const RECON_BLOB_OP_CREATE =
	process.env.WORKSPACE_RECON_BLOB_OP_CREATE || "create";
const RECON_BLOB_OP_GET = process.env.WORKSPACE_RECON_BLOB_OP_GET || "get";
const RECON_BLOB_OP_DELETE =
	process.env.WORKSPACE_RECON_BLOB_OP_DELETE || "delete";

function normalizeStorageRef(executionId: string, changeSetId: string): string {
	const cleanExecution = executionId.replace(/[^a-zA-Z0-9._-]/g, "-");
	return `${RECON_BLOB_PREFIX}/${cleanExecution}/${changeSetId}.json`;
}

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

function parseFiles(input: ChangeFileEntry[] | string): ChangeFileEntry[] {
	if (Array.isArray(input)) {
		return input
			.map((entry) => ({
				path: String(entry.path || "").trim(),
				status: (String(entry.status || "M")
					.toUpperCase()
					.charAt(0) || "M") as ChangeFileStatus,
			}))
			.filter((entry) => Boolean(entry.path));
	}
	if (typeof input === "string" && input.trim()) {
		try {
			const parsed = JSON.parse(input) as ChangeFileEntry[];
			return parseFiles(parsed);
		} catch {
			return [];
		}
	}
	return [];
}

function mapRowToMetadata(row: ChangeArtifactRow): ChangeArtifactMetadata {
	return {
		changeSetId: row.change_set_id,
		executionId: row.execution_id,
		workspaceRef: row.workspace_ref,
		durableInstanceId: row.durable_instance_id || undefined,
		operation: row.operation,
		sequence: row.sequence,
		format: "git-unified-v1",
		sha256: row.sha256,
		filesChanged: row.files_changed,
		additions: row.additions,
		deletions: row.deletions,
		bytes: row.bytes,
		compressed: row.compressed,
		storageRef: row.storage_ref,
		createdAt: toIsoString(row.created_at),
		includeInExecutionPatch: row.include_in_execution_patch,
		truncated: row.truncated,
		originalBytes: row.original_bytes,
		files: parseFiles(row.files),
		baseRevision: row.base_revision || undefined,
		headRevision: row.head_revision || undefined,
	};
}

class WorkspaceChangeArtifactStore {
	private readonly sql: Sql | null;
	private readonly daprClient = new DaprClient();
	private initPromise: Promise<void> | null = null;
	private initialized = false;

	constructor() {
		this.sql = RECON_DATABASE_URL
			? postgres(RECON_DATABASE_URL, {
					max: parseInt(
						process.env.WORKSPACE_RECON_DB_MAX_CONNECTIONS || "4",
						10,
					),
					idle_timeout: parseInt(
						process.env.WORKSPACE_RECON_DB_IDLE_TIMEOUT_SECONDS || "30",
						10,
					),
				})
			: null;
	}

	async ensureReady(): Promise<void> {
		await this.ensureInitialized();
	}

	async save(input: SaveChangeArtifactInput): Promise<ChangeArtifactMetadata> {
		await this.ensureInitialized();
		if (!this.sql) {
			throw new Error(
				"Workspace change persistence database is not configured",
			);
		}

		const patchBytes = Buffer.byteLength(input.patch, "utf8");
		if (patchBytes > MAX_PATCH_BYTES) {
			throw new Error(
				`Workspace patch exceeds limit (${patchBytes} bytes > ${MAX_PATCH_BYTES} bytes). Increase WORKSPACE_CHANGE_MAX_PATCH_BYTES.`,
			);
		}

		const storedPatch = input.patch;
		const storedBytes = patchBytes;
		const shouldCompress = storedBytes >= COMPRESS_THRESHOLD_BYTES;
		const payloadBytes = shouldCompress
			? gzipSync(Buffer.from(storedPatch, "utf8"))
			: Buffer.from(storedPatch, "utf8");
		const sha256 = createHash("sha256").update(storedPatch).digest("hex");
		const changeSetId = `chg_${nanoid(16)}`;
		const storageRef = normalizeStorageRef(input.executionId, changeSetId);
		const metadata: ChangeArtifactMetadata = {
			changeSetId,
			executionId: input.executionId,
			workspaceRef: input.workspaceRef,
			durableInstanceId: input.durableInstanceId,
			operation: input.operation,
			sequence: input.sequence,
			format: "git-unified-v1",
			sha256,
			filesChanged: input.files.length,
			additions: input.additions,
			deletions: input.deletions,
			bytes: storedBytes,
			compressed: shouldCompress,
			storageRef,
			createdAt: new Date().toISOString(),
			includeInExecutionPatch: input.includeInExecutionPatch !== false,
			truncated: false,
			originalBytes: patchBytes,
			files: input.files,
			baseRevision: input.baseRevision,
			headRevision: input.headRevision,
		};

		try {
			await this.writeBlobPayload(
				metadata.storageRef,
				payloadBytes,
				shouldCompress,
			);
			await this.sql`
				insert into workspace_change_artifacts (
					change_set_id,
					execution_id,
					workspace_ref,
					durable_instance_id,
					operation,
					sequence,
					format,
					sha256,
					files_changed,
					additions,
					deletions,
					bytes,
					compressed,
					storage_ref,
					created_at,
					include_in_execution_patch,
					truncated,
					original_bytes,
					files,
					base_revision,
					head_revision
				)
				values (
					${metadata.changeSetId},
					${metadata.executionId},
					${metadata.workspaceRef},
					${metadata.durableInstanceId ?? null},
					${metadata.operation},
					${metadata.sequence},
					${metadata.format},
					${metadata.sha256},
					${metadata.filesChanged},
					${metadata.additions},
					${metadata.deletions},
					${metadata.bytes},
					${metadata.compressed},
					${metadata.storageRef},
					${metadata.createdAt},
					${metadata.includeInExecutionPatch},
					${metadata.truncated},
					${metadata.originalBytes},
					${this.sql.json(metadata.files)},
					${metadata.baseRevision ?? null},
					${metadata.headRevision ?? null}
				)
			`;
			return metadata;
		} catch (error) {
			await this.deleteBlobPayload(metadata.storageRef);
			throw error;
		}
	}

	async get(
		changeSetId: string,
	): Promise<{ metadata: ChangeArtifactMetadata; patch: string } | null> {
		await this.ensureInitialized();
		const metadata = await this.getMetadataByChangeSetId(changeSetId);
		if (!metadata) {
			return null;
		}
		const patch = await this.readPatchFromMetadata(metadata);
		return { metadata, patch };
	}

	async listByExecutionId(
		executionId: string,
	): Promise<ChangeArtifactMetadata[]> {
		await this.ensureInitialized();
		if (!this.sql) {
			throw new Error(
				"Workspace change persistence database is not configured",
			);
		}

		const rows = await this.sql<ChangeArtifactRow[]>`
			select
				change_set_id,
				execution_id,
				workspace_ref,
				durable_instance_id,
				operation,
				sequence,
				format,
				sha256,
				files_changed,
				additions,
				deletions,
				bytes,
				compressed,
				storage_ref,
				created_at,
				include_in_execution_patch,
				truncated,
				original_bytes,
				files,
				base_revision,
				head_revision
			from workspace_change_artifacts
			where execution_id = ${executionId}
			order by sequence asc, created_at asc
		`;

		return rows.map((row) => mapRowToMetadata(row));
	}

	async getExecutionPatch(
		executionId: string,
		opts?: { durableInstanceId?: string; includeExcluded?: boolean },
	): Promise<{
		patch: string;
		changeSets: ChangeArtifactMetadata[];
	}> {
		const includeExcluded = opts?.includeExcluded === true;
		const durableInstanceId = opts?.durableInstanceId;
		const all = await this.listByExecutionId(executionId);
		const filtered = all.filter((entry) => {
			if (!includeExcluded && !entry.includeInExecutionPatch) {
				return false;
			}
			if (durableInstanceId && entry.durableInstanceId !== durableInstanceId) {
				return false;
			}
			return true;
		});

		const patches = await Promise.all(
			filtered.map((entry) => this.readPatchFromMetadata(entry)),
		);

		return {
			patch: patches.filter(Boolean).join("\n"),
			changeSets: filtered,
		};
	}

	private async getMetadataByChangeSetId(
		changeSetId: string,
	): Promise<ChangeArtifactMetadata | null> {
		if (!this.sql) {
			throw new Error(
				"Workspace change persistence database is not configured",
			);
		}

		const rows = await this.sql<ChangeArtifactRow[]>`
			select
				change_set_id,
				execution_id,
				workspace_ref,
				durable_instance_id,
				operation,
				sequence,
				format,
				sha256,
				files_changed,
				additions,
				deletions,
				bytes,
				compressed,
				storage_ref,
				created_at,
				include_in_execution_patch,
				truncated,
				original_bytes,
				files,
				base_revision,
				head_revision
			from workspace_change_artifacts
			where change_set_id = ${changeSetId}
			limit 1
		`;

		if (rows.length === 0) {
			return null;
		}
		return mapRowToMetadata(rows[0]);
	}

	private async readPatchFromMetadata(
		metadata: ChangeArtifactMetadata,
	): Promise<string> {
		const rawPayload = await this.readBlobPayload(metadata.storageRef);
		const patchBuffer = metadata.compressed
			? gunzipSync(rawPayload)
			: rawPayload;
		const patch = patchBuffer.toString("utf8");
		const computedSha = createHash("sha256").update(patch).digest("hex");
		if (computedSha !== metadata.sha256) {
			throw new Error(
				`Patch integrity check failed for ${metadata.changeSetId} (${computedSha} != ${metadata.sha256})`,
			);
		}
		return patch;
	}

	private async writeBlobPayload(
		storageRef: string,
		payloadBytes: Buffer,
		compressed: boolean,
	): Promise<void> {
		const envelope: BlobPayloadEnvelope = {
			encoding: "base64",
			payload: payloadBytes.toString("base64"),
			compressed,
		};
		await this.daprClient.binding.send(
			RECON_BLOB_BINDING,
			RECON_BLOB_OP_CREATE,
			JSON.stringify(envelope),
			{
				blobName: storageRef,
				contentType: "application/json",
			},
		);
	}

	private async readBlobPayload(storageRef: string): Promise<Buffer> {
		const rawResponse = (await this.daprClient.binding.send(
			RECON_BLOB_BINDING,
			RECON_BLOB_OP_GET,
			"",
			{
				blobName: storageRef,
			},
		)) as unknown;
		let parsed: BlobPayloadEnvelope;

		if (rawResponse && typeof rawResponse === "object") {
			const record = rawResponse as Record<string, unknown>;
			if (
				record.encoding === "base64" &&
				typeof record.payload === "string" &&
				typeof record.compressed === "boolean"
			) {
				parsed = record as BlobPayloadEnvelope;
			} else {
				const payloadText = this.extractBindingText(rawResponse);
				try {
					parsed = JSON.parse(payloadText) as BlobPayloadEnvelope;
				} catch (error) {
					throw new Error(
						`Unable to parse blob payload envelope for ${storageRef}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		} else {
			const payloadText = this.extractBindingText(rawResponse);
			try {
				parsed = JSON.parse(payloadText) as BlobPayloadEnvelope;
			} catch (error) {
				throw new Error(
					`Unable to parse blob payload envelope for ${storageRef}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		if (parsed.encoding !== "base64" || typeof parsed.payload !== "string") {
			throw new Error(`Blob payload envelope is invalid for ${storageRef}`);
		}
		return Buffer.from(parsed.payload, "base64");
	}

	private extractBindingText(raw: unknown): string {
		if (typeof raw === "string") {
			return raw;
		}
		if (Buffer.isBuffer(raw)) {
			return raw.toString("utf8");
		}
		if (raw && typeof raw === "object") {
			const record = raw as Record<string, unknown>;
			const candidateKeys = ["data", "value", "result", "content", "blob"];
			for (const key of candidateKeys) {
				const value = record[key];
				if (typeof value === "string") {
					return value;
				}
			}
			if (
				Array.isArray(record.data) &&
				record.data.every((entry) => typeof entry === "number")
			) {
				return Buffer.from(record.data as number[]).toString("utf8");
			}
		}
		throw new Error("Binding response did not contain a readable payload");
	}

	private async deleteBlobPayload(storageRef: string): Promise<void> {
		try {
			await this.daprClient.binding.send(
				RECON_BLOB_BINDING,
				RECON_BLOB_OP_DELETE,
				"",
				{
					blobName: storageRef,
				},
			);
		} catch {
			// best-effort cleanup only
		}
	}

	private async ensureInitialized(): Promise<void> {
		if (this.initialized) {
			return;
		}
		if (!this.initPromise) {
			this.initPromise = this.initialize();
		}
		await this.initPromise;
		this.initialized = true;
	}

	private async initialize(): Promise<void> {
		if (!RECON_DATABASE_URL) {
			if (PERSISTENCE_REQUIRED) {
				throw new Error(
					"WORKSPACE_RECON_DATABASE_URL or DATABASE_URL must be set for workspace change persistence",
				);
			}
			return;
		}
		if (!RECON_BLOB_BINDING) {
			if (PERSISTENCE_REQUIRED) {
				throw new Error(
					"WORKSPACE_RECON_BLOB_BINDING must be set for workspace change persistence",
				);
			}
			return;
		}
		if (!this.sql) {
			throw new Error(
				"Failed to initialize workspace persistence database client",
			);
		}

		await this.sql`
			create table if not exists workspace_change_artifacts (
				change_set_id text primary key,
				execution_id text not null,
				workspace_ref text not null,
				durable_instance_id text null,
				operation text not null,
				sequence integer not null,
				format text not null,
				sha256 text not null,
				files_changed integer not null,
				additions integer not null,
				deletions integer not null,
				bytes integer not null,
				compressed boolean not null,
				storage_ref text not null,
				created_at timestamptz not null,
				include_in_execution_patch boolean not null,
				truncated boolean not null,
				original_bytes integer not null,
				files jsonb not null,
				base_revision text null,
				head_revision text null
			)
		`;
		await this.sql`
			create index if not exists idx_workspace_change_artifacts_execution
			on workspace_change_artifacts (execution_id, sequence, created_at)
		`;
		await this.sql`
			create index if not exists idx_workspace_change_artifacts_instance
			on workspace_change_artifacts (durable_instance_id, sequence)
		`;
		await this.verifyBlobBindingRoundTrip();

		console.log(
			`[workspace-change-artifacts] Persistence initialized (db=postgres, binding=${RECON_BLOB_BINDING}, prefix=${RECON_BLOB_PREFIX})`,
		);
	}

	private async verifyBlobBindingRoundTrip(): Promise<void> {
		const probeRef = `${RECON_BLOB_PREFIX}/_probe/${Date.now()}-${nanoid(8)}.json`;
		const probePayload = Buffer.from("durable-change-artifacts-probe", "utf8");
		await this.writeBlobPayload(probeRef, probePayload, false);
		const readBack = await this.readBlobPayload(probeRef);
		if (readBack.toString("utf8") !== probePayload.toString("utf8")) {
			throw new Error(
				"Workspace blob binding probe round-trip validation failed",
			);
		}
		await this.deleteBlobPayload(probeRef);
	}
}

export const changeArtifacts = new WorkspaceChangeArtifactStore();
