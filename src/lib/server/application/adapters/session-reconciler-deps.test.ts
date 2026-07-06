import { afterEach, describe, expect, it } from "vitest";
import { authenticateReconcilerJobPayload } from "./session-reconciler-deps";

// authenticateReconcilerJobPayload reads INTERNAL_API_TOKEN via env → process.env
// fallback; the vitest $env mock is empty, so process.env drives it here.
const ORIGINAL = process.env.INTERNAL_API_TOKEN;

describe("authenticateReconcilerJobPayload", () => {
	afterEach(() => {
		if (ORIGINAL === undefined) delete process.env.INTERNAL_API_TOKEN;
		else process.env.INTERNAL_API_TOKEN = ORIGINAL;
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
