import { afterEach, describe, expect, it, vi } from "vitest";

const daprFetchMock = vi.hoisted(() => vi.fn());

vi.mock("$lib/server/dapr-client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/dapr-client")>();
	return {
		...actual,
		daprFetch: (...args: unknown[]) => daprFetchMock(...args),
		getDaprSidecarUrl: () => "http://localhost:3500",
	};
});

import {
	authenticateReconcilerJobPayload,
	RECONCILER_JOB_NAME,
	scheduleSessionReconcilerJob,
} from "./session-reconciler-deps";

// authenticateReconcilerJobPayload reads INTERNAL_API_TOKEN via env → process.env
// fallback; the vitest $env mock is empty, so process.env drives it here.
const ORIGINAL = process.env.INTERNAL_API_TOKEN;
const ORIGINAL_ENABLED = process.env.SESSION_RECONCILER_ENABLED;
const ORIGINAL_TICK = process.env.SESSION_RECONCILER_TICK;

function restoreEnv(name: string, original: string | undefined): void {
	if (original === undefined) delete process.env[name];
	else process.env[name] = original;
}

describe("authenticateReconcilerJobPayload", () => {
	afterEach(() => {
		restoreEnv("INTERNAL_API_TOKEN", ORIGINAL);
	});

	it("allows any payload when no INTERNAL_API_TOKEN is configured (dev)", () => {
		delete process.env.INTERNAL_API_TOKEN;
		expect(authenticateReconcilerJobPayload({})).toBe(true);
		expect(authenticateReconcilerJobPayload({ token: "anything" })).toBe(true);
	});

	it("rejects a payload with no/blank token when a secret is configured", () => {
		process.env.INTERNAL_API_TOKEN = "s3kret";
		expect(authenticateReconcilerJobPayload({})).toBe(false);
		expect(authenticateReconcilerJobPayload({ data: {} })).toBe(false);
		expect(authenticateReconcilerJobPayload(null)).toBe(false);
	});

	it("accepts a matching token at body.token OR body.data.token, and rejects mismatches", () => {
		process.env.INTERNAL_API_TOKEN = "s3kret";
		expect(authenticateReconcilerJobPayload({ token: "s3kret" })).toBe(true);
		expect(authenticateReconcilerJobPayload({ data: { token: "s3kret" } })).toBe(true);
		expect(authenticateReconcilerJobPayload({ token: "nope" })).toBe(false);
		// length mismatch must not throw (timingSafeEqual requires equal length)
		expect(authenticateReconcilerJobPayload({ token: "s3kre" })).toBe(false);
	});
});

describe("scheduleSessionReconcilerJob", () => {
	afterEach(() => {
		daprFetchMock.mockReset();
		restoreEnv("INTERNAL_API_TOKEN", ORIGINAL);
		restoreEnv("SESSION_RECONCILER_ENABLED", ORIGINAL_ENABLED);
		restoreEnv("SESSION_RECONCILER_TICK", ORIGINAL_TICK);
	});

	it("uses Dapr's overwrite contract for idempotent multi-replica startup", async () => {
		process.env.INTERNAL_API_TOKEN = "s3kret";
		process.env.SESSION_RECONCILER_ENABLED = "true";
		process.env.SESSION_RECONCILER_TICK = "dapr-job";
		daprFetchMock.mockResolvedValue(new Response(null, { status: 204 }));

		await Promise.all([scheduleSessionReconcilerJob(), scheduleSessionReconcilerJob()]);

		expect(daprFetchMock).toHaveBeenCalledTimes(2);
		for (const [url, options] of daprFetchMock.mock.calls) {
			expect(url).toBe(`http://localhost:3500/v1.0/jobs/${RECONCILER_JOB_NAME}`);
			expect(options).toMatchObject({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				maxRetries: 0,
			});
			expect(JSON.parse(String(options.body))).toEqual({
				schedule: "@every 10m",
				dueTime: "2m",
				data: { reconcile: true, token: "s3kret" },
				overwrite: true,
			});
		}
	});
});
