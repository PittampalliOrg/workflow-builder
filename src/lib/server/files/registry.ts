import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import { files, filePayloads, type FileRow } from "$lib/server/db/schema";
import { generateId } from "$lib/server/utils/id";

function requireDb() {
	if (!db) throw new Error("Database not configured");
	return db;
}

export type FileSummary = {
	id: string;
	name: string;
	purpose: "agent" | "output";
	scopeId: string | null;
	contentType: string | null;
	sizeBytes: number;
	createdAt: string;
	archivedAt: string | null;
};

function rowToSummary(row: FileRow): FileSummary {
	return {
		id: row.id,
		name: row.name,
		purpose: row.purpose,
		scopeId: row.scopeId ?? null,
		contentType: row.contentType ?? null,
		sizeBytes: row.sizeBytes,
		createdAt: row.createdAt.toISOString(),
		archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
	};
}

/**
 * Hard cap on uploaded bytes, enforced in the handler. Agent-written outputs
 * usually fit well below this. Raising it needs a migration + TOAST review.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export type CreateFileInput = {
	userId: string;
	projectId?: string | null;
	name: string;
	purpose: "agent" | "output";
	scopeId?: string | null;
	contentType?: string | null;
	bytes: Buffer;
};

export async function createFile(input: CreateFileInput): Promise<FileSummary> {
	if (input.bytes.byteLength > MAX_UPLOAD_BYTES) {
		throw new Error(
			`file exceeds ${MAX_UPLOAD_BYTES} byte limit (${input.bytes.byteLength})`,
		);
	}
	const database = requireDb();
	const storageRef = `file_${generateId()}`;

	// Write bytes first so the metadata row is never orphaned without payload.
	// If this throws, nothing lingers; if the metadata insert fails, we'll
	// have a dangling payload — rare, and the payload gets reaped by a nightly
	// GC pass (see follow-up work).
	await database.insert(filePayloads).values({
		storageRef,
		payloadBytes: input.bytes,
	});

	const [row] = await database
		.insert(files)
		.values({
			userId: input.userId,
			projectId: input.projectId ?? null,
			name: input.name,
			purpose: input.purpose,
			scopeId: input.scopeId ?? null,
			contentType: input.contentType ?? null,
			sizeBytes: input.bytes.byteLength,
			storageRef,
		})
		.returning();
	return rowToSummary(row);
}

export type ListFilesFilter = {
	userId: string;
	purpose?: "agent" | "output";
	scopeId?: string;
	limit?: number;
	includeArchived?: boolean;
};

export async function listFiles(
	filter: ListFilesFilter,
): Promise<FileSummary[]> {
	const database = requireDb();
	const conds = [eq(files.userId, filter.userId)];
	if (filter.purpose) conds.push(eq(files.purpose, filter.purpose));
	if (filter.scopeId) conds.push(eq(files.scopeId, filter.scopeId));
	if (!filter.includeArchived) {
		conds.push(isNull(files.archivedAt) as unknown as ReturnType<typeof eq>);
	}

	const rows = await database
		.select()
		.from(files)
		.where(and(...conds))
		.orderBy(desc(files.createdAt))
		.limit(filter.limit ?? 200);
	return rows.map(rowToSummary);
}

export async function getFile(id: string): Promise<FileSummary | null> {
	const database = requireDb();
	const [row] = await database
		.select()
		.from(files)
		.where(eq(files.id, id))
		.limit(1);
	return row ? rowToSummary(row) : null;
}

export async function getFileContent(
	id: string,
): Promise<{ summary: FileSummary; bytes: Buffer } | null> {
	const database = requireDb();
	const [row] = await database
		.select()
		.from(files)
		.where(eq(files.id, id))
		.limit(1);
	if (!row) return null;
	const [payload] = await database
		.select({ bytes: filePayloads.payloadBytes })
		.from(filePayloads)
		.where(eq(filePayloads.storageRef, row.storageRef))
		.limit(1);
	if (!payload) return null;
	return { summary: rowToSummary(row), bytes: payload.bytes };
}

export async function archiveFile(
	id: string,
	userId: string,
): Promise<boolean> {
	const database = requireDb();
	const [row] = await database
		.update(files)
		.set({ archivedAt: new Date() })
		.where(and(eq(files.id, id), eq(files.userId, userId)))
		.returning({ id: files.id });
	return Boolean(row);
}

/**
 * Hard-delete a file + its payload. Used by the Files UI "Delete" action
 * when the user wants the bytes gone immediately (not just archived). No
 * FK cascades from session_resources — that's by design: a mounted file
 * reference outlives the file itself so the mount becomes a 404 rather
 * than cascading into session_resources and breaking session replay.
 */
export async function deleteFile(id: string, userId: string): Promise<boolean> {
	const database = requireDb();
	const [row] = await database
		.select({ storageRef: files.storageRef })
		.from(files)
		.where(and(eq(files.id, id), eq(files.userId, userId)))
		.limit(1);
	if (!row) return false;
	await database.delete(files).where(eq(files.id, id));
	await database
		.delete(filePayloads)
		.where(eq(filePayloads.storageRef, row.storageRef));
	return true;
}

// Silence unused imports reserved for follow-up work (scoped counts, etc.)
void sql;
