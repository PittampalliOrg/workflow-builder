import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	requirePreviewControlBroker: vi.fn(),
	launch: vi.fn(async () => ({
		ok: true,
		status: "launched",
		profile: "manifest-candidate",
		pullRequest: { number: 42 },
		changedPaths: ["packages/workloads/app.yaml"],
		launch: { ok: true, environment: {} },
	})),
}));

vi.mock("$env/dynamic/private", () => ({
	env: { PREVIEW_CONTROL_BROKER_MODE: "true" },
}));
vi.mock("$lib/server/internal-auth", () => ({
	requirePreviewControlBroker: mocks.requirePreviewControlBroker,
}));
vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		previewInfrastructureCandidates: { launch: mocks.launch },
	}),
}));

import { POST } from "./+server";

const body = {
	requestId: "request-1",
	name: "infra-pr-42",
	userId: "admin-1",
	pullRequestNumber: 42,
	ttlHours: 24,
	lifecycle: "ephemeral",
};

function event(payload: Record<string, unknown> = body) {
	return {
		request: new Request("http://broker/infrastructure-candidate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		}),
	};
}

describe("physical infrastructure candidate broker route", () => {
	beforeEach(() => vi.clearAllMocks());

	it("requires broker auth and delegates the narrow PR command", async () => {
		const response = (await POST(event() as never)) as Response;
		expect(response.status).toBe(202);
		expect(mocks.requirePreviewControlBroker).toHaveBeenCalledOnce();
		expect(mocks.launch).toHaveBeenCalledWith(body);
	});

	it("rejects caller-authored paths, refs, repositories, and profiles", async () => {
		const response = (await POST(
			event({
				...body,
				candidatePaths: ["attacker/path"],
				platformRef: "attacker/ref",
				repository: "attacker/repo",
				profile: "host-candidate",
			}) as never,
		)) as Response;
		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: expect.stringContaining("unsupported broker fields"),
		});
		expect(mocks.launch).not.toHaveBeenCalled();
	});
});
