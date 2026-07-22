import { describe, expect, it, vi } from "vitest";

// Control the auth decision + isolate the heavy reconciler deps graph.
vi.mock("$lib/server/application/session-reconciler-service", () => ({
	authenticateReconcilerJobPayload: vi.fn(),
	runSessionReconcile: vi.fn(async () => ({
		scanned: 0,
		decisions: [],
		actionsTaken: 0,
		dryRun: true,
		runtimeHostCleanup: {
			scanned: 0,
			acknowledged: [],
			failed: [],
			dryRun: true,
		},
	})),
}));

import { POST } from "./+server";
import {
	authenticateReconcilerJobPayload,
	runSessionReconcile,
} from "$lib/server/application/session-reconciler-service";

function request(body: Record<string, unknown> = {}): Request {
	return new Request("http://localhost/job/session-liveness-reconcile", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

const call = (req: Request) =>
	(POST as unknown as (e: { request: Request }) => Promise<Response>)({ request: req });

describe("POST /job/session-liveness-reconcile", () => {
	it("401s an unauthenticated callback and never runs the sweep", async () => {
		vi.mocked(authenticateReconcilerJobPayload).mockReturnValue(false);
		vi.mocked(runSessionReconcile).mockClear();
		await expect(call(request({ data: { token: "wrong" } }))).rejects.toMatchObject({
			status: 401,
		});
		expect(runSessionReconcile).not.toHaveBeenCalled();
	});

	it("runs the sweep once the payload token authenticates", async () => {
		vi.mocked(authenticateReconcilerJobPayload).mockReturnValue(true);
		vi.mocked(runSessionReconcile).mockClear();
		const res = await call(request({ data: { token: "ok" } }));
		expect(runSessionReconcile).toHaveBeenCalledOnce();
		expect(res.status).toBe(200);
	});
});
