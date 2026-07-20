import { describe, it, expect } from "vitest";
import { redactSecrets } from "./content";

// Guards the load-bearing invariant for the compiled-capabilities debug panel:
// resolved MCP servers may carry a hosted_workflow Authorization bearer token,
// but the X-Connection-External-Id is only an audit-only reference (the
// piece-runtime self-resolves plaintext via BFF /decrypt). The panel must mask
// the former and keep the latter visible.
describe("redactSecrets", () => {
	it("masks secret headers (Authorization / api-key) by key", () => {
		const out = redactSecrets({
			headers: {
				Authorization: "Bearer super-secret-token",
				"x-api-key": "sk-live-123",
			},
		}) as { headers: Record<string, string> };
		expect(out.headers.Authorization).toBe("[REDACTED]");
		expect(out.headers["x-api-key"]).toBe("[REDACTED]");
	});

	it("KEEPS X-Connection-External-Id visible (reference, not a secret)", () => {
		const out = redactSecrets({
			headers: { "X-Connection-External-Id": "conn_abc123" },
		}) as { headers: Record<string, string> };
		expect(out.headers["X-Connection-External-Id"]).toBe("conn_abc123");
	});

	it("redacts secret-looking env values recursively across mcpServers", () => {
		const out = redactSecrets({
			mcpServers: [
				{
					serverName: "x",
					headers: { Authorization: "Bearer t" },
					env: { API_TOKEN: "zzz", PUBLIC_FLAG: "ok" },
					allowedTools: ["a", "b"],
				},
			],
		}) as {
			mcpServers: Array<{
				headers: Record<string, string>;
				env: Record<string, string>;
				allowedTools: string[];
			}>;
		};
		expect(out.mcpServers[0].headers.Authorization).toBe("[REDACTED]");
		expect(out.mcpServers[0].env.API_TOKEN).toBe("[REDACTED]");
		expect(out.mcpServers[0].env.PUBLIC_FLAG).toBe("ok");
		// Non-secret fields pass through untouched.
		expect(out.mcpServers[0].allowedTools).toEqual(["a", "b"]);
	});

	it("redacts screenshot pixels in structured, serialized, and data URI forms", () => {
		const pixels = "iVBORw0KGgo-sensitive-pixels";
		const out = redactSecrets({
			payloadBase64: pixels,
			serialized: `{"payloadBase64":"${pixels}"}`,
			doublySerialized: JSON.stringify(
				JSON.stringify({ payload_base64: pixels }),
			),
			imageUrl: `data:image/png;base64,${pixels}`,
			storageRef: "screenshots/frame.png",
		});
		const serialized = JSON.stringify(out);

		expect(out.payloadBase64).toBe("[REDACTED]");
		expect(out.serialized).toContain('"payloadBase64":"[REDACTED]"');
		expect(out.doublySerialized).toContain('payload_base64\\\":\\\"[REDACTED]');
		expect(out.imageUrl).toBe("[REDACTED image data URI]");
		expect(out.storageRef).toBe("screenshots/frame.png");
		expect(serialized).not.toContain(pixels);
	});
});
