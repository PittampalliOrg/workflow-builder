import { describe, expect, it } from "vitest";
import {
	getObjectStoreConfig,
	isRunArchiveActive,
	readObjectStoreConnection,
	resolveFilesBlobBackend,
} from "./object-store-config";
import { resolveFilesBlobRuntime } from "./files-blob-backend";

const FULL_CREDS = {
	WFB_OBJECT_STORE_ENDPOINT: "http://minio:9000",
	WFB_OBJECT_STORE_ACCESS_KEY_ID: "key",
	WFB_OBJECT_STORE_SECRET_ACCESS_KEY: "secret",
};

describe("readObjectStoreConnection", () => {
	it("returns null when unconfigured", () => {
		expect(readObjectStoreConnection({})).toBeNull();
	});

	it("returns null when only partially configured", () => {
		expect(
			readObjectStoreConnection({
				WFB_OBJECT_STORE_ENDPOINT: "http://minio:9000",
				WFB_OBJECT_STORE_ACCESS_KEY_ID: "key",
			}),
		).toBeNull();
	});

	it("resolves a full connection and strips trailing slashes + defaults region", () => {
		expect(
			readObjectStoreConnection({
				...FULL_CREDS,
				WFB_OBJECT_STORE_ENDPOINT: "http://minio:9000/",
			}),
		).toEqual({
			endpoint: "http://minio:9000",
			accessKeyId: "key",
			secretAccessKey: "secret",
			region: "us-east-1",
		});
	});
});

describe("getObjectStoreConfig defaults", () => {
	it("defaults to postgres backend + off, unconfigured", () => {
		expect(getObjectStoreConfig({})).toEqual({
			connection: null,
			filesBlobBackend: "postgres",
			filesBucket: "wfb-files",
			runArchiveEnabled: false,
			runArchiveBucket: "wfb-run-archives",
		});
	});

	it("rejects an unknown files blob backend", () => {
		expect(() =>
			getObjectStoreConfig({ WFB_FILES_BLOB_BACKEND: "gcs" }),
		).toThrow(/Unsupported WFB_FILES_BLOB_BACKEND/);
	});
});

describe("resolveFilesBlobBackend degradation", () => {
	it("stays postgres when s3 requested but no connection", () => {
		const config = getObjectStoreConfig({ WFB_FILES_BLOB_BACKEND: "s3" });
		expect(resolveFilesBlobBackend(config)).toBe("postgres");
	});

	it("honors s3 only when both requested and configured", () => {
		const config = getObjectStoreConfig({
			...FULL_CREDS,
			WFB_FILES_BLOB_BACKEND: "s3",
		});
		expect(resolveFilesBlobBackend(config)).toBe("s3");
	});

	it("stays postgres when configured but backend not requested", () => {
		const config = getObjectStoreConfig(FULL_CREDS);
		expect(resolveFilesBlobBackend(config)).toBe("postgres");
	});
});

describe("isRunArchiveActive", () => {
	it("requires both the flag AND a connection", () => {
		expect(
			isRunArchiveActive(
				getObjectStoreConfig({ WFB_RUN_ARCHIVE_ENABLED: "true" }),
			),
		).toBe(false);
		expect(
			isRunArchiveActive(getObjectStoreConfig(FULL_CREDS)),
		).toBe(false);
		expect(
			isRunArchiveActive(
				getObjectStoreConfig({
					...FULL_CREDS,
					WFB_RUN_ARCHIVE_ENABLED: "true",
				}),
			),
		).toBe(true);
	});
});

describe("resolveFilesBlobRuntime", () => {
	it("returns the postgres runtime (no client) when unconfigured", () => {
		const runtime = resolveFilesBlobRuntime({ source: {} });
		expect(runtime.backend).toBe("postgres");
		expect(runtime.objectStore).toBeNull();
		expect(runtime.objectKeyForSha1("abc")).toBe("sha1/abc");
	});

	it("returns the postgres runtime when s3 requested but unconfigured", () => {
		const runtime = resolveFilesBlobRuntime({
			source: { WFB_FILES_BLOB_BACKEND: "s3" },
		});
		expect(runtime.backend).toBe("postgres");
		expect(runtime.objectStore).toBeNull();
	});

	it("builds an s3 client for the files bucket when configured", () => {
		const makeClient = (bucket: string) =>
			({ bucket }) as never;
		const runtime = resolveFilesBlobRuntime({
			source: {
				...FULL_CREDS,
				WFB_FILES_BLOB_BACKEND: "s3",
				WFB_FILES_BUCKET: "custom-files",
			},
			makeClient,
		});
		expect(runtime.backend).toBe("s3");
		expect(runtime.objectStore).toEqual({ bucket: "custom-files" });
	});
});
