import { env } from "$env/dynamic/private";

/**
 * Object-store (S3-compatible / in-cluster MinIO) configuration for durability
 * phase 4 — blob offload behind the Files API + archive-on-terminal run bundles.
 *
 * EVERYTHING here defaults OFF: with no `WFB_OBJECT_STORE_*` env the connection
 * resolves to `null`, the files backend stays `postgres`, and run-archiving is
 * disabled — byte-identical to pre-phase-4 behavior. The infra (MinIO endpoint +
 * buckets + BFF credentials) is wired on the stacks side and only turns these on
 * once present, so an unconfigured deployment degrades gracefully rather than
 * erroring.
 */

export const FILES_BLOB_BACKENDS = ["postgres", "s3"] as const;
export type FilesBlobBackend = (typeof FILES_BLOB_BACKENDS)[number];

const DEFAULT_REGION = "us-east-1";
export const DEFAULT_FILES_BUCKET = "wfb-files";
export const DEFAULT_RUN_ARCHIVE_BUCKET = "wfb-run-archives";

/** Fully-resolved connection to the object store. `null` when not configured. */
export type ObjectStoreConnection = {
	endpoint: string;
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
};

export type ObjectStoreConfig = {
	/** Present only when endpoint + access key + secret are ALL set. */
	connection: ObjectStoreConnection | null;
	/** Requested files blob backend (before degradation). */
	filesBlobBackend: FilesBlobBackend;
	filesBucket: string;
	runArchiveEnabled: boolean;
	runArchiveBucket: string;
};

type EnvSource = Record<string, string | undefined>;

function read(source: EnvSource, key: string): string {
	return (source[key] ?? "").trim();
}

function readFlag(source: EnvSource, key: string, fallback = false): boolean {
	const raw = read(source, key).toLowerCase();
	if (!raw) return fallback;
	return ["1", "true", "yes", "on"].includes(raw);
}

/**
 * Resolve the object-store connection, or `null` when any of the three required
 * credentials is missing. A partially-configured store is treated as unconfigured
 * — we never sign a request with a blank key.
 */
export function readObjectStoreConnection(
	source: EnvSource = env,
): ObjectStoreConnection | null {
	const endpoint = read(source, "WFB_OBJECT_STORE_ENDPOINT").replace(/\/+$/, "");
	const accessKeyId = read(source, "WFB_OBJECT_STORE_ACCESS_KEY_ID");
	const secretAccessKey = read(source, "WFB_OBJECT_STORE_SECRET_ACCESS_KEY");
	if (!endpoint || !accessKeyId || !secretAccessKey) return null;
	return {
		endpoint,
		accessKeyId,
		secretAccessKey,
		region: read(source, "WFB_OBJECT_STORE_REGION") || DEFAULT_REGION,
	};
}

function readFilesBlobBackend(source: EnvSource): FilesBlobBackend {
	const raw = read(source, "WFB_FILES_BLOB_BACKEND").toLowerCase();
	if (!raw) return "postgres";
	if ((FILES_BLOB_BACKENDS as readonly string[]).includes(raw)) {
		return raw as FilesBlobBackend;
	}
	throw new Error(
		`Unsupported WFB_FILES_BLOB_BACKEND='${raw}'. Supported values: ${FILES_BLOB_BACKENDS.join(", ")}`,
	);
}

export function getObjectStoreConfig(
	source: EnvSource = env,
): ObjectStoreConfig {
	return {
		connection: readObjectStoreConnection(source),
		filesBlobBackend: readFilesBlobBackend(source),
		filesBucket: read(source, "WFB_FILES_BUCKET") || DEFAULT_FILES_BUCKET,
		runArchiveEnabled: readFlag(source, "WFB_RUN_ARCHIVE_ENABLED"),
		runArchiveBucket:
			read(source, "WFB_RUN_ARCHIVE_BUCKET") || DEFAULT_RUN_ARCHIVE_BUCKET,
	};
}

/**
 * The EFFECTIVE files blob backend. `s3` is honored only when a connection is
 * actually configured — a requested `s3` with no credentials degrades to
 * `postgres` so the Files API keeps working (writes land in `file_payloads`).
 */
export function resolveFilesBlobBackend(config: ObjectStoreConfig): FilesBlobBackend {
	if (config.filesBlobBackend === "s3" && config.connection) return "s3";
	return "postgres";
}

/** True when run-archiving should actually run (enabled AND store configured). */
export function isRunArchiveActive(config: ObjectStoreConfig): boolean {
	return config.runArchiveEnabled && config.connection !== null;
}
