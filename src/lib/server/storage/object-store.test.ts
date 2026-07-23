import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	buildSigV4Auth,
	createObjectStoreClient,
	EMPTY_PAYLOAD_SHA256,
	ObjectStoreError,
	uriEncode,
} from "./object-store";
import type { ObjectStoreConnection } from "./object-store-config";

const CONNECTION: ObjectStoreConnection = {
	endpoint: "http://minio.workflow-builder.svc.cluster.local:9000",
	accessKeyId: "test-access",
	secretAccessKey: "test-secret",
	region: "us-east-1",
};

describe("uriEncode", () => {
	it("preserves unreserved characters and slashes when asked", () => {
		expect(uriEncode("sha1/abcDEF-._~", false)).toBe("sha1/abcDEF-._~");
	});

	it("encodes slashes for a single path segment", () => {
		expect(uriEncode("sha1/abc", true)).toBe("sha1%2Fabc");
	});

	it("percent-encodes reserved bytes with uppercase hex", () => {
		expect(uriEncode("a b+c", false)).toBe("a%20b%2Bc");
	});
});

describe("buildSigV4Auth", () => {
	it("computes the AWS S3 'GET Object' documented example signature", () => {
		// AWS docs: Authenticating Requests (AWS Signature Version 4) — Example GET.
		// Anchors the full signing chain (key derivation + canonical assembly) to a
		// published ground-truth vector.
		const { authorization, signedHeaders } = buildSigV4Auth({
			method: "GET",
			host: "examplebucket.s3.amazonaws.com",
			canonicalUri: "/test.txt",
			signedHeaderValues: {
				host: "examplebucket.s3.amazonaws.com",
				range: "bytes=0-9",
				"x-amz-content-sha256": EMPTY_PAYLOAD_SHA256,
				"x-amz-date": "20130524T000000Z",
			},
			payloadHash: EMPTY_PAYLOAD_SHA256,
			accessKeyId: "AKIAIOSFODNN7EXAMPLE",
			secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
			region: "us-east-1",
			amzDate: "20130524T000000Z",
		});
		expect(signedHeaders).toBe("host;range;x-amz-content-sha256;x-amz-date");
		expect(authorization).toBe(
			"AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
				"SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
				"Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
		);
	});

	it("exposes the well-known empty-payload SHA-256 constant", () => {
		expect(EMPTY_PAYLOAD_SHA256).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});
});

function jsonlessResponse(
	status: number,
	body?: string | Buffer | null,
	headers?: HeadersInit,
) {
	return new Response((body ?? undefined) as BodyInit | undefined, {
		status,
		headers,
	});
}

describe("createObjectStoreClient", () => {
	const fixedNow = () => new Date("2026-07-23T00:00:00.000Z");

	it("PUTs to the content-addressed path-style key with a signed body hash", async () => {
		const bytes = Buffer.from("hello world");
		const fetchImpl = vi.fn(async () => jsonlessResponse(200));
		const client = createObjectStoreClient(CONNECTION, "wfb-files", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			now: fixedNow,
		});

		await client.putObject("sha1/2aae6c35c94fcfb415dbe95f408b9ce91ee846ed", bytes, {
			contentType: "text/plain",
		});

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe(
			"http://minio.workflow-builder.svc.cluster.local:9000/wfb-files/sha1/2aae6c35c94fcfb415dbe95f408b9ce91ee846ed",
		);
		expect(init.method).toBe("PUT");
		expect(init.body).toBe(bytes);
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=test-access\//);
		expect(headers["x-amz-content-sha256"]).toBe(
			createHash("sha256").update(bytes).digest("hex"),
		);
		expect(headers["Content-Type"]).toBe("text/plain");
	});

	it("GET returns bytes on 200 and null on 404", async () => {
		const payload = Buffer.from("archived-bundle");
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonlessResponse(200, payload))
			.mockResolvedValueOnce(jsonlessResponse(404));
		const client = createObjectStoreClient(CONNECTION, "wfb-files", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			now: fixedNow,
		});

		const found = await client.getObject("sha1/aaa");
		expect(found?.toString("utf8")).toBe("archived-bundle");
		expect(await client.getObject("sha1/missing")).toBeNull();
	});

	it("GET throws ObjectStoreError on a non-404 failure", async () => {
		const fetchImpl = vi.fn(async () => jsonlessResponse(500, "boom"));
		const client = createObjectStoreClient(CONNECTION, "wfb-files", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			now: fixedNow,
		});
		await expect(client.getObject("sha1/x")).rejects.toBeInstanceOf(
			ObjectStoreError,
		);
	});

	it("HEAD returns size on 200 and null on 404", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				jsonlessResponse(200, null, { "content-length": "1234" }),
			)
			.mockResolvedValueOnce(jsonlessResponse(404));
		const client = createObjectStoreClient(CONNECTION, "wfb-files", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			now: fixedNow,
		});
		expect(await client.headObject("sha1/a")).toEqual({ size: 1234 });
		expect(await client.headObject("sha1/b")).toBeNull();
	});

	it("DELETE treats 204 and 404 as success but throws on 500", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonlessResponse(204))
			.mockResolvedValueOnce(jsonlessResponse(404))
			.mockResolvedValueOnce(jsonlessResponse(500, "err"));
		const client = createObjectStoreClient(CONNECTION, "wfb-files", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			now: fixedNow,
		});
		await expect(client.deleteObject("sha1/a")).resolves.toBeUndefined();
		await expect(client.deleteObject("sha1/gone")).resolves.toBeUndefined();
		await expect(client.deleteObject("sha1/c")).rejects.toBeInstanceOf(
			ObjectStoreError,
		);
	});
});
