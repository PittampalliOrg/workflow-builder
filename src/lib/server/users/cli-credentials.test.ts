import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { assertPlausibleCliCredential } from "./cli-credentials";

function tarGz(entries: Record<string, string>): string {
	const blocks: Buffer[] = [];
	for (const [name, content] of Object.entries(entries)) {
		const body = Buffer.from(content, "utf8");
		const header = Buffer.alloc(512);
		header.write(name, 0, "utf8");
		header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
		header.write("0", 156, "ascii");
		blocks.push(header, body);
		const padding = (512 - (body.length % 512)) % 512;
		if (padding > 0) blocks.push(Buffer.alloc(padding));
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks)).toString("base64");
}

describe("assertPlausibleCliCredential", () => {
	it("requires Gemini OAuth credentials in Google file bundles", () => {
		const metadataOnly = tarGz({
			"google_accounts.json": '["user@example.com"]',
		});

		expect(() => assertPlausibleCliCredential("google", metadataOnly)).toThrow(
			/oauth_creds\.json/,
		);

		const oauthBundle = tarGz({
			"oauth_creds.json": '{"refresh_token":"r"}',
			"google_accounts.json": '["user@example.com"]',
		});

		expect(() =>
			assertPlausibleCliCredential("google", oauthBundle),
		).not.toThrow();
	});
});
