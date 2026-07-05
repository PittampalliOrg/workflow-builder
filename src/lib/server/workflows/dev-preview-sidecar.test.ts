import { describe, expect, it, vi } from "vitest";
import {
	allowedSidecarCommands,
	fetchSidecarStatus,
	runSidecarCommand,
	sidecarBaseUrl,
} from "$lib/server/workflows/dev-preview-sidecar";

describe("sidecarBaseUrl", () => {
	it("derives the base from a stored syncUrl", () => {
		expect(sidecarBaseUrl("http://10.0.0.5:8001/__sync")).toBe("http://10.0.0.5:8001");
		expect(sidecarBaseUrl("http://10.0.0.5:3000/__sync/")).toBe("http://10.0.0.5:3000");
	});
	it("returns null when nothing is recorded", () => {
		expect(sidecarBaseUrl(null)).toBeNull();
		expect(sidecarBaseUrl("  ")).toBeNull();
	});
});

describe("allowedSidecarCommands", () => {
	it("exposes the registry's deps + testCommands names", () => {
		expect(allowedSidecarCommands("workflow-builder")).toEqual([
			"boundaries",
			"check",
			"contract",
			"deps",
			"test-unit",
		]);
	});
	it("denies unknown services instead of throwing", () => {
		expect(allowedSidecarCommands("not-a-service")).toEqual([]);
	});
});

describe("fetchSidecarStatus", () => {
	it("parses a sidecar status payload", async () => {
		const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
			new Response(
				JSON.stringify({
					ok: true,
					service: "dev-sync-sidecar",
					dest: "/app",
					lastSyncAt: "2026-07-04T10:00:00.000Z",
					lastSyncBytes: 2048,
					lastRun: null,
					commands: ["contract", "deps"],
				}),
				{ status: 200 },
			),
		);
		const result = await fetchSidecarStatus({
			syncUrl: "http://10.0.0.5:8001/__sync",
			fetchImpl,
		});
		expect(result).toMatchObject({
			ok: true,
			data: { ok: true, dest: "/app", commands: ["contract", "deps"] },
		});
		expect(fetchImpl.mock.calls[0][0]).toBe("http://10.0.0.5:8001/__status");
	});

	it("classifies a plugin-mode dev server (non-sidecar body) as no-sidecar", async () => {
		const result = await fetchSidecarStatus({
			syncUrl: "http://10.0.0.5:3000/__sync",
			fetchImpl: vi.fn(async () =>
				new Response(JSON.stringify({ hello: "app" }), { status: 200 }),
			),
		});
		expect(result).toMatchObject({ ok: false, reason: "no-sidecar" });
	});

	it("degrades to unreachable on network failure", async () => {
		const result = await fetchSidecarStatus({
			syncUrl: "http://10.0.0.5:8001/__sync",
			fetchImpl: vi.fn(async () => {
				throw new Error("timeout");
			}),
		});
		expect(result).toMatchObject({ ok: false, reason: "unreachable" });
	});
});

describe("runSidecarCommand", () => {
	it("refuses commands outside the registry allowlist BEFORE any request", async () => {
		const fetchImpl = vi.fn();
		const result = await runSidecarCommand({
			syncUrl: "http://10.0.0.5:8001/__sync",
			service: "workflow-builder",
			cmd: "rm -rf /",
			fetchImpl,
		});
		expect(result).toMatchObject({ ok: false, reason: "forbidden" });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("POSTs an allowlisted command and returns the run output", async () => {
		const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
			new Response(
				JSON.stringify({
					ok: true,
					cmd: "contract",
					exitCode: 0,
					durationMs: 1234,
					truncated: false,
					output: "8 passed",
				}),
				{ status: 200 },
			),
		);
		const result = await runSidecarCommand({
			syncUrl: "http://10.0.0.5:8001/__sync",
			service: "workflow-builder",
			cmd: "contract",
			fetchImpl,
		});
		expect(fetchImpl.mock.calls[0][0]).toBe("http://10.0.0.5:8001/__run?cmd=contract");
		expect((fetchImpl.mock.calls[0][1] as RequestInit).method).toBe("POST");
		expect(result).toMatchObject({
			ok: true,
			data: { ok: true, exitCode: 0, output: "8 passed" },
		});
	});

	it("passes through a failed run (non-zero exit) as data, not an error", async () => {
		const result = await runSidecarCommand({
			syncUrl: "http://10.0.0.5:8001/__sync",
			service: "workflow-orchestrator",
			cmd: "contract",
			fetchImpl: vi.fn(async () =>
				new Response(
					JSON.stringify({
						ok: false,
						cmd: "contract",
						exitCode: 1,
						durationMs: 900,
						truncated: false,
						output: "1 failed",
					}),
					{ status: 200 },
				),
			),
		});
		expect(result).toMatchObject({
			ok: true,
			data: { ok: false, exitCode: 1, output: "1 failed" },
		});
	});
});
