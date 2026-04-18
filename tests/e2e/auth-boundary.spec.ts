import { expect, test } from "@playwright/test";

/**
 * Unauth-boundary smoke test for the endpoints added as part of the CMA
 * parity push. These all require an authenticated session; if any ever
 * start returning 200 without a cookie/bearer we've broken an authz
 * boundary and this test catches it immediately.
 *
 * Intentionally shallow — we don't assert response shape, only the
 * status code. Shape is validated by the handler type system + manual
 * browser verification.
 */
const PROTECTED_ENDPOINTS: Array<{
	method: "GET" | "POST" | "PATCH" | "DELETE";
	path: string;
}> = [
	// Members
	{ method: "GET", path: "/api/v1/projects/some-project/members" },
	{ method: "POST", path: "/api/v1/projects/some-project/members" },
	{ method: "PATCH", path: "/api/v1/projects/some-project/members/m1" },
	{ method: "DELETE", path: "/api/v1/projects/some-project/members/m1" },

	// Custom skills
	{ method: "GET", path: "/api/agent-skills" },
	{ method: "POST", path: "/api/agent-skills" },
	{ method: "PATCH", path: "/api/agent-skills/sk_test" },
	{ method: "DELETE", path: "/api/agent-skills/sk_test" },

	// API key rotation
	{ method: "POST", path: "/api/settings/api-keys/key_test/rotate" },

	// Session fork
	{ method: "POST", path: "/api/v1/sessions/ses_test/fork" },

	// Usage + cost (workspace-scoped)
	{ method: "GET", path: "/api/v1/usage" },
	{ method: "GET", path: "/api/v1/cost" },

	// Live limits
	{ method: "GET", path: "/api/v1/limits/live" },

	// Workflow-spawned sessions index
	{ method: "GET", path: "/api/workflows/executions/exec_test/sessions" },
];

for (const { method, path } of PROTECTED_ENDPOINTS) {
	test(`${method} ${path} requires auth`, async ({ request }) => {
		const res = await request.fetch(path, {
			method,
			data: method === "POST" || method === "PATCH" ? { noop: true } : undefined,
			headers: { "content-type": "application/json" },
		});
		// 401 is the expected case. 400 is acceptable when the body is rejected
		// by validation *before* the auth check runs (e.g. a zod schema wrap);
		// 403 is acceptable when authz runs but the caller lacks membership.
		// 200/201 means the boundary is broken.
		expect(res.status(), `${method} ${path} returned ${res.status()}`).not.toBe(200);
		expect(res.status()).not.toBe(201);
		expect([401, 400, 403, 404]).toContain(res.status());
	});
}

test("observability traces accepts sessionId filter", async ({ request }) => {
	// Traces endpoint is intentionally open (no cookie needed) — it reads
	// from ClickHouse and returns what's there. The sessionId filter is a
	// WHERE narrowing, not an authz check. Smoke: the handler doesn't 500
	// when sessionId is provided.
	const res = await request.get("/api/observability/traces?sessionId=smoke-test");
	expect(res.status()).toBe(200);
	const body = await res.json();
	expect(body).toHaveProperty("traces");
	expect(Array.isArray(body.traces)).toBe(true);
});

test("phoenix session redirect requires session id", async ({ request }) => {
	const res = await request.get(
		"/api/observability/phoenix/sessions/nonexistent",
		{ maxRedirects: 0 },
	);
	// Either 302 (redirect with empty target) or 404 (session not in phoenix).
	// 500 would mean the handler crashed — regression.
	expect([302, 303, 307, 308, 404]).toContain(res.status());
});
