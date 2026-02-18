import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { DaprClient } from "@dapr/dapr";
import { nanoid } from "nanoid";
import postgres, { type Sql } from "postgres";

export type ChangeFileStatus = "A" | "M" | "D" | "R";

export type ChangeFileEntry = {
	path: string;
	status: ChangeFileStatus;
	oldPath?: string;
};

export type ChangeArtifactFileSnapshotInput = {
	path: string;
	status: ChangeFileStatus;
	oldPath?: string;
	isBinary: boolean;
	language?: string;
	oldContent?: string | null;
	newContent?: string | null;
};

export type ChangeArtifactFileSnapshot = {
	id: string;
	changeSetId: string;
	sequence: number;
	path: string;
	oldPath?: string;
	status: ChangeFileStatus;
	isBinary: boolean;
	language?: string;
	oldBytes: number;
	newBytes: number;
	oldStorageRef?: string;
	newStorageRef?: string;
	oldCompressed: boolean;
	newCompressed: boolean;
	createdAt: string;
};

export type ExecutionFileSnapshot = {
	executionId: string;
	path: string;
	oldPath?: string;
	status: ChangeFileStatus;
	isBinary: boolean;
	language?: string;
	oldContent: string | null;
	newContent: string | null;
	oldBytes: number;
	newBytes: number;
	baseRevision?: string;
	headRevision?: string;
	history: ChangeArtifactFileSnapshot[];
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
	fileSnapshots?: ChangeArtifactFileSnapshotInput[];
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

type WorkflowExecutionAliasRow = {
	id: string;
	dapr_instance_id: string | null;
};

type ChangeArtifactFileRow = {
	id: string;
	change_set_id: string;
	sequence: number;
	path: string;
	old_path: string | null;
	status: ChangeFileStatus;
	is_binary: boolean;
	language: string | null;
	old_storage_ref: string | null;
	new_storage_ref: string | null;
	old_compressed: boolean;
	new_compressed: boolean;
	old_bytes: number;
	new_bytes: number;
	created_at: string | Date;
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

function normalizeFileStorageRef(
	executionId: string,
	changeSetId: string,
	fileIndex: number,
	variant: "old" | "new",
): string {
	const cleanExecution = executionId.replace(/[^a-zA-Z0-9._-]/g, "-");
	return `${RECON_BLOB_PREFIX}/${cleanExecution}/${changeSetId}/files/${fileIndex}-${variant}.txt`;
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
				oldPath:
					typeof entry.oldPath === "string" && entry.oldPath.trim()
						? entry.oldPath.trim()
						: undefined,
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

function mapSnapshotRow(
	row: ChangeArtifactFileRow,
): ChangeArtifactFileSnapshot {
	return {
		id: row.id,
		changeSetId: row.change_set_id,
		sequence: row.sequence,
		path: row.path,
		oldPath: row.old_path || undefined,
		status: row.status,
		isBinary: row.is_binary,
		language: row.language || undefined,
		oldBytes: row.old_bytes,
		newBytes: row.new_bytes,
		oldStorageRef: row.old_storage_ref || undefined,
		newStorageRef: row.new_storage_ref || undefined,
		oldCompressed: row.old_compressed,
		newCompressed: row.new_compressed,
		createdAt: toIsoString(row.created_at),
	};
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
		const createdBlobRefs: string[] = [];
		const fileSnapshots = input.fileSnapshots ?? [];
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
			createdBlobRefs.push(metadata.storageRef);
			const snapshotRows = await Promise.all(
				fileSnapshots.map(async (snapshot, index) => {
					const id = `chgfil_${nanoid(18)}`;
					let oldStorageRef: string | null = null;
					let newStorageRef: string | null = null;
					let oldCompressed = false;
					let newCompressed = false;
					let oldBytes = 0;
					let newBytes = 0;

					if (typeof snapshot.oldContent === "string") {
						const stored = this.prepareStoredTextPayload(snapshot.oldContent);
						oldStorageRef = normalizeFileStorageRef(
							input.executionId,
							changeSetId,
							index,
							"old",
						);
						await this.writeBlobPayload(
							oldStorageRef,
							stored.payloadBytes,
							stored.compressed,
						);
						createdBlobRefs.push(oldStorageRef);
						oldCompressed = stored.compressed;
						oldBytes = stored.bytes;
					}

					if (typeof snapshot.newContent === "string") {
						const stored = this.prepareStoredTextPayload(snapshot.newContent);
						newStorageRef = normalizeFileStorageRef(
							input.executionId,
							changeSetId,
							index,
							"new",
						);
						await this.writeBlobPayload(
							newStorageRef,
							stored.payloadBytes,
							stored.compressed,
						);
						createdBlobRefs.push(newStorageRef);
						newCompressed = stored.compressed;
						newBytes = stored.bytes;
					}

					return {
						id,
						changeSetId,
						createdAt: metadata.createdAt,
						isBinary: snapshot.isBinary,
						language: snapshot.language || null,
						newBytes,
						newCompressed,
						newStorageRef,
						oldBytes,
						oldCompressed,
						oldPath: snapshot.oldPath || null,
						oldStorageRef,
						path: snapshot.path,
						sequence: metadata.sequence,
						status: snapshot.status,
					};
				}),
			);

			await this.sql.begin(async (tx) => {
				await tx`
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
						${tx.json(metadata.files)},
						${metadata.baseRevision ?? null},
						${metadata.headRevision ?? null}
					)
				`;
				for (const row of snapshotRows) {
					await tx`
						insert into workspace_change_artifact_files (
							id,
							change_set_id,
							sequence,
							path,
							old_path,
							status,
							is_binary,
							language,
							old_storage_ref,
							new_storage_ref,
							old_compressed,
							new_compressed,
							old_bytes,
							new_bytes,
							created_at
						)
						values (
							${row.id},
							${row.changeSetId},
							${row.sequence},
							${row.path},
							${row.oldPath},
							${row.status},
							${row.isBinary},
							${row.language},
							${row.oldStorageRef},
							${row.newStorageRef},
							${row.oldCompressed},
							${row.newCompressed},
							${row.oldBytes},
							${row.newBytes},
							${row.createdAt}
						)
					`;
				}
			});
			return metadata;
		} catch (error) {
			await Promise.all(
				createdBlobRefs.map((ref) => this.deleteBlobPayload(ref)),
			);
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
		const id = executionId.trim();
		if (!id) {
			return [];
		}
		const direct = await this.listByExecutionIdExact(id);
		if (direct.length > 0) {
			return direct;
		}
		const aliasId = await this.resolveAlternateExecutionId(id);
		if (!aliasId) {
			return direct;
		}
		const aliasRows = await this.listByExecutionIdExact(aliasId);
		if (aliasRows.length > 0) {
			console.log(
				`[workspace-change-artifacts] Resolved execution alias ${id} -> ${aliasId}`,
			);
		}
		return aliasRows;
	}

	private async listByExecutionIdExact(
		executionId: string,
	): Promise<ChangeArtifactMetadata[]> {
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

	private async resolveAlternateExecutionId(
		executionId: string,
	): Promise<string | null> {
		if (!this.sql) {
			return null;
		}
		const rows = await this.sql<WorkflowExecutionAliasRow[]>`
			select id, dapr_instance_id
			from workflow_executions
			where id = ${executionId} or dapr_instance_id = ${executionId}
			limit 2
		`;
		if (rows.length === 0) {
			return null;
		}
		for (const row of rows) {
			if (row.id && row.id !== executionId) {
				return row.id;
			}
			if (row.dapr_instance_id && row.dapr_instance_id !== executionId) {
				return row.dapr_instance_id;
			}
		}
		return null;
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

	async getExecutionFileSnapshot(
		executionId: string,
		path: string,
		opts?: { durableInstanceId?: string },
	): Promise<ExecutionFileSnapshot | null> {
		await this.ensureInitialized();
		if (!this.sql) {
			throw new Error(
				"Workspace change persistence database is not configured",
			);
		}

		const normalizedExecutionId = executionId.trim();
		const normalizedPath = path.trim();
		if (!normalizedExecutionId || !normalizedPath) {
			return null;
		}

		const rows = await this.sql<ChangeArtifactFileRow[]>`
			select
				acf.id,
				acf.change_set_id,
				acf.sequence,
				acf.path,
				acf.old_path,
				acf.status,
				acf.is_binary,
				acf.language,
				acf.old_storage_ref,
				acf.new_storage_ref,
				acf.old_compressed,
				acf.new_compressed,
				acf.old_bytes,
				acf.new_bytes,
				acf.created_at,
				aca.base_revision,
				aca.head_revision
			from workspace_change_artifact_files acf
			join workspace_change_artifacts aca
				on aca.change_set_id = acf.change_set_id
			where aca.execution_id = ${normalizedExecutionId}
				${
					opts?.durableInstanceId
						? this.sql`and aca.durable_instance_id = ${opts.durableInstanceId}`
						: this.sql``
				}
			order by acf.sequence asc, acf.created_at asc
		`;

		if (rows.length === 0) {
			return null;
		}

		const lineagePaths = new Set<string>([normalizedPath]);
		const lineageRows: ChangeArtifactFileRow[] = [];
		for (const row of rows) {
			const oldPath = row.old_path ?? undefined;
			const matchesPath =
				lineagePaths.has(row.path) ||
				(oldPath !== undefined && lineagePaths.has(oldPath));
			if (!matchesPath) {
				continue;
			}
			lineageRows.push(row);
			lineagePaths.add(row.path);
			if (oldPath) {
				lineagePaths.add(oldPath);
			}
		}

		if (lineageRows.length === 0) {
			return null;
		}

		const firstWithOld = lineageRows.find((row) => row.old_storage_ref);
		const lastWithNew = [...lineageRows]
			.reverse()
			.find((row) => row.new_storage_ref);
		const lastRow = lineageRows[lineageRows.length - 1];
		const isBinary = lineageRows.some((row) => row.is_binary);

		const oldContent =
			firstWithOld?.old_storage_ref && !isBinary
				? await this.readStoredTextPayload(
						firstWithOld.old_storage_ref,
						firstWithOld.old_compressed,
					)
				: null;
		const newContent =
			lastWithNew?.new_storage_ref && !isBinary
				? await this.readStoredTextPayload(
						lastWithNew.new_storage_ref,
						lastWithNew.new_compressed,
					)
				: null;

		return {
			executionId: normalizedExecutionId,
			path: lastRow.path,
			oldPath: lastRow.old_path || undefined,
			status: lastRow.status,
			isBinary,
			language: lastRow.language || undefined,
			oldContent,
			newContent,
			oldBytes: firstWithOld?.old_bytes ?? 0,
			newBytes: lastWithNew?.new_bytes ?? 0,
			baseRevision:
				lineageRows.find((row) => row.base_revision)?.base_revision ||
				undefined,
			headRevision:
				[...lineageRows].reverse().find((row) => row.head_revision)
					?.head_revision || undefined,
			history: lineageRows.map((row) => mapSnapshotRow(row)),
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

	private prepareStoredTextPayload(content: string): {
		bytes: number;
		compressed: boolean;
		payloadBytes: Buffer;
	} {
		const bytes = Buffer.byteLength(content, "utf8");
		const compressed = bytes >= COMPRESS_THRESHOLD_BYTES;
		const payloadBytes = compressed
			? gzipSync(Buffer.from(content, "utf8"))
			: Buffer.from(content, "utf8");
		return { bytes, compressed, payloadBytes };
	}

	private async readStoredTextPayload(
		storageRef: string,
		compressed: boolean,
	): Promise<string> {
		const rawPayload = await this.readBlobPayload(storageRef);
		const payload = compressed ? gunzipSync(rawPayload) : rawPayload;
		return payload.toString("utf8");
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
			create table if not exists workspace_change_artifact_files (
				id text primary key,
				change_set_id text not null references workspace_change_artifacts(change_set_id) on delete cascade,
				sequence integer not null,
				path text not null,
				old_path text null,
				status text not null,
				is_binary boolean not null default false,
				language text null,
				old_storage_ref text null,
				new_storage_ref text null,
				old_compressed boolean not null default false,
				new_compressed boolean not null default false,
				old_bytes integer not null default 0,
				new_bytes integer not null default 0,
				created_at timestamptz not null
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
		await this.sql`
			create index if not exists idx_workspace_change_artifact_files_change_set
			on workspace_change_artifact_files (change_set_id)
		`;
		await this.sql`
			create index if not exists idx_workspace_change_artifact_files_path_sequence
			on workspace_change_artifact_files (path, sequence)
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
