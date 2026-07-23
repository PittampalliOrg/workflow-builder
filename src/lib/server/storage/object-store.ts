import { createHash, createHmac } from "node:crypto";
import type { ObjectStoreConnection } from "./object-store-config";

/**
 * Minimal S3-compatible object-store client.
 *
 * The repo ships NO AWS SDK, and pulling `@aws-sdk/client-s3` (a large, heavily
 * transitive dependency) for four verbs — PUT / GET / HEAD / DELETE — against an
 * in-cluster MinIO would be disproportionate. We already depend on Node's
 * `crypto` and the global `fetch` (undici, used the same way by
 * `otel/clickhouse.ts`), so this is a hand-rolled AWS Signature V4 signer plus a
 * thin fetch wrapper. Path-style addressing (`<endpoint>/<bucket>/<key>`) is the
 * only mode MinIO needs; there is no bucket-in-host virtual-hosted path.
 *
 * `buildSigV4Auth` is exported and pure so the signing math is unit-testable in
 * isolation from any network I/O.
 */

export const EMPTY_PAYLOAD_SHA256 = createHash("sha256")
	.update("")
	.digest("hex");

const DEFAULT_TIMEOUT_MS = 30_000;

function sha256Hex(data: Buffer | string): string {
	return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
	return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * AWS-flavored RFC 3986 percent-encoding. Unreserved chars pass through; `/` is
 * preserved only when `encodeSlash` is false (path segments keep their
 * separators, individual segment values do not). Encodes per UTF-8 byte with
 * uppercase hex, matching the canonicalization S3 expects.
 */
export function uriEncode(input: string, encodeSlash: boolean): string {
	let out = "";
	for (const byte of Buffer.from(input, "utf8")) {
		const isUnreserved =
			(byte >= 0x41 && byte <= 0x5a) || // A-Z
			(byte >= 0x61 && byte <= 0x7a) || // a-z
			(byte >= 0x30 && byte <= 0x39) || // 0-9
			byte === 0x2d || // -
			byte === 0x2e || // .
			byte === 0x5f || // _
			byte === 0x7e; // ~
		if (isUnreserved) {
			out += String.fromCharCode(byte);
		} else if (byte === 0x2f && !encodeSlash) {
			out += "/";
		} else {
			out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
		}
	}
	return out;
}

/** Encode an object path (`/bucket/key…`) preserving `/` between segments. */
function canonicalizeUri(rawPath: string): string {
	return rawPath
		.split("/")
		.map((segment) => uriEncode(segment, true))
		.join("/");
}

export type SigV4AuthParams = {
	method: string;
	host: string;
	/** Percent-encoded absolute path, leading slash (as sent on the wire). */
	canonicalUri: string;
	canonicalQueryString?: string;
	/** Lowercased header name -> value; must include every header being signed. */
	signedHeaderValues: Record<string, string>;
	payloadHash: string;
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
	service?: string;
	/** Basic ISO timestamp `YYYYMMDDTHHMMSSZ`. */
	amzDate: string;
};

/**
 * Pure AWS Signature V4 computation. Returns the `Authorization` header value and
 * the `SignedHeaders` list. No network, no clock — every input is explicit — so
 * the signing chain is exercised deterministically by the unit tests.
 */
export function buildSigV4Auth(params: SigV4AuthParams): {
	authorization: string;
	signedHeaders: string;
} {
	const service = params.service ?? "s3";
	const dateStamp = params.amzDate.slice(0, 8);
	const credentialScope = `${dateStamp}/${params.region}/${service}/aws4_request`;

	const sortedHeaderNames = Object.keys(params.signedHeaderValues)
		.map((name) => name.toLowerCase())
		.sort();
	const canonicalHeaders = sortedHeaderNames
		.map((name) => `${name}:${params.signedHeaderValues[name].trim()}\n`)
		.join("");
	const signedHeaders = sortedHeaderNames.join(";");

	const canonicalRequest = [
		params.method,
		params.canonicalUri,
		params.canonicalQueryString ?? "",
		canonicalHeaders,
		signedHeaders,
		params.payloadHash,
	].join("\n");

	const stringToSign = [
		"AWS4-HMAC-SHA256",
		params.amzDate,
		credentialScope,
		sha256Hex(canonicalRequest),
	].join("\n");

	const kDate = hmac(`AWS4${params.secretAccessKey}`, dateStamp);
	const kRegion = hmac(kDate, params.region);
	const kService = hmac(kRegion, service);
	const kSigning = hmac(kService, "aws4_request");
	const signature = createHmac("sha256", kSigning)
		.update(stringToSign, "utf8")
		.digest("hex");

	const authorization =
		`AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${credentialScope}, ` +
		`SignedHeaders=${signedHeaders}, Signature=${signature}`;
	return { authorization, signedHeaders };
}

function amzDateNow(now: Date): string {
	return `${now.toISOString().replace(/[:-]/g, "").replace(/\.\d{3}Z$/, "")}Z`;
}

export class ObjectStoreError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "ObjectStoreError";
	}
}

export type FetchImpl = typeof fetch;

export interface ObjectStoreClient {
	readonly bucket: string;
	putObject(
		key: string,
		body: Buffer,
		opts?: { contentType?: string },
	): Promise<void>;
	/** Returns the object bytes, or `null` when the key does not exist (404). */
	getObject(key: string): Promise<Buffer | null>;
	/** Returns `{ size }`, or `null` when the key does not exist (404). */
	headObject(key: string): Promise<{ size: number } | null>;
	/** Idempotent: a missing object is treated as already deleted. */
	deleteObject(key: string): Promise<void>;
}

export type ObjectStoreClientOptions = {
	fetchImpl?: FetchImpl;
	timeoutMs?: number;
	now?: () => Date;
};

/**
 * Build a bucket-scoped client. `connection` comes from
 * `readObjectStoreConnection`; callers create one client per bucket (files vs
 * run-archives). `fetchImpl`/`now` are injectable so the transport is mockable.
 */
export function createObjectStoreClient(
	connection: ObjectStoreConnection,
	bucket: string,
	options: ObjectStoreClientOptions = {},
): ObjectStoreClient {
	const doFetch = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const clock = options.now ?? (() => new Date());

	async function send(
		method: string,
		key: string,
		body: Buffer | null,
		extraHeaders: Record<string, string> = {},
	): Promise<Response> {
		const url = new URL(connection.endpoint);
		const rawPath = `/${bucket}/${key}`;
		const canonicalUri = canonicalizeUri(rawPath);
		url.pathname = canonicalUri;

		const amzDate = amzDateNow(clock());
		const payloadHash = body ? sha256Hex(body) : EMPTY_PAYLOAD_SHA256;
		const signedHeaderValues: Record<string, string> = {
			host: url.host,
			"x-amz-content-sha256": payloadHash,
			"x-amz-date": amzDate,
		};
		const { authorization } = buildSigV4Auth({
			method,
			host: url.host,
			canonicalUri,
			signedHeaderValues,
			payloadHash,
			accessKeyId: connection.accessKeyId,
			secretAccessKey: connection.secretAccessKey,
			region: connection.region,
			amzDate,
		});

		return doFetch(url.toString(), {
			method,
			headers: {
				Authorization: authorization,
				"x-amz-content-sha256": payloadHash,
				"x-amz-date": amzDate,
				...extraHeaders,
			},
			// A Node Buffer is a valid undici BodyInit at runtime; the DOM `fetch`
			// lib types don't model that, so cast rather than copy the bytes.
			body: (body ?? undefined) as BodyInit | undefined,
			signal: AbortSignal.timeout(timeoutMs),
		});
	}

	async function bodySnippet(res: Response): Promise<string> {
		return (await res.text().catch(() => "")).slice(0, 300);
	}

	return {
		bucket,
		async putObject(key, body, opts) {
			const res = await send("PUT", key, body, {
				"Content-Type": opts?.contentType ?? "application/octet-stream",
			});
			if (!res.ok) {
				throw new ObjectStoreError(
					`PUT ${bucket}/${key} failed: ${res.status} ${await bodySnippet(res)}`,
					res.status,
				);
			}
		},
		async getObject(key) {
			const res = await send("GET", key, null);
			if (res.status === 404) return null;
			if (!res.ok) {
				throw new ObjectStoreError(
					`GET ${bucket}/${key} failed: ${res.status} ${await bodySnippet(res)}`,
					res.status,
				);
			}
			return Buffer.from(await res.arrayBuffer());
		},
		async headObject(key) {
			const res = await send("HEAD", key, null);
			if (res.status === 404) return null;
			if (!res.ok) {
				throw new ObjectStoreError(
					`HEAD ${bucket}/${key} failed: ${res.status}`,
					res.status,
				);
			}
			const len = Number(res.headers.get("content-length") ?? "0");
			return { size: Number.isFinite(len) ? len : 0 };
		},
		async deleteObject(key) {
			const res = await send("DELETE", key, null);
			// 204/200 = deleted; 404 = already gone. Both are success.
			if (res.ok || res.status === 404) return;
			throw new ObjectStoreError(
				`DELETE ${bucket}/${key} failed: ${res.status} ${await bodySnippet(res)}`,
				res.status,
			);
		},
	};
}
