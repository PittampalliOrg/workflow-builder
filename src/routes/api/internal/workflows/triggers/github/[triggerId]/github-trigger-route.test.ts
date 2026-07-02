import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const trigger = {
		id: "trigger-1",
		workflowId: "wf-1",
		userId: "user-1",
		projectId: "project-1" as string | null,
		kind: "github",
		config: { events: "push,pull_request", secretRef: "enc" },
		triggerData: { configured: true },
		dedupSalt: "salt",
		backingRef: null,
		status: "active",
		lastError: null,
		lastFiredAt: null,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	};
	const workflowData = {
		getWorkflowTriggerById: vi.fn(async (): Promise<typeof trigger | null> => trigger),
		markWorkflowTriggerFired: vi.fn(async () => undefined),
	};
	const eventBus = {
		publish: vi.fn(async () => undefined),
	};
	const getGithubTriggerSecret = vi.fn(() => "secret");
	return { eventBus, getGithubTriggerSecret, trigger, workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/application/event-bus", () => ({
	getEventBusAdapter: () => mocks.eventBus,
}));

vi.mock("$lib/server/lifecycle/github-webhook", () => ({
	getGithubTriggerSecret: mocks.getGithubTriggerSecret,
}));

import { POST } from "./+server";

function signature(raw: string, secret = "secret") {
	return `sha256=${crypto.createHmac("sha256", secret).update(raw).digest("hex")}`;
}

function event(options: {
	body?: Record<string, unknown>;
	eventName?: string;
	delivery?: string;
	sig?: string;
	triggerId?: string;
} = {}) {
	const body =
		options.body ??
		({
			repository: { full_name: "PittampalliOrg/workflow-builder" },
			sender: { login: "octo" },
		} as Record<string, unknown>);
	const raw = JSON.stringify(body);
	return {
		params: { triggerId: options.triggerId ?? "trigger-1" },
		request: new Request("http://localhost", {
			method: "POST",
			body: raw,
			headers: {
				"x-hub-signature-256": options.sig ?? signature(raw),
				"x-github-event": options.eventName ?? "push",
				"x-github-delivery": options.delivery ?? "delivery-1",
			},
		}),
	};
}

describe("GitHub trigger webhook route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getWorkflowTriggerById.mockResolvedValue(mocks.trigger);
		mocks.workflowData.markWorkflowTriggerFired.mockResolvedValue(undefined);
		mocks.eventBus.publish.mockResolvedValue(undefined);
		mocks.getGithubTriggerSecret.mockReturnValue("secret");
	});

	it("keeps trigger persistence behind workflow-data services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.getWorkflowTriggerById");
		expect(source).toContain("workflowData.markWorkflowTriggerFired");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("workflowTriggers");
	});

	it("publishes a verified delivery and marks the trigger fired", async () => {
		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(202);
		await expect(response.json()).resolves.toEqual({
			accepted: true,
			event: "push",
			dedupKey: "delivery-1",
		});
		expect(mocks.workflowData.getWorkflowTriggerById).toHaveBeenCalledWith("trigger-1");
		expect(mocks.eventBus.publish).toHaveBeenCalledWith(
			"workflow.triggers",
			expect.objectContaining({
				workflowId: "wf-1",
				triggerId: "trigger-1",
				dedupKey: "delivery-1",
				triggerData: expect.objectContaining({
					configured: true,
					githubEvent: "push",
					repository: "PittampalliOrg/workflow-builder",
					sender: "octo",
				}),
			}),
		);
		expect(mocks.workflowData.markWorkflowTriggerFired).toHaveBeenCalledWith({
			triggerId: "trigger-1",
			firedAt: expect.any(Date),
		});
	});

	it("rejects bad signatures before publishing", async () => {
		const response = (await POST(event({ sig: "sha256=bad" }) as never)) as Response;

		expect(response.status).toBe(401);
		expect(mocks.eventBus.publish).not.toHaveBeenCalled();
		expect(mocks.workflowData.markWorkflowTriggerFired).not.toHaveBeenCalled();
	});

	it("returns 404 for missing or non-GitHub triggers", async () => {
		mocks.workflowData.getWorkflowTriggerById.mockResolvedValueOnce(null);

		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(404);
		expect(mocks.eventBus.publish).not.toHaveBeenCalled();
	});

	it("returns 409 for inactive triggers", async () => {
		mocks.workflowData.getWorkflowTriggerById.mockResolvedValueOnce({
			...mocks.trigger,
			status: "inactive",
		});

		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(409);
		expect(mocks.eventBus.publish).not.toHaveBeenCalled();
	});

	it("acknowledges ping and ignored events without publishing", async () => {
		const ping = (await POST(event({ eventName: "ping" }) as never)) as Response;
		expect(ping.status).toBe(200);
		await expect(ping.json()).resolves.toEqual({ ok: true, pong: true });

		const ignored = (await POST(event({ eventName: "issues" }) as never)) as Response;
		expect(ignored.status).toBe(200);
		await expect(ignored.json()).resolves.toEqual({ ok: true, ignored: "issues" });
		expect(mocks.eventBus.publish).not.toHaveBeenCalled();
		expect(mocks.workflowData.markWorkflowTriggerFired).not.toHaveBeenCalled();
	});

	it("returns 502 when publishing fails", async () => {
		mocks.eventBus.publish.mockRejectedValueOnce(new Error("nats unavailable"));

		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(502);
		expect(mocks.workflowData.markWorkflowTriggerFired).not.toHaveBeenCalled();
	});

	it("keeps last-fired update best-effort after a successful publish", async () => {
		mocks.workflowData.markWorkflowTriggerFired.mockRejectedValueOnce(
			new Error("write failed"),
		);

		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(202);
		await expect(response.json()).resolves.toMatchObject({
			accepted: true,
			event: "push",
			dedupKey: "delivery-1",
		});
		expect(mocks.eventBus.publish).toHaveBeenCalled();
		expect(mocks.workflowData.markWorkflowTriggerFired).toHaveBeenCalled();
	});
});
