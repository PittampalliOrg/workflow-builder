import { describe, expect, it } from "vitest";
import {
	classifyExecutionError,
	extractHttpStatus,
	isNetworkError,
} from "./error-classify.js";

/**
 * Minimal stand-in for @activepieces/pieces-common HttpError — the real
 * class wraps an AxiosError and exposes `get response(): { status, body }`
 * from the prototype.
 */
class FakeHttpError extends Error {
	constructor(private readonly statusValue: number) {
		super(`HTTP ${statusValue}`);
	}
	get response(): { status: number; body: unknown } {
		return { status: this.statusValue, body: {} };
	}
}

describe("extractHttpStatus", () => {
	it("reads HttpError's response getter", () => {
		expect(extractHttpStatus(new FakeHttpError(503))).toBe(503);
	});

	it("reads axios-style response.status on plain objects", () => {
		expect(extractHttpStatus({ response: { status: 404 } })).toBe(404);
	});

	it("falls back to status / statusCode", () => {
		expect(extractHttpStatus({ status: 502 })).toBe(502);
		expect(extractHttpStatus({ statusCode: 400 })).toBe(400);
	});

	it("returns undefined for non-HTTP errors", () => {
		expect(extractHttpStatus(new Error("boom"))).toBeUndefined();
		expect(extractHttpStatus(null)).toBeUndefined();
		expect(extractHttpStatus("string error")).toBeUndefined();
		expect(extractHttpStatus({ response: { status: "418" } })).toBeUndefined();
	});
});

describe("isNetworkError", () => {
	it("matches node error codes", () => {
		for (const code of ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET"]) {
			const err = Object.assign(new Error("connect failed"), { code });
			expect(isNetworkError(err)).toBe(true);
		}
	});

	it("matches AbortError / aborted requests", () => {
		const abort = Object.assign(new Error("This operation was aborted"), {
			name: "AbortError",
		});
		expect(isNetworkError(abort)).toBe(true);
		expect(isNetworkError(new Error("The user aborted a request"))).toBe(true);
	});

	it("unwraps undici fetch-failed causes", () => {
		const cause = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
			code: "ECONNREFUSED",
		});
		const wrapper = Object.assign(new TypeError("fetch failed"), { cause });
		expect(isNetworkError(wrapper)).toBe(true);
	});

	it("does not match generic errors", () => {
		expect(isNetworkError(new Error("invalid input: missing field"))).toBe(false);
		expect(isNetworkError(undefined)).toBe(false);
	});
});

describe("classifyExecutionError", () => {
	it("classifies 429 and 5xx as retryable", () => {
		expect(classifyExecutionError(new FakeHttpError(429))).toBe("retryable");
		expect(classifyExecutionError(new FakeHttpError(500))).toBe("retryable");
		expect(classifyExecutionError(new FakeHttpError(503))).toBe("retryable");
		expect(classifyExecutionError({ response: { status: 599 } })).toBe(
			"retryable",
		);
	});

	it("classifies other 4xx as permanent", () => {
		expect(classifyExecutionError(new FakeHttpError(400))).toBe("permanent");
		expect(classifyExecutionError(new FakeHttpError(401))).toBe("permanent");
		expect(classifyExecutionError(new FakeHttpError(403))).toBe("permanent");
		expect(classifyExecutionError(new FakeHttpError(404))).toBe("permanent");
		expect(classifyExecutionError(new FakeHttpError(422))).toBe("permanent");
	});

	it("classifies network/transport errors as retryable", () => {
		const econn = Object.assign(new Error("connect refused"), {
			code: "ECONNREFUSED",
		});
		expect(classifyExecutionError(econn)).toBe("retryable");
		const fetchFailed = Object.assign(new TypeError("fetch failed"), {
			cause: Object.assign(new Error("dns fail"), { code: "ENOTFOUND" }),
		});
		expect(classifyExecutionError(fetchFailed)).toBe("retryable");
	});

	it("classifies validation / unknown errors as permanent (conservative)", () => {
		expect(classifyExecutionError(new Error("missing required prop: channel"))).toBe(
			"permanent",
		);
		expect(classifyExecutionError("string error")).toBe("permanent");
		expect(classifyExecutionError(null)).toBe("permanent");
		expect(classifyExecutionError({})).toBe("permanent");
	});

	it("HTTP status wins over a network-looking message", () => {
		// e.g. a 504 whose message mentions a timeout — status drives the class
		const err = Object.assign(new Error("upstream ETIMEDOUT"), {
			response: { status: 422 },
		});
		expect(classifyExecutionError(err)).toBe("permanent");
	});
});
