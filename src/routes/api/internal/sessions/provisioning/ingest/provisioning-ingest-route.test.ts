import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowData = {
		resolveSessionIdForProvisioningEvent: vi.fn(
			async (): Promise<string | null> => "session-1",
		),
		appendSessionEvent: vi.fn(async () => ({
			id: "event-1",
			sessionId: "session-1",
			sequence: 7,
			type: "session.provisioning_running",
			data: {},
			processedAt: "2026-07-02T00:00:00.000Z",
			sourceEventId: "prov:session-1:running",
			producerId: null,
			producerEpoch: null,
			createdAt: "2026-07-02T00:00:00.000Z",
			timestamp: "2026-07-02T00:00:00.000Z",
		})),
	};
	const requireInternal = vi.fn();
	return { requireInternal, workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/internal-auth", () => ({
	requireInternal: mocks.requireInternal,
}));

import { POST } from "./+server";

function event(body: unknown) {
	return {
		request: new Request(
			"http://localhost/api/internal/sessions/provisioning/ingest",
			{
				method: "POST",
				body: typeof body === "string" ? body : JSON.stringify(body),
				headers: { "Content-Type": "application/json" },
			},
		),
	};
}

describe("internal session provisioning ingest route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.resolveSessionIdForProvisioningEvent.mockResolvedValue(
			"session-1",
		);
		mocks.workflowData.appendSessionEvent.mockResolvedValue({
			id: "event-1",
			sessionId: "session-1",
			sequence: 7,
			type: "session.provisioning_running",
			data: {},
			processedAt: "2026-07-02T00:00:00.000Z",
			sourceEventId: "prov:session-1:running",
			producerId: null,
			producerEpoch: null,
			createdAt: "2026-07-02T00:00:00.000Z",
			timestamp: "2026-07-02T00:00:00.000Z",
		});
	});

	it("keeps provisioning persistence behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.resolveSessionIdForProvisioningEvent");
		expect(source).toContain("workflowData.appendSessionEvent");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("$lib/server/sessions/events");
	});

	it("acks malformed JSON without persistence", async () => {
		const response = (await POST(event("{") as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			skipped: "bad_json",
		});
		expect(mocks.requireInternal).toHaveBeenCalledTimes(1);
		expect(mocks.workflowData.resolveSessionIdForProvisioningEvent).not.toHaveBeenCalled();
		expect(mocks.workflowData.appendSessionEvent).not.toHaveBeenCalled();
	});

	it("skips missing fields without persistence", async () => {
		const response = (await POST(event({ runtimeAppId: "app-1" }) as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			skipped: "missing_fields",
		});
		expect(mocks.workflowData.resolveSessionIdForProvisioningEvent).not.toHaveBeenCalled();
	});

	it("skips unmatched sessions without retrying the observer", async () => {
		mocks.workflowData.resolveSessionIdForProvisioningEvent.mockResolvedValueOnce(null);

		const response = (await POST(
			event({ runtimeAppId: "app-1", phase: "running" }) as never,
		)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			skipped: "no_session",
		});
		expect(mocks.workflowData.appendSessionEvent).not.toHaveBeenCalled();
	});

	it("resolves the session and appends an idempotent provisioning event", async () => {
		const response = (await POST(
			event({
				runtimeAppId: "app-1",
				sessionId: "label-session-1",
				phase: "running",
				at: "2026-07-02T01:02:03.000Z",
				durationMs: 1234,
				podName: "sandbox-pod",
				namespace: "workflow-builder",
				reason: "Ready",
			}) as never,
		)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			sequence: 7,
			type: "session.provisioning_running",
		});
		expect(mocks.workflowData.resolveSessionIdForProvisioningEvent).toHaveBeenCalledWith({
			runtimeAppId: "app-1",
			sessionId: "label-session-1",
		});
		expect(mocks.workflowData.appendSessionEvent).toHaveBeenCalledWith(
			"session-1",
			{
				type: "session.provisioning_running",
				data: {
					phase: "running",
					at: "2026-07-02T01:02:03.000Z",
					durationMs: 1234,
					podName: "sandbox-pod",
					namespace: "workflow-builder",
					reason: "Ready",
				},
				sourceEventId: "prov:session-1:running",
				processedAt: new Date("2026-07-02T01:02:03.000Z"),
			},
		);
	});
});
