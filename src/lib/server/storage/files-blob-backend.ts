import { createObjectStoreClient, type ObjectStoreClient } from "./object-store";
import {
	getObjectStoreConfig,
	resolveFilesBlobBackend,
	type FilesBlobBackend,
} from "./object-store-config";

/**
 * Runtime binding for the Files API blob backend (durability phase 4).
 *
 * `backend` is the EFFECTIVE choice after degradation — `s3` only when both
 * `WFB_FILES_BLOB_BACKEND=s3` AND the object store is configured; otherwise
 * `postgres` (bytes in `file_payloads`, the original behavior). `objectStore` is
 * a bucket-scoped client (files bucket) present only on the `s3` path.
 */
export type FilesBlobRuntime = {
	backend: FilesBlobBackend;
	objectStore: ObjectStoreClient | null;
	/** Content-addressed object key for a payload sha1 (dedup collapses to one). */
	objectKeyForSha1(sha1: string): string;
};

const POSTGRES_RUNTIME: FilesBlobRuntime = {
	backend: "postgres",
	objectStore: null,
	objectKeyForSha1: (sha1) => `sha1/${sha1}`,
};

/**
 * Build the blob runtime from configuration. Pure of side effects beyond
 * constructing the client; safe to call once per store instance. Env/source and
 * the object-store client factory are injectable for tests.
 */
export function resolveFilesBlobRuntime(
	options: {
		source?: Record<string, string | undefined>;
		makeClient?: (bucket: string) => ObjectStoreClient;
	} = {},
): FilesBlobRuntime {
	const config = getObjectStoreConfig(options.source);
	if (resolveFilesBlobBackend(config) !== "s3" || !config.connection) {
		return POSTGRES_RUNTIME;
	}
	const connection = config.connection;
	const client = options.makeClient
		? options.makeClient(config.filesBucket)
		: createObjectStoreClient(connection, config.filesBucket);
	return {
		backend: "s3",
		objectStore: client,
		objectKeyForSha1: (sha1) => `sha1/${sha1}`,
	};
}
