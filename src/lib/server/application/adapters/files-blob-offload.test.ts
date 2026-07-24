import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { PostgresWorkflowFileStore } from "$lib/server/application/adapters/postgres";
import type { FilesBlobRuntime } from "$lib/server/storage/files-blob-backend";
import type { ObjectStoreClient } from "$lib/server/storage/object-store";

/** In-memory object store standing in for MinIO. */
function fakeObjectStore(): ObjectStoreClient & { store: Map<string, Buffer> } {
	const store = new Map<string, Buffer>();
	return {
		store,
		bucket: "wfb-files",
		async putObject(key, body) {
			store.set(key, Buffer.from(body));
		},
		async getObject(key) {
			return store.has(key) ? Buffer.from(store.get(key)!) : null;
		},
		async headObject(key) {
			return store.has(key) ? { size: store.get(key)!.byteLength } : null;
		},
		async deleteObject(key) {
			store.delete(key);
		},
	};
}

async function createSchema(client: PGlite) {
	await client.exec(`
		CREATE TABLE files (
			id text PRIMARY KEY,
			user_id text NOT NULL,
			project_id text,
			name text NOT NULL,
			purpose text NOT NULL,
			scope_id text,
			content_type text,
			size_bytes integer NOT NULL DEFAULT 0,
			storage_ref text NOT NULL,
			storage_backend text,
			object_key text,
			sha1 text,
			created_at timestamp NOT NULL DEFAULT now(),
			archived_at timestamp
		);
		CREATE TABLE file_payloads (
			storage_ref text PRIMARY KEY,
			payload_bytes bytea NOT NULL,
			created_at timestamp NOT NULL DEFAULT now()
		);
	`);
}

describe("PostgresWorkflowFileStore blob offload (s3 backend)", () => {
	let client: PGlite;
	let objectStore: ReturnType<typeof fakeObjectStore>;
	let store: PostgresWorkflowFileStore;

	beforeEach(async () => {
		client = new PGlite();
		await createSchema(client);
		objectStore = fakeObjectStore();
		const blob: FilesBlobRuntime = {
			backend: "s3",
			objectStore,
			objectKeyForSha1: (sha1) => `sha1/${sha1}`,
		};
		store = new PostgresWorkflowFileStore(drizzle(client) as never, blob);
	});

	it("writes bytes to the object store (not file_payloads) with a storage marker", async () => {
		const { file } = await store.createFile({
			userId: "u1",
			name: "out.txt",
			purpose: "output",
			scopeId: "scope-1",
			bytes: Buffer.from("hello"),
		});

		const rows = await client.query<{
			storage_backend: string | null;
			object_key: string | null;
			sha1: string;
		}>(`SELECT storage_backend, object_key, sha1 FROM files WHERE id = $1`, [
			file.id,
		]);
		expect(rows.rows[0].storage_backend).toBe("s3");
		expect(rows.rows[0].object_key).toBe(`sha1/${rows.rows[0].sha1}`);
		expect(objectStore.store.has(rows.rows[0].object_key!)).toBe(true);

		const payloadRows = await client.query(`SELECT * FROM file_payloads`);
		expect(payloadRows.rows).toHaveLength(0);
	});

	it("reads bytes back from the object store", async () => {
		const { file } = await store.createFile({
			userId: "u1",
			name: "out.txt",
			purpose: "output",
			scopeId: "scope-1",
			bytes: Buffer.from("roundtrip"),
		});
		const content = await store.getFileContent(file.id);
		expect(content?.bytes.toString("utf8")).toBe("roundtrip");
	});

	it("deduplicates identical bytes to a single object across file rows", async () => {
		const first = await store.createFile({
			userId: "u1",
			name: "a.txt",
			purpose: "output",
			scopeId: "scope-1",
			bytes: Buffer.from("same-bytes"),
		});
		// Different name/scope → a NEW file row, but the same content-addressed key.
		const second = await store.createFile({
			userId: "u1",
			name: "b.txt",
			purpose: "output",
			scopeId: "scope-2",
			bytes: Buffer.from("same-bytes"),
		});
		expect(first.file.id).not.toBe(second.file.id);
		expect(objectStore.store.size).toBe(1);
	});

	it("only reclaims the object when the LAST referencing row is deleted", async () => {
		const a = await store.createFile({
			userId: "u1",
			name: "a.txt",
			purpose: "output",
			scopeId: "scope-1",
			bytes: Buffer.from("shared"),
		});
		const b = await store.createFile({
			userId: "u1",
			name: "b.txt",
			purpose: "output",
			scopeId: "scope-2",
			bytes: Buffer.from("shared"),
		});
		expect(objectStore.store.size).toBe(1);

		await store.deleteFile({ id: a.file.id, userId: "u1" });
		// Object retained — b.txt still references it.
		expect(objectStore.store.size).toBe(1);

		await store.deleteFile({ id: b.file.id, userId: "u1" });
		// Last reference gone — object reclaimed.
		expect(objectStore.store.size).toBe(0);
	});
});

describe("PostgresWorkflowFileStore blob offload (postgres backend, default)", () => {
	let client: PGlite;
	let store: PostgresWorkflowFileStore;

	beforeEach(async () => {
		client = new PGlite();
		await createSchema(client);
		const blob: FilesBlobRuntime = {
			backend: "postgres",
			objectStore: null,
			objectKeyForSha1: (sha1) => `sha1/${sha1}`,
		};
		store = new PostgresWorkflowFileStore(drizzle(client) as never, blob);
	});

	it("stores bytes in file_payloads and reads them back (unchanged behavior)", async () => {
		const { file } = await store.createFile({
			userId: "u1",
			name: "out.txt",
			purpose: "output",
			scopeId: "scope-1",
			bytes: Buffer.from("pg-bytes"),
		});
		const payloadRows = await client.query(`SELECT * FROM file_payloads`);
		expect(payloadRows.rows).toHaveLength(1);

		const content = await store.getFileContent(file.id);
		// pglite returns bytea as Uint8Array; production postgres-js returns Buffer.
		expect(Buffer.from(content!.bytes).toString("utf8")).toBe("pg-bytes");

		await store.deleteFile({ id: file.id, userId: "u1" });
		const after = await client.query(`SELECT * FROM file_payloads`);
		expect(after.rows).toHaveLength(0);
	});
});
