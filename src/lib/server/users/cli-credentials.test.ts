import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/db", () => ({ db: null }));
vi.mock("$lib/server/security/encryption", () => ({
	decryptString: vi.fn(),
	encryptString: vi.fn(),
}));

import { assertPlausibleCliCredential } from "./cli-credentials";

const BLOCK_SIZE = 512;

function writeString(buf: Buffer, offset: number, length: number, value: string): void {
	buf.write(value.slice(0, length), offset, length, "utf8");
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
	const encoded = value.toString(8).padStart(length - 1, "0") + "\0";
	writeString(buf, offset, length, encoded);
}

function tarHeader(name: string, size: number): Buffer {
	const header = Buffer.alloc(BLOCK_SIZE);
	writeString(header, 0, 100, name);
	writeOctal(header, 100, 8, 0o644);
	writeOctal(header, 108, 8, 0);
	writeOctal(header, 116, 8, 0);
	writeOctal(header, 124, 12, size);
	writeOctal(header, 136, 12, 0);
	header.fill(0x20, 148, 156);
	writeString(header, 156, 1, "0");
	writeString(header, 257, 6, "ustar");

	let checksum = 0;
	for (const byte of header) checksum += byte;
	writeString(header, 148, 8, checksum.toString(8).padStart(6, "0") + "\0 ");
	return header;
}

function tarGz(entries: Record<string, Buffer | string>): string {
	const chunks: Buffer[] = [];
	for (const [name, value] of Object.entries(entries)) {
		const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
		chunks.push(tarHeader(name, body.length));
		chunks.push(body);
		const pad = (BLOCK_SIZE - (body.length % BLOCK_SIZE)) % BLOCK_SIZE;
		if (pad) chunks.push(Buffer.alloc(pad));
	}
	chunks.push(Buffer.alloc(BLOCK_SIZE * 2));
	return gzipSync(Buffer.concat(chunks)).toString("base64");
}

describe("assertPlausibleCliCredential file_bundle validation", () => {
	it("accepts a Google AGY bundle with the Antigravity OAuth token", () => {
		const bundle = tarGz({
			"antigravity-cli/antigravity-oauth-token": '{"token":{}}',
			"antigravity-cli/installation_id": "install-1",
		});

		expect(() => assertPlausibleCliCredential("google", bundle)).not.toThrow();
	});

	it("rejects a legacy Gemini-only oauth_creds.json bundle for Google AGY", () => {
		const bundle = tarGz({
			"oauth_creds.json": '{"token":{}}',
		});

		expect(() => assertPlausibleCliCredential("google", bundle)).toThrow(
			/Antigravity OAuth token/,
		);
	});

	it("rejects non-gzip file bundles", () => {
		const bundle = Buffer.alloc(64, "x").toString("base64");

		expect(() => assertPlausibleCliCredential("google", bundle)).toThrow(
			/gzip/,
		);
	});

	it("rejects oversized file bundles before inspecting tar contents", () => {
		const oversized = Buffer.alloc(8 * 1024 * 1024 + 1);
		oversized[0] = 0x1f;
		oversized[1] = 0x8b;

		expect(() =>
			assertPlausibleCliCredential("google", oversized.toString("base64")),
		).toThrow(/too large/);
	});
});
