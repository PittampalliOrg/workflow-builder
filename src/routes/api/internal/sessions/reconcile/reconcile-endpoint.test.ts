import { describe, expect, it, vi } from "vitest";

// Isolate the auth check from the heavy reconciler deps graph.
vi.mock("$lib/server/application/session-reconciler-service", () => ({
	runSessionReconcile: vi.fn(async () => ({
		scanned: 0,
		decisions: [],
		actionsTaken: 0,
		dryRun: true,
	})),
}));

import { POST } from "./+server";
import { runSessionReconcile } from "$lib/server/application/session-reconciler-service";

function request(headers: Record<string, string> = {}): Request {
	return new Request("http://localhost/api/internal/sessions/reconcile", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: "{}",
	});
}

describe("POST /api/internal/sessions/reconcile", () => {
	it("rejects a request without a valid internal token (401) and never runs the sweep", async () => {
		// No INTERNAL_API_TOKEN configured in the test env → any request is unauthorized.
		await expect(
			(POST as unknown as (e: { request: Request }) => Promise<Response>)({
				request: request(),
			}),
		).rejects.toMatchObject({ status: 401 });
		expect(runSessionReconcile).not.toHaveBeenCalled();
	});
});
