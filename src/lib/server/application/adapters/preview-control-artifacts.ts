import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { env } from "$env/dynamic/private";
import type {
  PreviewAcceptanceArtifactPort,
  PreviewArtifactExportPort,
  PreviewArtifactTransferEnvelope,
  PreviewArtifactTransferPort,
  PreviewControlArtifactRecord,
  PreviewControlArtifactStorePort,
  PreviewImportedArtifactIdentity,
  PreviewImportedArtifactLookup,
  WorkflowArtifactRecord,
  WorkflowFileRecord,
} from "$lib/server/application/ports";
import { parseStrictPreviewCapture } from "$lib/server/application/preview-acceptance-trust";
import { db as defaultDb } from "$lib/server/db";
import { previewControlArtifacts } from "$lib/server/db/schema";
import {
  localPreviewControlCapability,
  localPreviewControlIdentity,
  type PreviewControlIdentity,
} from "$lib/server/preview-control-capability";

type Database = typeof defaultDb;
type WorkflowFiles = Readonly<{
  createWorkflowFile(input: {
    userId: string;
    name: string;
    purpose: "output";
    scopeId: string;
    contentType: string;
    bytes: Buffer;
  }): Promise<{ file: WorkflowFileRecord; deduplicated: boolean }>;
  getWorkflowFileContent(
    id: string,
  ): Promise<{ summary: WorkflowFileRecord; bytes: Buffer } | null>;
  deleteWorkflowFile(input: { id: string; userId: string }): Promise<boolean>;
}>;

type LocalWorkflowData = WorkflowFiles &
  Readonly<{
    getWorkflowArtifactForExecution(input: {
      executionId: string;
      artifactId: string;
    }): Promise<WorkflowArtifactRecord | null>;
  }>;

export class WorkflowDataPreviewArtifactExportAdapter implements PreviewArtifactExportPort {
  constructor(private readonly workflowData: () => LocalWorkflowData) {}

  async load(input: { executionId: string; artifactId: string }) {
    const artifact =
      await this.workflowData().getWorkflowArtifactForExecution(input);
    if (!artifact?.fileId) return null;
    const file = await this.workflowData().getWorkflowFileContent(
      artifact.fileId,
    );
    if (!file) return null;
    return {
      artifact: {
        id: artifact.id,
        executionId: artifact.workflowExecutionId,
        kind: artifact.kind,
        fileId: artifact.fileId,
        inlinePayload: artifact.inlinePayload,
        metadata: artifact.metadata,
      },
      bytes: file.bytes,
      fileDigest:
        `sha256:${createHash("sha256").update(file.bytes).digest("hex")}` as const,
    };
  }
}

/** Physical durable store; every read is scoped before object bytes are touched. */
export class PostgresPreviewControlArtifactStore implements PreviewControlArtifactStorePort {
  constructor(
    private readonly files: () => WorkflowFiles,
    private readonly database: Database = defaultDb,
  ) {}

  async put(input: Parameters<PreviewControlArtifactStorePort["put"]>[0]) {
    const importIdentity = importedArtifactIdentity(input);
    const artifactSnapshot = immutableArtifactSnapshot(input.envelope.artifact);
    const id = contentAddressedArtifactId(importIdentity, artifactSnapshot);
    const existing = await this.getBySourceIdentity({
      previewName: importIdentity.previewName,
      requestId: importIdentity.requestId,
      executionId: importIdentity.executionId,
      sourceArtifactId: importIdentity.sourceArtifactId,
    });
    if (existing) {
      if (sameImportedArtifact(existing, input, id)) return existing;
      throw new Error(
        "immutable preview artifact source identity was replayed with different content",
      );
    }

    const workflowFiles = this.files();
    const created = await workflowFiles.createWorkflowFile({
      userId: input.ownerId,
      name: `${id}.json.gz`,
      purpose: "output",
      scopeId: `preview-control:${importIdentity.previewName}:${importIdentity.requestId}`,
      contentType: "application/gzip",
      bytes: input.bytes,
    });
    let metadataInserted = false;
    let compensated = false;
    const compensate = async () => {
      if (metadataInserted || created.deduplicated || compensated) return;
      compensated = true;
      await workflowFiles.deleteWorkflowFile({
        id: created.file.id,
        userId: input.ownerId,
      });
    };

    try {
      const inserted = await this.database
        .insert(previewControlArtifacts)
        .values({
          id,
          previewName: importIdentity.previewName,
          environmentRequestId: importIdentity.requestId,
          executionId: importIdentity.executionId,
          sourceArtifactId: importIdentity.sourceArtifactId,
          fileId: created.file.id,
          fileDigest: importIdentity.fileDigest,
          artifactSnapshot,
          platformRevision: importIdentity.platformRevision,
          sourceRevision: importIdentity.sourceRevision,
          catalogDigest: importIdentity.catalogDigest,
          services: [...importIdentity.services],
          captureId: importIdentity.captureId,
          generation: importIdentity.generation,
        })
        .onConflictDoNothing()
        .returning({ id: previewControlArtifacts.id });
      metadataInserted = inserted.length === 1;
      const record = metadataInserted
        ? await this.get({ artifactId: id, identity: importIdentity })
        : await this.getBySourceIdentity({
            previewName: importIdentity.previewName,
            requestId: importIdentity.requestId,
            executionId: importIdentity.executionId,
            sourceArtifactId: importIdentity.sourceArtifactId,
          });
      if (!metadataInserted) await compensate();
      if (!record || !sameImportedArtifact(record, input, id)) {
        throw new Error("content-addressed preview artifact collision");
      }
      return record;
    } catch (cause) {
      await compensate();
      throw cause;
    }
  }

  async get(input: PreviewImportedArtifactLookup) {
    const [row] = await this.database
      .select()
      .from(previewControlArtifacts)
      .where(
        and(
          eq(previewControlArtifacts.id, input.artifactId),
          eq(previewControlArtifacts.previewName, input.identity.previewName),
          eq(
            previewControlArtifacts.environmentRequestId,
            input.identity.requestId,
          ),
          eq(previewControlArtifacts.executionId, input.identity.executionId),
          eq(
            previewControlArtifacts.sourceArtifactId,
            input.identity.sourceArtifactId,
          ),
          eq(
            previewControlArtifacts.platformRevision,
            input.identity.platformRevision,
          ),
          eq(
            previewControlArtifacts.sourceRevision,
            input.identity.sourceRevision,
          ),
          eq(
            previewControlArtifacts.catalogDigest,
            input.identity.catalogDigest,
          ),
          eq(
            previewControlArtifacts.services,
            canonicalServices(input.identity.services),
          ),
          eq(previewControlArtifacts.captureId, input.identity.captureId),
          eq(previewControlArtifacts.generation, input.identity.generation),
          eq(previewControlArtifacts.fileDigest, input.identity.fileDigest),
        ),
      )
      .limit(1);
    if (!row) return null;
    const record = mapPreviewControlArtifact(row);
    return sameArtifactLookup(record, input) ? record : null;
  }

  private async getBySourceIdentity(input: {
    previewName: string;
    requestId: string;
    executionId: string;
    sourceArtifactId: string;
  }) {
    const [row] = await this.database
      .select()
      .from(previewControlArtifacts)
      .where(
        and(
          eq(previewControlArtifacts.previewName, input.previewName),
          eq(previewControlArtifacts.environmentRequestId, input.requestId),
          eq(previewControlArtifacts.executionId, input.executionId),
          eq(previewControlArtifacts.sourceArtifactId, input.sourceArtifactId),
        ),
      )
      .limit(1);
    return row ? mapPreviewControlArtifact(row) : null;
  }

  async fileDigest(
    input: PreviewImportedArtifactLookup & Readonly<{ fileId: string }>,
  ): Promise<`sha256:${string}` | null> {
    const record = await this.get(input);
    if (!record || record.fileId !== input.fileId) return null;
    const file = await this.files().getWorkflowFileContent(input.fileId);
    if (!file) return null;
    return `sha256:${createHash("sha256").update(file.bytes).digest("hex")}`;
  }
}

function mapPreviewControlArtifact(
  row: typeof previewControlArtifacts.$inferSelect,
): PreviewControlArtifactRecord {
  const importIdentity = Object.freeze({
    previewName: row.previewName,
    requestId: row.environmentRequestId,
    executionId: row.executionId,
    sourceArtifactId: row.sourceArtifactId,
    platformRevision: row.platformRevision,
    sourceRevision: row.sourceRevision,
    catalogDigest: row.catalogDigest as `sha256:${string}`,
    services: Object.freeze(canonicalServices(row.services as string[])),
    captureId: row.captureId,
    generation: row.generation,
    fileDigest: row.fileDigest as `sha256:${string}`,
  }) satisfies PreviewImportedArtifactIdentity;
  return {
    id: row.id,
    fileId: row.fileId,
    fileDigest: row.fileDigest as `sha256:${string}`,
    artifact: row.artifactSnapshot as never,
    importIdentity,
  };
}

function importedArtifactIdentity(
  input: Parameters<PreviewControlArtifactStorePort["put"]>[0],
): PreviewImportedArtifactIdentity {
  return Object.freeze({
    previewName: input.envelope.identity.previewName,
    requestId: input.envelope.identity.environmentRequestId,
    executionId: input.envelope.executionId,
    sourceArtifactId: input.envelope.artifactId,
    platformRevision: input.envelope.identity.environmentPlatformRevision,
    sourceRevision: input.envelope.identity.environmentSourceRevision,
    catalogDigest: input.envelope.identity.catalogDigest,
    services: Object.freeze(canonicalServices(input.services)),
    captureId: input.captureId,
    generation: input.generation,
    fileDigest: input.envelope.fileDigest,
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const MUTABLE_ARTIFACT_METADATA_KEYS = new Set([
  "promotion",
  "acceptance",
  "teardownCheckpoint",
]);

/**
 * Promotion, acceptance, and teardown metadata are mutable local projections
 * over one immutable capture. They must not change the physical artifact's
 * content identity; every source and bundle field remains part of that identity.
 */
function immutableArtifactSnapshot(
  artifact: PreviewArtifactTransferEnvelope["artifact"],
): PreviewArtifactTransferEnvelope["artifact"] {
  const metadataEntries = Object.entries(artifact.metadata ?? {}).filter(
    ([key]) => !MUTABLE_ARTIFACT_METADATA_KEYS.has(key),
  );
  return {
    ...artifact,
    metadata:
      metadataEntries.length > 0 ? Object.fromEntries(metadataEntries) : null,
  };
}

function contentAddressedArtifactId(
  importIdentity: PreviewImportedArtifactIdentity,
  artifact: PreviewArtifactTransferEnvelope["artifact"],
): string {
  const canonical = stableJson({ importIdentity, artifact });
  return `pca_${createHash("sha256").update(canonical).digest("hex")}`;
}

function sameImportedIdentity(
  left: PreviewImportedArtifactIdentity,
  right: PreviewImportedArtifactIdentity,
): boolean {
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    !Array.isArray(left.services) ||
    !Array.isArray(right.services)
  ) {
    return false;
  }
  return (
    stableJson({ ...left, services: canonicalServices(left.services) }) ===
    stableJson({ ...right, services: canonicalServices(right.services) })
  );
}

function sameImportedArtifact(
  record: PreviewControlArtifactRecord,
  input: Parameters<PreviewControlArtifactStorePort["put"]>[0],
  expectedId: string,
): boolean {
  const recordSnapshot = immutableArtifactSnapshot(record.artifact);
  const inputSnapshot = immutableArtifactSnapshot(input.envelope.artifact);
  const legacyRecordId = contentAddressedArtifactId(
    record.importIdentity,
    record.artifact,
  );
  return (
    (record.id === expectedId || record.id === legacyRecordId) &&
    sameImportedIdentity(
      record.importIdentity,
      importedArtifactIdentity(input),
    ) &&
    stableJson(recordSnapshot) === stableJson(inputSnapshot)
  );
}

function sameArtifactLookup(
  record: PreviewControlArtifactRecord,
  lookup: PreviewImportedArtifactLookup,
): boolean {
  return (
    record.id === lookup.artifactId &&
    sameImportedIdentity(record.importIdentity, lookup.identity)
  );
}

function canonicalServices(services: readonly string[]): string[] {
  return [...services].sort();
}

export class PreviewControlAcceptanceArtifactAdapter implements PreviewAcceptanceArtifactPort {
  constructor(private readonly store: PreviewControlArtifactStorePort) {}

  async get(input: PreviewImportedArtifactLookup) {
    const record = await this.store.get(input);
    if (!record) return null;
    return {
      ...record.artifact,
      id: record.id,
      executionId: record.importIdentity.executionId,
      fileId: record.fileId,
      importIdentity: record.importIdentity,
    };
  }

  fileDigest(
    input: PreviewImportedArtifactLookup & Readonly<{ fileId: string }>,
  ) {
    return this.store.fileDigest(input);
  }
}

export type HttpPreviewArtifactTransferOptions = Readonly<{
  baseUrl?: () => string | null;
  token?: () => string;
  identity?: (expectedName?: string) => PreviewControlIdentity;
  fetch?: typeof globalThis.fetch;
  maxBytes?: number;
}>;

/** Preview-local transfer: bytes leave isolated CNPG only through this capability. */
export class HttpPreviewArtifactTransferAdapter implements PreviewArtifactTransferPort {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(
    private readonly source: PreviewArtifactExportPort,
    private readonly options: HttpPreviewArtifactTransferOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async transfer(
    input: Parameters<PreviewArtifactTransferPort["transfer"]>[0],
  ) {
    const identity = (this.options.identity ?? localPreviewControlIdentity)(
      input.identity.previewName,
    );
    if (JSON.stringify(identity) !== JSON.stringify(input.identity)) {
      throw new Error("artifact transfer identity is not local and current");
    }
    const loaded = await this.source.load(input);
    if (!loaded)
      throw new Error("strict source artifact was not found locally");
    const capture = parseStrictPreviewCapture(loaded.artifact);
    if (!capture)
      throw new Error("strict source artifact is not an atomic capture");
    if (loaded.bytes.byteLength > (this.options.maxBytes ?? 25 * 1024 * 1024)) {
      throw new Error("strict source artifact exceeds transfer limit");
    }
    const envelope = {
      identity,
      executionId: input.executionId,
      artifactId: input.artifactId,
      fileDigest: loaded.fileDigest,
      artifact: loaded.artifact,
    };
    const baseUrl = (
      this.options.baseUrl?.() ??
      env.PREVIEW_CONTROL_BROKER_URL ??
      process.env.PREVIEW_CONTROL_BROKER_URL ??
      ""
    )
      .trim()
      .replace(/\/+$/, "");
    if (!baseUrl)
      throw new Error("PREVIEW_CONTROL_BROKER_URL is not configured");
    const token = this.options.token?.() ?? localPreviewControlCapability();
    const response = await this.fetchImpl(
      `${baseUrl}/api/internal/preview-control/artifacts`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(loaded.bytes.byteLength),
          "X-Content-SHA256": loaded.fileDigest,
          "X-Preview-Control-Capability": token,
          "X-Preview-Artifact-Envelope": Buffer.from(
            JSON.stringify(envelope),
          ).toString("base64url"),
        },
        body: new Uint8Array(loaded.bytes),
        signal: AbortSignal.timeout(120_000),
      },
    );
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const expectedImportIdentity: PreviewImportedArtifactIdentity =
      Object.freeze({
        previewName: identity.previewName,
        requestId: identity.environmentRequestId,
        executionId: input.executionId,
        sourceArtifactId: input.artifactId,
        platformRevision: identity.environmentPlatformRevision,
        sourceRevision: identity.environmentSourceRevision,
        catalogDigest: identity.catalogDigest,
        services: Object.freeze(canonicalServices(capture.services)),
        captureId: capture.captureId,
        generation: capture.generation,
        fileDigest: loaded.fileDigest,
      });
    if (
      !response.ok ||
      typeof body.id !== "string" ||
      typeof body.fileId !== "string" ||
      body.fileDigest !== loaded.fileDigest ||
      !body.importIdentity ||
      !sameImportedIdentity(
        body.importIdentity as PreviewImportedArtifactIdentity,
        expectedImportIdentity,
      )
    ) {
      throw new Error(
        typeof body.error === "string"
          ? body.error
          : `preview artifact transfer failed (HTTP ${response.status})`,
      );
    }
    return {
      id: body.id,
      fileId: body.fileId,
      fileDigest: loaded.fileDigest,
      artifact: loaded.artifact,
      importIdentity: expectedImportIdentity,
    };
  }
}
